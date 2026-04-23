import { randomUUID } from "node:crypto";
import type { ChatEventHandler } from "../chat/chat-events.js";
import type { ChatRunResult, ChatRunnerDeps } from "../chat/chat-runner.js";
import { CrossPlatformChatSessionManager } from "../chat/cross-platform-session.js";
import type { CrossPlatformIngressMessage } from "../chat/cross-platform-session.js";

export interface TuiChatSurface {
  onEvent?: ChatEventHandler;
  startSession(cwd: string): void;
  execute(input: string, cwd: string): Promise<ChatRunResult>;
  executeIngressMessage(ingress: CrossPlatformIngressMessage, cwd: string): Promise<ChatRunResult>;
}

export class SharedManagerTuiChatSurface implements TuiChatSurface {
  onEvent: ChatEventHandler | undefined = undefined;

  private readonly conversationId = randomUUID();
  private sessionCwd: string | null = null;
  private readonly manager: CrossPlatformChatSessionManager;

  constructor(deps: ChatRunnerDeps) {
    this.manager = new CrossPlatformChatSessionManager(deps);
  }

  startSession(cwd: string): void {
    this.sessionCwd = cwd;
  }

  execute(input: string, cwd: string): Promise<ChatRunResult> {
    const effectiveCwd = this.sessionCwd ?? cwd;
    return this.manager.execute(input, {
      channel: "tui",
      platform: "local_tui",
      conversation_id: this.conversationId,
      cwd: effectiveCwd,
      onEvent: this.onEvent,
      runtimeControl: {
        allowed: true,
        approvalMode: "interactive",
      },
      replyTarget: {
        surface: "tui",
        channel: "tui",
        platform: "local_tui",
        conversation_id: this.conversationId,
      },
    });
  }

  executeIngressMessage(ingress: CrossPlatformIngressMessage, cwd: string): Promise<ChatRunResult> {
    const effectiveCwd = this.sessionCwd ?? cwd;
    return this.manager.executeIngress({
      ...ingress,
      channel: ingress.channel ?? "tui",
      platform: ingress.platform ?? "local_tui",
      conversation_id: ingress.conversation_id ?? this.conversationId,
      replyTarget: {
        ...ingress.replyTarget,
        channel: ingress.replyTarget?.channel ?? "tui",
        platform: ingress.replyTarget?.platform ?? ingress.platform ?? "local_tui",
        conversation_id: ingress.replyTarget?.conversation_id ?? ingress.conversation_id ?? this.conversationId,
      },
      actor: {
        ...ingress.actor,
        surface: ingress.actor?.surface ?? "tui",
        platform: ingress.actor?.platform ?? ingress.platform ?? "local_tui",
        conversation_id: ingress.actor?.conversation_id ?? ingress.conversation_id ?? this.conversationId,
      },
    }, {
      cwd: effectiveCwd,
      onEvent: this.onEvent,
    });
  }
}
