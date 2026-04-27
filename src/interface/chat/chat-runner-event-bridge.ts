import type { ActivityKind, ChatEvent, ChatEventContext } from "./chat-events.js";
import type {
  AgentLoopEvent,
  AgentLoopEventSink,
} from "../../orchestrator/execution/agent-loop/agent-loop-events.js";
import {
  DIFF_ARTIFACT_MAX_LINES,
  formatIntentInput,
  formatToolActivity,
  previewActivityText,
  type GitDiffArtifact,
} from "./chat-runner-support.js";
import { classifyFailureRecovery, formatLifecycleFailureMessage } from "./failure-recovery.js";

export interface AssistantBuffer {
  text: string;
}

export interface ActiveChatTurn {
  context: ChatEventContext;
  cwd: string;
  startedAt: number;
  abortController: AbortController;
  finished: Promise<void>;
  resolveFinished: () => void;
  recentEvents: string[];
  interruptRequested: boolean;
}

export class ChatRunnerEventBridge {
  private activeTurn: ActiveChatTurn | null = null;

  constructor(
    private readonly onEventGetter: () => ((event: ChatEvent) => void) | undefined,
  ) {}

  hasActiveTurn(): boolean {
    return this.activeTurn !== null;
  }

  getActiveTurn(): ActiveChatTurn | null {
    return this.activeTurn;
  }

  createEventContext(): ChatEventContext {
    return {
      runId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
    };
  }

  eventBase(context: ChatEventContext): ChatEventContext & { createdAt: string } {
    return { ...context, createdAt: new Date().toISOString() };
  }

  beginActiveTurn(context: ChatEventContext, cwd: string): ActiveChatTurn {
    let resolveFinished: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const turn: ActiveChatTurn = {
      context,
      cwd,
      startedAt: Date.now(),
      abortController: new AbortController(),
      finished,
      resolveFinished,
      recentEvents: [],
      interruptRequested: false,
    };
    this.activeTurn = turn;
    return turn;
  }

