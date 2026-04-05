import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChatRunner } from "../chat-runner.js";
import type { ChatRunnerDeps } from "../chat-runner.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { IAdapter } from "../../../orchestrator/execution/adapter-layer.js";
import type { ITool, ToolCallContext, PermissionCheckResult, ToolResult } from "../../../tools/types.js";
import type { ToolRegistry } from "../../../tools/registry.js";
import { z } from "zod";

// Mock context-provider so tests don't walk the real filesystem
vi.mock("../../../platform/observation/context-provider.js", () => ({
  resolveGitRoot: (cwd: string) => cwd,
  buildChatContext: (_task: string, cwd: string) => Promise.resolve(`Working directory: ${cwd}`),
}));

// ─── Helpers ───

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

/**
 * Build a mock ITool with configurable permission check result.
 */
function makeMockTool(
  name: string,
  permResult: PermissionCheckResult,
  callResult: Partial<ToolResult> = {},
): ITool {
  const callFn = vi.fn().mockResolvedValue({
    success: true,
    data: { done: true },
    summary: `${name} executed`,
    durationMs: 1,
    ...callResult,
  });

  return {
    metadata: {
      name,
      aliases: [],
      permissionLevel: "write_local",
      isReadOnly: false,
      isDestructive: false,
      shouldDefer: false,
      alwaysLoad: false,
      maxConcurrency: 0,
      maxOutputChars: 8000,
      tags: [],
    },
    inputSchema: z.object({ query: z.string().optional() }),
    description: () => `Mock tool: ${name}`,
    call: callFn,
    checkPermissions: vi.fn().mockResolvedValue(permResult),
    isConcurrencySafe: () => true,
  } as unknown as ITool;
}

/**
 * Build a mock ToolRegistry containing a single tool.
 */
function makeMockRegistry(tool: ITool): ToolRegistry {
  return {
    get: vi.fn().mockImplementation((n: string) => (n === tool.metadata.name ? tool : undefined)),
    listAll: vi.fn().mockReturnValue([tool]),
    register: vi.fn(),
  } as unknown as ToolRegistry;
}

/**
 * Build an LLM client that returns one tool_call response, then a final text response.
 * The tool_call uses `toolName` with empty arguments.
 */
function makeLLMClientWithToolCall(toolName: string) {
  return {
    supportsToolCalling: () => true,
    sendMessage: vi.fn()
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          {
            id: "tc-1",
            function: { name: toolName, arguments: "{}" },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 10 },
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({
        content: "Final answer",
        tool_calls: [],
        usage: { input_tokens: 5, output_tokens: 5 },
        stop_reason: "end_turn",
      }),
    parseJSON: vi.fn(),
  };
}

function makeDeps(overrides: Partial<ChatRunnerDeps> = {}): ChatRunnerDeps {
  return {
    stateManager: makeMockStateManager(),
    adapter: makeMockAdapter(),
    ...overrides,
  };
}

// ─── Tests ───

