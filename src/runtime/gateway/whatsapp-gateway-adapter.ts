import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { ChannelAdapter, EnvelopeHandler } from "./channel-adapter.js";
import { dispatchGatewayChatInput } from "./chat-session-dispatch.js";
import { formatPlaintextNotification, supportsCoreGatewayNotification } from "./core-channel-notification.js";
import { evaluateChannelAccess, resolveChannelRoute } from "./channel-policy.js";
import type { INotifier, NotificationEvent, NotificationEventType } from "../../base/types/plugin.js";

interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
        }>;
      };
    }>;
  }>;
}

export interface WhatsAppGatewayConfig {
  phone_number_id: string;
  access_token: string;
  verify_token: string;
  recipient_id: string;
  identity_key: string;
  allowed_sender_ids: string[];
  denied_sender_ids: string[];
  runtime_control_allowed_sender_ids: string[];
  sender_goal_map: Record<string, string>;
  default_goal_id?: string;
  host: string;
  port: number;
  path: string;
  app_secret?: string;
}

export class WhatsAppGatewayNotifier implements INotifier {
  readonly name = "whatsapp-webhook";

  constructor(
    private readonly client: WhatsAppCloudClient,
    private readonly config: WhatsAppGatewayConfig
  ) {}

  supports(eventType: NotificationEventType): boolean {
    return supportsCoreGatewayNotification(eventType);
  }

  async notify(event: NotificationEvent): Promise<void> {
    await this.client.sendTextMessage({
      to: this.config.recipient_id,
      body: formatPlaintextNotification(event),
    });
  }
}

export class WhatsAppGatewayAdapter implements ChannelAdapter {
  readonly name = "whatsapp";

  private handler: EnvelopeHandler | null = null;
  private server: http.Server | null = null;
  private readonly client: WhatsAppCloudClient;
  private readonly notifier: WhatsAppGatewayNotifier;

  constructor(private readonly config: WhatsAppGatewayConfig) {
    this.client = new WhatsAppCloudClient(config.phone_number_id, config.access_token);
    this.notifier = new WhatsAppGatewayNotifier(this.client, config);
  }

  static fromConfigDir(configDir: string): WhatsAppGatewayAdapter {
    return new WhatsAppGatewayAdapter(loadWhatsAppGatewayConfig(configDir));
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
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? this.config.host}`);
    if (req.method === "GET" && url.pathname === this.config.path) {
      this.handleVerification(res, url);
      return;
    }
    if (req.method !== "POST" || url.pathname !== this.config.path) {
      this.respondJson(res, 404, { error: "not_found" });
      return;
    }

    const body = await this.readBody(req);
    if (body === null) {
      this.respondJson(res, 400, { error: "invalid_body" });
      return;
    }
    if (!(await this.verifySignature(req, body))) {
      this.respondJson(res, 401, { error: "invalid_signature" });
      return;
    }

    let payload: WhatsAppWebhookPayload;
    try {
      payload = JSON.parse(body) as WhatsAppWebhookPayload;
    } catch {
      this.respondJson(res, 400, { error: "invalid_json" });
      return;
    }

    for (const message of this.extractMessages(payload)) {
      void this.processMessage(message).catch(() => undefined);
    }

    this.respondJson(res, 200, { ok: true });
  }

  private handleVerification(res: http.ServerResponse, url: URL): void {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === this.config.verify_token && challenge !== null) {
      res.statusCode = 200;
      res.end(challenge);
      return;
    }
    this.respondJson(res, 403, { error: "verification_failed" });
  }

  private async processMessage(message: {
    id?: string;
    from?: string;
    timestamp?: string;
    text?: { body?: string };
    type?: string;
  }): Promise<void> {
    if (message.from === undefined || message.text?.body === undefined || message.text.body.trim().length === 0) {
      return;
    }
    const channelContext = {
      platform: "whatsapp",
      senderId: message.from,
      conversationId: message.from,
    };
    const access = evaluateChannelAccess(
      {
        allowedSenderIds: this.config.allowed_sender_ids,
        deniedSenderIds: this.config.denied_sender_ids,
        runtimeControlAllowedSenderIds: this.config.runtime_control_allowed_sender_ids,
      },
      channelContext
    );
    if (!access.allowed) return;

    const route = resolveChannelRoute(
      {
        identityKey: this.config.identity_key,
        senderGoalMap: this.config.sender_goal_map,
        defaultGoalId: this.config.default_goal_id,
      },
      channelContext
    );
    const reply = await dispatchGatewayChatInput({
      text: message.text.body,
      platform: "whatsapp",
      identity_key: route.identityKey ?? this.config.identity_key,
      conversation_id: message.from,
      sender_id: message.from,
      message_id: message.id,
      goal_id: route.goalId,
      metadata: {
        ...route.metadata,
        message_type: message.type,
        timestamp: message.timestamp,
        ...(route.goalId ? { goal_id: route.goalId } : {}),
        ...(access.runtimeControlApproved ? { runtime_control_approved: true } : {}),
      },
    });

    await this.client.sendTextMessage({
      to: message.from,
      body: reply ?? "Received.",
    });
  }

  private extractMessages(payload: WhatsAppWebhookPayload): Array<{
    id?: string;
    from?: string;
    timestamp?: string;
    type?: string;
    text?: { body?: string };
  }> {
    const messages: Array<{
      id?: string;
      from?: string;
      timestamp?: string;
      type?: string;
      text?: { body?: string };
    }> = [];
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value?.messages ?? []) {
          messages.push(message);
        }
      }
    }
    return messages;
  }

  private async verifySignature(req: http.IncomingMessage, body: string): Promise<boolean> {
    if (!this.config.app_secret) {
      return true;
    }
    const header = req.headers["x-hub-signature-256"];
    if (typeof header !== "string" || !header.startsWith("sha256=")) {
      return false;
    }
    const expected = crypto.createHmac("sha256", this.config.app_secret).update(body).digest("hex");
    const actual = header.slice("sha256=".length);
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
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

class WhatsAppCloudClient {
  constructor(
    private readonly phoneNumberId: string,
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async sendTextMessage(message: { to: string; body: string }): Promise<void> {
    const response = await this.fetchImpl(`https://graph.facebook.com/v20.0/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: message.to,
        type: "text",
        text: { body: message.body },
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`whatsapp-webhook: send failed with ${response.status}: ${body}`);
    }
  }
}