  finishActiveTurn(context: ChatEventContext): void {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.context.runId !== context.runId) return;
    activeTurn.resolveFinished();
    this.activeTurn = null;
  }

  waitForActiveTurn(turn: ActiveChatTurn, timeoutMs: number): Promise<boolean> {
    return Promise.race([
      turn.finished.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  emitEphemeralAssistantResult(input: string, output: string, success: boolean, start: number): {
    success: boolean;
    output: string;
    elapsed_ms: number;
  } {
    const context = this.createEventContext();
    this.emitEvent({
      type: "lifecycle_start",
      input,
      ...this.eventBase(context),
    });
    this.emitEvent({
      type: "assistant_final",
      text: output,
      persisted: false,
      ...this.eventBase(context),
    });
    const elapsed_ms = Date.now() - start;
    this.emitLifecycleEndEvent(success ? "completed" : "error", elapsed_ms, context, false);
    return { success, output, elapsed_ms };
  }

  createAgentLoopEventSink(eventContext: ChatEventContext): AgentLoopEventSink {
    return {
      emit: async (event: AgentLoopEvent) => {
        if (event.type === "tool_call_started") {
          const detail = event.inputPreview ? previewActivityText(event.inputPreview) : undefined;
          this.emitActivity("tool", formatToolActivity("Running", event.toolName, detail), eventContext, event.callId);
          this.emitEvent({
            type: "tool_start",
            toolCallId: event.callId,
            toolName: event.toolName,
            args: this.parseAgentLoopPreview(event.inputPreview),
            ...this.eventBase(eventContext),
          });
          this.emitEvent({
            type: "tool_update",
            toolCallId: event.callId,
            toolName: event.toolName,
            status: "running",
            message: "started",
            ...this.eventBase(eventContext),
          });
          return;
        }

        if (event.type === "tool_call_finished") {
          this.emitActivity(
            "tool",
            formatToolActivity(event.success ? "Finished" : "Failed", event.toolName, event.outputPreview),
            eventContext,
            event.callId
          );
          this.emitEvent({
            type: "tool_end",
            toolCallId: event.callId,
            toolName: event.toolName,
            success: event.success,
            summary: event.outputPreview,
            durationMs: event.durationMs,
            ...this.eventBase(eventContext),
          });
          return;
        }

        if (event.type === "assistant_message" && event.phase === "commentary" && event.contentPreview) {
          this.emitActivity("commentary", previewActivityText(event.contentPreview, 120), eventContext, `commentary:${event.eventId}`);
          return;
        }

        if (event.type === "plan_update") {
          this.emitActivity("tool", `Updated plan: ${previewActivityText(event.summary)}`, eventContext, `plan:${event.turnId}`);
          this.emitCheckpoint("Plan updated", previewActivityText(event.summary, 160), eventContext, `plan:${event.eventId}`);
          this.emitEvent({
            type: "tool_update",
            toolCallId: `plan:${event.turnId}:${event.createdAt}`,
            toolName: "update_plan",
            status: "result",
            message: event.summary,
            ...this.eventBase(eventContext),
          });
          return;
        }

        if (event.type === "approval_request") {
          this.emitActivity("tool", formatToolActivity("Running", event.toolName, `awaiting approval: ${event.reason}`), eventContext, event.callId);
          this.emitCheckpoint("Approval requested", `${event.toolName}: ${event.reason}`, eventContext, `approval:${event.callId}`);
          this.emitEvent({
            type: "tool_update",
            toolCallId: event.callId,
            toolName: event.toolName,
            status: "awaiting_approval",
            message: event.reason,
            ...this.eventBase(eventContext),
          });
          return;
        }

        if (event.type === "approval") {
          this.emitActivity("tool", formatToolActivity("Finished", event.toolName, `approval ${event.status}: ${event.reason}`), eventContext);
          this.emitEvent({
            type: "tool_update",
            toolCallId: `approval:${event.turnId}:${event.createdAt}`,
            toolName: event.toolName,
            status: "result",
            message: `approval ${event.status}: ${event.reason}`,
            ...this.eventBase(eventContext),
          });
          return;
        }

        if (event.type === "resumed") {
          this.emitEvent({
            type: "tool_update",
            toolCallId: `resume:${event.turnId}:${event.createdAt}`,
            toolName: "agentloop_resume",
            status: "result",
            message: `resumed ${event.restoredMessages} message(s) from ${event.fromUpdatedAt}`,
            ...this.eventBase(eventContext),
          });
          return;
        }

        if (event.type === "context_compaction") {
          this.emitEvent({
            type: "tool_update",
            toolCallId: `compaction:${event.turnId}:${event.createdAt}`,
            toolName: "context_compaction",
            status: "result",
            message: `${event.phase} ${event.reason}: ${event.inputMessages} -> ${event.outputMessages}`,
            ...this.eventBase(eventContext),
          });
        }
      },
    };
  }

  emitEvent(event: ChatEvent): void {
    this.rememberActiveTurnEvent(event);
    this.onEventGetter()?.(event);
  }

  emitActivity(
    kind: ActivityKind,
    message: string,
    eventContext: ChatEventContext,
    sourceId?: string,
    transient = true
  ): void {
    if (!message.trim()) return;
    this.emitEvent({
      type: "activity",
      kind,
      message,
      ...(sourceId ? { sourceId } : {}),
      transient,
      ...this.eventBase(eventContext),
    });
  }

  emitIntent(
    input: string,
    selectedRoute: { kind: string; reason?: string; intent?: { kind: string } } | null,
    eventContext: ChatEventContext
  ): void {
    const subject = formatIntentInput(input);
    let nextStep = "resume the saved agent loop state before continuing.";
    let reason = "resume needs the prior runtime context before any further action.";
    if (selectedRoute?.kind === "runtime_control" && selectedRoute.intent) {
      nextStep = `prepare the ${selectedRoute.intent.kind} runtime-control request.`;
      reason = "runtime changes need an explicit operation plan and approval path.";
    } else if (selectedRoute?.kind === "agent_loop") {
      nextStep = "gather workspace context, then let the agent loop inspect or change files with visible tool activity.";
      reason = "this request may require multiple tool-backed steps.";
    } else if (selectedRoute?.kind === "tool_loop") {
      nextStep = "call the model with the tool catalog, then execute selected tools with visible activity.";
      reason = "the available tools are needed to answer from current project state.";
    } else if (selectedRoute?.kind === "adapter") {
      nextStep = "prepare project context before handing the turn to the configured adapter.";
      reason = "the adapter needs the current workspace context to act correctly.";
    }
    const message = [
      "Intent",
      `- Confirm: ${subject || "the current request"}`,
      `- Next: ${nextStep}`,
      `- Why: ${reason}`,
    ].join("\n");
    this.emitActivity("commentary", message, eventContext, "intent:first-step", false);
  }

  emitCheckpoint(
    title: string,
    detail: string,
    eventContext: ChatEventContext,
    sourceKey: string
  ): void {
    const message = detail
      ? `Checkpoint\n- ${title}: ${detail}`
      : `Checkpoint\n- ${title}`;
    this.emitActivity("checkpoint", message, eventContext, `checkpoint:${sourceKey}`, false);
  }

  emitDiffArtifact(
    artifact: GitDiffArtifact,
    eventContext: ChatEventContext
  ): void {
    const sections = [
      "Changed files",
      "",
      "Modified files",
      artifact.nameStatus || artifact.stat,
      "",
      "Diff summary",
      artifact.stat,
      "",
      "Inline patch",
      "```diff",
      artifact.patch || "(patch unavailable)",
      artifact.truncated ? `... truncated after ${DIFF_ARTIFACT_MAX_LINES} lines; run /review for the full diff.` : "",
      "```",
      "",
      "Files inspected are shown separately in the activity log.",
    ].filter((line) => line !== "").join("\n");
    this.emitActivity("diff", sections, eventContext, "diff:working-tree", false);
  }

  pushAssistantDelta(
    delta: string,
    assistantBuffer: AssistantBuffer,
    eventContext: ChatEventContext
  ): void {
    if (!delta) return;
    assistantBuffer.text += delta;
    this.emitEvent({
      type: "assistant_delta",
      delta,
      text: assistantBuffer.text,
      ...this.eventBase(eventContext),
    });
  }

  emitLifecycleEndEvent(
    status: "completed" | "error",
    elapsedMs: number,
    eventContext: ChatEventContext,
    persisted: boolean
  ): void {
    this.emitEvent({
      type: "lifecycle_end",
      status,
      elapsedMs,
      persisted,
      ...this.eventBase(eventContext),
    });
    this.finishActiveTurn(eventContext);
  }

  emitLifecycleErrorEvent(
    error: string,
    partialText: string,
    eventContext: ChatEventContext
  ): string {
    const recovery = classifyFailureRecovery(error);
    this.emitEvent({
      type: "lifecycle_error",
      error,
      partialText,
      persisted: false,
      recovery,
      ...this.eventBase(eventContext),
    });
    return formatLifecycleFailureMessage(error, partialText, recovery);
  }

  private rememberActiveTurnEvent(event: ChatEvent): void {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.context.turnId !== event.turnId) return;
    let summary: string | null = null;
    if (event.type === "activity") {
      summary = previewActivityText(event.message, 140);
    } else if (event.type === "tool_start") {
      summary = `Started ${event.toolName}`;
    } else if (event.type === "tool_update") {
      summary = `${event.toolName}: ${previewActivityText(event.message, 100)}`;
    } else if (event.type === "tool_end") {
      summary = `${event.success ? "Finished" : "Failed"} ${event.toolName}: ${previewActivityText(event.summary, 100)}`;
    }
    if (!summary) return;
    activeTurn.recentEvents = [...activeTurn.recentEvents, summary].slice(-12);
  }

  private parseAgentLoopPreview(preview: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(preview) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
    return preview ? { preview } : {};
  }
}
