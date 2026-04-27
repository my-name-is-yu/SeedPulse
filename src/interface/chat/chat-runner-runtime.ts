import type { ChatSession } from "./chat-history.js";
import {
  buildStandaloneIngressMessage,
  type ChatIngressMessage,
  type IngressReplyTarget,
  type SelectedChatRoute,
} from "./ingress-router.js";
import { createRuntimeSessionRegistry } from "../../runtime/session-registry/index.js";
import type {
  BackgroundRun,
  RuntimeSession,
  RuntimeSessionRegistrySnapshot,
  RuntimeSessionRegistryWarning,
} from "../../runtime/session-registry/types.js";
import type { RuntimeControlActor, RuntimeControlReplyTarget } from "../../runtime/store/runtime-operation-schemas.js";
import type { RuntimeControlChatContext } from "./chat-runner.js";
import type { LoadedChatSession } from "./chat-session-store.js";
import type { StateManager } from "../../base/state/state-manager.js";

export interface ChatRunnerRuntimeDeps {
  llmClient?: unknown;
  chatAgentLoopRunner?: unknown;
  runtimeControlService?: unknown;
  runtimeReplyTarget?: RuntimeControlReplyTarget;
  runtimeControlActor?: RuntimeControlActor;
  runtimeControlApprovalFn?: (description: string) => Promise<boolean>;
  approvalFn?: (description: string) => Promise<boolean>;
  stateManager: {
    readRaw(path: string): Promise<unknown>;
  };
}

export function loadedSessionToChatSession(session: LoadedChatSession): ChatSession {
  return {
    id: session.id,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: [...session.messages],
    ...(session.compactionSummary ? { compactionSummary: session.compactionSummary } : {}),
    ...(session.title ? { title: session.title } : {}),
    ...(session.agentLoopStatePath ? { agentLoopStatePath: session.agentLoopStatePath } : {}),
    ...(session.agentLoopStatus === "running" || session.agentLoopStatus === "completed" || session.agentLoopStatus === "failed"
      ? { agentLoopStatus: session.agentLoopStatus }
      : {}),
    ...(session.agentLoopResumable ? { agentLoopResumable: true } : {}),
    ...(session.agentLoopUpdatedAt ? { agentLoopUpdatedAt: session.agentLoopUpdatedAt } : {}),
    ...(session.agentLoop ? { agentLoop: session.agentLoop } : {}),
  };
}

export function getRouteCapabilities(deps: ChatRunnerRuntimeDeps): {
  hasAgentLoop: boolean;
  hasToolLoop: boolean;
  hasRuntimeControlService: boolean;
} {
  return {
    hasAgentLoop: deps.chatAgentLoopRunner !== undefined,
    hasToolLoop: deps.llmClient !== undefined,
    hasRuntimeControlService: deps.runtimeControlService !== undefined,
  };
}

