import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { ChatRunner } from "./chat-runner.js";
import type { ChatRunResult, ChatRunnerDeps } from "./chat-runner.js";
import type { ChatEvent, ChatEventHandler } from "./chat-events.js";
import {
  createIngressRouter,
  type ChatIngressChannel,
  type ChatIngressMessage,
  type ChatIngressReplyTarget,
  type ChatIngressRuntimeControl,
  type SelectedChatRoute,
} from "./ingress-router.js";
import { StateManager } from "../../base/state/state-manager.js";
import { buildAdapterRegistry, buildLLMClient } from "../../base/llm/provider-factory.js";
import { loadProviderConfig } from "../../base/llm/provider-config.js";
import { TrustManager } from "../../platform/traits/trust-manager.js";
import { ObservationEngine } from "../../platform/observation/observation-engine.js";
import { KnowledgeManager } from "../../platform/knowledge/knowledge-manager.js";
import { GoalDependencyGraph } from "../../orchestrator/goal/goal-dependency-graph.js";
import { SessionManager } from "../../orchestrator/execution/session-manager.js";
import { ScheduleEngine } from "../../runtime/schedule/engine.js";
import { PluginLoader } from "../../runtime/plugin-loader.js";
import { NotifierRegistry } from "../../runtime/notifier-registry.js";
import { buildCliDataSourceRegistry } from "../cli/data-source-bootstrap.js";
import {
  ConcurrencyController,
  createBuiltinTools,
  ToolExecutor,
  ToolPermissionManager,
  ToolRegistry,
} from "../../tools/index.js";
import {
  createNativeChatAgentLoopRunner,
  createNativeReviewAgentLoopRunner,
  shouldUseNativeTaskAgentLoop,
} from "../../orchestrator/execution/agent-loop/index.js";
import {
  RuntimeControlService,
  createDaemonRuntimeControlExecutor,
} from "../../runtime/control/index.js";
import { registerGlobalCrossPlatformChatSessionManager } from "./cross-platform-session-global.js";
import type { RuntimeControlActor } from "../../runtime/store/runtime-operation-schemas.js";

export interface CrossPlatformChatSessionOptions {
  /**
   * Stable cross-platform join key.
   * When present, sessions with the same identity_key share one ChatRunner session.
   */
  identity_key?: string;
  /** Platform or transport name, e.g. "slack", "discord", "web". */
  platform?: string;
  /** Conversation/thread identifier on the transport. */
  conversation_id?: string;
  /** Human-readable conversation title or thread name. */
  conversation_name?: string;
  /** User identifier on the transport. */
  user_id?: string;
  /** Human-readable user name. */
  user_name?: string;
  /** Channel family for ingress normalization. */
  channel?: ChatIngressChannel;
  /** Optional per-turn message id from the transport. */
  message_id?: string;
  /** Explicit typed actor override for routing/runtime control. */
  actor?: Partial<RuntimeControlActor>;
  /** Explicit reply target override for outbound routing. */
  replyTarget?: Partial<ChatIngressReplyTarget>;
  /** Explicit runtime-control policy for the turn. */
  runtimeControl?: Partial<ChatIngressRuntimeControl>;
  /** Workspace root or working directory used when the session is created. */
  cwd?: string;
  /** Per-turn timeout forwarded to ChatRunner. */
  timeoutMs?: number;
  /** Extra transport metadata for plugins to retain alongside the session. */
  metadata?: Record<string, unknown>;
  /** Optional streaming callback for ChatEvent updates. */
  onEvent?: ChatEventHandler;
}

export interface CrossPlatformIncomingChatMessage {
  text: string;
  channel?: ChatIngressChannel;
  identity_key?: string;
  platform?: string;
  conversation_id?: string;
  conversation_name?: string;
  sender_id?: string;
  user_id?: string;
  user_name?: string;
  message_id?: string;
  cwd?: string;
  timeoutMs?: number;
  actor?: Partial<RuntimeControlActor>;
  replyTarget?: Partial<ChatIngressReplyTarget>;
  runtimeControl?: Partial<ChatIngressRuntimeControl>;
  metadata?: Record<string, unknown>;
  onEvent?: ChatEventHandler;
}

export type CrossPlatformIngressMessage = ChatIngressMessage;

export interface CrossPlatformChatSessionInfo {
  session_key: string;
  identity_key?: string;
  platform?: string;
  conversation_id?: string;
  conversation_name?: string;
  user_id?: string;
  user_name?: string;
  cwd: string;
  created_at: string;
  last_used_at: string;
  last_message_id?: string;
  active_reply_target?: ChatIngressReplyTarget;
  metadata: Record<string, unknown>;
}

