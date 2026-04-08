import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskStopTool } from "../TaskStopTool.js";
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

describe("TaskStopTool", () => {
  let stateManager: StateManager;
  let tool: TaskStopTool;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-stop-tool-"));
    stateManager = {
      readRaw: vi.fn().mockImplementation((rel: string) => fakeReadRaw(tmpDir, rel)),
      writeRaw: vi.fn().mockImplementation(async (rel: string, data: unknown) => {
        const resolved = path.resolve(tmpDir, rel);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, JSON.stringify(data), "utf-8");
      }),
    } as unknown as StateManager;
    tool = new TaskStopTool(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("marks a task as error and appends the stop reason", async () => {
    const tasksDir = path.join(tmpDir, "tasks", "goal-1");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "task-1.json"), JSON.stringify(makeTaskJson("task-1", "goal-1")));

    const result = await tool.call(
      { goalId: "goal-1", taskId: "task-1", reason: "Supervisor cancelled it" },
      makeContext()
    );

    expect(result.success).toBe(true);
    const persisted = await fakeReadRaw(tmpDir, "tasks/goal-1/task-1.json") as Record<string, unknown>;
    expect(persisted.status).toBe("error");
    expect((persisted.execution_output as string)).toContain("Supervisor cancelled it");
    expect(typeof persisted.completed_at).toBe("string");
  });

  it("updates task-history.json", async () => {
    const tasksDir = path.join(tmpDir, "tasks", "goal-1");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "task-1.json"), JSON.stringify(makeTaskJson("task-1", "goal-1")));

    const result = await tool.call({ goalId: "goal-1", taskId: "task-1" }, makeContext());
    expect(result.success).toBe(true);

    const history = await fakeReadRaw(tmpDir, "tasks/goal-1/task-history.json") as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(history[0]?.task_id).toBe("task-1");
    expect(history[0]?.status).toBe("error");
  });
});
