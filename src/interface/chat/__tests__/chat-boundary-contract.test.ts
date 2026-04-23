import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateManager } from "../../../base/state/state-manager.js";
import type { IAdapter, AgentResult } from "../../../orchestrator/execution/adapter-layer.js";
import {
  BoundedAgentLoopRunner,
  ChatAgentLoopRunner,
  JsonAgentLoopSessionStateStore,
  StaticAgentLoopModelRegistry,
  ToolExecutorAgentLoopToolRuntime,
  ToolRegistryAgentLoopToolRouter,
  createAgentLoopSession,
  defaultAgentLoopCapabilities,
  type AgentLoopModelClient,
  type AgentLoopModelInfo,
  type AgentLoopModelRequest,
  type AgentLoopModelResponse,
} from "../../../orchestrator/execution/agent-loop/index.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { ToolExecutor } from "../../../tools/executor.js";
import { ToolPermissionManager } from "../../../tools/permission.js";
import { ConcurrencyController } from "../../../tools/concurrency.js";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { ChatRunner } from "../chat-runner.js";
import { SharedManagerTuiChatSurface } from "../../tui/chat-surface.js";
import { CrossPlatformChatSessionManager } from "../cross-platform-session.js";

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

class ScriptedModelClient implements AgentLoopModelClient {
  calls: AgentLoopModelRequest[] = [];
  private index = 0;

  constructor(
    private readonly modelInfo: AgentLoopModelInfo,
    private readonly responses: AgentLoopModelResponse[],
  ) {}

  async getModelInfo(): Promise<AgentLoopModelInfo> {
    return this.modelInfo;
  }

  async createTurn(input: AgentLoopModelRequest): Promise<AgentLoopModelResponse> {
    this.calls.push(input);
    return this.responses[this.index++] ?? this.responses[this.responses.length - 1];
  }
}

function makeModelInfo(): AgentLoopModelInfo {
  return {
    ref: { providerId: "test", modelId: "model" },
    displayName: "test/model",
    capabilities: { ...defaultAgentLoopCapabilities },
  };
}

function makeMockAdapter(result: AgentResult = CANNED_RESULT): IAdapter {
  return {
    adapterType: "mock",
    execute: vi.fn().mockResolvedValue(result),
  } as unknown as IAdapter;
}

function makeRuntime(registry: ToolRegistry) {
  const router = new ToolRegistryAgentLoopToolRouter(registry);
  const executor = new ToolExecutor({
    registry,
    permissionManager: new ToolPermissionManager({}),
    concurrency: new ConcurrencyController(),
  });
  return {
    router,
    runtime: new ToolExecutorAgentLoopToolRuntime(executor, router),
  };
}

function makeChatAgentLoopRunner(
  stateDir: string,
  modelClient: ScriptedModelClient,
  observedStatePaths: string[] = [],
): ChatAgentLoopRunner {
  const registry = new ToolRegistry();
  const { router, runtime } = makeRuntime(registry);
  const modelInfo = makeModelInfo();
  return new ChatAgentLoopRunner({
    boundedRunner: new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime }),
    modelClient,
    modelRegistry: new StaticAgentLoopModelRegistry([modelInfo]),
    defaultModel: modelInfo.ref,
    createSession: (input) => {
      const statePath = path.join(stateDir, input.resumeStatePath ?? "chat/agentloop/fallback.state.json");
      observedStatePaths.push(statePath);
      return createAgentLoopSession({
        sessionId: input.sessionId,
        traceId: input.traceId,
        eventSink: input.eventSink,
        stateStore: new JsonAgentLoopSessionStateStore(statePath),
      });
    },
  });
}

function makeModelClient(): ScriptedModelClient {
  const modelInfo = makeModelInfo();
  return new ScriptedModelClient(modelInfo, [
    {
      content: JSON.stringify({ status: "done", message: "first", evidence: [], blockers: [] }),
      toolCalls: [],
      stopReason: "end_turn",
    },
    {
      content: JSON.stringify({ status: "done", message: "second", evidence: [], blockers: [] }),
      toolCalls: [],
      stopReason: "end_turn",
    },
  ]);
}

