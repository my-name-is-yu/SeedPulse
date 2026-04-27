import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatRunner } from "../chat-runner.js";
import type { ChatRunnerDeps } from "../chat-runner.js";
import { StateManager as RealStateManager } from "../../../base/state/state-manager.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { IAdapter } from "../../../orchestrator/execution/adapter-layer.js";
import type { ChatAgentLoopRunner } from "../../../orchestrator/execution/agent-loop/chat-agent-loop-runner.js";
import type { ReviewAgentLoopRunner } from "../../../orchestrator/execution/agent-loop/review-agent-loop-runner.js";
import { ChatSessionCatalog } from "../chat-session-store.js";

vi.mock("../../../platform/observation/context-provider.js", () => ({
  resolveGitRoot: (cwd: string) => cwd,
  buildChatContext: (_task: string, cwd: string) => Promise.resolve(`Working directory: ${cwd}`),
}));

vi.mock("../../../base/llm/provider-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../base/llm/provider-config.js")>();
  return {
    ...actual,
    loadProviderConfig: vi.fn().mockResolvedValue({
      provider: "openai",
      model: "gpt-5.4-mini",
      adapter: "openai_codex_cli",
      agent_loop: {
        security: {
          sandbox_mode: "workspace_write",
          approval_policy: "on_request",
          network_access: false,
          trust_project_instructions: true,
        },
      },
    }),
  };
});

function makeMockStateManager(): StateManager {
  return {
    writeRaw: vi.fn().mockResolvedValue(undefined),
    readRaw: vi.fn().mockResolvedValue(null),
  } as unknown as StateManager;
}

function makeMockAdapter(): IAdapter {
  return {
    adapterType: "mock",
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: "adapter output",
      error: null,
      exit_code: 0,
      elapsed_ms: 10,
      stopped_reason: "completed",
    }),
  } as unknown as IAdapter;
}

