import * as fs from "node:fs";
import * as path from "node:path";
import type { ChannelAdapter, EnvelopeHandler } from "./channel-adapter.js";
import { dispatchGatewayChatInput } from "./chat-session-dispatch.js";
import { formatTelegramNotification, supportsCoreGatewayNotification } from "./core-channel-notification.js";
import { writeJsonFileAtomic } from "../../base/utils/json-io.js";
import type { ChatEvent, ChatEventHandler } from "../../interface/chat/chat-events.js";
import { evaluateChannelAccess, resolveChannelRoute } from "./channel-policy.js";
import type { INotifier, NotificationEvent, NotificationEventType } from "../../base/types/plugin.js";

const BACKOFF_STEPS_MS = [5_000, 10_000, 20_000, 40_000, 60_000];

export interface TelegramGatewayConfig {
  bot_token: string;
  chat_id?: number;
  allowed_user_ids: number[];
  denied_user_ids: number[];
  allowed_chat_ids: number[];
  denied_chat_ids: number[];
  runtime_control_allowed_user_ids: number[];
  chat_goal_map: Record<string, string>;
  user_goal_map: Record<string, string>;
  default_goal_id?: string;
  allow_all: boolean;
  polling_timeout: number;
  identity_key?: string;
}

export class TelegramGatewayNotifier implements INotifier {
  readonly name = "telegram-bot";

  constructor(
    private readonly api: TelegramAPI,
    private readonly homeChatStore: TelegramHomeChatStore
  ) {}

  supports(eventType: NotificationEventType): boolean {
    return supportsCoreGatewayNotification(eventType);
  }

  async notify(event: NotificationEvent): Promise<void> {
    const chatId = this.homeChatStore.get();
    if (chatId === undefined) {
      throw new Error("telegram-bot: no home chat configured. Send /sethome from the target Telegram chat.");
    }
    await this.api.sendMessage(chatId, formatTelegramNotification(event));
  }
}

export class TelegramGatewayAdapter implements ChannelAdapter {
  readonly name = "telegram";

  private handler: EnvelopeHandler | null = null;
  private readonly api: TelegramAPI;
  private readonly config: TelegramGatewayConfig;
  private readonly homeChatStore: TelegramHomeChatStore;
  private readonly notifier: TelegramGatewayNotifier;
  private running = false;
  private offset = 0;

  constructor(pluginDir: string, config: TelegramGatewayConfig) {
    this.config = config;
    this.api = new TelegramAPI(config.bot_token);
    this.homeChatStore = new TelegramHomeChatStore(pluginDir, config.chat_id);
    this.notifier = new TelegramGatewayNotifier(this.api, this.homeChatStore);
  }

  static fromConfigDir(configDir: string): TelegramGatewayAdapter {
    return new TelegramGatewayAdapter(configDir, loadTelegramGatewayConfig(configDir));
  }

  getNotifier(): INotifier {
    return this.notifier;
  }

