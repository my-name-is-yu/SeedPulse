import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { writeJsonFileAtomic, readJsonFileOrNull } from "../../base/utils/json-io.js";
import { ScheduleEntryListSchema, type ScheduleEntry } from "../types/schedule.js";

const SCHEDULES_FILE = "schedules.json";
const SCHEDULE_LOCK_DIR = `${SCHEDULES_FILE}.lock`;
const SCHEDULE_LOCK_TIMEOUT_MS = 5000;
const SCHEDULE_LOCK_STALE_MS = 30_000;
const SCHEDULE_LOCK_RETRY_MS = 25;

export interface ScheduleEntryStoreLogger {
  warn: (message: string, context?: Record<string, unknown>) => void;
}

export class ScheduleEntryStore {
  private readonly schedulesPath: string;
  private readonly schedulesLockPath: string;
  private lockDepth = 0;

  constructor(
    private readonly baseDir: string,
    private readonly logger: ScheduleEntryStoreLogger,
    private readonly onPersist?: (entries: ScheduleEntry[]) => Promise<void>
  ) {
    this.schedulesPath = path.join(baseDir, SCHEDULES_FILE);
    this.schedulesLockPath = path.join(baseDir, SCHEDULE_LOCK_DIR);
  }

  async readEntries(): Promise<ScheduleEntry[]> {
    const raw = await readJsonFileOrNull(this.schedulesPath);
    if (raw === null) return [];
    const result = ScheduleEntryListSchema.safeParse(raw);
    return result.success ? result.data : [];
  }

  async saveEntries(entries: ScheduleEntry[]): Promise<void> {
    await this.withLock(async () => {
      await writeJsonFileAtomic(this.schedulesPath, entries);
      await this.onPersist?.(entries);
    });
  }

  async withLock<T>(work: () => Promise<T>): Promise<T> {
    if (this.lockDepth > 0) {
      return work();
    }

    const release = await this.acquireScheduleFileLock();
    this.lockDepth++;
    try {
      return await work();
    } finally {
      this.lockDepth--;
      await release();
    }
  }

  private async acquireScheduleFileLock(): Promise<() => Promise<void>> {
    await fsp.mkdir(this.baseDir, { recursive: true });
    const startedAt = Date.now();

    while (true) {
      try {
        await fsp.mkdir(this.schedulesLockPath);
        await fsp.writeFile(
          path.join(this.schedulesLockPath, "owner.json"),
          JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }),
          "utf-8"
        );
        return async () => {
          await fsp.rm(this.schedulesLockPath, { recursive: true, force: true });
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          throw error;
        }

        await this.removeStaleScheduleLock().catch(() => undefined);
        if (Date.now() - startedAt >= SCHEDULE_LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for schedule file lock at ${this.schedulesLockPath}`);
        }
        await new Promise((resolve) => setTimeout(resolve, SCHEDULE_LOCK_RETRY_MS));
      }
    }
  }

  private async removeStaleScheduleLock(): Promise<void> {
    const stat = await fsp.stat(this.schedulesLockPath);
    if (Date.now() - stat.mtimeMs <= SCHEDULE_LOCK_STALE_MS) {
      return;
    }

    try {
      const raw = await fsp.readFile(path.join(this.schedulesLockPath, "owner.json"), "utf-8");
      const owner = JSON.parse(raw) as { pid?: unknown };
      if (typeof owner.pid === "number") {
        try {
          process.kill(owner.pid, 0);
          return;
        } catch {
          // Owner is gone; stale lock can be removed.
        }
      }
    } catch {
      // Missing or malformed owner data is treated as stale after the age threshold.
    }

    try {
      await fsp.rm(this.schedulesLockPath, { recursive: true, force: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.warn("Failed to remove stale schedule lock", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
