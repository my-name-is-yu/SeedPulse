import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { writeJsonFileAtomic, readJsonFileOrNull } from "../utils/json-io.js";
import { CronTaskSchema, CronTaskListSchema, type CronTask } from "../types/cron.js";

const TASKS_FILE = "scheduled-tasks.json";
const EXPIRY_DAYS = 7;
const JITTER_FACTOR = 0.05; // ±5%

export class CronScheduler {
  private tasksPath: string;

  constructor(baseDir: string) {
    this.tasksPath = path.join(baseDir, TASKS_FILE);
  }

  async loadTasks(): Promise<CronTask[]> {
    const raw = await readJsonFileOrNull(this.tasksPath);
    if (raw === null) return [];
    const result = CronTaskListSchema.safeParse(raw);
    return result.success ? result.data : [];
  }

  async saveTasks(tasks: CronTask[]): Promise<void> {
    await writeJsonFileAtomic(this.tasksPath, tasks);
  }

  async addTask(task: Omit<CronTask, "id" | "created_at">): Promise<CronTask> {
    const tasks = await this.loadTasks();
    const newTask = CronTaskSchema.parse({
      ...task,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    });
    tasks.push(newTask);
    await this.saveTasks(tasks);
    return newTask;
  }

  async removeTask(id: string): Promise<boolean> {
    const tasks = await this.loadTasks();
    const filtered = tasks.filter((t) => t.id !== id);
    if (filtered.length === tasks.length) return false;
    await this.saveTasks(filtered);
    return true;
  }

  async getDueTasks(): Promise<CronTask[]> {
    const tasks = await this.loadTasks();
    const now = new Date();
    const due: CronTask[] = [];

    for (const task of tasks) {
      if (!task.enabled) continue;
      if (!isDue(task, now)) continue;
      due.push(task);
    }

    return due;
  }

  async markFired(id: string): Promise<void> {
    const tasks = await this.loadTasks();
    const updated = tasks.map((t) =>
      t.id === id ? { ...t, last_fired_at: new Date().toISOString() } : t
    );
    await this.saveTasks(updated);
  }

  async expireOldTasks(): Promise<void> {
    const tasks = await this.loadTasks();
    const cutoff = Date.now() - EXPIRY_DAYS * 24 * 60 * 60 * 1000;
    const kept = tasks.filter(
      (t) => t.permanent || new Date(t.created_at).getTime() >= cutoff
    );
    await this.saveTasks(kept);
  }
}

// ─── Helpers ───

function isDue(task: CronTask, now: Date): boolean {
  try {
    const interval = CronExpressionParser.parse(task.cron, { currentDate: now });
    const prevFire = interval.prev();

    // Apply one-sided jitter: only moves adjustedPrev earlier, never later
    const nextFire = interval.next();
    const intervalMs = nextFire.getTime() - prevFire.getTime();
    const jitterMs = -(intervalMs * JITTER_FACTOR * Math.random());
    const adjustedPrev = new Date(prevFire.getTime() + jitterMs);

    // If never fired, task is due if the adjusted prev fire is in the past
    if (task.last_fired_at === null) {
      return adjustedPrev.getTime() <= now.getTime();
    }

    // Task is due if it hasn't been fired since the last scheduled time
    const lastFired = new Date(task.last_fired_at).getTime();
    return lastFired < adjustedPrev.getTime();
  } catch {
    return false;
  }
}
