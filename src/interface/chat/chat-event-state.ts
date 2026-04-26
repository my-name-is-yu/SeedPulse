import type { ChatEvent } from "./chat-events.js";
import { formatLifecycleFailureMessage } from "./failure-recovery.js";

type ToolActivityState = "reading" | "planning" | "editing" | "verifying" | "waiting" | "running" | "completed" | "failed";

interface StreamToolActivity {
  id: string;
  toolName: string;
  state: ToolActivityState;
  detail: string;
  timestamp: Date;
}

export interface StreamChatMessage {
  id: string;
  role: "user" | "pulseed";
  text: string;
  timestamp: Date;
  messageType?: "info" | "error" | "warning" | "success";
  transient?: boolean;
  toolActivities?: StreamToolActivity[];
}

const MAX_TOOL_ACTIVITIES = 5;

function upsertMessage(
  messages: StreamChatMessage[],
  nextMessage: StreamChatMessage,
  maxMessages: number
): StreamChatMessage[] {
  const next = [...messages];
  const index = next.findIndex((message) => message.id === nextMessage.id);
  if (index >= 0) {
    next[index] = nextMessage;
    return next;
  }
  return [...next, nextMessage].slice(-maxMessages);
}

function removeTransientActivityForTurn(
  messages: StreamChatMessage[],
  turnId: string
): StreamChatMessage[] {
  const transientActivityId = `activity:${turnId}`;
  return messages.filter((message) => !(message.id === transientActivityId && message.transient));
}

function getToolLogId(turnId: string): string {
  return `tool-log:${turnId}`;
}

function getActivityMessageId(event: Extract<ChatEvent, { type: "activity" }>): string {
  if (event.transient === false && event.sourceId) {
    return `activity:${event.turnId}:${event.sourceId}`;
  }
  return `activity:${event.turnId}`;
}

function summarizeValue(value: unknown): string {
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length > 0 ? `{${keys.slice(0, 3).join(", ")}}` : "{}";
  }
  return "";
}

function summarizeToolArgs(args: Record<string, unknown>): string {
  const priorityKeys = [
    "command",
    "cmd",
    "path",
    "file",
    "filename",
    "cwd",
    "pattern",
    "query",
    "url",
    "target",
    "plan_id",
  ];
  const entries = priorityKeys
    .filter((key) => Object.prototype.hasOwnProperty.call(args, key))
    .map((key) => {
      const value = summarizeValue(args[key]);
      return value ? `${key}=${value}` : "";
    })
    .filter(Boolean);
  if (entries.length > 0) return entries.slice(0, 2).join(", ");
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  return keys.slice(0, 3).map((key) => `${key}=${summarizeValue(args[key])}`).filter(Boolean).join(", ");
}

function classifyCommand(command: string): ToolActivityState {
  const normalized = command.trim().toLowerCase();
  if (/^(rg|grep|cat|sed|awk|ls|find|pwd|git (show|log|status|diff\b|grep))\b/.test(normalized)) {
    return "reading";
  }
  if (/(npm|pnpm|yarn|bun) (run )?(test|check|typecheck|lint|verify)\b|pytest\b|vitest\b|cargo test\b|go test\b/.test(normalized)) {
    return "verifying";
  }
  if (/^(apply_patch|git apply|python .*write|node .*write)\b/.test(normalized)) {
    return "editing";
  }
  return "running";
}

function classifyTool(toolName: string, args: Record<string, unknown>, status?: "awaiting_approval" | "running" | "result"): ToolActivityState {
  if (status === "awaiting_approval") return "waiting";
  const normalized = toolName.toLowerCase().replace(/[-_]/g, "");
  const command = typeof args["command"] === "string"
    ? args["command"]
    : typeof args["cmd"] === "string"
      ? args["cmd"]
      : null;
  if (command) return classifyCommand(command);
  if (normalized.includes("plan")) return "planning";
  if (normalized.includes("write") || normalized.includes("edit") || normalized.includes("patch") || normalized.includes("delete")) {
    return "editing";
  }
  if (normalized.includes("test") || normalized.includes("verify") || normalized.includes("check")) {
    return "verifying";
  }
  if (
    normalized.includes("read") ||
    normalized.includes("list") ||
    normalized.includes("search") ||
    normalized.includes("grep") ||
    normalized.includes("diff") ||
    normalized.includes("log") ||
    normalized.includes("status")
  ) {
    return "reading";
  }
  return "running";
}

function formatToolActivityState(state: ToolActivityState): string {
  switch (state) {
    case "reading":
      return "Reading";
    case "planning":
      return "Planning";
    case "editing":
      return "Editing";
    case "verifying":
      return "Verifying";
    case "waiting":
      return "Waiting for approval";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "running":
      return "Running";
  }
}

