import type { ChatEventHandler } from "../../interface/chat/chat-events.js";
import { getGlobalCrossPlatformChatSessionManager } from "../../interface/chat/cross-platform-session.js";

export interface GatewayChatDispatchInput {
  text: string;
  platform: string;
  identity_key?: string;
  conversation_id: string;
  sender_id: string;
  message_id?: string;
  goal_id?: string;
  cwd?: string;
  metadata?: Record<string, unknown>;
  onEvent?: ChatEventHandler;
}

export async function dispatchGatewayChatInput(
  input: GatewayChatDispatchInput
): Promise<string | null> {
  try {
    const manager = await getGlobalCrossPlatformChatSessionManager();
    const result = await manager.processIncomingMessage({
      text: input.text,
      platform: input.platform,
      identity_key: input.identity_key,
      conversation_id: input.conversation_id,
      sender_id: input.sender_id,
      message_id: input.message_id,
      goal_id: input.goal_id,
      cwd: input.cwd,
      metadata: input.metadata,
      onEvent: input.onEvent,
    });
    return normalizeManagerResult(result);
  } catch {
    return null;
  }
}

function normalizeManagerResult(result: unknown): string | null {
  if (typeof result === "string") {
    const trimmed = result.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof result === "object" && result !== null) {
    const record = result as Record<string, unknown>;
    for (const key of ["text", "message"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
  }
  return null;
}
