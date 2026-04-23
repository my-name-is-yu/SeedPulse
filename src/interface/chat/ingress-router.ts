import { randomUUID } from "node:crypto";
import type { ChatEventHandler } from "./chat-events.js";
import { recognizeRuntimeControlIntent, type RuntimeControlIntent } from "../../runtime/control/index.js";
import type {
  RuntimeControlActor,
  RuntimeControlReplyTarget,
} from "../../runtime/store/runtime-operation-schemas.js";

export type IngressChannel = "tui" | "plugin_gateway" | "cli" | "web";
export type IngressDeliveryMode = "reply" | "notify" | "thread_reply";
export type IngressApprovalMode = "interactive" | "preapproved" | "disallowed";
export type ReplyTargetPolicy = "turn_reply_target";
export type EventProjectionPolicy = "turn_only" | "latest_active_reply_target";
export type ConcurrencyPolicy = "session_serial";
export type DaemonChatPolicy = "compatibility_only";

export interface ChatIngressRuntimeControl {
  allowed: boolean;
  approvalMode: IngressApprovalMode;
  approval_mode?: IngressApprovalMode;
}

export interface IngressReplyTarget extends RuntimeControlReplyTarget {
  channel?: IngressChannel;
  message_id?: string;
  deliveryMode?: IngressDeliveryMode;
  metadata?: Record<string, unknown>;
}

export interface ChatIngressMessage {
  ingress_id?: string;
  received_at?: string;
  channel: IngressChannel;
  platform?: string;
  identity_key?: string;
  conversation_id?: string;
  message_id?: string;
  user_id?: string;
  user_name?: string;
  text: string;
  actor: RuntimeControlActor;
  runtimeControl: ChatIngressRuntimeControl;
  deliveryMode?: IngressDeliveryMode;
  metadata: Record<string, unknown>;
  replyTarget: IngressReplyTarget;
  cwd?: string;
  timeoutMs?: number;
  onEvent?: ChatEventHandler;
}

export type SelectedChatRoute =
  | {
      lane: "fast";
      kind: "direct_answer";
      reason: "simple_question";
      modelTier: "light";
      maxTokens: number;
      replyTargetPolicy: ReplyTargetPolicy;
      eventProjectionPolicy: EventProjectionPolicy;
      concurrencyPolicy: ConcurrencyPolicy;
      daemonChatPolicy: DaemonChatPolicy;
    }
  | {
      lane: "fast";
      kind: "agent_loop" | "tool_loop" | "adapter";
      reason: "agent_loop_available" | "tool_loop_available" | "adapter_fallback";
      replyTargetPolicy: ReplyTargetPolicy;
      eventProjectionPolicy: EventProjectionPolicy;
      concurrencyPolicy: ConcurrencyPolicy;
      daemonChatPolicy: DaemonChatPolicy;
    }
  | {
      lane: "durable";
      kind: "runtime_control";
      reason: "runtime_control_intent";
      intent: RuntimeControlIntent;
      replyTargetPolicy: ReplyTargetPolicy;
      eventProjectionPolicy: EventProjectionPolicy;
      concurrencyPolicy: ConcurrencyPolicy;
      daemonChatPolicy: DaemonChatPolicy;
    };

export interface IngressRouterCapabilities {
  hasLightweightLlm: boolean;
  hasAgentLoop: boolean;
  hasToolLoop: boolean;
  hasRuntimeControlService?: boolean;
}

