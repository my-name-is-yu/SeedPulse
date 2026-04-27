import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { TaskSchema, type Task } from "../../base/types/task.js";

export interface GoalUsageSummary {
  goalId: string;
  totalTokens: number;
  taskCount: number;
  terminalTaskCount: number;
}

export interface ScheduleUsageSummary {
  period: string;
  runs: number;
  totalTokens: number;
}

export function resolveStatePath(baseDir: string, ...segments: string[]): string | null {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, ...segments);
  if (!resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

export async function listRecoverableArchivedGoalIds(baseDir: string): Promise<string[]> {
  const archiveDir = resolveStatePath(baseDir, "archive");
  if (archiveDir === null) return [];
  let entries: Array<{ name: string; isDirectory(): boolean }> = [];
  try {
    entries = await fsp.readdir(archiveDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const goalIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".staging") continue;
    try {
      await fsp.access(path.join(archiveDir, entry.name, "goal", "goal.json"));
      goalIds.push(entry.name);
    } catch {
      continue;
    }
  }
  return goalIds;
}

export async function readTasksFromDir(tasksDir: string): Promise<Task[]> {
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(tasksDir);
  } catch {
    return [];
  }

  const tasks: Task[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry === "task-history.json" || entry === "last-failure-context.json") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(await fsp.readFile(path.join(tasksDir, entry), "utf-8"));
    } catch {
      continue;
    }
    const parsed = TaskSchema.safeParse(raw);
    if (parsed.success) tasks.push(parsed.data);
  }
  return tasks.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export async function readTasksForGoal(baseDir: string, goalId: string): Promise<Task[]> {
  const activeTasksDir = resolveStatePath(baseDir, "tasks", goalId);
  const archiveTasksDir = resolveStatePath(baseDir, "archive", goalId, "tasks");
  if (activeTasksDir === null || archiveTasksDir === null) return [];
  const activeTasks = await readTasksFromDir(activeTasksDir);
  if (activeTasks.length > 0) return activeTasks;
  return readTasksFromDir(archiveTasksDir);
}

export function parseUsagePeriodMs(period: string): number {
  const match = /^(\d+)([dhw])$/i.exec(period.trim());
  if (!match) {
    throw new Error("period must be one of 24h, 7d, 2w");
  }
  const value = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("period value must be positive");
  }
  if (unit === "h") return value * 60 * 60 * 1000;
  if (unit === "w") return value * 7 * 24 * 60 * 60 * 1000;
  return value * 24 * 60 * 60 * 1000;
}

export async function collectGoalUsage(baseDir: string, goalId: string): Promise<GoalUsageSummary> {
  const ledgerDir = path.join(baseDir, "tasks", goalId, "ledger");
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(ledgerDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { goalId, totalTokens: 0, taskCount: 0, terminalTaskCount: 0 };
  }

  let totalTokens = 0;
  let taskCount = 0;
  let terminalTaskCount = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    taskCount += 1;
    try {
      const raw = await fsp.readFile(path.join(ledgerDir, entry), "utf-8");
      const parsed = JSON.parse(raw) as {
        summary?: { latest_event_type?: string; tokens_used?: number };
      };
      if (typeof parsed.summary?.tokens_used === "number") {
        totalTokens += parsed.summary.tokens_used;
      }
      if (parsed.summary?.latest_event_type === "succeeded"
        || parsed.summary?.latest_event_type === "failed"
        || parsed.summary?.latest_event_type === "abandoned") {
        terminalTaskCount += 1;
      }
    } catch {
      // Ignore malformed records.
    }
  }

  return { goalId, totalTokens, taskCount, terminalTaskCount };
}

export async function collectScheduleUsage(
  baseDir: string,
  period: string,
  now = Date.now()
): Promise<ScheduleUsageSummary> {
  const periodMs = parseUsagePeriodMs(period);
  const since = now - periodMs;
  const historyPath = path.join(baseDir, "schedule-history.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(historyPath, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { period, runs: 0, totalTokens: 0 };
    }
    throw err;
  }
  if (!Array.isArray(raw)) {
    return { period, runs: 0, totalTokens: 0 };
  }
  let runs = 0;
  let totalTokens = 0;
  for (const record of raw) {
    if (!record || typeof record !== "object") continue;
    const finishedAt = (record as Record<string, unknown>)["finished_at"];
    const firedAt = typeof finishedAt === "string" ? Date.parse(finishedAt) : Number.NaN;
    if (!Number.isFinite(firedAt) || firedAt < since) continue;
    runs += 1;
    const tokensUsed = (record as Record<string, unknown>)["tokens_used"];
    if (typeof tokensUsed === "number" && Number.isFinite(tokensUsed)) {
      totalTokens += tokensUsed;
    }
  }
  return { period, runs, totalTokens };
}
