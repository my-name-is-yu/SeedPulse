import { createHmac, timingSafeEqual } from "crypto";
import type { ChannelAdapter, EnvelopeHandler } from "./channel-adapter.js";
import { createEnvelope } from "../types/envelope.js";
import {
  evaluateChannelAccess,
  resolveChannelRoute,
  type ChannelAccessPolicy,
  type ChannelRoutingPolicy,
} from "./channel-policy.js";
import { dispatchGatewayChatInput } from "./chat-session-dispatch.js";

export interface SlackChannelAdapterConfig {
  signingSecret: string;
  /** Optional bot token used to send chat replies back to Slack channels. */
  botToken?: string;
  /** Optional: map Slack channel IDs to PulSeed goal IDs */
  channelGoalMap?: Record<string, string>;
  security?: ChannelAccessPolicy;
  routing?: ChannelRoutingPolicy;
}

export interface SlackResponse {
  status: number;
  body: string;
}

/** Maximum age of a Slack request timestamp (5 minutes in seconds) */
const MAX_TIMESTAMP_AGE_SEC = 5 * 60;

/**
 * SlackChannelAdapter receives events from the Slack Events API.
 *
 * This adapter is passive — it does NOT create its own HTTP server.
 * Wire `handleRequest()` into your existing HTTP server's route handler.
 *
 * Outbound Slack notifications are handled by `src/runtime/channels/slack-channel.ts`.
 */
export class SlackChannelAdapter implements ChannelAdapter {
  readonly name = "slack";
  private handler: EnvelopeHandler | null = null;
  private readonly config: SlackChannelAdapterConfig;
  private readonly api: SlackAPI | null;

  constructor(config: SlackChannelAdapterConfig) {
    this.config = config;
    this.api = config.botToken ? new SlackAPI(config.botToken) : null;
  }

  onEnvelope(handler: EnvelopeHandler): void {
    this.handler = handler;
  }

  /** No-op: adapter is driven by external HTTP server */
  async start(): Promise<void> {}

  /** No-op: no resources to release */
  async stop(): Promise<void> {}

  /**
   * Handle a raw Slack Events API HTTP request.
   * Call this from your HTTP server's POST route handler.
   *
   * @param body - Raw request body string
   * @param headers - Request headers (lowercase keys expected)
   * @returns HTTP response to send back to Slack
   */
  handleRequest(body: string, headers: Record<string, string>): SlackResponse {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return { status: 400, body: "invalid json" };
    }

    // Signature verification for ALL requests (including url_verification)
    const sigResult = this.verifySignature(body, headers);
    if (sigResult !== null) {
      return sigResult;
    }

    // URL Verification Challenge
    if (parsed["type"] === "url_verification") {
      const challenge = parsed["challenge"];
      return {
        status: 200,
        body: JSON.stringify({ challenge }),
      };
    }

    // Event callback
    if (parsed["type"] === "event_callback") {
      return this.handleEventCallback(parsed);
    }