function shouldUseDirectAnswerRoute(input: string): boolean {
  const normalized = input.trim();
  if (!normalized) return false;

  const lowered = normalized.toLowerCase();
  const questionSignals = [
    /[?？]/,
    /\b(what|why|how|when|where|who|which|is|are|can|could|would|should|tell me|explain|describe|help me understand)\b/,
    /(教えて|説明して|教えてください|説明してください|どう思う|なんで|なぜ|どうして|いつ|どこ|だれ|誰|何|どれ|どっち)/,
  ];
  if (!questionSignals.some((pattern) => pattern.test(lowered))) {
    return false;
  }

  const workSignals = [
    /\b(fix|implement|change|changed|add|remove|delete|update|refactor|patch|debug|diagnose|investigate|review|write|create|build|run|execute|test|verify|confirm|check|inspect|search|open|read|edit|modify|commit|push|merge|release|deploy|start|stop|restart|resume|compare|convert|migrate|optimize|improve|configure|setup|set up)\b/,
    /(修正|実装|変更|追加|削除|更新|リファクタ|デバッグ|調査|確認|レビュー|書いて|作って|作成|実行|走らせ|テスト|検証|調べて|開いて|読んで|編集|コミット|プッシュ|マージ|デプロイ|再起動|再開|設定)/,
    /\b(git|repo|repository|branch|commit|diff|pull request|pr|issue|ticket|adapter|agentloop|tool|tools|code)\b|コード|src\//,
    /\b(latest|most recent|current|today|now|recent|news|web|internet|api|docs|github|release|version)\b|最新|最新版|今日|現在|最近|今|外部|ネット/,
    /\bwhat\s+(files?\s+)?changed\b|\bwhich\s+files?\s+(changed|were\s+(modified|edited))\b/,
    /(\.(ts|tsx|js|jsx|json|md|yml|yaml|toml|py|go|rs|sh|sql)\b|\/[^/\s]+\.[A-Za-z0-9]+$)/,
  ];
  return !workSignals.some((pattern) => pattern.test(lowered));
}

function selectRouteForText(
  text: string,
  runtimeControl: ChatIngressRuntimeControl,
  deps: IngressRouterCapabilities
): SelectedChatRoute {
  const baseFastPolicy = {
    replyTargetPolicy: "turn_reply_target" as const,
    eventProjectionPolicy: "turn_only" as const,
    concurrencyPolicy: "session_serial" as const,
    daemonChatPolicy: "compatibility_only" as const,
  };
  const baseDurablePolicy = {
    replyTargetPolicy: "turn_reply_target" as const,
    eventProjectionPolicy: "latest_active_reply_target" as const,
    concurrencyPolicy: "session_serial" as const,
    daemonChatPolicy: "compatibility_only" as const,
  };

  if (runtimeControl.allowed && runtimeControl.approvalMode !== "disallowed") {
    const intent = recognizeRuntimeControlIntent(text);
    if (intent !== null) {
      return {
        lane: "durable",
        kind: "runtime_control",
        reason: "runtime_control_intent",
        intent,
        ...baseDurablePolicy,
      };
    }
  }

  if (!deps.hasAgentLoop && deps.hasLightweightLlm && shouldUseDirectAnswerRoute(text)) {
    return {
      lane: "fast",
      kind: "direct_answer",
      reason: "simple_question",
      modelTier: "light",
      maxTokens: 256,
      ...baseFastPolicy,
    };
  }

  if (deps.hasAgentLoop) {
    return {
      lane: "fast",
      kind: "agent_loop",
      reason: "agent_loop_available",
      ...baseFastPolicy,
    };
  }

  if (deps.hasToolLoop) {
    return {
      lane: "fast",
      kind: "tool_loop",
      reason: "tool_loop_available",
      ...baseFastPolicy,
    };
  }

  return {
    lane: "fast",
    kind: "adapter",
    reason: "adapter_fallback",
    ...baseFastPolicy,
  };
}

export class IngressRouter {
  selectRoute(message: ChatIngressMessage, capabilities: IngressRouterCapabilities): SelectedChatRoute {
    return selectRouteForText(message.text, message.runtimeControl, capabilities);
  }
}

export function selectLegacyChatRoute(
  input: string,
  deps: IngressRouterCapabilities
): SelectedChatRoute {
  return selectRouteForText(input, { allowed: true, approvalMode: "interactive" }, deps);
}

