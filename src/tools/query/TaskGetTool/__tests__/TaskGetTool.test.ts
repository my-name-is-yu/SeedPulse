import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskGetTool } from "../TaskGetTool.js";
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
    task_category: "verification",
    status: "completed",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:05:00.000Z",
    timeout_at: null,
    heartbeat_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    verification_verdict: "pass",
    verification_evidence: ["tests passed"],
    execution_output: "done",
    ...overrides,
  };
}

describe("TaskGetTool", () => {
  let stateManager: StateManager;
  let tool: TaskGetTool;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-get-tool-"));
    stateManager = {
      readRaw: vi.fn().mockImplementation((rel: string) => fakeReadRaw(tmpDir, rel)),
    } as unknown as StateManager;
    tool = new TaskGetTool(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns metadata with task tags", () => {
    expect(tool.metadata.name).toBe("task_get");
    expect(tool.metadata.tags).toContain("task");
    expect(tool.metadata.isReadOnly).toBe(true);
  });

  it("returns the parsed task when present", async () => {
    const tasksDir = path.join(tmpDir, "tasks", "goal-1");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, "task-1.json"),
      JSON.stringify(makeTaskJson("task-1", "goal-1"))
    );

    const result = await tool.call({ goalId: "goal-1", taskId: "task-1" }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { id: string; verification_verdict: string };
    expect(data.id).toBe("task-1");
    expect(data.verification_verdict).toBe("pass");
  });

  it("returns failure when the task does not exist", async () => {
    const result = await tool.call({ goalId: "goal-1", taskId: "missing" }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("missing");
  });

  it("returns failure when the task file is malformed", async () => {
    const tasksDir = path.join(tmpDir, "tasks", "goal-1");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "broken.json"), JSON.stringify({ id: "broken" }));

    const result = await tool.call({ goalId: "goal-1", taskId: "broken" }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("goal_id");
  });
});
