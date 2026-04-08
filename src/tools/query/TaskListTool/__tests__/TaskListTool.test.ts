import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskListTool } from "../TaskListTool.js";
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
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("TaskListTool", () => {
  let stateManager: StateManager;
  let tool: TaskListTool;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-list-tool-"));
    stateManager = {
      getBaseDir: vi.fn().mockReturnValue(tmpDir),
      readRaw: vi.fn().mockImplementation((rel: string) => fakeReadRaw(tmpDir, rel)),
    } as unknown as StateManager;
    tool = new TaskListTool(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns metadata with task tags", () => {
    expect(tool.metadata.name).toBe("task_list");
    expect(tool.metadata.tags).toContain("task");
    expect(tool.metadata.isReadOnly).toBe(true);
  });

  it("returns empty when the goal has no tasks", async () => {
    const result = await tool.call({ goalId: "goal-1", limit: 10 }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { tasks: unknown[]; totalFound: number };
    expect(data.tasks).toHaveLength(0);
    expect(data.totalFound).toBe(0);
  });

  it("returns tasks sorted by recency", async () => {
    const tasksDir = path.join(tmpDir, "tasks", "goal-1");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, "task-a.json"),
      JSON.stringify(makeTaskJson("task-a", "goal-1", { created_at: "2026-01-01T00:00:00.000Z" }))
    );
    fs.writeFileSync(
      path.join(tasksDir, "task-b.json"),
      JSON.stringify(makeTaskJson("task-b", "goal-1", { created_at: "2026-01-03T00:00:00.000Z" }))
    );
    fs.writeFileSync(
      path.join(tasksDir, "task-c.json"),
      JSON.stringify(makeTaskJson("task-c", "goal-1", { created_at: "2026-01-02T00:00:00.000Z" }))
    );

    const result = await tool.call({ goalId: "goal-1", limit: 10 }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { tasks: Array<{ id: string }> };
    expect(data.tasks.map((task) => task.id)).toEqual(["task-b", "task-c", "task-a"]);
  });

  it("filters by status", async () => {
    const tasksDir = path.join(tmpDir, "tasks", "goal-1");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, "task-a.json"),
      JSON.stringify(makeTaskJson("task-a", "goal-1", { status: "pending" }))
    );
    fs.writeFileSync(
      path.join(tasksDir, "task-b.json"),
      JSON.stringify(makeTaskJson("task-b", "goal-1", { status: "completed" }))
    );

    const result = await tool.call({ goalId: "goal-1", limit: 10, status: "completed" }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { tasks: Array<{ id: string }>; totalFound: number };
    expect(data.totalFound).toBe(1);
    expect(data.tasks[0]?.id).toBe("task-b");
  });

  it("respects limit and mentions truncation in summary", async () => {
    const tasksDir = path.join(tmpDir, "tasks", "goal-1");
    fs.mkdirSync(tasksDir, { recursive: true });
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(
        path.join(tasksDir, `task-${i}.json`),
        JSON.stringify(
          makeTaskJson(`task-${i}`, "goal-1", { created_at: `2026-01-0${i + 1}T00:00:00.000Z` })
        )
      );
    }

    const result = await tool.call({ goalId: "goal-1", limit: 2 }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { tasks: unknown[]; totalFound: number };
    expect(data.totalFound).toBe(4);
    expect(data.tasks).toHaveLength(2);
    expect(result.summary).toContain("showing latest 2");
  });

  it("skips malformed task files", async () => {
    const tasksDir = path.join(tmpDir, "tasks", "goal-1");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "broken.json"), "not-json");
    fs.writeFileSync(
      path.join(tasksDir, "task-ok.json"),
      JSON.stringify(makeTaskJson("task-ok", "goal-1"))
    );

    const result = await tool.call({ goalId: "goal-1", limit: 10 }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { tasks: Array<{ id: string }> };
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0]?.id).toBe("task-ok");
  });
});
