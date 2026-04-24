import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { createHash, webcrypto } from "node:crypto";
import type { ChannelAdapter, EnvelopeHandler } from "./channel-adapter.js";
import { dispatchGatewayChatInput } from "./chat-session-dispatch.js";
import { formatPlaintextNotification, supportsCoreGatewayNotification } from "./core-channel-notification.js";
import { evaluateChannelAccess, resolveChannelRoute } from "./channel-policy.js";
import type { INotifier, NotificationEvent, NotificationEventType } from "../../base/types/plugin.js";

const MAX_DISCORD_ACTIVITY_MESSAGES = 8;
const MAX_DISCORD_ACTIVITY_CHARS = 300;

interface DiscordInteractionOption {
  name: string;
  value?: unknown;
}

interface DiscordInteractionPayload {
  id?: string;
  type?: number;
  token?: string;
  application_id?: string;
  channel_id?: string;
  guild_id?: string;
  member?: {
    user?: {
      id?: string;
    };
  };
  user?: {
    id?: string;
  };
  data?: {
    name?: string;
    options?: DiscordInteractionOption[];
  };
}

interface ActivityChatEvent {
  type: "activity";
  kind: "lifecycle" | "commentary" | "tool" | "plugin" | "skill";
  message: string;
}

export interface DiscordGatewayConfig {
  application_id: string;
  public_key_hex?: string;
  bot_token: string;
  channel_id: string;
  identity_key: string;
  allowed_sender_ids: string[];
  denied_sender_ids: string[];
  allowed_conversation_ids: string[];
  denied_conversation_ids: string[];
  runtime_control_allowed_sender_ids: string[];
  conversation_goal_map: Record<string, string>;
  sender_goal_map: Record<string, string>;
  default_goal_id?: string;
  command_name: string;
  host: string;
  port: number;
  ephemeral: boolean;
}

export class DiscordGatewayNotifier implements INotifier {
  readonly name = "discord-bot";

  constructor(
    private readonly api: DiscordAPI,
    private readonly config: DiscordGatewayConfig
  ) {}

  supports(eventType: NotificationEventType): boolean {
    return supportsCoreGatewayNotification(eventType);
  }

  async notify(event: NotificationEvent): Promise<void> {
    await this.api.sendChannelMessage(this.config.channel_id, formatPlaintextNotification(event));
  }
}

export class DiscordGatewayAdapter implements ChannelAdapter {
  readonly name = "discord";

  private handler: EnvelopeHandler | null = null;
  private server: http.Server | null = null;
  private readonly api: DiscordAPI;
  private readonly notifier: DiscordGatewayNotifier;

  constructor(private readonly config: DiscordGatewayConfig) {
    this.api = new DiscordAPI(config.bot_token);
    this.notifier = new DiscordGatewayNotifier(this.api, config);
  }

  static fromConfigDir(configDir: string): DiscordGatewayAdapter {
    return new DiscordGatewayAdapter(loadDiscordGatewayConfig(configDir));
  }

  getNotifier(): INotifier {
    return this.notifier;
  }

