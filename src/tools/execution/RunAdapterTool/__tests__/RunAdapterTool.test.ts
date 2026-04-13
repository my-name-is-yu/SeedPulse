import { describe, it, expect, vi, beforeEach } from "vitest";
import { RunAdapterTool } from "../RunAdapterTool.js";
import type { ToolCallContext } from "../../../types.js";
import type { AdapterRegistry } from "../../../../orchestrator/execution/adapter-layer.js";

function makeContext(): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

const mockResult = {
  success: true,
  output: "done",
  error: null,
  exit_code: 0,
  elapsed_ms: 42,
  stopped_reason: "completed" as const,
};

describe("RunAdapterTool", () => {
  let registry: AdapterRegistry;
  let tool: RunAdapterTool;

  beforeEach(() => {
    registry = {
      getAdapter: vi.fn(),
      isAvailable: vi.fn().mockReturnValue(true),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    } as unknown as AdapterRegistry;
    tool = new RunAdapterTool(registry);
  });

  it("has correct metadata", () => {
    expect(tool.metadata.name).toBe("run-adapter");
    expect(tool.metadata.isReadOnly).toBe(false);
    expect(tool.metadata.isDestructive).toBe(false);
    expect(tool.metadata.tags).toContain("execution");
  });

  it("description returns non-empty string", () => {
    expect(tool.description()).toContain("adapter");
  });

  it("checkPermissions returns needs_approval", async () => {
    const result = await tool.checkPermissions(
      { adapter_id: "claude", task_description: "do something" },
      makeContext(),
    );
    expect(result.status).toBe("needs_approval");
  });

  it("isConcurrencySafe returns false", () => {
    expect(tool.isConcurrencySafe({ adapter_id: "claude", task_description: "x" })).toBe(false);
  });

  it("executes adapter successfully", async () => {
    const mockAdapter = { execute: vi.fn().mockResolvedValue(mockResult) };
    vi.mocked(registry.getAdapter).mockReturnValue(mockAdapter as any);

    const result = await tool.call(
      { adapter_id: "claude", task_description: "write tests" },
      makeContext(),
    );
    expect(result.success).toBe(true);
    expect(result.summary).toContain("claude");
    expect(mockAdapter.execute).toHaveBeenCalledOnce();
    expect(registry.recordSuccess).toHaveBeenCalledWith("claude");
  });

  it("returns failure when adapter result is unsuccessful", async () => {
    const failResult = { ...mockResult, success: false, error: "timeout", stopped_reason: "timeout" as const };
    const mockAdapter = { execute: vi.fn().mockResolvedValue(failResult) };
    vi.mocked(registry.getAdapter).mockReturnValue(mockAdapter as any);

    const result = await tool.call(
      { adapter_id: "claude", task_description: "do x" },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("timeout");
    expect(registry.recordFailure).toHaveBeenCalledWith("claude");
  });

  it("records failure when adapter execution throws", async () => {
    const mockAdapter = { execute: vi.fn().mockRejectedValue(new Error("boom")) };
    vi.mocked(registry.getAdapter).mockReturnValue(mockAdapter as any);

    const result = await tool.call(
      { adapter_id: "claude", task_description: "do x" },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("boom");
    expect(registry.recordFailure).toHaveBeenCalledWith("claude");
  });

  it("does not execute adapter when circuit breaker is open", async () => {
    const mockAdapter = { execute: vi.fn().mockResolvedValue(mockResult) };
    vi.mocked(registry.isAvailable).mockReturnValue(false);
    vi.mocked(registry.getAdapter).mockReturnValue(mockAdapter as any);

    const result = await tool.call(
      { adapter_id: "claude", task_description: "do x" },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("circuit breaker");
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    expect(registry.getAdapter).not.toHaveBeenCalled();
  });

  it("handles registry error gracefully", async () => {
    vi.mocked(registry.getAdapter).mockImplementation(() => {
      throw new Error("no adapter found");
    });

    const result = await tool.call(
      { adapter_id: "unknown", task_description: "x" },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("no adapter found");
  });

  it("rejects missing required params via Zod schema", () => {
    const parsed = tool.inputSchema.safeParse({ adapter_id: "" });
    expect(parsed.success).toBe(false);
  });
});