function renderToolActivityMessage(activities: StreamToolActivity[], current: boolean): string {
  const heading = current ? "Current activity" : "Recent activity";
  const lines = activities.map((activity) => {
    const detail = activity.detail ? ` - ${activity.detail}` : "";
    return `- ${formatToolActivityState(activity.state)} ${activity.toolName}${detail}`;
  });
  return [heading, ...lines].join("\n");
}

function closeToolActivityForTurn(messages: StreamChatMessage[], turnId: string): StreamChatMessage[] {
  const toolLogId = getToolLogId(turnId);
  return messages.map((message) => {
    if (message.id !== toolLogId || !message.toolActivities) return message;
    return {
      ...message,
      text: renderToolActivityMessage(message.toolActivities, false),
      transient: false,
    };
  });
}

function upsertToolActivity(
  messages: StreamChatMessage[],
  event: Extract<ChatEvent, { type: "tool_start" | "tool_update" | "tool_end" }>,
  maxMessages: number
): StreamChatMessage[] {
  const timestamp = new Date(event.createdAt);
  const toolLogId = getToolLogId(event.turnId);
  const previous = messages.find((message) => message.id === toolLogId);
  const previousActivities = previous?.toolActivities ?? [];
  const existing = previousActivities.find((activity) => activity.id === event.toolCallId);
  const args = event.type === "tool_start" ? event.args : {};
  const fallbackDetail = event.type === "tool_start"
    ? summarizeToolArgs(event.args)
    : event.type === "tool_update"
      ? (event.status === "running" ? existing?.detail ?? event.message : event.message)
      : event.summary;
  const detail = fallbackDetail || existing?.detail || "";
  const state = event.type === "tool_end"
    ? event.success ? "completed" : "failed"
    : event.type === "tool_update" && event.status !== "awaiting_approval" && existing && existing.state !== "waiting"
      ? existing.state
      : classifyTool(event.toolName, args, event.type === "tool_update" ? event.status : "running");
  const nextActivity: StreamToolActivity = {
    id: event.toolCallId,
    toolName: event.toolName,
    state,
    detail,
    timestamp,
  };
  const nextActivities = [
    ...previousActivities.filter((activity) => activity.id !== event.toolCallId),
    nextActivity,
  ].slice(-MAX_TOOL_ACTIVITIES);

  return upsertMessage(messages, {
    id: toolLogId,
    role: "pulseed",
    text: renderToolActivityMessage(nextActivities, true),
    timestamp,
    messageType: "info",
    toolActivities: nextActivities,
  }, maxMessages);
}

export function applyChatEventToMessages(
  messages: StreamChatMessage[],
  event: ChatEvent,
  maxMessages: number
): StreamChatMessage[] {
  const timestamp = new Date(event.createdAt);

  if (event.type === "assistant_delta") {
    return upsertMessage(messages, {
      id: event.turnId,
      role: "pulseed",
      text: event.text,
      timestamp,
      messageType: "info",
    }, maxMessages);
  }

  if (event.type === "assistant_final") {
    const next = removeTransientActivityForTurn(messages, event.turnId);
    return upsertMessage(next, {
      id: event.turnId,
      role: "pulseed",
      text: event.text,
      timestamp,
      messageType: event.persisted ? "info" : "warning",
    }, maxMessages);
  }

  if (event.type === "activity") {
    return upsertMessage(messages, {
      id: getActivityMessageId(event),
      role: "pulseed",
      text: event.message,
      timestamp,
      messageType: "info",
      transient: event.transient === true,
    }, maxMessages);
  }

  if (event.type === "lifecycle_error") {
    const next = closeToolActivityForTurn(removeTransientActivityForTurn(messages, event.turnId), event.turnId);
    const messageId = event.partialText ? event.turnId : `error:${event.runId}`;
    const text = formatLifecycleFailureMessage(event.error, event.partialText, event.recovery);
    return upsertMessage(next, {
      id: messageId,
      role: "pulseed",
      text,
      timestamp,
      messageType: "error",
    }, maxMessages);
  }

  if (event.type === "lifecycle_end") {
    return closeToolActivityForTurn(removeTransientActivityForTurn(messages, event.turnId), event.turnId);
  }

  if (event.type === "tool_start") {
    return upsertToolActivity(messages, event, maxMessages);
  }

  if (event.type === "tool_update") {
    return upsertToolActivity(messages, event, maxMessages);
  }

  if (event.type === "tool_end") {
    return upsertToolActivity(messages, event, maxMessages);
  }

  return messages;
}