describe("ChatRunner — permission gate (Fix #505)", () => {
  describe("denied permission", () => {
    it("returns denial message and does NOT call tool.call", async () => {
      const tool = makeMockTool("test-tool", { status: "denied", reason: "no access" });
      const registry = makeMockRegistry(tool);
      const llmClient = makeLLMClientWithToolCall("test-tool");

      const runner = new ChatRunner(makeDeps({ registry, llmClient: llmClient as never }));
      const result = await runner.execute("do something", "/repo");

      expect(tool.call).not.toHaveBeenCalled();
      // The LLM receives the denial message as a tool result
      // and the second sendMessage call returns "Final answer"
      expect(result.output).toBe("Final answer");

      // Verify the tool result message sent to LLM contains denial text
      const secondCall = llmClient.sendMessage.mock.calls[1];
      const messages = secondCall[0] as Array<{ role: string; content: string }>;
      const toolResultMsg = messages.find((m) => m.role === "user" && m.content.includes("denied"));
      expect(toolResultMsg).toBeDefined();
      expect(toolResultMsg!.content).toContain("no access");
    });
  });

  describe("needs_approval — approved", () => {
    it("calls approvalFn and then tool.call when approved", async () => {
      const tool = makeMockTool("test-tool", { status: "needs_approval", reason: "requires confirmation" });
      const registry = makeMockRegistry(tool);
      const approvalFn = vi.fn().mockResolvedValue(true);
      const llmClient = makeLLMClientWithToolCall("test-tool");

      const runner = new ChatRunner(makeDeps({ registry, llmClient: llmClient as never, approvalFn }));
      await runner.execute("do something", "/repo");

      expect(approvalFn).toHaveBeenCalledOnce();
      expect(approvalFn).toHaveBeenCalledWith("requires confirmation");
      expect(tool.call).toHaveBeenCalledOnce();
    });
  });

  describe("needs_approval — rejected", () => {
    it("does NOT call tool.call when approvalFn returns false", async () => {
      const tool = makeMockTool("test-tool", { status: "needs_approval", reason: "risky action" });
      const registry = makeMockRegistry(tool);
      const approvalFn = vi.fn().mockResolvedValue(false);
      const llmClient = makeLLMClientWithToolCall("test-tool");

      const runner = new ChatRunner(makeDeps({ registry, llmClient: llmClient as never, approvalFn }));
      const result = await runner.execute("do something", "/repo");

      expect(approvalFn).toHaveBeenCalledOnce();
      expect(tool.call).not.toHaveBeenCalled();

      // The tool result message sent to LLM should indicate "not approved"
      const secondCall = llmClient.sendMessage.mock.calls[1];
      const messages = secondCall[0] as Array<{ role: string; content: string }>;
      const toolResultMsg = messages.find((m) => m.role === "user" && m.content.includes("not approved"));
      expect(toolResultMsg).toBeDefined();
      expect(result.output).toBe("Final answer");
    });
  });

  describe("allowed permission", () => {
    it("calls tool.call directly without invoking approvalFn", async () => {
      const tool = makeMockTool("test-tool", { status: "allowed" });
      const registry = makeMockRegistry(tool);
      const approvalFn = vi.fn().mockResolvedValue(false);
      const llmClient = makeLLMClientWithToolCall("test-tool");

      const runner = new ChatRunner(makeDeps({ registry, llmClient: llmClient as never, approvalFn }));
      await runner.execute("do something", "/repo");

      expect(tool.call).toHaveBeenCalledOnce();
      expect(approvalFn).not.toHaveBeenCalled();
    });
  });

  describe("needs_approval without approvalFn dep", () => {
    it("denies when no approvalFn provided in deps (defaults to false)", async () => {
      const tool = makeMockTool("test-tool", { status: "needs_approval", reason: "needs ok" });
      const registry = makeMockRegistry(tool);
      const llmClient = makeLLMClientWithToolCall("test-tool");

      // No approvalFn in deps — context.approvalFn returns false by default
      const runner = new ChatRunner(makeDeps({ registry, llmClient: llmClient as never }));
      await runner.execute("do something", "/repo");

      expect(tool.call).not.toHaveBeenCalled();
    });
  });
});

describe("ChatRunner — goalId plumbing (Fix #506)", () => {
  describe("goalId passed through to tool context", () => {
    it("tool.call receives context.goalId matching deps.goalId", async () => {
      const tool = makeMockTool("test-tool", { status: "allowed" });
      const registry = makeMockRegistry(tool);
      const llmClient = makeLLMClientWithToolCall("test-tool");

      const runner = new ChatRunner(
        makeDeps({ registry, llmClient: llmClient as never, goalId: "test-goal-123" }),
      );
      await runner.execute("do something", "/repo");

      expect(tool.call).toHaveBeenCalledOnce();
      const ctx = (tool.call as ReturnType<typeof vi.fn>).mock.calls[0][1] as ToolCallContext;
      expect(ctx.goalId).toBe("test-goal-123");
    });
  });

  describe("goalId defaults to empty string when not provided", () => {
    it("context.goalId is empty string when deps.goalId is omitted", async () => {
      const tool = makeMockTool("test-tool", { status: "allowed" });
      const registry = makeMockRegistry(tool);
      const llmClient = makeLLMClientWithToolCall("test-tool");

      // No goalId in deps
      const runner = new ChatRunner(makeDeps({ registry, llmClient: llmClient as never }));
      await runner.execute("do something", "/repo");

      expect(tool.call).toHaveBeenCalledOnce();
      const ctx = (tool.call as ReturnType<typeof vi.fn>).mock.calls[0][1] as ToolCallContext;
      expect(ctx.goalId).toBe("");
    });
  });

  describe("goalId with undefined explicit value", () => {
    it("context.goalId is empty string when deps.goalId is undefined", async () => {
      const tool = makeMockTool("test-tool", { status: "allowed" });
      const registry = makeMockRegistry(tool);
      const llmClient = makeLLMClientWithToolCall("test-tool");

      const runner = new ChatRunner(
        makeDeps({ registry, llmClient: llmClient as never, goalId: undefined }),
      );
      await runner.execute("do something", "/repo");

      expect(tool.call).toHaveBeenCalledOnce();
      const ctx = (tool.call as ReturnType<typeof vi.fn>).mock.calls[0][1] as ToolCallContext;
      expect(ctx.goalId).toBe("");
    });
  });
});
