import { describe, it, expect, vi } from "vitest";
import { CrossPlatformChatSessionManager } from "../cross-platform-session.js";
import type { CrossPlatformChatSessionOptions } from "../cross-platform-session.js";
import type { ChatRunnerDeps } from "../chat-runner.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { IAdapter, AgentResult } from "../../../orchestrator/execution/adapter-layer.js";

vi.mock("../../../platform/observation/context-provider.js", () => ({
  resolveGitRoot: (cwd: string) => cwd,
  buildChatContext: (_task: string, cwd: string) => Promise.resolve(`Working directory: ${cwd}`),
}));

const CANNED_RESULT: AgentResult = {
  success: true,
  output: "Task completed successfully.",
  error: null,
  exit_code: 0,
  elapsed_ms: 50,
  stopped_reason: "completed",
};

function makeMockAdapter(result: AgentResult = CANNED_RESULT): IAdapter {
  return {
    adapterType: "mock",
    execute: vi.fn().mockResolvedValue(result),
  } as unknown as IAdapter;
}

function makeMockStateManager(): StateManager {
  return {
    writeRaw: vi.fn().mockResolvedValue(undefined),
    readRaw: vi.fn().mockResolvedValue(null),
  } as unknown as StateManager;
}

function makeDeps(overrides: Partial<ChatRunnerDeps> = {}): ChatRunnerDeps {
  return {
    stateManager: makeMockStateManager(),
    adapter: makeMockAdapter(),
    ...overrides,
  };
}

function getSessionPaths(stateManager: StateManager): string[] {
  const writeRawMock = stateManager.writeRaw as ReturnType<typeof vi.fn>;
  return writeRawMock.mock.calls
    .map((call: unknown[]) => call[0] as string)
    .filter((path: string) => path.startsWith("chat/sessions/"));
}

