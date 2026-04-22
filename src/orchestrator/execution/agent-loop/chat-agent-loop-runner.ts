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
import { buildAgentLoopBaseInstructions } from "./agent-loop-prompts.js";
import type { ApprovalRequest, ToolCallContext } from "../../../tools/types.js";
import type { ExecutionPolicy, SubagentRole } from "./execution-policy.js";

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
  evidence: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  finalAnswer: ChatAgentLoopFinalAnswerSchema.optional(),
}).passthrough();

export const ChatAgentLoopOutputSchema = ChatAgentLoopOutputBaseSchema.transform((value) => {
  const finalAnswer = value.finalAnswer ?? {
    summary: value.message,
    sections: [],
    evidence: value.evidence,
    blockers: value.blockers,
    nextActions: [],
  };

  return {
    ...value,
    message: value.message.trim() || finalAnswer.summary.trim(),
    evidence: value.evidence.length > 0 ? value.evidence : finalAnswer.evidence,
    blockers: value.blockers.length > 0 ? value.blockers : finalAnswer.blockers,
    finalAnswer,
  };
});
export type ChatAgentLoopOutput = z.infer<typeof ChatAgentLoopOutputSchema>;

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
}

export class ChatAgentLoopRunner {
  constructor(private readonly deps: ChatAgentLoopRunnerDeps) {}

  async execute(input: ChatAgentLoopInput): Promise<AgentResult> {
    const started = Date.now();
    const model = input.model ?? this.deps.defaultModel ?? await this.deps.modelRegistry.defaultModel();
    const modelInfo = await this.deps.modelClient.getModelInfo(model);
    const cwd = input.cwd ?? this.deps.cwd ?? process.cwd();
    const turnId = randomUUID();
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
        cwd,
        model,
        modelInfo,
        ...(this.deps.defaultProfileName ? { profileName: this.deps.defaultProfileName } : {}),
        ...(this.deps.defaultReasoningEffort ? { reasoningEffort: this.deps.defaultReasoningEffort } : {}),
        loadPersistedState: input.resumeOnly || input.resumeState !== undefined,
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
                    ],
                    role: input.role,
                  }),
                  input.systemPrompt?.trim() ? input.systemPrompt.trim() : "",
                ].join("\n"),
              },
              ...(input.history ?? []).map((m) => ({ role: m.role, content: m.content })),
              { role: "user" as const, content: input.message },
            ],
        outputSchema: ChatAgentLoopOutputSchema,
        budget: withDefaultBudget({ ...this.deps.defaultBudget, ...input.budget }),
        toolPolicy: { ...this.deps.defaultToolPolicy, ...input.toolPolicy },
        ...(input.resumeState ? { resumeState: input.resumeState } : {}),
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

      const success = result.success && result.output?.status === "done";
      const hadApprovalDeniedError = result.commandResults.some((entry) =>
        /approval denied|user denied approval|requires approval/i.test(entry.outputSummary),
      );
      const fallbackOutput = success
        ? this.buildSuccessfulOutput(result.finalText, result.output)
        : this.buildFailureOutput(result.stopReason, hadApprovalDeniedError, result.finalText, result.output, result.output?.blockers);
      return {
        success,
        output: fallbackOutput,
        error: success ? null : result.output?.blockers.join("; ") || result.stopReason,
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
          completionEvidence: result.output?.evidence ?? [],
          verificationHints: result.output?.blockers ?? [],
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
    const formattedOutput = this.formatChatOutput(output);
    if (formattedOutput) return formattedOutput;
    const formatted = this.formatStructuredFinalText(finalText);
    if (formatted) return formatted;
    if (output?.message && output.message.trim().length > 0) return output.message.trim();
    if (finalText && finalText.trim().length > 0) return finalText.trim();
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

    const formattedOutput = this.formatChatOutput(output);
    if (formattedOutput) return formattedOutput;
    const formatted = this.formatStructuredFinalText(finalText);
    if (formatted) return formatted;
    if (blockers && blockers.length > 0) return blockers.join("; ");
    if (finalText && !/^Calling\s+/i.test(finalText.trim())) return finalText.trim();
    return `Interrupted: ${stopReason}`;
  }

  private formatChatOutput(output?: ChatAgentLoopOutput | null): string | null {
    if (!output) return null;

    const finalAnswer = output.finalAnswer;
    const summary = finalAnswer?.summary.trim() || output.message.trim();
    const sections: string[] = [];
    const handledKeys = new Set<string>(["status", "message", "evidence", "blockers", "finalAnswer"]);

    if (summary.length > 0) {
      sections.push(summary);
    }

    for (const section of finalAnswer?.sections ?? []) {
      const bullets = section.bullets.map((item) => item.trim()).filter((item) => item.length > 0);
      if (bullets.length === 0) continue;
      sections.push(`### ${section.title.trim()}\n${bullets.map((bullet) => `- ${bullet}`).join("\n")}`);
    }

    const evidence = [...new Set([
      ...(finalAnswer?.evidence ?? []),
      ...output.evidence,
    ].map((item) => item.trim()).filter((item) => item.length > 0))];
    if (evidence.length > 0) {
      sections.push(`### Evidence\n${evidence.map((item) => `- ${item}`).join("\n")}`);
    }

    const blockers = [...new Set([
      ...(finalAnswer?.blockers ?? []),
      ...output.blockers,
    ].map((item) => item.trim()).filter((item) => item.length > 0))];
    if (blockers.length > 0) {
      sections.push(`### Blockers\n${blockers.map((item) => `- ${item}`).join("\n")}`);
    }

    const nextActions = [
      ...(finalAnswer?.nextActions ?? []),
      ...(typeof finalAnswer?.nextAction === "string" ? [finalAnswer.nextAction] : []),
    ].map((item) => item.trim()).filter((item) => item.length > 0);
    if (nextActions.length > 0) {
      sections.push(`### Next steps\n${nextActions.map((item) => `- ${item}`).join("\n")}`);
    }

    for (const [key, fieldValue] of Object.entries(output)) {
      if (handledKeys.has(key) || !Array.isArray(fieldValue)) continue;
      const lines = fieldValue.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      if (lines.length === 0) continue;
      sections.push(`### ${this.humanizeFieldLabel(this.normalizeOutputFieldLabel(key))}\n${lines.map((line) => `- ${line}`).join("\n")}`);
    }

    for (const [key, fieldValue] of Object.entries(output)) {
      if (handledKeys.has(key) || typeof fieldValue !== "string") continue;
      const value = fieldValue.trim();
      if (!value) continue;
      if (key === "nextAction" || key === "next_action" || key === "nextStep" || key === "next_step") {
        sections.push(`### Next step\n- ${value}`);
      }
    }

    const rendered = sections.join("\n\n").trim();
    return rendered.length > 0 ? rendered : null;
  }

  private humanizeFieldLabel(key: string): string {
    return key
      .split(/[_\s-]+/g)
      .filter(Boolean)
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join(" ");
  }

  private normalizeOutputFieldLabel(key: string): string {
    switch (key) {
      case "steps":
        return "recommended_steps";
      case "files":
      case "relevantFiles":
        return "relevant_files";
      case "nextActions":
      case "next_actions":
        return "next_steps";
      default:
        return key;
    }
  }

  private formatStructuredFinalText(finalText: string): string | null {
    const raw = finalText?.trim();
    if (!raw) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const parsedOutput = ChatAgentLoopOutputSchema.safeParse(parsed);
    if (!parsedOutput.success) return null;
    return this.formatChatOutput(parsedOutput.data);
  }
}