  onEnvelope(handler: EnvelopeHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.server !== null) return;
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(this.config.port, this.config.host, resolve);
    });
  }

  async stop(): Promise<void> {
    if (this.server === null) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      this.respondJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    const body = await this.readBody(req);
    if (body === null) {
      this.respondJson(res, 400, { error: "invalid_body" });
      return;
    }

    if (!(await this.verifyRequest(req, body))) {
      this.respondJson(res, 401, { error: "invalid_signature" });
      return;
    }

    let payload: DiscordInteractionPayload;
    try {
      payload = JSON.parse(body) as DiscordInteractionPayload;
    } catch {
      this.respondJson(res, 400, { error: "invalid_json" });
      return;
    }

    if (payload.type === 1) {
      this.respondJson(res, 200, { type: 1 });
      return;
    }

    if (
      payload.type !== 2 ||
      payload.token === undefined ||
      payload.application_id === undefined ||
      payload.data?.name !== this.config.command_name
    ) {
      this.respondJson(res, 400, { error: "unsupported_interaction" });
      return;
    }

    const text = this.extractCommandText(payload);
    if (text === null) {
      this.respondJson(res, 400, { error: "missing_message_text" });
      return;
    }

    const senderId = payload.member?.user?.id ?? payload.user?.id ?? "discord-user";
    const conversationId = payload.channel_id ?? payload.guild_id ?? payload.id ?? senderId;
    const channelContext = {
      platform: "discord",
      senderId,
      conversationId,
      channelId: payload.channel_id,
    };
    const access = evaluateChannelAccess(
      {
        allowedSenderIds: this.config.allowed_sender_ids,
        deniedSenderIds: this.config.denied_sender_ids,
        allowedConversationIds: this.config.allowed_conversation_ids,
        deniedConversationIds: this.config.denied_conversation_ids,
        runtimeControlAllowedSenderIds: this.config.runtime_control_allowed_sender_ids,
      },
      channelContext
    );
    if (!access.allowed) {
      this.respondJson(res, 403, { error: access.reason ?? "forbidden" });
      return;
    }

    const route = resolveChannelRoute(
      {
        identityKey: this.config.identity_key,
        conversationGoalMap: this.config.conversation_goal_map,
        senderGoalMap: this.config.sender_goal_map,
        defaultGoalId: this.config.default_goal_id,
      },
      channelContext
    );

    void this.processIncomingMessage(payload, {
      text,
      platform: "discord",
      identity_key: route.identityKey ?? this.config.identity_key,
      conversation_id: conversationId,
      sender_id: senderId,
      message_id: payload.id,
      goal_id: route.goalId,
      metadata: {
        ...route.metadata,
        interaction_type: payload.type,
        command_name: payload.data?.name,
        channel_id: payload.channel_id,
        guild_id: payload.guild_id,
        ...(route.goalId ? { goal_id: route.goalId } : {}),
        ...(access.runtimeControlApproved ? { runtime_control_approved: true } : {}),
      },
    }).catch(() => undefined);

    this.respondJson(res, 200, {
      type: 5,
      data: this.config.ephemeral ? { flags: 64 } : undefined,
    });
  }

  private async processIncomingMessage(
    payload: DiscordInteractionPayload,
    input: Parameters<typeof dispatchGatewayChatInput>[0]
  ): Promise<void> {
    let sentActivityCount = 0;
    let lastActivity = "";
    const reply = await dispatchGatewayChatInput({
      ...input,
      onEvent: async (event: unknown) => {
        if (
          !isActivityChatEvent(event) ||
          (event.kind !== "tool" && event.kind !== "plugin" && event.kind !== "skill") ||
          payload.application_id === undefined ||
          payload.token === undefined ||
          sentActivityCount >= MAX_DISCORD_ACTIVITY_MESSAGES
        ) {
          return;
        }
        const content = truncateDiscordActivity(event.message);
        if (content === lastActivity) return;
        lastActivity = content;
        sentActivityCount++;
        await this.api.sendInteractionFollowUp(payload.application_id, payload.token, content);
      },
    });
    const content = reply ?? "Received.";

    if (payload.application_id !== undefined && payload.token !== undefined) {
      await this.api.sendInteractionFollowUp(payload.application_id, payload.token, content);
    }
  }

  private extractCommandText(payload: DiscordInteractionPayload): string | null {
    for (const option of payload.data?.options ?? []) {
      if (
        (option.name === "message" || option.name === "text" || option.name === "content") &&
        typeof option.value === "string" &&
        option.value.trim().length > 0
      ) {
        return option.value;
      }
    }
    return null;
  }

  private async verifyRequest(req: http.IncomingMessage, body: string): Promise<boolean> {
    if (!this.config.public_key_hex) {
      return true;
    }
    const signature = req.headers["x-signature-ed25519"];
    const timestamp = req.headers["x-signature-timestamp"];
    if (typeof signature !== "string" || typeof timestamp !== "string") {
      return false;
    }

    const publicKeyBytes = Uint8Array.from(Buffer.from(this.config.public_key_hex, "hex"));
    let key: Awaited<ReturnType<typeof webcrypto.subtle.importKey>>;
    try {
      key = await webcrypto.subtle.importKey("raw", publicKeyBytes, { name: "Ed25519" }, false, ["verify"]);
    } catch {
      return false;
    }

    const signedMessage = new TextEncoder().encode(`${timestamp}${body}`);
    const signatureBytes = Uint8Array.from(Buffer.from(signature, "hex"));
    return webcrypto.subtle.verify("Ed25519", key, signatureBytes, signedMessage);
  }

  private async readBody(req: http.IncomingMessage): Promise<string | null> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  private respondJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
  }
}