interface ManagedChatSession {
  runner: ChatRunner;
  info: CrossPlatformChatSessionInfo;
  queue: Promise<void>;
  lastRoute?: SelectedChatRoute;
}

function normalizeIdentity(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizePlatform(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function buildSessionKeyFromParts(params: {
  identity_key?: string;
  platform?: string;
  conversation_id?: string;
  user_id?: string;
}): string {
  const identityKey = normalizeIdentity(params.identity_key);
  if (identityKey) {
    return `identity:${identityKey}`;
  }

  const platform = normalizePlatform(params.platform);
  const conversationId = normalizeIdentity(params.conversation_id);
  if (platform && conversationId) {
    return `platform:${platform}:conversation:${conversationId}`;
  }

  const userId = normalizeIdentity(params.user_id);
  if (platform && userId) {
    return `platform:${platform}:user:${userId}`;
  }

  return `ephemeral:${randomUUID()}`;
}

function buildSessionKey(options: CrossPlatformChatSessionOptions): string {
  return buildSessionKeyFromParts(options);
}

function cloneMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  return metadata ? { ...metadata } : {};
}

function buildSessionMetadata(options: {
  metadata?: Record<string, unknown>;
  platform?: string;
  conversation_id?: string;
  conversation_name?: string;
  user_id?: string;
  user_name?: string;
  channel?: ChatIngressChannel;
}): Record<string, unknown> {
  return {
    ...(options.metadata ?? {}),
    ...(options.channel ? { channel: options.channel } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.conversation_id ? { conversation_id: options.conversation_id } : {}),
    ...(options.conversation_name ? { conversation_name: options.conversation_name } : {}),
    ...(options.user_id ? { user_id: options.user_id } : {}),
    ...(options.user_name ? { user_name: options.user_name } : {}),
  };
}

function resolveChannel(
  input: Pick<CrossPlatformIncomingChatMessage, "channel" | "platform"> | CrossPlatformChatSessionOptions
): ChatIngressChannel {
  if (input.channel) return input.channel;
  return input.platform ? "plugin_gateway" : "cli";
}

function resolveActorSurface(channel: ChatIngressChannel): RuntimeControlActor["surface"] {
  switch (channel) {
    case "plugin_gateway":
      return "gateway";
    case "cli":
      return "cli";
    case "tui":
      return "tui";
    default:
      return "chat";
  }
}

function resolveRuntimeControl(
  channel: ChatIngressChannel,
  runtimeControl: Partial<ChatIngressRuntimeControl> | undefined,
  metadata: Record<string, unknown> | undefined
): ChatIngressRuntimeControl {
  const approvalMode = runtimeControl?.approvalMode
    ?? (metadata?.["runtime_control_approved"] === true
      ? "preapproved"
      : channel === "tui" || channel === "cli"
        ? "interactive"
        : "disallowed");
  return {
    allowed: runtimeControl?.allowed ?? approvalMode !== "disallowed",
    approvalMode,
  };
}

function normalizeReplyTarget(
  channel: ChatIngressChannel,
  input: {
    platform?: string;
    conversation_id?: string;
    identity_key?: string;
    user_id?: string;
    message_id?: string;
    replyTarget?: Partial<ChatIngressReplyTarget>;
    metadata?: Record<string, unknown>;
  }
): ChatIngressReplyTarget {
  const platform = normalizePlatform(input.replyTarget?.platform ?? input.platform) ?? undefined;
  const conversationId = normalizeIdentity(input.replyTarget?.conversation_id ?? input.conversation_id) ?? undefined;
  const identityKey = normalizeIdentity(input.replyTarget?.identity_key ?? input.identity_key) ?? undefined;
  const userId = normalizeIdentity(input.replyTarget?.user_id ?? input.user_id) ?? undefined;
  const messageId = normalizeIdentity(input.replyTarget?.message_id ?? input.message_id) ?? undefined;

  return {
    surface: input.replyTarget?.surface ?? resolveActorSurface(channel),
    ...(platform ? { platform } : {}),
    ...(conversationId ? { conversation_id: conversationId } : {}),
    ...(identityKey ? { identity_key: identityKey } : {}),
    ...(userId ? { user_id: userId } : {}),
    ...(messageId ? { message_id: messageId } : {}),
    deliveryMode: input.replyTarget?.deliveryMode ?? "reply",
    metadata: {
      ...(input.metadata ?? {}),
      ...(input.replyTarget?.metadata ?? {}),
    },
    ...input.replyTarget,
  };
}

function normalizeActor(
  channel: ChatIngressChannel,
  input: {
    platform?: string;
    conversation_id?: string;
    identity_key?: string;
    user_id?: string;
    actor?: Partial<RuntimeControlActor>;
  }
): RuntimeControlActor {
  const platform = normalizePlatform(input.actor?.platform ?? input.platform) ?? undefined;
  const conversationId = normalizeIdentity(input.actor?.conversation_id ?? input.conversation_id) ?? undefined;
  const identityKey = normalizeIdentity(input.actor?.identity_key ?? input.identity_key) ?? undefined;
  const userId = normalizeIdentity(input.actor?.user_id ?? input.user_id) ?? undefined;

  return {
    surface: input.actor?.surface ?? resolveActorSurface(channel),
    ...(platform ? { platform } : {}),
    ...(conversationId ? { conversation_id: conversationId } : {}),
    ...(identityKey ? { identity_key: identityKey } : {}),
    ...(userId ? { user_id: userId } : {}),
    ...input.actor,
  };
}

function safeInvoke(handler: ChatEventHandler | undefined, event: ChatEvent): void {
  if (!handler) return;
  try {
    const result = handler(event);
    if (result && typeof (result as Promise<void>).catch === "function") {
      void (result as Promise<void>).catch(() => undefined);
    }
  } catch {
    // Event streaming should not break chat delivery.
  }
}

export class CrossPlatformChatSessionManager {
  private readonly sessions = new Map<string, ManagedChatSession>();
  private readonly ingressRouter = createIngressRouter();

  constructor(private readonly deps: ChatRunnerDeps) {}

  /**
   * Execute a chat turn through a session keyed by identity_key.
   * If identity_key is absent, the manager falls back to a deterministic platform-scoped key when possible,
   * otherwise it creates an isolated one-shot session.
   */
  async execute(input: string, options: CrossPlatformChatSessionOptions = {}): Promise<ChatRunResult> {
    const ingress = this.createIngressMessage({
      text: input,
      identity_key: options.identity_key,
      platform: options.platform,
      conversation_id: options.conversation_id,
      conversation_name: options.conversation_name,
      user_id: options.user_id,
      user_name: options.user_name,
      message_id: options.message_id,
      channel: options.channel ?? (options.platform ? "plugin_gateway" : "cli"),
      actor: options.actor,
      replyTarget: options.replyTarget,
      runtimeControl: options.runtimeControl ?? {
        allowed: true,
        approvalMode: "interactive",
      },
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      metadata: options.metadata,
      onEvent: options.onEvent,
    });
    const session = this.getOrCreateSession(ingress, options.cwd);
    const queueEntry = session.queue.then(() => this.executeInSession(session, ingress, options));
    session.queue = queueEntry.then(() => undefined, () => undefined);
    return queueEntry;
  }

  async processIncomingMessage(input: CrossPlatformIncomingChatMessage): Promise<string> {
    const result = await this.executeIngress(this.createIngressMessage(input), input);
    return result.output;
  }

  async executeIngress(
    ingress: CrossPlatformIngressMessage,
    options: Pick<CrossPlatformIncomingChatMessage, "cwd" | "timeoutMs" | "onEvent" | "conversation_name" | "user_name"> = {}
  ): Promise<ChatRunResult> {
    const session = this.getOrCreateSession(ingress, options.cwd);
    const queueEntry = session.queue.then(() => this.executeInSession(session, ingress, options));
    session.queue = queueEntry.then(() => undefined, () => undefined);
    return queueEntry;
  }

  handleIncomingMessage(input: CrossPlatformIncomingChatMessage): Promise<string> {
    return this.processIncomingMessage(input);
  }

  continueConversation(input: CrossPlatformIncomingChatMessage): Promise<string> {
    return this.processIncomingMessage(input);
  }

  processMessage(input: CrossPlatformIncomingChatMessage): Promise<string> {
    return this.processIncomingMessage(input);
  }

  private createIngressMessage(
    input: CrossPlatformIncomingChatMessage | (CrossPlatformChatSessionOptions & { text: string })
  ): CrossPlatformIngressMessage {
    const channel = resolveChannel(input);
    const metadata = {
      ...(input.metadata ?? {}),
      ...("sender_id" in input && input.sender_id ? { sender_id: input.sender_id } : {}),
      ...(input.message_id ? { message_id: input.message_id } : {}),
    };
    const userId = normalizeIdentity(input.user_id ?? ("sender_id" in input ? input.sender_id : undefined)) ?? undefined;
    const platform = normalizePlatform(input.platform) ?? undefined;
    const identityKey = normalizeIdentity(input.identity_key) ?? undefined;
    const conversationId = normalizeIdentity(input.conversation_id) ?? undefined;
    const messageId = normalizeIdentity(input.message_id) ?? undefined;

    return {
      ingress_id: randomUUID(),
      received_at: new Date().toISOString(),
      channel,
      ...(platform ? { platform } : {}),
      ...(identityKey ? { identity_key: identityKey } : {}),
      ...(conversationId ? { conversation_id: conversationId } : {}),
      ...(messageId ? { message_id: messageId } : {}),
      ...(userId ? { user_id: userId } : {}),
      text: input.text,
      actor: normalizeActor(channel, {
        platform,
        conversation_id: conversationId,
        identity_key: identityKey,
        user_id: userId,
        actor: input.actor,
      }),
      runtimeControl: resolveRuntimeControl(channel, input.runtimeControl, metadata),
      metadata,
      replyTarget: normalizeReplyTarget(channel, {
        platform,
        conversation_id: conversationId,
        identity_key: identityKey,
        user_id: userId,
        message_id: messageId,
        replyTarget: input.replyTarget,
        metadata,
      }),
    };
  }

  /**
   * Returns the active session info if a matching session is already loaded.
   */
  getSessionInfo(options: CrossPlatformChatSessionOptions): CrossPlatformChatSessionInfo | null {
    const sessionKey = buildSessionKey(options);
    const session = this.sessions.get(sessionKey);
    return session
      ? {
          ...session.info,
          metadata: cloneMetadata(session.info.metadata),
          active_reply_target: session.info.active_reply_target
            ? {
                ...session.info.active_reply_target,
                metadata: cloneMetadata(session.info.active_reply_target.metadata),
              }
            : undefined,
        }
      : null;
  }

  private getOrCreateSession(
    ingress: Pick<ChatIngressMessage, "identity_key" | "platform" | "conversation_id" | "user_id">,
    cwdOverride?: string
  ): ManagedChatSession {
    const sessionKey = buildSessionKeyFromParts(ingress);
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      return existing;
    }

    const cwd = cwdOverride?.trim() || process.cwd();
    const runner = new ChatRunner(this.deps);
    runner.startSession(cwd);

    const now = new Date().toISOString();
    const info: CrossPlatformChatSessionInfo = {
      session_key: sessionKey,
      identity_key: normalizeIdentity(ingress.identity_key) ?? undefined,
      platform: normalizePlatform(ingress.platform) ?? undefined,
      conversation_id: normalizeIdentity(ingress.conversation_id) ?? undefined,
      user_id: normalizeIdentity(ingress.user_id) ?? undefined,
      cwd,
      created_at: now,
      last_used_at: now,
      metadata: {},
    };

    const created: ManagedChatSession = {
      runner,
      info,
      queue: Promise.resolve(),
      lastRoute: undefined,
    };
    this.sessions.set(sessionKey, created);
    return created;
  }

  private async executeInSession(
    session: ManagedChatSession,
    ingress: CrossPlatformIngressMessage,
    options: Pick<CrossPlatformIncomingChatMessage, "timeoutMs" | "onEvent" | "conversation_name" | "user_name"> = {}
  ): Promise<ChatRunResult> {
    session.info.last_used_at = new Date().toISOString();
    session.info.conversation_name = options.conversation_name?.trim() || session.info.conversation_name;
    session.info.user_id = session.info.user_id ?? (normalizeIdentity(ingress.user_id) ?? undefined);
    session.info.user_name = options.user_name?.trim() || session.info.user_name;
    session.info.last_message_id = normalizeIdentity(ingress.message_id) ?? session.info.last_message_id;
    session.info.active_reply_target = {
      ...ingress.replyTarget,
      metadata: cloneMetadata(ingress.replyTarget.metadata),
    };
    session.info.metadata = cloneMetadata(buildSessionMetadata({
      metadata: ingress.metadata,
      channel: ingress.channel,
      platform: ingress.platform,
      conversation_id: ingress.conversation_id,
      conversation_name: options.conversation_name,
      user_id: ingress.user_id,
      user_name: options.user_name,
    }));

    const selectedRoute = this.ingressRouter.selectRoute(ingress, {
      hasLightweightLlm: this.deps.llmClient !== undefined,
      hasAgentLoop: this.deps.chatAgentLoopRunner !== undefined,
      hasToolLoop: this.deps.llmClient !== undefined,
      hasRuntimeControlService: this.deps.runtimeControlService !== undefined,
    });
    session.lastRoute = selectedRoute;

    const previousOnEvent = session.runner.onEvent;
    if (options.onEvent) {
      const handler = options.onEvent;
      const upstream = this.deps.onEvent;
      session.runner.onEvent = (event: ChatEvent) => {
        safeInvoke(handler, event);
        if (upstream && upstream !== handler) {
          safeInvoke(upstream, event);
        }
      };
    } else {
      session.runner.onEvent = undefined;
    }

    try {
      return await session.runner.executeIngressMessage(
        ingress,
        session.info.cwd,
        options.timeoutMs,
        selectedRoute
      );
    } finally {
      session.runner.onEvent = previousOnEvent;
    }
  }
}

