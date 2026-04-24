import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentResult } from "../adapter-layer.js";
import type { AgentLoopBudget } from "./agent-loop-budget.js";
import type {
  AgentLoopModelClient,
  AgentLoopModelRef,
  AgentLoopModelRegistry,
  AgentLoopReasoningEffort,
} from "./agent-loop-model.js";
import { createAgentLoopSession, type AgentLoopSession } from "./agent-loop-session.js";
import type { AgentLoopEventSink } from "./agent-loop-events.js";
import type { AgentLoopToolPolicy } from "./agent-loop-turn-context.js";
import { withDefaultBudget } from "./agent-loop-turn-context.js";
import type { BoundedAgentLoopRunner } from "./bounded-agent-loop-runner.js";
import type { AgentLoopSessionState } from "./agent-loop-session-state.js";
import { buildAgentLoopBaseInstructions, buildChatStructuredOutputInstructions } from "./agent-loop-prompts.js";
import type { ApprovalRequest, ToolCallContext } from "../../../tools/types.js";
import type { ExecutionPolicy, SubagentRole } from "./execution-policy.js";
import { normalizeAssistantDisplayText } from "./chat-display-output.js";

const ChatAgentLoopFinalAnswerSectionSchema = z.object({
  title: z.string(),
  bullets: z.array(z.string()).default([]),
});

const ChatAgentLoopFinalAnswerSchema = z.object({
  summary: z.string().default(""),
  sections: z.array(ChatAgentLoopFinalAnswerSectionSchema).default([]),
  evidence: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  nextActions: z.array(z.string()).default([]),
  nextAction: z.string().optional(),
}).passthrough();

const ChatAgentLoopOutputBaseSchema = z.object({
  status: z.enum(["done", "blocked", "failed"]).default("done"),
  message: z.string().default(""),
  answer: z.string().optional(),
  evidence: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  finalAnswer: ChatAgentLoopFinalAnswerSchema.optional(),
}).passthrough();

export const ChatAgentLoopOutputSchema = ChatAgentLoopOutputBaseSchema.transform((value) => {
  const summary = value.message.trim() || value.answer?.trim() || "";
  const finalAnswer = value.finalAnswer ?? {
    summary,
    sections: [],
    evidence: value.evidence,
    blockers: value.blockers,
    nextActions: [],
  };

  return {
    ...value,
    message: value.message.trim() || value.answer?.trim() || finalAnswer.summary.trim(),
    evidence: value.evidence.length > 0 ? value.evidence : finalAnswer.evidence,
    blockers: value.blockers.length > 0 ? value.blockers : finalAnswer.blockers,
    finalAnswer,
  };
});
export type ChatAgentLoopOutput = z.infer<typeof ChatAgentLoopOutputSchema>;

export type ChatAgentLoopOutputMode =
  | { kind: "display_text" }
  | { kind: "structured"; schema?: z.ZodType<unknown, z.ZodTypeDef, unknown> };

export interface ChatAgentLoopRunnerDeps {
  boundedRunner: BoundedAgentLoopRunner;
  modelClient: AgentLoopModelClient;
  modelRegistry: AgentLoopModelRegistry;
  defaultModel?: AgentLoopModelRef;
  cwd?: string;
  defaultBudget?: Partial<AgentLoopBudget>;
  defaultToolPolicy?: AgentLoopToolPolicy;
  defaultToolCallContext?: Partial<ToolCallContext>;
  defaultReasoningEffort?: AgentLoopReasoningEffort;
  defaultProfileName?: string;
  defaultExecutionPolicy?: ExecutionPolicy;
  createSession?: (input: {
    goalId?: string;
    eventSink?: AgentLoopEventSink;
    resumeStatePath?: string;
    sessionId?: string;
    traceId?: string;
  }) => AgentLoopSession;
}

export interface ChatAgentLoopInput {
  message: string;
  goalId?: string;
  cwd?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  systemPrompt?: string;
  eventSink?: AgentLoopEventSink;
  model?: AgentLoopModelRef;
  budget?: Partial<AgentLoopBudget>;
  toolPolicy?: AgentLoopToolPolicy;
  approvalFn?: (request: ApprovalRequest) => Promise<boolean>;
  toolCallContext?: Partial<ToolCallContext>;
  resumeState?: AgentLoopSessionState;
  resumeStatePath?: string;
  resumeOnly?: boolean;
  role?: SubagentRole;
  outputMode?: ChatAgentLoopOutputMode;
}

