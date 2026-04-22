import type {
  ChatEvent,
  ToolEndEvent,
  ToolStartEvent,
  ToolUpdateEvent,
} from "./chat-events.js";

export interface StreamChatMessage {
  id: string;
  role: "user" | "pulseed";
  text: string;
  timestamp: Date;
  messageType?: "info" | "error" | "warning" | "success";
  transient?: boolean;
}

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
  const transientToolPrefix = `tool:${turnId}:`;
  return messages.filter((message) => {
    if (!message.transient) {
      return true;
    }
    return !(
      message.id === transientActivityId ||
      message.id.startsWith(transientToolPrefix)
    );
  });
}

function buildToolMessage(
  event: ToolStartEvent | ToolUpdateEvent | ToolEndEvent,
): StreamChatMessage {
  const id = `tool:${event.turnId}:${event.toolCallId}`;
  if (event.type === "tool_start") {
    return {
      id,
      role: "pulseed",
      text: `Running tool: ${event.toolName}`,
      timestamp: new Date(event.createdAt),
      messageType: "info",
      transient: true,
    };
  }

  if (event.type === "tool_update") {
    const transient = event.status !== "result";
    const messageType = event.status === "awaiting_approval" ? "warning" : "info";
    const text = event.status === "running" && event.message === "started"
      ? `Running tool: ${event.toolName}`
      : `${event.toolName}: ${event.message}`;
    return {
      id,
      role: "pulseed",
      text,
      timestamp: new Date(event.createdAt),
      messageType,
      transient,
    };
  }

  return {
    id,
    role: "pulseed",
    text: `${event.success ? "Finished" : "Failed"} tool: ${event.toolName}${event.summary ? ` - ${event.summary}` : ""}`,
    timestamp: new Date(event.createdAt),
    messageType: event.success ? "success" : "error",
  };
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
      id: `activity:${event.turnId}`,
      role: "pulseed",
      text: event.message,
      timestamp,
      messageType: "info",
      transient: event.transient === true,
    }, maxMessages);
  }

  if (event.type === "tool_start" || event.type === "tool_update" || event.type === "tool_end") {
    return upsertMessage(messages, buildToolMessage(event), maxMessages);
  }

  if (event.type === "lifecycle_error") {
    const next = removeTransientActivityForTurn(messages, event.turnId);
    const messageId = event.partialText ? event.turnId : `error:${event.runId}`;
    const text = event.partialText
      ? `${event.partialText}\n\n[interrupted: ${event.error}]`
      : `Error: ${event.error}`;
    return upsertMessage(next, {
      id: messageId,
      role: "pulseed",
      text,
      timestamp,
      messageType: "error",
    }, maxMessages);
  }

  if (event.type === "lifecycle_end") {
    return removeTransientActivityForTurn(messages, event.turnId);
  }

  return messages;
}