function lastUserMessage(call: AgentLoopModelRequest | undefined): string {
  return [...(call?.messages ?? [])].reverse().find((message) => message.role === "user")?.content ?? "";
}

const tempDirs: string[] = [];

function trackedTempDir(): string {
  const dir = makeTempDir();
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    cleanupTempDir(tempDirs.pop()!);
  }
  vi.restoreAllMocks();
});

describe("chat boundary contracts", () => {
  it("ChatRunner normal turns reuse the state path without resuming stale native agentloop state", async () => {
    const stateDir = trackedTempDir();
    const workspaceDir = trackedTempDir();
    const stateManager = new StateManager(stateDir);
    await stateManager.init();
    const modelClient = makeModelClient();
    const statePaths: string[] = [];
    const chatAgentLoopRunner = makeChatAgentLoopRunner(stateDir, modelClient, statePaths);
    const runner = new ChatRunner({
      stateManager,
      adapter: makeMockAdapter(),
      chatAgentLoopRunner,
    });
    runner.startSession(workspaceDir);

    await runner.execute("first input", workspaceDir);
    await runner.execute("second input", workspaceDir);

    expect(modelClient.calls).toHaveLength(2);
    expect(new Set(statePaths).size).toBe(1);
    expect(lastUserMessage(modelClient.calls[0])).toContain("first input");
    const secondLastUser = lastUserMessage(modelClient.calls[1]);
    expect(secondLastUser).toContain("second input");
    expect(secondLastUser).not.toContain("first input");
  });

  it("TUI surface normal turns keep the latest input when native agentloop state path is reused", async () => {
    const stateDir = trackedTempDir();
    const workspaceDir = trackedTempDir();
    const stateManager = new StateManager(stateDir);
    await stateManager.init();
    const modelClient = makeModelClient();
    const statePaths: string[] = [];
    const chatAgentLoopRunner = makeChatAgentLoopRunner(stateDir, modelClient, statePaths);
    const surface = new SharedManagerTuiChatSurface({
      stateManager,
      adapter: makeMockAdapter(),
      chatAgentLoopRunner,
    });
    surface.startSession(workspaceDir);

    await surface.execute("first tui input", workspaceDir);
    await surface.execute("second tui input", workspaceDir);

    expect(modelClient.calls).toHaveLength(2);
    expect(new Set(statePaths).size).toBe(1);
    expect(lastUserMessage(modelClient.calls[0])).toContain("first tui input");
    const secondLastUser = lastUserMessage(modelClient.calls[1]);
    expect(secondLastUser).toContain("second tui input");
    expect(secondLastUser).not.toContain("first tui input");
  });

  it("shared gateway sessions route runtime control to the latest turn reply target", async () => {
    const stateDir = trackedTempDir();
    const workspaceDir = trackedTempDir();
    const stateManager = new StateManager(stateDir);
    await stateManager.init();
    const runtimeControlService = {
      request: vi.fn().mockResolvedValue({
        success: true,
        message: "restart queued",
        operationId: "op-1",
        state: "acknowledged",
      }),
    };
    const manager = new CrossPlatformChatSessionManager({
      stateManager,
      adapter: makeMockAdapter(),
      runtimeControlService,
      approvalFn: vi.fn().mockResolvedValue(true),
    });

    await manager.execute("hello from slack", {
      identity_key: "owner",
      platform: "slack",
      conversation_id: "slack-thread-1",
      user_id: "user-1",
      cwd: workspaceDir,
    });
    await manager.execute("PulSeed を再起動して", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: workspaceDir,
    });

    expect(runtimeControlService.request).toHaveBeenCalledOnce();
    expect(runtimeControlService.request).toHaveBeenCalledWith(
      expect.objectContaining({
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
  });
});