export function buildStandaloneIngressMessageFromContext(
  input: string,
  runtimeControlContext: RuntimeControlChatContext | null,
  deps: ChatRunnerRuntimeDeps
): ChatIngressMessage {
  const channel = runtimeControlContext?.replyTarget?.surface === "tui"
    ? "tui"
    : runtimeControlContext?.replyTarget?.surface === "cli"
      ? "cli"
      : runtimeControlContext?.replyTarget?.surface === "gateway"
        ? "plugin_gateway"
        : "cli";
  const replyTarget = runtimeControlContext?.replyTarget ?? deps.runtimeReplyTarget;
  const replyTargetInput: Partial<IngressReplyTarget> | undefined = replyTarget
    ? {
        ...(replyTarget.surface ? { surface: replyTarget.surface } : {}),
        channel,
        ...(replyTarget.platform ? { platform: replyTarget.platform } : {}),
        ...(replyTarget.conversation_id ? { conversation_id: replyTarget.conversation_id } : {}),
        ...(replyTarget.message_id ? { message_id: replyTarget.message_id } : {}),
        ...(replyTarget.response_channel ? { response_channel: replyTarget.response_channel } : {}),
        ...(replyTarget.outbox_topic ? { outbox_topic: replyTarget.outbox_topic } : {}),
        ...(replyTarget.identity_key ? { identity_key: replyTarget.identity_key } : {}),
        ...(replyTarget.user_id ? { user_id: replyTarget.user_id } : {}),
        ...(replyTarget.deliveryMode === "reply" || replyTarget.deliveryMode === "notify" || replyTarget.deliveryMode === "thread_reply"
          ? { deliveryMode: replyTarget.deliveryMode }
          : {}),
        ...(replyTarget.metadata ? { metadata: replyTarget.metadata } : {}),
      }
    : undefined;
  return buildStandaloneIngressMessage({
    text: input,
    channel,
    platform: runtimeControlContext?.replyTarget?.platform ?? deps.runtimeReplyTarget?.platform,
    identity_key: runtimeControlContext?.replyTarget?.identity_key ?? deps.runtimeReplyTarget?.identity_key,
    conversation_id: runtimeControlContext?.replyTarget?.conversation_id ?? deps.runtimeReplyTarget?.conversation_id,
    user_id: runtimeControlContext?.replyTarget?.user_id ?? deps.runtimeReplyTarget?.user_id,
    actor: runtimeControlContext?.actor ?? deps.runtimeControlActor,
    replyTarget: replyTargetInput,
    runtimeControl: {
      allowed: true,
      approvalMode: "interactive",
    },
  });
}

export function buildRuntimeControlContextFromIngress(
  ingress: ChatIngressMessage,
  currentContext: RuntimeControlChatContext | null,
  deps: ChatRunnerRuntimeDeps
): RuntimeControlChatContext | null {
  if (!ingress.actor && !ingress.replyTarget) return null;
  const interactiveApproval =
    currentContext?.approvalFn
    ?? deps.runtimeControlApprovalFn
    ?? deps.approvalFn;
  return {
    actor: ingress.actor,
    replyTarget: ingress.replyTarget,
    approvalFn: ingress.runtimeControl.approvalMode === "preapproved"
      ? async () => true
      : ingress.runtimeControl.approvalMode === "interactive"
        ? interactiveApproval
        : undefined,
  };
}

export function formatRoute(route: SelectedChatRoute | null): string {
  if (!route) return "none selected yet";
  const details = [
    `kind=${route.kind}`,
    `reason=${route.reason}`,
  ];
  if (route.kind === "runtime_control") {
    details.push(`intent=${route.intent.kind}`);
  }
  return details.join(", ");
}

export async function resolveChatResumeSelector(
  selector: string,
  deps: { stateManager: StateManager }
): Promise<{
  chatSelector: string;
  nonResumableMessage?: string;
}> {
  if (selector.startsWith("session:conversation:")) {
    return { chatSelector: selector.slice("session:conversation:".length) };
  }

  if (selector.startsWith("session:") || selector.startsWith("run:")) {
    const registry = createRuntimeSessionRegistry({ stateManager: deps.stateManager });
    if (selector.startsWith("session:")) {
      const session = await registry.getSession(selector);
      if (session?.kind === "conversation") {
        return { chatSelector: selector.slice("session:conversation:".length) };
      }
      if (
        session?.kind === "agent"
        && session.resumable
        && session.parent_session_id?.startsWith("session:conversation:")
      ) {
        return { chatSelector: session.parent_session_id.slice("session:conversation:".length) };
      }
      return {
        chatSelector: selector,
        nonResumableMessage: `Runtime session ${selector} is not chat-resumable. Inspect it with 'pulseed runtime session ${selector}'.`,
      };
    }

    return {
      chatSelector: selector,
      nonResumableMessage: `Background run ${selector} is not chat-resumable. Inspect it with 'pulseed runtime run ${selector}'.`,
    };
  }

  return { chatSelector: selector };
}

function formatRuntimeTimestamp(value: string | null | undefined): string {
  return value ?? "unknown";
}

function formatRuntimeTitle(value: string | null | undefined): string {
  return value ? ` "${value}"` : "";
}

