import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskOutputTool } from "../TaskOutputTool.js";
import type { ToolCallContext } from "../../../types.js";
import type { StateManager } from "../../../../base/state/state-manager.js";

async function fakeReadRaw(baseDir: string, relativePath: string): Promise<unknown | null> {
  const resolved = path.resolve(baseDir, relativePath);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep)) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }
  if (!fs.existsSync(resolved)) return null;
  try {
    return JSON.parse(fs.readFileSync(resolved, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

async function fakeWriteRaw(baseDir: string, relativePath: string, payload: unknown): Promise<void> {
  const resolved = path.resolve(baseDir, relativePath);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep)) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(payload, null, 2), "utf-8");
}

function makeContext(): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "goal-1",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

function makeTaskJson(id: string, goalId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    goal_id: goalId,
    strategy_id: null,
    target_dimensions: ["coverage"],
    primary_dimension: "coverage",
    work_description: `Improve coverage for ${id}`,
    rationale: "Need better confidence",
    approach: "Run tests and add missing cases",
    success_criteria: [],
    scope_boundary: {
      in_scope: ["src"],
      out_of_scope: ["infra"],
      blast_radius: "low",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "running",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    execution_output: "Initial output",
    ...overrides,
  };
}

describe("TaskOutputTool", () => {
  let stateManager: StateManager;
  let tool: TaskOutputTool;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-output-tool-"));
    stateManager = {
      readRaw: vi.fn().mockImplementation((rel: string) => fakeReadRaw(tmpDir, rel)),
      writeRaw: vi.fn().mockImplementation((rel: string, payload: unknown) => fakeWriteRaw(tmpDir, rel, payload)),
    } as unknown as StateManager;
    tool = new TaskOutputTool(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends execution output by default", async () => {
    await fakeWriteRaw(tmpDir, "tasks/goal-1/task-1.json", makeTaskJson("task-1", "goal-1"));

    const result = await tool.call(
      { goalId: "goal-1", taskId: "task-1", content: "Sub-agent result" },
      makeContext()
    );

    expect(result.success).toBe(true);
    const updated = await fakeReadRaw(tmpDir, "tasks/goal-1/task-1.json") as Record<string, unknown>;
    expect(updated.execution_output).toBe("Initial output\n\nSub-agent result");
  });

  it("replaces execution output when mode=replace", async () => {
    await fakeWriteRaw(tmpDir, "tasks/goal-1/task-1.json", makeTaskJson("task-1", "goal-1"));

    const result = await tool.call(
      { goalId: "goal-1", taskId: "task-1", content: "Fresh output", mode: "replace" },
      makeContext()
    );

    expect(result.success).toBe(true);
    const updated = await fakeReadRaw(tmpDir, "tasks/goal-1/task-1.json") as Record<string, unknown>;
    expect(updated.execution_output).toBe("Fresh output");
  });

  it("returns failure when task does not exist", async () => {
    const result = await tool.call(
      { goalId: "goal-1", taskId: "missing", content: "hello" },
      makeContext()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("missing");
  });
});
