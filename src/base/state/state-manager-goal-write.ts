import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { acquireLock, releaseLock } from "./state-lock.js";
import { appendWALRecord, compactWAL } from "./state-wal.js";
import { writeSnapshot } from "./state-snapshot.js";
import type { Goal } from "../types/goal.js";
import type { StateWriteFence, StateWriteFenceContext } from "./state-manager.js";

export interface GoalWriteCoordinatorOptions {
  baseDir: string;
  walEnabled: boolean;
  loadGoal: (goalId: string) => Promise<Goal | null>;
}

export class GoalWriteCoordinator {
  private readonly baseDir: string;
  private readonly walEnabled: boolean;
  private readonly loadGoal: (goalId: string) => Promise<Goal | null>;
  private readonly writeCount = new Map<string, number>();
  private readonly writeFences = new Map<string, StateWriteFence>();

  constructor(options: GoalWriteCoordinatorOptions) {
    this.baseDir = options.baseDir;
    this.walEnabled = options.walEnabled;
    this.loadGoal = options.loadGoal;
  }

  setWriteFence(goalId: string, fence: StateWriteFence): void {
    this.writeFences.set(goalId, fence);
  }

  clearWriteFence(goalId: string): void {
    this.writeFences.delete(goalId);
  }

  async assertWriteFence(goalId: string, op: string, data: unknown): Promise<void> {
    const fence = this.writeFences.get(goalId);
    if (!fence) return;
    await fence({ goalId, op, data } satisfies StateWriteFenceContext);
  }

  async goalDir(goalId: string): Promise<string> {
    const dir = path.join(this.baseDir, "goals", goalId);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return dir;
      throw err;
    }
    return dir;
  }

  /** Wrap a goal write with lock + WAL + snapshot cycle. */
  async protectedWrite(
    goalId: string,
    op: string,
    data: unknown,
    writeFn: () => Promise<void>,
  ): Promise<void> {
    await acquireLock(goalId, this.baseDir);
    try {
      await this.assertWriteFence(goalId, op, data);
      if (!this.walEnabled) {
        await writeFn();
        return;
      }
      const ts = new Date().toISOString();
      await appendWALRecord(goalId, this.baseDir, { op, data, ts });
      await writeFn();
      await appendWALRecord(goalId, this.baseDir, {
        op: "commit",
        ref_ts: ts,
        ts: new Date().toISOString(),
      });
      this.writeCount.set(goalId, (this.writeCount.get(goalId) || 0) + 1);
      const count = this.writeCount.get(goalId)!;
      if (count % 50 === 0) {
        const fullGoal = await this.loadGoal(goalId);
        if (fullGoal !== null) await writeSnapshot(goalId, this.baseDir, fullGoal);
      }
      if (count % 100 === 0) await compactWAL(goalId, this.baseDir);
    } finally {
      await releaseLock(goalId, this.baseDir);
    }
  }

  /** Wrap a goal-scoped operation with lock + fence only (no WAL). */
  async protectedOperation(
    goalId: string,
    op: string,
    data: unknown,
    run: () => Promise<void>,
  ): Promise<void> {
    await acquireLock(goalId, this.baseDir);
    try {
      await this.assertWriteFence(goalId, op, data);
      await run();
    } finally {
      await releaseLock(goalId, this.baseDir);
    }
  }

  /** Wrap a locked read-modify-write cycle with lock + WAL + snapshot cycle. */
  async protectedReadModifyWrite<TData>(
    goalId: string,
    op: string,
    buildData: () => Promise<TData>,
    writeFn: (data: TData) => Promise<void>,
  ): Promise<void> {
    await acquireLock(goalId, this.baseDir);
    try {
      const data = await buildData();
      await this.assertWriteFence(goalId, op, data);
      if (!this.walEnabled) {
        await writeFn(data);
        return;
      }
      const ts = new Date().toISOString();
      await appendWALRecord(goalId, this.baseDir, { op, data, ts });
      await writeFn(data);
      await appendWALRecord(goalId, this.baseDir, {
        op: "commit",
        ref_ts: ts,
        ts: new Date().toISOString(),
      });
      this.writeCount.set(goalId, (this.writeCount.get(goalId) || 0) + 1);
      const count = this.writeCount.get(goalId)!;
      if (count % 50 === 0) {
        const fullGoal = await this.loadGoal(goalId);
        if (fullGoal !== null) await writeSnapshot(goalId, this.baseDir, fullGoal);
      }
      if (count % 100 === 0) await compactWAL(goalId, this.baseDir);
    } finally {
      await releaseLock(goalId, this.baseDir);
    }
  }
}