export class ChatAgentLoopRunner {
  constructor(private readonly deps: ChatAgentLoopRunnerDeps) {}

  async execute(input: ChatAgentLoopInput): Promise<AgentResult> {
    const started = Date.now();
    const model = input.model ?? this.deps.defaultModel ?? await this.deps.modelRegistry.defaultModel();
    const modelInfo = await this.deps.modelClient.getModelInfo(model);
    const cwd = input.cwd ?? this.deps.cwd ?? process.cwd();
    const turnId = randomUUID();
    const outputMode = input.outputMode ?? { kind: "display_text" as const };
    const outputSchema: z.ZodType<unknown, z.ZodTypeDef, unknown> = outputMode.kind === "structured"
      ? outputMode.schema ?? ChatAgentLoopOutputSchema
      : ChatAgentLoopOutputSchema;
    const session = this.deps.createSession?.({
      goalId: input.goalId,
      eventSink: input.eventSink,
      ...(input.resumeStatePath ? { resumeStatePath: input.resumeStatePath } : {}),
      ...(input.resumeState ? { sessionId: input.resumeState.sessionId, traceId: input.resumeState.traceId } : {}),
    }) ?? createAgentLoopSession({
      ...(input.eventSink ? { eventSink: input.eventSink } : {}),
      ...(input.resumeState ? { sessionId: input.resumeState.sessionId, traceId: input.resumeState.traceId } : {}),
    });
    try {
      const result = await this.deps.boundedRunner.run({
        session,
        turnId,
        goalId: input.goalId ?? "chat",
        ...(this.deps.defaultProfileName ? { profileName: this.deps.defaultProfileName } : {}),
        cwd,
        model,
        modelInfo,
        ...(this.deps.defaultReasoningEffort ? { reasoningEffort: this.deps.defaultReasoningEffort } : {}),
        messages: input.resumeOnly
          ? []
          : [
              {
                role: "system",
                content: [
                  buildAgentLoopBaseInstructions({
                    mode: "chat",
                    extraRules: [
                      "Use tools to answer the user and operate CoreLoop only through tools.",
                      "Do not call CoreLoop internals directly.",
                      ...(outputMode.kind === "structured" ? [buildChatStructuredOutputInstructions()] : []),
                    ],
                    role: input.role,
                  }),
                  input.systemPrompt?.trim() ? input.systemPrompt.trim() : "",
                ].join("\n"),
              },
              ...(input.history ?? []).map((m) => ({ role: m.role, content: m.content })),
              { role: "user" as const, content: input.message },
            ],
        outputSchema,
        finalOutputMode: outputMode.kind === "structured" ? "schema" : "display_text",
        budget: withDefaultBudget({ ...this.deps.defaultBudget, ...input.budget }),
        toolPolicy: { ...this.deps.defaultToolPolicy, ...input.toolPolicy },
        ...(input.resumeState ? { resumeState: input.resumeState } : {}),
        loadPersistedState: input.resumeOnly === true || input.resumeState !== undefined,
        ...(this.deps.defaultExecutionPolicy ? { executionPolicy: this.deps.defaultExecutionPolicy } : {}),
        toolCallContext: {
          cwd,
          goalId: input.goalId ?? "chat",
          trustBalance: 0,
          preApproved: true,
          approvalFn: input.approvalFn ?? (async () => false),
          onApprovalRequested: async (request) => {
            await input.eventSink?.emit({
              type: "approval_request",
              eventId: randomUUID(),
              sessionId: session.sessionId,
              traceId: session.traceId,
              turnId,
              goalId: input.goalId ?? "chat",
              createdAt: new Date().toISOString(),
              callId: request.callId ?? `approval:${turnId}`,
              toolName: request.toolName,
              reason: request.reason,
              permissionLevel: request.permissionLevel,
              isDestructive: request.isDestructive,
            });
          },
          ...this.deps.defaultToolCallContext,
          ...input.toolCallContext,
          agentRole: input.role,
        },
      });

      const chatOutput = isRecord(result.output) ? result.output as ChatAgentLoopOutput : null;
      const outputStatus = isRecord(result.output) && typeof result.output.status === "string"
        ? result.output.status
        : "done";
      const success = outputMode.kind === "structured"
        ? result.success && outputStatus === "done"
        : result.success;
      const hadApprovalDeniedError = result.commandResults.some((entry) =>
        /approval denied|user denied approval|requires approval/i.test(entry.outputSummary),
      );
      const fallbackOutput = success
        ? this.buildSuccessfulOutput(result.finalText, chatOutput)
        : this.buildFailureOutput(result.stopReason, hadApprovalDeniedError, result.finalText, chatOutput, extractStringArray(result.output, "blockers"));
      return {
        success,
        output: fallbackOutput,
        ...(outputMode.kind === "structured" && result.output !== null ? { structuredOutput: result.output } : {}),
        error: success ? null : extractStringArray(result.output, "blockers").join("; ") || result.stopReason,
        exit_code: null,
        elapsed_ms: Date.now() - started,
        stopped_reason: success ? "completed" : result.stopReason === "timeout" ? "timeout" : "error",
        agentLoop: {
          traceId: result.traceId,
          sessionId: result.sessionId,
          turnId: result.turnId,
          stopReason: result.stopReason,
          modelTurns: result.modelTurns,
          toolCalls: result.toolCalls,
          usage: result.usage,
          compactions: result.compactions,
          ...(result.profileName ? { profileName: result.profileName } : {}),
          ...(result.reasoningEffort ? { reasoningEffort: result.reasoningEffort } : {}),
          completionEvidence: extractStringArray(result.output, "evidence"),
          verificationHints: extractStringArray(result.output, "blockers"),
          filesChangedPaths: result.changedFiles,
          ...(result.executionPolicy
            ? {
                sandboxMode: result.executionPolicy.sandboxMode,
                approvalPolicy: result.executionPolicy.approvalPolicy,
                networkAccess: result.executionPolicy.networkAccess,
              }
            : {}),
        },
      };
    } catch (err) {
      const detail = err instanceof Error
        ? [err.name !== "Error" ? err.name : null, err.message].filter((part): part is string => typeof part === "string" && part.length > 0).join(": ")
        : String(err);
      const lowered = detail.toLowerCase();
      const isTimeout = lowered.includes("timeout") || lowered.includes("timed out") || lowered.includes("aborterror") || lowered.includes("aborted");
      const output = isTimeout
        ? "Agent loop stopped: model request timed out. Narrow broad repo-wide searches or increase `codex_timeout_ms` if this workload is expected."
        : `Agent loop stopped: model request failed. ${detail ? `Detail: ${detail}. ` : ""}Retry the turn or inspect the provider connection.`;
      return {
        success: false,
        output,
        error: detail || output,
        exit_code: null,
        elapsed_ms: Date.now() - started,
        stopped_reason: isTimeout ? "timeout" : "error",
        agentLoop: {
          traceId: session.traceId,
          sessionId: session.sessionId,
          turnId,
          stopReason: isTimeout ? "timeout" : "fatal_error",
          modelTurns: 0,
          toolCalls: 0,
          compactions: 0,
          completionEvidence: [],
          verificationHints: [],
          filesChangedPaths: [],
        },
      };
    }
  }