  onEnvelope(handler: EnvelopeHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.api.getMe();
    this.running = true;
    void this.loop().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async loop(): Promise<void> {
    let backoffIndex = 0;
    while (this.running) {
      try {
        const updates = await this.api.getUpdates(this.offset, this.config.polling_timeout);
        backoffIndex = 0;
        for (const update of updates) {
          this.offset = update.update_id + 1;
          const msg = update.message;
          if (!msg?.text) continue;
          const fromId = msg.from?.id;
          const chatId = msg.chat?.id;
          if (!Number.isInteger(fromId) || !Number.isInteger(chatId)) continue;
          if (this.config.denied_user_ids.includes(fromId)) continue;
          if (this.config.denied_chat_ids.includes(chatId)) continue;
          if (this.config.allowed_chat_ids.length > 0 && !this.config.allowed_chat_ids.includes(chatId)) continue;
          if (!this.config.allow_all && !this.config.allowed_user_ids.includes(fromId)) continue;
          await this.processMessage(msg.text, fromId, chatId);
        }
      } catch (err) {
        if (!this.running) break;
        const delay = BACKOFF_STEPS_MS[Math.min(backoffIndex, BACKOFF_STEPS_MS.length - 1)];
        backoffIndex++;
        await sleep(delay);
      }
    }
  }

  private async processMessage(text: string, fromUserId: number, chatId: number): Promise<void> {
    const normalized = text.trim().toLowerCase();
    if (normalized === "/sethome" || normalized.startsWith("/sethome@")) {
      await this.homeChatStore.set(chatId);
      await this.api.sendPlainMessage(chatId, "This chat is now the home channel for PulSeed notifications.");
      return;
    }

    const eventAdapter = new TelegramChatEventAdapter(this.api, chatId);
    const route = resolveChannelRoute(
      {
        identityKey: this.config.identity_key,
        conversationGoalMap: this.config.chat_goal_map,
        senderGoalMap: this.config.user_goal_map,
        defaultGoalId: this.config.default_goal_id,
      },
      {
        platform: "telegram",
        senderId: String(fromUserId),
        conversationId: String(chatId),
        channelId: String(chatId),
      }
    );
    const access = evaluateChannelAccess(
      {
        allowedSenderIds: this.config.allow_all ? undefined : this.config.allowed_user_ids.map(String),
        deniedSenderIds: this.config.denied_user_ids.map(String),
        allowedConversationIds: this.config.allowed_chat_ids.map(String),
        deniedConversationIds: this.config.denied_chat_ids.map(String),
        runtimeControlAllowedSenderIds: this.config.runtime_control_allowed_user_ids.map(String),
      },
      {
        platform: "telegram",
        senderId: String(fromUserId),
        conversationId: String(chatId),
        channelId: String(chatId),
      }
    );
    if (!access.allowed) {
      return;
    }

    const reply = await dispatchGatewayChatInput({
      text,
      platform: "telegram",
      identity_key: route.identityKey ?? this.config.identity_key,
      conversation_id: String(chatId),
      sender_id: String(fromUserId),
      goal_id: route.goalId,
      cwd: process.cwd(),
      onEvent: (event) => eventAdapter.handle(event),
      metadata: {
        ...route.metadata,
        chat_id: chatId,
        ...(route.goalId ? { goal_id: route.goalId } : {}),
        ...(access.runtimeControlApproved ? { runtime_control_approved: true } : {}),
      },
    });

    if (!eventAdapter.renderedAssistantOutput) {
      await eventAdapter.sendFinalFallback(reply ?? "Received.");
    }
  }
}

interface TelegramMessage {
  message_id: number;
  from: { id: number };
  chat: { id: number };
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface SendMessageResult {
  message_id: number;
}

class TelegramAPI {
  private readonly baseUrl: string;

  constructor(botToken: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  async getMe(): Promise<unknown> {
    return this.call("getMe");
  }

  async getUpdates(offset: number, timeout: number): Promise<TelegramUpdate[]> {
    return this.call("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message"],
    });
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.sendMessageInternal(chatId, text, "Markdown");
  }

  async sendPlainMessage(chatId: number, text: string): Promise<number> {
    return this.sendMessageInternal(chatId, text, null);
  }

  async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
    const chunks = splitMessage(text, 4096);
    if (chunks.length === 0) return;
    await this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: chunks[0],
    });
    for (const chunk of chunks.slice(1)) {
      await this.call("sendMessage", {
        chat_id: chatId,
        text: chunk,
      });
    }
  }

  private async sendMessageInternal(chatId: number, text: string, parseMode: "Markdown" | null): Promise<number> {
    const chunks = splitMessage(text, 4096);
    let firstMessageId = -1;
    for (const [index, chunk] of chunks.entries()) {
      const result = await this.call<SendMessageResult>("sendMessage", {
        chat_id: chatId,
        text: chunk,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      });
      if (index === 0) {
        firstMessageId = result.message_id;
      }
    }
    return firstMessageId;
  }

  private async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: params !== undefined ? JSON.stringify(params) : undefined,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`telegram-api: ${method} returned ${response.status}: ${body}`);
    }
    const json = (await response.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) {
      throw new Error(`telegram-api: ${method} error: ${json.description ?? "unknown"}`);
    }
    return json.result;
  }
}