function runtimeWarningLine(warnings: RuntimeSessionRegistryWarning[]): string | null {
  return warnings.length > 0 ? `Warnings: ${warnings.length}` : null;
}

function activeRuntimeSession(session: RuntimeSession): boolean {
  return session.status === "active";
}

function statusRuntimeRun(run: BackgroundRun): boolean {
  return run.status === "queued"
    || run.status === "running"
    || run.status === "failed"
    || run.status === "timed_out"
    || run.status === "lost";
}

function compactRunLine(run: BackgroundRun): string {
  const title = formatRuntimeTitle(run.title);
  const updated = formatRuntimeTimestamp(run.updated_at ?? run.started_at ?? run.created_at);
  const summary = run.summary ? ` - ${run.summary.replace(/\s+/g, " ").trim()}` : "";
  const error = run.error ? ` - error: ${run.error.replace(/\s+/g, " ").trim()}` : "";
  return `- ${run.id}${title} [${run.kind}, ${run.status}], updated ${updated}${summary}${error}`;
}

function compactSessionLine(session: RuntimeSession): string {
  const displayId = session.kind === "conversation"
    ? session.transcript_ref?.id ?? session.id.replace(/^session:conversation:/, "")
    : session.id;
  const title = formatRuntimeTitle(session.title);
  const updated = formatRuntimeTimestamp(session.updated_at ?? session.last_event_at ?? session.created_at);
  const workspace = session.workspace ? `, cwd ${session.workspace}` : "";
  const resumable = session.resumable ? ", resumable" : "";
  const attachable = session.attachable ? ", attachable" : "";
  const runtimeId = displayId === session.id ? "" : `, runtime ${session.id}`;
  return `- ${displayId}${title} [${session.kind}, ${session.status}], updated ${updated}${workspace}${resumable}${attachable}${runtimeId}`;
}

export function formatRuntimeSessionsList(snapshot: RuntimeSessionRegistrySnapshot): string {
  const chatSessions = snapshot.sessions.filter((session) => session.kind === "conversation");
  const nonChatSessions = snapshot.sessions.filter((session) => session.kind !== "conversation");
  const lines: string[] = ["Chat sessions:"];

  if (chatSessions.length === 0) {
    lines.push("No chat sessions found.");
  } else {
    for (const session of chatSessions) {
      lines.push(compactSessionLine(session));
      const runs = snapshot.background_runs.filter((run) => run.parent_session_id === session.id);
      for (const run of runs) {
        lines.push(`  ${compactRunLine(run)}`);
      }
    }
  }

  if (nonChatSessions.length > 0) {
    lines.push("", "Other runtime sessions:");
    lines.push(...nonChatSessions.map((session) => compactSessionLine(session)));
  }

  if (snapshot.background_runs.length > 0) {
    lines.push("", "Background runs:");
    lines.push(...snapshot.background_runs.map((run) => compactRunLine(run)));
  }

  const warningLine = runtimeWarningLine(snapshot.warnings);
  if (warningLine) lines.push("", warningLine);
  return lines.join("\n");
}

export function formatRuntimeStatus(snapshot: RuntimeSessionRegistrySnapshot): string {
  const activeSessions = snapshot.sessions.filter((session) => activeRuntimeSession(session));
  const statusRuns = snapshot.background_runs.filter((run) => statusRuntimeRun(run));
  const lines: string[] = [];

  if (activeSessions.length > 0) {
    lines.push("Active runtime sessions:");
    lines.push(...activeSessions.map((session) => compactSessionLine(session)));
  }

  if (statusRuns.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Background runs (queued/running/attention-needed):");
    lines.push(...statusRuns.map((run) => compactRunLine(run)));
  }

  const warningLine = runtimeWarningLine(snapshot.warnings);
  if (warningLine) {
    if (lines.length > 0) lines.push("");
    lines.push(warningLine);
  }

  return lines.length > 0 ? lines.join("\n") : "No active runtime sessions or running/failed/lost background runs found.";
}