class DiscordAPI {
  constructor(
    private readonly botToken: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async sendChannelMessage(channelId: string, content: string): Promise<void> {
    const response = await this.fetchImpl(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${this.botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] as string[] },
      }),
    });
    if (!response.ok) {
      throw new Error(`discord-bot: channel send failed with ${response.status}`);
    }
  }

  async sendInteractionFollowUp(applicationId: string, interactionToken: string, content: string): Promise<void> {
    const response = await this.fetchImpl(`https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] as string[] },
      }),
    });
    if (!response.ok) {
      throw new Error(`discord-bot: follow-up send failed with ${response.status}`);
    }
  }
}

function loadDiscordGatewayConfig(pluginDir: string): DiscordGatewayConfig {
  const configPath = path.join(pluginDir, "config.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  const commandName = raw["command_name"] ?? "pulseed";
  const host = raw["host"] ?? "127.0.0.1";
  const port = raw["port"] ?? 8787;
  const ephemeral = raw["ephemeral"] ?? false;
  const runtimeControlAllowedSenderIds = raw["runtime_control_allowed_sender_ids"] ?? [];
  const allowedSenderIds = raw["allowed_sender_ids"] ?? raw["allow_from"] ?? [];
  const deniedSenderIds = raw["denied_sender_ids"] ?? raw["deny_from"] ?? [];
  const allowedConversationIds = raw["allowed_conversation_ids"] ?? [];
  const deniedConversationIds = raw["denied_conversation_ids"] ?? [];
  const conversationGoalMap = raw["conversation_goal_map"] ?? raw["goal_routes"] ?? {};
  const senderGoalMap = raw["sender_goal_map"] ?? {};

  assertNonEmptyString(raw["application_id"], "discord-bot: application_id must be a non-empty string");
  assertNonEmptyString(raw["bot_token"], "discord-bot: bot_token must be a non-empty string");
  assertNonEmptyString(raw["channel_id"], "discord-bot: channel_id must be a non-empty string");
  assertNonEmptyString(raw["identity_key"], "discord-bot: identity_key must be a non-empty string");
  assertNonEmptyString(commandName, "discord-bot: command_name must be a non-empty string");
  assertNonEmptyString(host, "discord-bot: host must be a non-empty string");
  assertInteger(port, "discord-bot: port must be an integer");
  assertBoolean(ephemeral, "discord-bot: ephemeral must be a boolean");
  assertStringArray(runtimeControlAllowedSenderIds, "discord-bot: runtime_control_allowed_sender_ids must be an array of non-empty strings");
  assertStringArray(allowedSenderIds, "discord-bot: allowed_sender_ids must be an array of non-empty strings");
  assertStringArray(deniedSenderIds, "discord-bot: denied_sender_ids must be an array of non-empty strings");
  assertStringArray(allowedConversationIds, "discord-bot: allowed_conversation_ids must be an array of non-empty strings");
  assertStringArray(deniedConversationIds, "discord-bot: denied_conversation_ids must be an array of non-empty strings");
  assertGoalMap(conversationGoalMap, "discord-bot: conversation_goal_map must map IDs to goal IDs");
  assertGoalMap(senderGoalMap, "discord-bot: sender_goal_map must map IDs to goal IDs");
  if (raw["default_goal_id"] !== undefined) {
    assertNonEmptyString(raw["default_goal_id"], "discord-bot: default_goal_id must be a non-empty string when set");
  }
  if (raw["public_key_hex"] !== undefined && typeof raw["public_key_hex"] !== "string") {
    throw new Error("discord-bot: public_key_hex must be a string when set");
  }

  return {
    application_id: raw["application_id"] as string,
    public_key_hex: raw["public_key_hex"] as string | undefined,
    bot_token: raw["bot_token"] as string,
    channel_id: raw["channel_id"] as string,
    identity_key: raw["identity_key"] as string,
    allowed_sender_ids: allowedSenderIds as string[],
    denied_sender_ids: deniedSenderIds as string[],
    allowed_conversation_ids: allowedConversationIds as string[],
    denied_conversation_ids: deniedConversationIds as string[],
    runtime_control_allowed_sender_ids: runtimeControlAllowedSenderIds as string[],
    conversation_goal_map: conversationGoalMap as Record<string, string>,
    sender_goal_map: senderGoalMap as Record<string, string>,
    default_goal_id: raw["default_goal_id"] as string | undefined,
    command_name: commandName as string,
    host: host as string,
    port: port as number,
    ephemeral: ephemeral as boolean,
  };
}

function isActivityChatEvent(event: unknown): event is ActivityChatEvent {
  return typeof event === "object" && event !== null &&
    (event as Record<string, unknown>)["type"] === "activity" &&
    typeof (event as Record<string, unknown>)["message"] === "string";
}

function truncateDiscordActivity(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length <= MAX_DISCORD_ACTIVITY_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_DISCORD_ACTIVITY_CHARS - 1)}...`;
}

function assertNonEmptyString(value: unknown, message: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(message);
  }
}

function assertInteger(value: unknown, message: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(message);
  }
}

function assertBoolean(value: unknown, message: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(message);
  }
}

function assertStringArray(value: unknown, message: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error(message);
  }
}

function assertGoalMap(value: unknown, message: string): asserts value is Record<string, string> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.values(value).every((goalId) => typeof goalId === "string" && goalId.length > 0)
  ) {
    throw new Error(message);
  }
}