  private buildSuccessfulOutput(finalText: string, output?: ChatAgentLoopOutput | null): string {
    const displayText = normalizeAssistantDisplayText({ finalText, output });
    if (displayText) return displayText;
    return "(no response)";
  }

  private buildFailureOutput(
    stopReason: string,
    hadApprovalDeniedError: boolean,
    finalText: string,
    output?: ChatAgentLoopOutput | null,
    blockers?: string[],
  ): string {
    if (
      stopReason === "consecutive_tool_errors"
      && (hadApprovalDeniedError || /^Calling\s+/i.test(finalText.trim()))
    ) {
      return [
        "I could not continue because repeated tool actions were denied or failed.",
        "Approve the request or update session policy with `/permissions ...`, then retry.",
      ].join("\n");
    }
    if (stopReason === "max_tool_calls") {
      return "I reached the tool-call limit before completing this request. Please narrow the scope or continue in another turn.";
    }
    if (stopReason === "max_model_turns") {
      return "I reached the model-turn limit before completing this request. Please continue in another turn.";
    }
    if (stopReason === "stalled_tool_loop") {
      return "I stopped because the tool loop repeated without making progress.";
    }

    const displayText = normalizeAssistantDisplayText({ finalText, output });
    if (displayText) return displayText;
    if (blockers && blockers.length > 0) return blockers.join("; ");
    return `Interrupted: ${stopReason}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractStringArray(value: unknown, key: string): string[] {
  if (!isRecord(value)) return [];
  const field = value[key];
  if (!Array.isArray(field)) return [];
  return field.filter((item): item is string => typeof item === "string" && item.length > 0);
}
