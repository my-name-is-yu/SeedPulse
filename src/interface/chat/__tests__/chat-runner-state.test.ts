import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectGoalUsage,
  collectScheduleUsage,
  listRecoverableArchivedGoalIds,
  parseUsagePeriodMs,
  readTasksForGoal,
  resolveStatePath,
} from "../chat-runner-state.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJson(baseDir: string, relativePath: string, value: unknown): void {
  const target = path.join(baseDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("chat-runner-state helpers", () => {
  it("resolveStatePath blocks escaping the base dir", () => {
    const baseDir = makeTempDir("pulseed-chat-state-");
    expect(resolveStatePath(baseDir, "tasks", "goal-1")).toBe(path.join(baseDir, "tasks", "goal-1"));
    expect(resolveStatePath(baseDir, "..", "outside")).toBeNull();
  });

  it("listRecoverableArchivedGoalIds only returns archived goals with goal.json", async () => {
    const baseDir = makeTempDir("pulseed-chat-archive-");
    writeJson(baseDir, "archive/goal-a/goal/goal.json", { id: "goal-a" });
    fs.mkdirSync(path.join(baseDir, "archive", "goal-b", "goal"), { recursive: true });
    fs.mkdirSync(path.join(baseDir, "archive", ".staging"), { recursive: true });

    await expect(listRecoverableArchivedGoalIds(baseDir)).resolves.toEqual(["goal-a"]);
  });

  it("readTasksForGoal falls back to archived tasks and sorts newest first", async () => {
    const baseDir = makeTempDir("pulseed-chat-tasks-");
    writeJson(baseDir, "archive/goal-1/tasks/task-1.json", {
      id: "task-1",
      goal_id: "goal-1",
      strategy_id: null,
      target_dimensions: ["quality"],
      primary_dimension: "quality",
      status: "completed",
      task_category: "normal",
      created_at: "2026-04-01T00:00:00.000Z",
      work_description: "older",
      rationale: "test",
      approach: "ship",
      success_criteria: [{ description: "done", verification_method: "check", is_blocking: true }],
      scope_boundary: { in_scope: ["task"], out_of_scope: [], blast_radius: "low" },
      constraints: [],
    });
    writeJson(baseDir, "archive/goal-1/tasks/task-2.json", {
      id: "task-2",
      goal_id: "goal-1",
      strategy_id: null,
      target_dimensions: ["quality"],
      primary_dimension: "quality",
      status: "running",
      task_category: "normal",
      created_at: "2026-04-02T00:00:00.000Z",
      work_description: "newer",
      rationale: "test",
      approach: "ship",
      success_criteria: [{ description: "done", verification_method: "check", is_blocking: true }],
      scope_boundary: { in_scope: ["task"], out_of_scope: [], blast_radius: "low" },
      constraints: [],
    });

    const tasks = await readTasksForGoal(baseDir, "goal-1");
    expect(tasks.map((task) => task.id)).toEqual(["task-2", "task-1"]);
  });

  it("collectGoalUsage ignores malformed ledger records and counts terminal tasks", async () => {
    const baseDir = makeTempDir("pulseed-chat-usage-goal-");
    writeJson(baseDir, "tasks/goal-usage/ledger/task-1.json", {
      summary: { latest_event_type: "succeeded", tokens_used: 21 },
    });
    writeJson(baseDir, "tasks/goal-usage/ledger/task-2.json", {
      summary: { latest_event_type: "running", tokens_used: 8 },
    });
    const invalidPath = path.join(baseDir, "tasks", "goal-usage", "ledger", "task-3.json");
    fs.mkdirSync(path.dirname(invalidPath), { recursive: true });
    fs.writeFileSync(invalidPath, "{not-json");

    await expect(collectGoalUsage(baseDir, "goal-usage")).resolves.toEqual({
      goalId: "goal-usage",
      totalTokens: 29,
      taskCount: 3,
      terminalTaskCount: 1,
    });
  });

  it("collectScheduleUsage filters by period", async () => {
    const baseDir = makeTempDir("pulseed-chat-usage-schedule-");
    writeJson(baseDir, "schedule-history.json", [
      { finished_at: "2026-04-27T10:00:00.000Z", tokens_used: 13 },
      { finished_at: "2026-04-26T11:00:00.000Z", tokens_used: 7 },
      { finished_at: "2026-04-20T11:00:00.000Z", tokens_used: 99 },
    ]);

    await expect(
      collectScheduleUsage(baseDir, "24h", Date.parse("2026-04-27T12:00:00.000Z"))
    ).resolves.toEqual({
      period: "24h",
      runs: 1,
      totalTokens: 13,
    });
  });

  it("parseUsagePeriodMs rejects invalid periods", () => {
    expect(() => parseUsagePeriodMs("tomorrow")).toThrow("period must be one of 24h, 7d, 2w");
  });
});