    return { status: 200, body: "ok" };
  }

  /**
   * Verify Slack request signature.
   * Returns a SlackResponse on failure, null on success.
   */
  private verifySignature(
    body: string,
    headers: Record<string, string>
  ): SlackResponse | null {
    const timestamp = headers["x-slack-request-timestamp"];
    const signature = headers["x-slack-signature"];

    if (!timestamp || !signature) {
      return { status: 401, body: "missing signature headers" };
    }

    // Replay attack prevention
    const nowSec = Math.floor(Date.now() / 1000);
    const requestSec = parseInt(timestamp, 10);
    if (isNaN(requestSec) || Math.abs(nowSec - requestSec) > MAX_TIMESTAMP_AGE_SEC) {
      return { status: 401, body: "stale timestamp" };
    }

    // Compute expected signature
    const sigBase = `v0:${timestamp}:${body}`;
    const mac = createHmac("sha256", this.config.signingSecret)
      .update(sigBase)
      .digest("hex");
    const expected = `v0=${mac}`;

    // Reject immediately if lengths differ (Slack signatures are always 67 bytes: "v0=" + 64 hex chars).
    // Length check first means timingSafeEqual won't throw, and reveals no secret information
    // because the expected length is fixed regardless of the signing secret.
    if (signature.length !== expected.length) {
      return { status: 401, body: "invalid signature" };
    }
    const expectedBuf = Buffer.from(expected, "utf8");
    const actualBuf = Buffer.from(signature, "utf8");
    if (!timingSafeEqual(expectedBuf, actualBuf)) {
      return { status: 401, body: "invalid signature" };
    }

    return null;
  }

  private handleEventCallback(parsed: Record<string, unknown>): SlackResponse {
    const slackEvent = parsed["event"] as Record<string, unknown> | undefined;
    if (!slackEvent) {
      return { status: 400, body: "missing event field" };
    }

    const slackChannelId = slackEvent["channel"] as string | undefined;
    const userId = slackEvent["user"] as string | undefined;
    const context = {
      platform: "slack",
      senderId: userId,
      conversationId: slackChannelId,
      channelId: slackChannelId,
    };
    const access = evaluateChannelAccess(this.config.security, context);
    if (!access.allowed) {
      return { status: 403, body: access.reason ?? "forbidden" };
    }
    const route = resolveChannelRoute(
      {
        ...this.config.routing,
        channelGoalMap: {
          ...(this.config.channelGoalMap ?? {}),
          ...(this.config.routing?.channelGoalMap ?? {}),
        },
      },
      context
    );

    const eventType = String(slackEvent["type"] ?? "slack_event");
    const metadata = {
      ...route.metadata,
      slack_team_id: parsed["team_id"],
      slack_event_id: parsed["event_id"],
      ...(route.goalId ? { goal_id: route.goalId } : {}),
      ...(access.runtimeControlApproved ? { runtime_control_approved: true } : {}),
    };

    if (isSlackChatTextEvent(slackEvent, eventType) && this.api) {
      void this.dispatchSlackChat({
        text: slackEvent["text"].trim(),
        channel: slackEvent["channel"],
        user: slackEvent["user"],
        messageId: typeof slackEvent["ts"] === "string"
          ? slackEvent["ts"]
          : parsed["event_id"] as string | undefined,
        identityKey: route.identityKey,
        goalId: route.goalId,
        metadata,
      }).catch((err: unknown) => {
        console.warn("SlackChannelAdapter: chat dispatch failed", err);
      });
      return { status: 200, body: "ok" };
    }

    if (!this.handler) {
      console.warn("SlackChannelAdapter: no handler registered, dropping event");
      return { status: 200, body: "ok" };
    }

    const envelope = createEnvelope({
      type: "event",
      name: eventType,
      source: "slack",
      goal_id: route.goalId,
      priority: "normal",
      payload: slackEvent,
      dedupe_key: parsed["event_id"] as string | undefined,
      auth: userId ? { principal: userId } : undefined,
    });

    // Attach Slack-specific metadata via a plain property merge (envelope is a plain object)
    (envelope as Record<string, unknown>)["metadata"] = metadata;

    this.handler(envelope);

    return { status: 200, body: "ok" };
  }

  private async dispatchSlackChat(input: {
    text: string;
    channel: string;
    user: string;
    messageId?: string;
    identityKey?: string;
    goalId?: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    let sentAssistantOutput = false;
    const sendReply = async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed || sentAssistantOutput || !this.api) return;
      sentAssistantOutput = true;
      await this.api.postMessage(input.channel, trimmed, input.messageId);
    };

    const reply = await dispatchGatewayChatInput({
      text: input.text,
      platform: "slack",
      identity_key: input.identityKey,
      conversation_id: input.channel,
      sender_id: input.user,
      message_id: input.messageId,
      goal_id: input.goalId,
      cwd: process.cwd(),
      onEvent: (event) => {
        if (event.type === "assistant_final") {
          void sendReply(event.text).catch((err: unknown) => {
            console.warn("SlackChannelAdapter: failed to send assistant event", err);
          });
        }
      },
      metadata: input.metadata,
    });
    if (reply) {
      await sendReply(reply);
    }
  }
}

class SlackAPI {
  constructor(private readonly botToken: string) {}

  async postMessage(channel: string, text: string, threadTs?: string): Promise<void> {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`slack-api: chat.postMessage returned ${response.status}: ${body}`);
    }
    const json = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (json.ok === false) {
      throw new Error(`slack-api: chat.postMessage failed: ${json.error ?? "unknown error"}`);
    }
  }
}

function isSlackChatTextEvent(
  slackEvent: Record<string, unknown>,
  eventType: string
): slackEvent is Record<string, unknown> & { text: string; channel: string; user: string } {
  if (eventType !== "message" && eventType !== "app_mention") {
    return false;
  }
  if (typeof slackEvent["text"] !== "string" || slackEvent["text"].trim().length === 0) {
    return false;
  }
  if (typeof slackEvent["channel"] !== "string" || slackEvent["channel"].trim().length === 0) {
    return false;
  }
  if (typeof slackEvent["user"] !== "string" || slackEvent["user"].trim().length === 0) {
    return false;
  }
  return typeof slackEvent["bot_id"] !== "string" && slackEvent["subtype"] !== "bot_message";
}