function normalizePlatform(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function normalizeIdentity(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function inferActorSurface(channel: IngressChannel): RuntimeControlActor["surface"] {
  switch (channel) {
    case "plugin_gateway":
      return "gateway";
    case "tui":
      return "tui";
    case "cli":
      return "cli";
    case "web":
      return "chat";
  }
}

export interface NormalizeLegacyIngressInput {
  text: string;
  channel?: IngressChannel;
  ingress_id?: string;
  received_at?: string;
  identity_key?: string;
  platform?: string;
  conversation_id?: string;
  user_id?: string;
  user_name?: string;
  sender_id?: string;
  message_id?: string;
  cwd?: string;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
  onEvent?: ChatEventHandler;
  deliveryMode?: IngressDeliveryMode;
  actor?: RuntimeControlActor;
  replyTarget?: Partial<IngressReplyTarget>;
  runtimeControl?: Partial<ChatIngressRuntimeControl>;
}

export function normalizeLegacyIngressInput(input: NormalizeLegacyIngressInput): ChatIngressMessage {
  const channel = input.channel ?? (input.platform ? "plugin_gateway" : "cli");
  const platform = normalizePlatform(input.platform ?? (channel === "tui" ? "local_tui" : undefined));
  const identityKey = normalizeIdentity(input.identity_key);
  const conversationId = normalizeIdentity(input.conversation_id);
  const userId = normalizeIdentity(input.user_id ?? input.sender_id);
  const actorSurface = inferActorSurface(channel);
  const metadata = { ...(input.metadata ?? {}) };
  const preapproved = input.runtimeControl?.approvalMode === "preapproved"
    || input.runtimeControl?.approval_mode === "preapproved"
    || metadata["runtime_control_approved"] === true;
  const interactiveDefault = channel === "tui" || channel === "cli";
  const allowed = input.runtimeControl?.allowed ?? (preapproved || interactiveDefault);
  const approvalMode = input.runtimeControl?.approvalMode
    ?? input.runtimeControl?.approval_mode
    ?? (preapproved ? "preapproved" : interactiveDefault ? "interactive" : "disallowed");

  const actor: RuntimeControlActor = input.actor ?? {
    surface: actorSurface,
    ...(platform ? { platform } : {}),
    ...(conversationId ? { conversation_id: conversationId } : {}),
    ...(identityKey ? { identity_key: identityKey } : {}),
    ...(userId ? { user_id: userId } : {}),
  };
  const replyTarget: IngressReplyTarget = {
    surface: actor.surface,
    channel,
    ...(platform ? { platform } : {}),
    ...(conversationId ? { conversation_id: conversationId } : {}),
    ...(identityKey ? { identity_key: identityKey } : {}),
    ...(userId ? { user_id: userId } : {}),
    ...(input.message_id ? { message_id: input.message_id } : {}),
    metadata,
    ...(input.replyTarget ?? {}),
  };

  return {
    ingress_id: input.ingress_id ?? randomUUID(),
    received_at: input.received_at ?? new Date().toISOString(),
    channel,
    ...(platform ? { platform } : {}),
    ...(identityKey ? { identity_key: identityKey } : {}),
    ...(conversationId ? { conversation_id: conversationId } : {}),
    ...(input.message_id ? { message_id: input.message_id } : {}),
    ...(userId ? { user_id: userId } : {}),
    ...(input.user_name ? { user_name: input.user_name } : {}),
    text: input.text,
    actor,
    runtimeControl: {
      allowed,
      approvalMode,
      approval_mode: approvalMode,
    },
    ...(input.deliveryMode ? { deliveryMode: input.deliveryMode } : {}),
    metadata,
    replyTarget,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.onEvent ? { onEvent: input.onEvent } : {}),
  };
}

export function buildStandaloneIngressMessage(input: NormalizeLegacyIngressInput): ChatIngressMessage {
  return normalizeLegacyIngressInput(input);
}

export function createIngressRouter(): IngressRouter {
  return new IngressRouter();
}

export function describeSelectedRoute(route: SelectedChatRoute): string {
  if (route.kind === "direct_answer") {
    return `${route.lane} ${route.kind} (${route.reason}, ${route.modelTier}, max ${route.maxTokens}, reply=${route.replyTargetPolicy}, events=${route.eventProjectionPolicy}, concurrency=${route.concurrencyPolicy}, daemon=${route.daemonChatPolicy})`;
  }
  return `${route.lane} ${route.kind} (${route.reason}, reply=${route.replyTargetPolicy}, events=${route.eventProjectionPolicy}, concurrency=${route.concurrencyPolicy}, daemon=${route.daemonChatPolicy})`;
}

export type IngressMessage = ChatIngressMessage;
export type IngressRuntimeControl = ChatIngressRuntimeControl;
export type ChatSelectedRoute = SelectedChatRoute;
export type ChatIngressChannel = IngressChannel;
export type ChatIngressReplyTarget = IngressReplyTarget;