describe("CrossPlatformChatSessionManager", () => {
  it("reuses the same ChatRunner session for the same identity_key across platforms", async () => {
    const stateManager = makeMockStateManager();
    const manager = new CrossPlatformChatSessionManager(makeDeps({ stateManager }));
    const events: string[] = [];

    const first = await manager.execute("hello from slack", {
      identity_key: "user-123",
      platform: "slack",
      conversation_id: "conv-1",
      user_id: "user-a",
      cwd: "/repo",
      onEvent: (event) => {
        events.push(event.type);
      },
    });

    const second = await manager.execute("hello from discord", {
      identity_key: "user-123",
      platform: "discord",
      conversation_id: "thread-9",
      user_id: "user-a",
      cwd: "/repo",
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    const sessionPaths = getSessionPaths(stateManager);
    expect(new Set(sessionPaths).size).toBe(1);
    expect(sessionPaths[0]).toMatch(/^chat\/sessions\/.+\.json$/);

    const info = manager.getSessionInfo({ identity_key: "user-123" } satisfies CrossPlatformChatSessionOptions);
    expect(info).not.toBeNull();
    expect(info?.identity_key).toBe("user-123");
    expect(info?.platform).toBe("slack");
    expect(info?.conversation_id).toBe("conv-1");
    expect(info?.cwd).toBe("/repo");
    expect(info?.metadata).toMatchObject({
      channel: "plugin_gateway",
      platform: "discord",
      conversation_id: "thread-9",
      user_id: "user-a",
    });
    expect(info?.active_reply_target).toMatchObject({
      surface: "gateway",
      platform: "discord",
      conversation_id: "thread-9",
      identity_key: "user-123",
      user_id: "user-a",
    });

    expect(events).toContain("lifecycle_start");
    expect(events).toContain("assistant_final");
  });

  it("keeps sessions isolated when identity_key is omitted", async () => {
    const stateManager = makeMockStateManager();
    const manager = new CrossPlatformChatSessionManager(makeDeps({ stateManager }));

    const sharedOptions: Omit<CrossPlatformChatSessionOptions, "identity_key" | "platform"> = {
      conversation_id: "conv-1",
      user_id: "user-a",
      cwd: "/repo",
    };

    await manager.execute("hello from slack", {
      ...sharedOptions,
      platform: "slack",
    });

    await manager.execute("hello from discord", {
      ...sharedOptions,
      platform: "discord",
    });

    const sessionPaths = getSessionPaths(stateManager);
    expect(new Set(sessionPaths).size).toBe(2);
  });

  it("streams ChatEvent updates through the per-turn callback", async () => {
    const stateManager = makeMockStateManager();
    const manager = new CrossPlatformChatSessionManager(makeDeps({ stateManager }));
    const events: Array<{ type: string; text?: string }> = [];

    const result = await manager.execute("stream this turn", {
      identity_key: "stream-user",
      platform: "web",
      conversation_id: "web-1",
      cwd: "/repo",
      onEvent: (event) => {
        events.push({ type: event.type, text: "text" in event ? event.text : undefined });
      },
    });

    expect(result.success).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "lifecycle_start")).toBe(true);
    expect(events.some((event) => event.type === "assistant_delta")).toBe(true);
    expect(events.some((event) => event.type === "assistant_final")).toBe(true);
    expect(events.at(-1)?.type).toBe("lifecycle_end");
  });

  it("returns recovery guidance for gateway-visible failures", async () => {
    const adapter = makeMockAdapter({
      ...CANNED_RESULT,
      success: false,
      output: "Agent failed",
      error: "boom",
      exit_code: 1,
    });
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      adapter,
    }));

    const result = await manager.processIncomingMessage({
      text: "do risky work",
      platform: "slack",
      conversation_id: "C_GENERAL",
      sender_id: "U123",
      cwd: "/repo",
    });

    expect(result).toContain("Agent failed");
    expect(result).toContain("Recovery");
    expect(result).toContain("Next actions");
  });

  it("routes natural-language restart with the current platform reply target", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const runtimeControlService = {
      request: vi.fn().mockResolvedValue({
        success: true,
        message: "restart queued",
        operationId: "op-1",
        state: "acknowledged",
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      runtimeControlService,
      approvalFn: vi.fn().mockResolvedValue(true),
    }));

    const result = await manager.execute("PulSeed を再起動して", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("restart queued");
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(runtimeControlService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({ kind: "restart_daemon" }),
        replyTarget: expect.objectContaining({
          surface: "gateway",
          platform: "telegram",
          conversation_id: "telegram-chat-1",
          identity_key: "owner",
          user_id: "user-1",
        }),
        requestedBy: expect.objectContaining({
          surface: "gateway",
          platform: "telegram",
          conversation_id: "telegram-chat-1",
        }),
      })
    );

    const info = manager.getSessionInfo({ identity_key: "owner" });
    expect(info?.active_reply_target).toMatchObject({
      surface: "gateway",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      identity_key: "owner",
      user_id: "user-1",
    });
  });

  it("routes long-running work through durable tend with the current session target", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const llmClient = {
      supportsToolCalling: () => true,
      sendMessage: vi.fn().mockResolvedValue({
        content: "Keep improving the requested work until the target is reached.",
        usage: { input_tokens: 7, output_tokens: 9 },
        stop_reason: "stop",
      }),
      parseJSON: vi.fn(),
    };
    const goalNegotiator = {
      negotiate: vi.fn().mockResolvedValue({
        goal: {
          id: "goal-long",
          title: "Reach the long-running target",
          description: "Keep improving the requested work.",
          dimensions: [],
          constraints: [],
          created_at: "2026-04-26T00:00:00.000Z",
          updated_at: "2026-04-26T00:00:00.000Z",
        },
      }),
    };
    const daemonClient = {
      startGoal: vi.fn().mockResolvedValue(undefined),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      llmClient: llmClient as never,
      goalNegotiator: goalNegotiator as never,
      daemonClient: daemonClient as never,
    }));

    const result = await manager.execute("coreloopの方でscore0.98行くまで取り組んで", {
      identity_key: "owner",
      channel: "tui",
      platform: "local_tui",
      conversation_id: "tui-session",
      cwd: "/repo",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Tend to this goal?");
    expect(result.output).toContain("Reach the long-running target");
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(llmClient.sendMessage).toHaveBeenCalledOnce();
    expect(daemonClient.startGoal).not.toHaveBeenCalled();
  });

  it("serializes concurrent turns for the same shared session across channels", async () => {
    let activeCalls = 0;
    let maxConcurrentCalls = 0;
    const adapter = {
      adapterType: "mock",
      execute: vi.fn().mockImplementation(async () => {
        activeCalls += 1;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeCalls -= 1;
        return CANNED_RESULT;
      }),
    } as unknown as IAdapter;
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      adapter,
    }));

    await Promise.all([
      manager.processIncomingMessage({
        text: "turn one",
        identity_key: "shared-user",
        platform: "discord",
        conversation_id: "discord-1",
        sender_id: "u-1",
        cwd: "/repo",
      }),
      manager.processIncomingMessage({
        text: "turn two",
        identity_key: "shared-user",
        platform: "telegram",
        conversation_id: "telegram-2",
        sender_id: "u-1",
        cwd: "/repo",
      }),
    ]);

    expect(adapter.execute).toHaveBeenCalledTimes(2);
    expect(maxConcurrentCalls).toBe(1);
  });

  it("passes gateway-routed goal_id into ChatRunner agent-loop execution", async () => {
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "Agent loop response",
        error: null,
        exit_code: 0,
        elapsed_ms: 42,
        stopped_reason: "completed",
      }),
    };
    const adapter = makeMockAdapter();
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      adapter,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
    }));

    const result = await manager.processIncomingMessage({
      text: "implement this",
      platform: "slack",
      conversation_id: "C_GENERAL",
      sender_id: "U123",
      goal_id: "goal-routed",
      metadata: { goal_id: "goal-metadata-only" },
      cwd: "/repo",
    });
    await manager.processIncomingMessage({
      text: "implement next thing",
      platform: "slack",
      conversation_id: "C_GENERAL",
      sender_id: "U123",
      goal_id: "goal-next",
      cwd: "/repo",
    });

    expect(result).toBe("Agent loop response");
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(chatAgentLoopRunner.execute).toHaveBeenCalledTimes(2);
    expect(chatAgentLoopRunner.execute).toHaveBeenNthCalledWith(1, expect.objectContaining({
      goalId: "goal-routed",
    }));
    expect(chatAgentLoopRunner.execute).toHaveBeenNthCalledWith(2, expect.objectContaining({
      goalId: "goal-next",
    }));
  });
});
