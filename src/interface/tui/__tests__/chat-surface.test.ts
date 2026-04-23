import { describe, it, expect, vi } from "vitest";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { IAdapter, AgentResult } from "../../../orchestrator/execution/adapter-layer.js";
import type { ChatRunnerDeps } from "../../chat/chat-runner.js";
import { SharedManagerTuiChatSurface } from "../chat-surface.js";

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

describe("SharedManagerTuiChatSurface", () => {
  it("keeps a stable TUI conversation id when executeIngressMessage omits one", async () => {
    const stateManager = makeMockStateManager();
    const surface = new SharedManagerTuiChatSurface(makeDeps({ stateManager }));
    surface.startSession("/repo");

    await surface.executeIngressMessage({
      text: "first",
      channel: "tui",
      platform: "local_tui",
      actor: { surface: "tui", platform: "local_tui" },
      replyTarget: { surface: "tui", platform: "local_tui", metadata: {} },
      runtimeControl: { allowed: true, approvalMode: "interactive" },
      metadata: {},
    }, "/repo");

    await surface.executeIngressMessage({
      text: "second",
      channel: "tui",
      platform: "local_tui",
      actor: { surface: "tui", platform: "local_tui" },
      replyTarget: { surface: "tui", platform: "local_tui", metadata: {} },
      runtimeControl: { allowed: true, approvalMode: "interactive" },
      metadata: {},
    }, "/repo");

    const sessionPaths = getSessionPaths(stateManager);
    expect(new Set(sessionPaths).size).toBe(1);
    expect(sessionPaths[0]).toMatch(/^chat\/sessions\/.+\.json$/);
  });
});