class TelegramHomeChatStore {
  private readonly configPath: string;
  private chatId: number | undefined;

  constructor(pluginDir: string, initialChatId?: number) {
    this.configPath = path.join(pluginDir, "config.json");
    this.chatId = initialChatId;
  }

  get(): number | undefined {
    return this.chatId;
  }

  async set(chatId: number): Promise<void> {
    this.chatId = chatId;
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(fs.readFileSync(this.configPath, "utf-8")) as Record<string, unknown>;
    } catch {
      current = {};
    }
    current["chat_id"] = chatId;
    await writeJsonFileAtomic(this.configPath, current);
  }
}

class TelegramChatEventAdapter {
  private assistantMessage: { messageId: number; text: string } | null = null;
  private readonly toolMessages = new Map<string, { messageId: number; text: string }>();
  private readonly activityMessages = new Map<string, { messageId: number; text: string }>();
  private hasAssistantOutput = false;

  constructor(
    private readonly api: TelegramAPI,
    private readonly chatId: number
  ) {}

  get renderedAssistantOutput(): boolean {
    return this.hasAssistantOutput;
  }

  async handle(event: ChatEvent): Promise<void> {
    switch (event.type) {
      case "lifecycle_start":
        this.assistantMessage = null;
        this.toolMessages.clear();
        this.activityMessages.clear();
        this.hasAssistantOutput = false;
        return;
      case "assistant_delta":
      case "assistant_final":
        await this.upsertAssistantMessage(event.text);
        return;
      case "activity":
        if (event.kind === "plugin" || event.kind === "skill") {
          await this.upsertActivityMessage(event.sourceId ?? event.kind, `[${event.kind}] ${event.message}`);
        }
        return;
      case "tool_start":
        await this.upsertToolMessage(event.toolCallId, `[tool] ${event.toolName} started`);
        return;
      case "tool_update":
        await this.upsertToolMessage(event.toolCallId, `[tool] ${event.toolName} ${event.status}: ${event.message}`);
        return;
      case "tool_end":
        await this.upsertToolMessage(
          event.toolCallId,
          `[tool] ${event.toolName} ${event.success ? "done" : "failed"}: ${event.summary}`
        );
        return;
      case "lifecycle_error":
        await this.sendFinalFallback(event.partialText ? `${event.partialText}\n\n[interrupted: ${event.error}]` : `Error: ${event.error}`);
        return;
      case "lifecycle_end":
        return;
    }
  }

  async sendFinalFallback(text: string): Promise<void> {
    if (!text.trim()) return;
    await this.upsertAssistantMessage(text);
  }

  private async upsertAssistantMessage(text: string): Promise<void> {
    if (!this.assistantMessage) {
      const messageId = await this.api.sendPlainMessage(this.chatId, text);
      this.assistantMessage = { messageId, text };
      this.hasAssistantOutput = true;
      return;
    }
    await this.api.editMessageText(this.chatId, this.assistantMessage.messageId, text);
    this.assistantMessage.text = text;
    this.hasAssistantOutput = true;
  }

  private async upsertToolMessage(toolCallId: string, text: string): Promise<void> {
    const existing = this.toolMessages.get(toolCallId);
    if (!existing) {
      const messageId = await this.api.sendPlainMessage(this.chatId, text);
      this.toolMessages.set(toolCallId, { messageId, text });
      return;
    }
    await this.api.editMessageText(this.chatId, existing.messageId, text);
    existing.text = text;
  }