function makeDeps(overrides: Partial<ChatRunnerDeps> = {}): ChatRunnerDeps {
  return {
    stateManager: makeMockStateManager(),
    adapter: makeMockAdapter(),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ChatRunner policy commands", () => {
  it("/permissions shows the current execution policy", async () => {
    const runner = new ChatRunner(makeDeps());
    runner.startSession("/repo");

    const result = await runner.execute("/permissions", "/repo");

    expect(result.success).toBe(true);
    expect(result.output).toContain("sandbox_mode: workspace_write");
    expect(result.output).toContain("network_access: off");
  });

  it("/permissions updates sandbox and network settings for the session", async () => {
    const runner = new ChatRunner(makeDeps());
    runner.startSession("/repo");

    const result = await runner.execute("/permissions read-only network on approval never", "/repo");

    expect(result.success).toBe(true);
    expect(result.output).toContain("sandbox_mode: read_only");
    expect(result.output).toContain("network_access: on");
    expect(result.output).toContain("approval_policy: never");
  });

  it("/review falls back to a read-only summary when no runner is configured", async () => {
    const runner = new ChatRunner(makeDeps());
    runner.startSession("/repo");

    const result = await runner.execute("/review", "/repo");

    expect(result.success).toBe(true);
    expect(result.output).toContain("Review summary");
    expect(result.output).toContain("Execution policy");
    expect(result.output).toContain("sandbox_mode: read_only");
    expect(result.output).toContain("approval_policy: never");
  });

  it("/review routes through the native review runner with read-only semantics", async () => {
    const reviewAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "review output",
        review: null,
      }),
    } as Pick<ReviewAgentLoopRunner, "execute">;
    const runner = new ChatRunner(makeDeps({ reviewAgentLoopRunner }));
    runner.startSession("/repo");

    await runner.execute("/permissions workspace-write network on approval on_request", "/repo");
    const result = await runner.execute("/review", "/repo");

    expect(result.success).toBe(true);
    expect(result.output).toBe("review output");
    expect(reviewAgentLoopRunner.execute).toHaveBeenCalledOnce();
    const input = vi.mocked(reviewAgentLoopRunner.execute).mock.calls[0]?.[0] as {
      executionPolicy?: { sandboxMode?: string; approvalPolicy?: string; networkAccess?: boolean };
    };
    expect(input.executionPolicy?.sandboxMode).toBe("read_only");
    expect(input.executionPolicy?.approvalPolicy).toBe("never");
    expect(input.executionPolicy?.networkAccess).toBe(true);
  });

  it("/fork creates a new session id", async () => {
    const runner = new ChatRunner(makeDeps());
    runner.startSession("/repo");
    const before = runner.getSessionId();

    const result = await runner.execute("/fork Branch copy", "/repo");
    const after = runner.getSessionId();

    expect(result.success).toBe(true);
    expect(after).not.toBe(before);
    expect(result.output).toContain("Forked chat session");
  });

  it("/fork clears stale native agentloop metadata from the new session", async () => {
    const stateManager = makeMockStateManager();
    const runner = new ChatRunner(makeDeps({ stateManager }));
    runner.startSessionFromLoadedSession({
      id: "source-session",
      cwd: "/repo",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:01:00.000Z",
      title: "Source",
      messages: [
        { role: "user", content: "continue", timestamp: "2026-04-01T00:00:00.000Z", turnIndex: 0 },
      ],
      agentLoopStatePath: "chat/agentloop/source-session.state.json",
      agentLoopStatus: "running",
      agentLoopResumable: true,
      agentLoopUpdatedAt: "2026-04-01T00:02:00.000Z",
      agentLoop: {
        statePath: "chat/agentloop/source-session.state.json",
        status: "running",
        resumable: true,
        updatedAt: "2026-04-01T00:02:00.000Z",
      },
    });

    const result = await runner.execute("/fork Branch copy", "/repo");

    expect(result.success).toBe(true);
    const writeCalls = vi.mocked(stateManager.writeRaw).mock.calls;
    expect(writeCalls.length).toBeGreaterThan(0);
    const persistedSession = writeCalls.at(-1)?.[1] as Record<string, unknown>;
    expect(persistedSession["id"]).not.toBe("source-session");
    expect(persistedSession["agentLoopStatePath"]).toBe(`chat/agentloop/${persistedSession["id"]}.state.json`);
    expect(persistedSession["agentLoopStatus"]).toBeUndefined();
    expect(persistedSession["agentLoopResumable"]).toBeUndefined();
    expect(persistedSession["agentLoopUpdatedAt"]).toBeUndefined();
    expect(persistedSession["agentLoop"]).toBeUndefined();
  });

  it("loaded sessions do not rewrite stale nested agentloop metadata on the next persist", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-fork-load-persist-"));
    try {
      const stateManager = new RealStateManager(tmpDir);
      await stateManager.init();
      await stateManager.writeRaw("chat/sessions/forked-session.json", {
        id: "forked-session",
        cwd: "/repo",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:01:00.000Z",
        title: "Forked Session",
        messages: [],
        agentLoopStatePath: "chat/agentloop/forked-session.state.json",
        agentLoop: {
          statePath: "chat/agentloop/source-session.state.json",
          status: "running",
          resumable: true,
          updatedAt: "2026-04-01T00:02:00.000Z",
        },
      });
      await stateManager.writeRaw("chat/agentloop/source-session.state.json", {
        sessionId: "source-session",
        traceId: "trace-source",
        turnId: "turn-source",
        goalId: "chat",
        cwd: "/repo",
        modelRef: "native:test",
        messages: [],
        modelTurns: 1,
        toolCalls: 0,
        compactions: 0,
        completionValidationAttempts: 0,
        calledTools: [],
        lastToolLoopSignature: null,
        repeatedToolLoopCount: 0,
        finalText: "",
        status: "failed",
        updatedAt: "2026-04-01T00:02:00.000Z",
      });

      const catalog = new ChatSessionCatalog(stateManager);
      const loaded = await catalog.loadSession("forked-session");
      expect(loaded).not.toBeNull();

      const runner = new ChatRunner(makeDeps({ stateManager, adapter: makeMockAdapter() }));
      runner.startSessionFromLoadedSession(loaded!);
      const result = await runner.execute("/title Renamed Session", "/repo");

      expect(result.success).toBe(true);
      const persisted = await stateManager.readRaw("chat/sessions/forked-session.json") as Record<string, unknown>;
      expect(persisted["agentLoopStatePath"]).toBe("chat/agentloop/forked-session.state.json");
      expect(persisted["agentLoopStatus"]).toBeUndefined();
      expect(persisted["agentLoopResumable"]).toBeUndefined();
      expect(persisted["agentLoopUpdatedAt"]).toBeUndefined();
      expect(persisted["agentLoop"]).toEqual({
        statePath: "chat/agentloop/forked-session.state.json",
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loaded sessions keep stale nested agentloop metadata cleared on a normal chat turn", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-normal-persist-"));
    try {
      const stateManager = new RealStateManager(tmpDir);
      await stateManager.init();
      await stateManager.writeRaw("chat/sessions/forked-session.json", {
        id: "forked-session",
        cwd: "/repo",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:01:00.000Z",
        title: "Forked Session",
        messages: [],
        agentLoopStatePath: "chat/agentloop/forked-session.state.json",
        agentLoop: {
          statePath: "chat/agentloop/source-session.state.json",
          status: "running",
          resumable: true,
          updatedAt: "2026-04-01T00:02:00.000Z",
        },
      });
      await stateManager.writeRaw("chat/agentloop/source-session.state.json", {
        sessionId: "source-session",
        traceId: "trace-source",
        turnId: "turn-source",
        goalId: "chat",
        cwd: "/repo",
        modelRef: "native:test",
        messages: [],
        modelTurns: 1,
        toolCalls: 0,
        compactions: 0,
        completionValidationAttempts: 0,
        calledTools: [],
        lastToolLoopSignature: null,
        repeatedToolLoopCount: 0,
        finalText: "",
        status: "failed",
        updatedAt: "2026-04-01T00:02:00.000Z",
      });

      const catalog = new ChatSessionCatalog(stateManager);
      const loaded = await catalog.loadSession("forked-session");
      expect(loaded).not.toBeNull();

      const runner = new ChatRunner(makeDeps({ stateManager, adapter: makeMockAdapter() }));
      runner.startSessionFromLoadedSession(loaded!);
      const result = await runner.execute("Continue from here", "/repo");

      expect(result.success).toBe(true);
      const persisted = await stateManager.readRaw("chat/sessions/forked-session.json") as Record<string, unknown>;
      expect(persisted["agentLoopStatePath"]).toBe("chat/agentloop/forked-session.state.json");
      expect(persisted["agentLoopStatus"]).toBeUndefined();
      expect(persisted["agentLoopResumable"]).toBeUndefined();
      expect(persisted["agentLoopUpdatedAt"]).toBeUndefined();
      expect(persisted["agentLoop"]).toEqual({
        statePath: "chat/agentloop/forked-session.state.json",
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("/undo removes the latest turn from chat history", async () => {
    const runner = new ChatRunner(makeDeps());
    runner.startSession("/repo");

    await runner.execute("Do something", "/repo");
    expect(runner.getCurrentSessionMessages().length).toBe(2);

    const result = await runner.execute("/undo", "/repo");

    expect(result.success).toBe(true);
    expect(runner.getCurrentSessionMessages().length).toBe(0);
    expect(result.output).toContain("File changes were not reverted");
  });

  it("/permissions updates the execution policy used by native agentloop", async () => {
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "agentloop output",
        error: null,
        exit_code: 0,
        elapsed_ms: 10,
        stopped_reason: "completed",
      }),
    } as unknown as ChatAgentLoopRunner;
    const runner = new ChatRunner(makeDeps({ chatAgentLoopRunner }));
    runner.startSession("/repo");

    await runner.execute("/permissions read-only network on", "/repo");
    const result = await runner.execute("Run with agentloop", "/repo");

    expect(result.success).toBe(true);
    expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce();
    const input = vi.mocked(chatAgentLoopRunner.execute).mock.calls[0][0] as {
      toolCallContext?: { executionPolicy?: { sandboxMode: string; networkAccess: boolean } };
    };
    expect(input.toolCallContext?.executionPolicy?.sandboxMode).toBe("read_only");
    expect(input.toolCallContext?.executionPolicy?.networkAccess).toBe(true);
  });
});