let globalManagerPromise: Promise<CrossPlatformChatSessionManager> | null = null;

export function getGlobalCrossPlatformChatSessionManager(): Promise<CrossPlatformChatSessionManager> {
  if (globalManagerPromise === null) {
    globalManagerPromise = createGlobalCrossPlatformChatSessionManager().catch((err) => {
      globalManagerPromise = null;
      throw err;
    });
  }
  return globalManagerPromise;
}

async function createGlobalCrossPlatformChatSessionManager(): Promise<CrossPlatformChatSessionManager> {
  const providerConfig = await loadProviderConfig();
  const stateManager = new StateManager();
  await stateManager.init();

  const llmClient = await buildLLMClient();
  const adapterRegistry = await buildAdapterRegistry(llmClient, providerConfig);
  const adapter = adapterRegistry.getAdapter(providerConfig.adapter);
  const toolRegistry = new ToolRegistry();
  const trustManager = new TrustManager(stateManager);
  const dataSourceRegistry = await buildCliDataSourceRegistry();
  const observationEngine = new ObservationEngine(
    stateManager,
    dataSourceRegistry.getAllSources(),
    llmClient,
  );
  const knowledgeManager = new KnowledgeManager(stateManager, llmClient);
  const goalDependencyGraph = new GoalDependencyGraph(stateManager, llmClient);
  await goalDependencyGraph.init();
  const sessionManager = new SessionManager(stateManager, goalDependencyGraph);
  const scheduleEngine = new ScheduleEngine({
    baseDir: stateManager.getBaseDir(),
    dataSourceRegistry,
    llmClient,
    stateManager,
    knowledgeManager,
  });
  await scheduleEngine.loadEntries();
  const pluginLoader = new PluginLoader(
    adapterRegistry,
    dataSourceRegistry,
    new NotifierRegistry(),
    undefined,
    undefined,
    (dataSource) => {
      if (!observationEngine.getDataSources().some((source) => source.sourceId === dataSource.sourceId)) {
        observationEngine.addDataSource(dataSource);
      }
    }
  );
  await pluginLoader.loadAll().catch(() => []);
  await scheduleEngine.syncExternalSources(pluginLoader.getScheduleSources()).catch(() => undefined);

  for (const tool of createBuiltinTools({
    stateManager,
    trustManager,
    registry: toolRegistry,
    adapterRegistry,
    knowledgeManager,
    observationEngine,
    sessionManager,
    scheduleEngine,
    pluginLoader,
  })) {
    toolRegistry.register(tool);
  }

  const toolExecutor = new ToolExecutor({
    registry: toolRegistry,
    permissionManager: new ToolPermissionManager({ trustManager }),
    concurrency: new ConcurrencyController(),
  });

  const chatAgentLoopRunner = shouldUseNativeTaskAgentLoop(providerConfig, llmClient)
    ? createNativeChatAgentLoopRunner({
        llmClient,
        providerConfig,
        toolRegistry,
        toolExecutor,
        traceBaseDir: stateManager.getBaseDir(),
      })
    : undefined;
  const reviewAgentLoopRunner = shouldUseNativeTaskAgentLoop(providerConfig, llmClient)
    ? createNativeReviewAgentLoopRunner({
        llmClient,
        providerConfig,
        toolRegistry,
        toolExecutor,
        traceBaseDir: stateManager.getBaseDir(),
      })
    : undefined;

  return new CrossPlatformChatSessionManager({
    stateManager,
    adapter,
    llmClient,
    registry: toolRegistry,
    toolExecutor,
    chatAgentLoopRunner,
    reviewAgentLoopRunner,
    runtimeControlService: new RuntimeControlService({
      runtimeRoot: path.join(stateManager.getBaseDir(), "runtime"),
      executor: createDaemonRuntimeControlExecutor({
        baseDir: stateManager.getBaseDir(),
      }),
    }),
  });
}

registerGlobalCrossPlatformChatSessionManager(getGlobalCrossPlatformChatSessionManager);