  private async upsertActivityMessage(activityId: string, text: string): Promise<void> {
    const existing = this.activityMessages.get(activityId);
    if (!existing) {
      const messageId = await this.api.sendPlainMessage(this.chatId, text);
      this.activityMessages.set(activityId, { messageId, text });
      return;
    }
    await this.api.editMessageText(this.chatId, existing.messageId, text);
    existing.text = text;
  }
}

function loadTelegramGatewayConfig(pluginDir: string): TelegramGatewayConfig {
  const raw = JSON.parse(fs.readFileSync(path.join(pluginDir, "config.json"), "utf-8")) as Record<string, unknown>;
  const allowedUserIds = raw["allowed_user_ids"] ?? [];
  const deniedUserIds = raw["denied_user_ids"] ?? raw["deny_from"] ?? [];
  const allowedChatIds = raw["allowed_chat_ids"] ?? [];
  const deniedChatIds = raw["denied_chat_ids"] ?? [];
  const runtimeControlAllowedUserIds = raw["runtime_control_allowed_user_ids"] ?? [];
  const allowAll = raw["allow_all"] ?? false;
  const pollingTimeout = raw["polling_timeout"] ?? 30;
  const chatGoalMap = raw["chat_goal_map"] ?? raw["goal_routes"] ?? {};
  const userGoalMap = raw["user_goal_map"] ?? {};

  assertNonEmptyString(raw["bot_token"], "telegram-bot: bot_token must be a non-empty string");
  if (raw["chat_id"] !== undefined) {
    assertInteger(raw["chat_id"], "telegram-bot: chat_id must be an integer when set");
  }
  assertIntegerArray(allowedUserIds, "telegram-bot: allowed_user_ids must be an array of integers");
  assertIntegerArray(deniedUserIds, "telegram-bot: denied_user_ids must be an array of integers");
  assertIntegerArray(allowedChatIds, "telegram-bot: allowed_chat_ids must be an array of integers");
  assertIntegerArray(deniedChatIds, "telegram-bot: denied_chat_ids must be an array of integers");
  assertIntegerArray(runtimeControlAllowedUserIds, "telegram-bot: runtime_control_allowed_user_ids must be an array of integers");
  if (typeof allowAll !== "boolean") {
    throw new Error("telegram-bot: allow_all must be a boolean");
  }
  assertInteger(pollingTimeout, "telegram-bot: polling_timeout must be an integer");
  if (raw["identity_key"] !== undefined) {
    assertNonEmptyString(raw["identity_key"], "telegram-bot: identity_key must be a non-empty string when set");
  }
  assertGoalMap(chatGoalMap, "telegram-bot: chat_goal_map must map IDs to goal IDs");
  assertGoalMap(userGoalMap, "telegram-bot: user_goal_map must map IDs to goal IDs");
  if (raw["default_goal_id"] !== undefined) {
    assertNonEmptyString(raw["default_goal_id"], "telegram-bot: default_goal_id must be a non-empty string when set");
  }

  return {
    bot_token: raw["bot_token"] as string,
    chat_id: raw["chat_id"] as number | undefined,
    allowed_user_ids: allowedUserIds as number[],
    denied_user_ids: deniedUserIds as number[],
    allowed_chat_ids: allowedChatIds as number[],
    denied_chat_ids: deniedChatIds as number[],
    runtime_control_allowed_user_ids: runtimeControlAllowedUserIds as number[],
    chat_goal_map: chatGoalMap as Record<string, string>,
    user_goal_map: userGoalMap as Record<string, string>,
    default_goal_id: raw["default_goal_id"] as string | undefined,
    allow_all: allowAll as boolean,
    polling_timeout: Math.min(Math.max(pollingTimeout as number, 1), 60),
    identity_key: raw["identity_key"] as string | undefined,
  };
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const slice = remaining.slice(0, maxLen);
    const lastNewline = slice.lastIndexOf("\n");
    const splitAt = lastNewline > 0 ? lastNewline + 1 : maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function assertIntegerArray(value: unknown, message: string): asserts value is number[] {
  if (!Array.isArray(value) || !value.every((item) => Number.isInteger(item))) {
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