function loadWhatsAppGatewayConfig(pluginDir: string): WhatsAppGatewayConfig {
  const raw = JSON.parse(fs.readFileSync(path.join(pluginDir, "config.json"), "utf-8")) as Record<string, unknown>;
  const host = raw["host"] ?? "127.0.0.1";
  const port = raw["port"] ?? 8788;
  const pathValue = raw["path"] ?? "/webhook";
  const runtimeControlAllowedSenderIds = raw["runtime_control_allowed_sender_ids"] ?? [];
  const allowedSenderIds = raw["allowed_sender_ids"] ?? raw["allow_from"] ?? [];
  const deniedSenderIds = raw["denied_sender_ids"] ?? raw["deny_from"] ?? [];
  const senderGoalMap = raw["sender_goal_map"] ?? raw["goal_routes"] ?? {};

  assertNonEmptyString(raw["phone_number_id"], "whatsapp-webhook: phone_number_id must be a non-empty string");
  assertNonEmptyString(raw["access_token"], "whatsapp-webhook: access_token must be a non-empty string");
  assertNonEmptyString(raw["verify_token"], "whatsapp-webhook: verify_token must be a non-empty string");
  assertNonEmptyString(raw["recipient_id"], "whatsapp-webhook: recipient_id must be a non-empty string");
  assertNonEmptyString(raw["identity_key"], "whatsapp-webhook: identity_key must be a non-empty string");
  assertNonEmptyString(host, "whatsapp-webhook: host must be a non-empty string");
  assertInteger(port, "whatsapp-webhook: port must be an integer");
  assertNonEmptyString(pathValue, "whatsapp-webhook: path must be a non-empty string");
  if (raw["app_secret"] !== undefined && typeof raw["app_secret"] !== "string") {
    throw new Error("whatsapp-webhook: app_secret must be a string when set");
  }
  assertStringArray(runtimeControlAllowedSenderIds, "whatsapp-webhook: runtime_control_allowed_sender_ids must be an array of non-empty strings");
  assertStringArray(allowedSenderIds, "whatsapp-webhook: allowed_sender_ids must be an array of non-empty strings");
  assertStringArray(deniedSenderIds, "whatsapp-webhook: denied_sender_ids must be an array of non-empty strings");
  assertGoalMap(senderGoalMap, "whatsapp-webhook: sender_goal_map must map IDs to goal IDs");
  if (raw["default_goal_id"] !== undefined) {
    assertNonEmptyString(raw["default_goal_id"], "whatsapp-webhook: default_goal_id must be a non-empty string when set");
  }

  return {
    phone_number_id: raw["phone_number_id"] as string,
    access_token: raw["access_token"] as string,
    verify_token: raw["verify_token"] as string,
    recipient_id: raw["recipient_id"] as string,
    identity_key: raw["identity_key"] as string,
    allowed_sender_ids: allowedSenderIds as string[],
    denied_sender_ids: deniedSenderIds as string[],
    runtime_control_allowed_sender_ids: runtimeControlAllowedSenderIds as string[],
    sender_goal_map: senderGoalMap as Record<string, string>,
    default_goal_id: raw["default_goal_id"] as string | undefined,
    host: host as string,
    port: port as number,
    path: pathValue as string,
    app_secret: raw["app_secret"] as string | undefined,
  };
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
