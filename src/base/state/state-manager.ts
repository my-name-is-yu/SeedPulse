import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getPulseedDirPath } from "../utils/paths.js";
import { StateError } from "../utils/errors.js";
import type { Logger } from "../../runtime/logger.js";
import { GoalSchema, GoalTreeSchema } from "../types/goal.js";
import { ObservationLogSchema, ObservationLogEntrySchema } from "../types/state.js";
import { GapHistoryEntrySchema } from "../types/gap.js";
import type { Goal, GoalTree } from "../types/goal.js";
import type { ObservationLog, ObservationLogEntry } from "../types/state.js";
import type { GapHistoryEntry } from "../types/gap.js";
import type { PaceSnapshot } from "../types/goal.js";
import { TaskSchema } from "../types/task.js";
import type { Task } from "../types/task.js";
import { LoopCheckpointSchema } from "../types/checkpoint.js";
import type { CheckpointTrustPort } from "./checkpoint-trust-port.js";
import { initDirs, atomicWrite, atomicRead } from "./state-persistence.js";
import { GoalWriteCoordinator } from "./state-manager-goal-write.js";
import { recoverStateManagerWAL } from "./state-manager-wal.js";

export { initDirs, atomicWrite, atomicRead };

export interface StateWriteFenceContext {
  goalId: string;
  op: string;
  data: unknown;
}

export type StateWriteFence = (context: StateWriteFenceContext) => Promise<void> | void;

const MAX_HISTORY_ENTRIES = 500;

type GoalLocationKind = "active" | "archive";

interface GoalStorageLocation {
  kind: GoalLocationKind;
  dir: string;
  goalJsonPath: string;
}

/**
 * StateManager handles persistence of goals, state vectors, observation logs,
 * and gap history under a base directory (default: ~/.pulseed/).
 *
 * File layout:
 *   <base>/goals/<goal_id>/goal.json
 *   <base>/goals/<goal_id>/observations.json
 *   <base>/goals/<goal_id>/gap-history.json
 *   <base>/goal-trees/<root_id>.json
 *   <base>/events/              (event queue directory)
 *   <base>/events/archive/      (processed events)
 *   <base>/reports/             (report output directory)
 *
 * All writes are atomic: write to .tmp file, then rename.
 */
export class StateManager {
  private readonly baseDir: string;
  private readonly logger?: Logger;
  private readonly walEnabled: boolean;
  private readonly goalWriteCoordinator: GoalWriteCoordinator;

  constructor(baseDir?: string, logger?: Logger, options?: { walEnabled?: boolean }) {
    this.baseDir = baseDir ?? getPulseedDirPath();
    this.logger = logger;
    this.walEnabled = options?.walEnabled ?? true;
    this.goalWriteCoordinator = new GoalWriteCoordinator({
      baseDir: this.baseDir,
      walEnabled: this.walEnabled,
      loadGoal: (goalId) => this.loadGoal(goalId),
    });
  }

  /** Create required subdirectories. Must be called after construction before first use. */
  async init(): Promise<void> {
    await initDirs(this.baseDir);
    if (this.walEnabled) {
      await this.recoverWAL();
    }
  }

  /**
   * Scan all goals for uncommitted WAL entries and replay them.
   * Depends on initDirs() having been called first (to ensure goals/ exists).
   */
  private async recoverWAL(): Promise<void> {
    await recoverStateManagerWAL({
      baseDir: this.baseDir,
      logger: this.logger,
      listGoalIds: () => this.listGoalIds(),
    });
  }

  /** Returns the base directory path */
  getBaseDir(): string {
    return this.baseDir;
  }

  setWriteFence(goalId: string, fence: StateWriteFence): void {
    this.goalWriteCoordinator.setWriteFence(goalId, fence);
  }

  clearWriteFence(goalId: string): void {
    this.goalWriteCoordinator.clearWriteFence(goalId);
  }

  private async assertWriteFence(goalId: string, op: string, data: unknown): Promise<void> {
    await this.goalWriteCoordinator.assertWriteFence(goalId, op, data);
  }

  private async goalDir(goalId: string): Promise<string> {
    return this.goalWriteCoordinator.goalDir(goalId);
  }

  // ─── Atomic Write / Read (delegated to state-persistence) ───

  private async atomicWrite(filePath: string, data: unknown): Promise<void> {
    return atomicWrite(filePath, data);
  }

  private async atomicRead<T>(filePath: string): Promise<T | null> {
    return atomicRead<T>(filePath, this.logger);
  }

  /** Wrap a goal write with lock + WAL + snapshot cycle. */
  private async protectedWrite(goalId: string, op: string, data: unknown, writeFn: () => Promise<void>): Promise<void> {
    await this.goalWriteCoordinator.protectedWrite(goalId, op, data, writeFn);
  }

  private isEnoent(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fsp.access(filePath);
      return true;
    } catch (e: unknown) {
      if (!this.isEnoent(e)) throw e;
      return false;
    }
  }

  private goalStorageLocation(goalId: string, kind: GoalLocationKind): GoalStorageLocation {
    if (kind === "active") {
      const dir = path.join(this.baseDir, "goals", goalId);
      return { kind, dir, goalJsonPath: path.join(dir, "goal.json") };
    }

    const dir = path.join(this.baseDir, "archive", goalId);
    return { kind, dir, goalJsonPath: path.join(dir, "goal", "goal.json") };
  }

  private archiveGoalDir(goalId: string): string {
    return path.join(this.baseDir, "archive", goalId);
  }

  private archiveGoalStagingDir(goalId: string): string {
    return path.join(this.baseDir, "archive", ".staging", goalId);
  }

  private archiveCompleteMarkerPath(archiveBase: string): string {
    return path.join(archiveBase, ".archive-complete.json");
  }

  private resolveWithinBase(...segments: string[]): string | null {
    const base = path.resolve(this.baseDir);
    const resolved = path.resolve(base, ...segments);
    if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
      return null;
    }
    return resolved;
  }

  private taskStorageDirs(goalId: string): { activeDir: string | null; archiveDir: string | null } {
    return {
      activeDir: this.resolveWithinBase("tasks", goalId),
      archiveDir: this.resolveWithinBase("archive", goalId, "tasks"),
    };
  }

  private async readTasksFromDir(tasksDir: string): Promise<Task[]> {
    let entries: string[];
    try {
      entries = await fsp.readdir(tasksDir);
    } catch (error: unknown) {
      if (this.isEnoent(error)) return [];
      throw error;
    }

    const tasks: Task[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry === "task-history.json" || entry === "last-failure-context.json") {
        continue;
      }
      try {
        const raw = await this.atomicRead<unknown>(path.join(tasksDir, entry));
        if (raw === null) continue;
        const parsed = TaskSchema.safeParse(raw);
        if (parsed.success) {
          tasks.push(parsed.data);
        }
      } catch (error: unknown) {
        if (!this.isEnoent(error)) throw error;
      }
    }

    return tasks.sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  private async cleanupActiveGoalState(goalId: string): Promise<void> {
    await fsp.rm(path.join(this.baseDir, "goals", goalId), { recursive: true, force: true });
    await fsp.rm(path.join(this.baseDir, "tasks", goalId), { recursive: true, force: true });
    await fsp.rm(path.join(this.baseDir, "strategies", goalId), { recursive: true, force: true });
    await fsp.rm(path.join(this.baseDir, "stalls", `${goalId}.json`), { force: true });
    await fsp.rm(path.join(this.baseDir, "reports", goalId), { recursive: true, force: true });
  }

  private async hasActiveGoalState(goalId: string): Promise<boolean> {
    const activePaths = [
      path.join(this.baseDir, "goals", goalId),
      path.join(this.baseDir, "tasks", goalId),
      path.join(this.baseDir, "strategies", goalId),
      path.join(this.baseDir, "stalls", `${goalId}.json`),
      path.join(this.baseDir, "reports", goalId),
    ];
    for (const activePath of activePaths) {
      if (await this.pathExists(activePath)) return true;
    }
    return false;
  }

  private async copyActiveArchiveRemnants(goalId: string, archiveBase: string): Promise<void> {
    const tasksDir = path.join(this.baseDir, "tasks", goalId);
    if (await this.pathExists(tasksDir)) {
      await fsp.cp(tasksDir, path.join(archiveBase, "tasks"), { recursive: true });
    }

    const strategiesDir = path.join(this.baseDir, "strategies", goalId);
    if (await this.pathExists(strategiesDir)) {
      await fsp.cp(strategiesDir, path.join(archiveBase, "strategies"), { recursive: true });
    }

    const stallsFile = path.join(this.baseDir, "stalls", `${goalId}.json`);
    if (await this.pathExists(stallsFile)) {
      await fsp.cp(stallsFile, path.join(archiveBase, "stalls.json"));
    }

    const reportsDir = path.join(this.baseDir, "reports", goalId);
    if (await this.pathExists(reportsDir)) {
      await fsp.cp(reportsDir, path.join(archiveBase, "reports"), { recursive: true });
    }
  }

  private async commitArchiveGoal(stagingBase: string, archiveBase: string): Promise<void> {
    await fsp.rename(stagingBase, archiveBase);
  }

  private async resolveGoalLocation(goalId: string, includeArchive: boolean): Promise<GoalStorageLocation | null> {
    const activeLocation = this.goalStorageLocation(goalId, "active");
    if (await this.pathExists(activeLocation.dir)) return activeLocation;

    if (!includeArchive) return null;

    const archiveLocation = this.goalStorageLocation(goalId, "archive");
    if (await this.pathExists(archiveLocation.dir)) return archiveLocation;
    return null;
  }

  private markGoalVisited(goalId: string, visited: Set<string>): boolean {
    if (visited.has(goalId)) return false;
    visited.add(goalId);
    return true;
  }

  private async loadGoalForChildTraversal(goalId: string, location: GoalStorageLocation): Promise<Goal | null> {
    try {
      if (location.kind === "archive") {
        const raw = await this.atomicRead<unknown>(location.goalJsonPath);
        return raw === null ? null : GoalSchema.parse(raw);
      }

      return this.loadGoal(goalId);
    } catch (e: unknown) {
      if (!this.isEnoent(e)) throw e;
      const archivedLabel = location.kind === "archive" ? " archived" : "";
      this.logger?.warn(`[StateManager] Skipping children of${archivedLabel} "${goalId}": goal.json unreadable`);
      return null;
    }
  }

  private async visitChildGoals(
    goalId: string,
    location: GoalStorageLocation,
    visited: Set<string>,
    visit: (childId: string, visited: Set<string>) => Promise<boolean>
  ): Promise<void> {
    const goal = await this.loadGoalForChildTraversal(goalId, location);
    if (goal === null) return;

    for (const childId of goal.children_ids) {
      await visit(childId, visited);
    }
  }

  private capHistoryEntries<T>(entries: T[]): T[] {
    return entries.slice(-MAX_HISTORY_ENTRIES);
  }

  private assertObservationGoalId(goalId: string, entry: ObservationLogEntry): void {
    if (entry.goal_id !== goalId) {
      throw new StateError(
        `appendObservation: entry.goal_id ("${entry.goal_id}") does not match goalId ("${goalId}")`
      );
    }
  }

  private async writeObservationLog(
    goalId: string,
    op: string,
    log: ObservationLog,
    resolveDirBeforeWrite: boolean
  ): Promise<void> {
    const resolvedDir = resolveDirBeforeWrite ? await this.goalDir(goalId) : null;
    await this.protectedWrite(goalId, op, log, async () => {
      const dir = resolvedDir ?? await this.goalDir(goalId);
      await this.atomicWrite(path.join(dir, "observations.json"), log);
    });
  }

  private async writeGapHistory(
    goalId: string,
    op: string,
    entries: GapHistoryEntry[],
    resolveDirBeforeWrite: boolean
  ): Promise<void> {
    const resolvedDir = resolveDirBeforeWrite ? await this.goalDir(goalId) : null;
    await this.protectedWrite(goalId, op, { goalId, entries }, async () => {
      const dir = resolvedDir ?? await this.goalDir(goalId);
      await this.atomicWrite(path.join(dir, "gap-history.json"), entries);
    });
  }

  // ─── Goal CRUD ───

  async saveGoal(goal: Goal): Promise<void> {
    const parsed = GoalSchema.parse(goal);
    const dir = await this.goalDir(parsed.id);
    await this.protectedWrite(parsed.id, "save_goal", parsed, async () => {
      await this.atomicWrite(path.join(dir, "goal.json"), parsed);
    });
  }

  async loadGoal(goalId: string): Promise<Goal | null> {
    const archiveBase = this.archiveGoalDir(goalId);
    const archiveCompleteMarkerExists = await this.pathExists(this.archiveCompleteMarkerPath(archiveBase));
    const archiveGoalPath = this.goalStorageLocation(goalId, "archive").goalJsonPath;
    const archiveGoalExists = await this.pathExists(archiveGoalPath);

    // Committed archive wins over stale active state after crash cleanup.
    if (archiveCompleteMarkerExists && archiveGoalExists) {
      const archiveRaw = await this.atomicRead<unknown>(archiveGoalPath);
      if (archiveRaw !== null) return GoalSchema.parse(archiveRaw);
    }

    // Primary path: active goals
    const filePath = path.join(this.baseDir, "goals", goalId, "goal.json");
    const raw = await this.atomicRead<unknown>(filePath);
    if (raw !== null) return GoalSchema.parse(raw);

    // Fallback: archived goals (archiveGoal() copies goal dir to archive/<goalId>/goal/)
    if (!archiveGoalExists) return null;

    const archiveRaw = await this.atomicRead<unknown>(archiveGoalPath);
    if (archiveRaw === null) return null;
    return GoalSchema.parse(archiveRaw);
  }

  async deleteGoal(goalId: string, _visited = new Set<string>()): Promise<boolean> {
    if (!this.markGoalVisited(goalId, _visited)) return false;

    const location = await this.resolveGoalLocation(goalId, true);
    if (location === null) return false;

    // Recursively delete children first (depth-first)
    await this.visitChildGoals(goalId, location, _visited, (childId, visited) => this.deleteGoal(childId, visited));
    await fsp.rm(location.dir, { recursive: true, force: true });
    return true;
  }

  /**
   * Archive a completed goal by moving its state files to
   * <base>/archive/<goalId>/.
   *
   * Moves:
   *   goals/<goalId>/         → archive/<goalId>/goal/
   *   tasks/<goalId>/         → archive/<goalId>/tasks/    (if exists)
   *   strategies/<goalId>/    → archive/<goalId>/strategies/ (if exists)
   *   stalls/<goalId>.json    → archive/<goalId>/stalls.json (if exists)
   *   reports/<goalId>/       → archive/<goalId>/reports/  (if exists)
   *
   * Returns true if the goal was archived, false if the goal was not found.
   */
  async archiveGoal(goalId: string, _visited = new Set<string>()): Promise<boolean> {
    if (!this.markGoalVisited(goalId, _visited)) return false;
    let archived = false;
    await this.goalWriteCoordinator.protectedOperation(goalId, "archive_goal", { goalId }, async () => {
      const archiveBase = this.archiveGoalDir(goalId);
      const stagingBase = this.archiveGoalStagingDir(goalId);
      const archiveLocation = this.goalStorageLocation(goalId, "archive");
      const archiveExists = await this.pathExists(archiveBase);
      const archiveCompleteMarkerExists = await this.pathExists(this.archiveCompleteMarkerPath(archiveBase));
      const archiveGoalJsonExists = await this.pathExists(archiveLocation.goalJsonPath);
      const activeLocation = await this.resolveGoalLocation(goalId, false);
      const location = archiveCompleteMarkerExists
        ? archiveLocation
        : activeLocation ?? (archiveGoalJsonExists ? archiveLocation : null);
      if (location === null) {
        await fsp.rm(stagingBase, { recursive: true, force: true });
        return;
      }

      // Recursively archive children first (depth-first)
      await this.visitChildGoals(goalId, location, _visited, (childId, visited) => this.archiveGoal(childId, visited));

      if (archiveCompleteMarkerExists) {
        await fsp.rm(stagingBase, { recursive: true, force: true });
        await this.cleanupActiveGoalState(goalId);
        archived = true;
        return;
      }

      if (archiveExists && activeLocation === null) {
        await fsp.rm(stagingBase, { recursive: true, force: true });
        await this.copyActiveArchiveRemnants(goalId, archiveBase);
        await this.atomicWrite(this.archiveCompleteMarkerPath(archiveBase), {
          goalId,
          completed_at: new Date().toISOString(),
        });
        await this.cleanupActiveGoalState(goalId);
        archived = true;
        return;
      }

      if (activeLocation === null) {
        await fsp.rm(stagingBase, { recursive: true, force: true });
        return;
      }

      await fsp.rm(stagingBase, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(stagingBase), { recursive: true });
      if (archiveExists) {
        await fsp.rm(archiveBase, { recursive: true, force: true });
      }

      // Move goals/<goalId>/ → archive/<goalId>/goal/
      const archiveGoalDir = path.join(stagingBase, "goal");
      await fsp.cp(location.dir, archiveGoalDir, {
        recursive: true,
        filter: (source) => path.basename(source) !== ".lock",
      });

      // Update status to "archived" in the archived goal.json (Bug 5)
      // Use direct JSON merge instead of GoalSchema.parse() to avoid silent failure
      // when unrelated fields fail Zod validation, which would leave status as "active".
      const archivedGoalJsonPath = path.join(archiveGoalDir, "goal.json");
      try {
        const archivedRaw = await this.atomicRead<unknown>(archivedGoalJsonPath);
        if (archivedRaw !== null && typeof archivedRaw === "object") {
          await this.atomicWrite(archivedGoalJsonPath, { ...(archivedRaw as Record<string, unknown>), status: "archived" });
        } else {
          this.logger?.warn(`[StateManager] Could not update status to "archived" for "${goalId}": goal.json missing or not an object`);
        }
      } catch (err) {
        this.logger?.warn(`[StateManager] Could not update status to "archived" for "${goalId}": ${String(err)}`);
      }

      // Move tasks/<goalId>/ → archive/<goalId>/tasks/ (if exists)
      const tasksDir = path.join(this.baseDir, "tasks", goalId);
      try {
        await fsp.access(tasksDir);
        const archiveTasksDir = path.join(stagingBase, "tasks");
        await fsp.cp(tasksDir, archiveTasksDir, { recursive: true });
      } catch (e: unknown) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }

      // Move strategies/<goalId>/ → archive/<goalId>/strategies/ (if exists)
      const strategiesDir = path.join(this.baseDir, "strategies", goalId);
      try {
        await fsp.access(strategiesDir);
        const archiveStrategiesDir = path.join(stagingBase, "strategies");
        await fsp.cp(strategiesDir, archiveStrategiesDir, { recursive: true });
      } catch (e: unknown) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }

      // Move stalls/<goalId>.json → archive/<goalId>/stalls.json (if exists)
      const stallsFile = path.join(this.baseDir, "stalls", `${goalId}.json`);
      try {
        await fsp.access(stallsFile);
        const archiveStallsFile = path.join(stagingBase, "stalls.json");
        await fsp.cp(stallsFile, archiveStallsFile);
      } catch (e: unknown) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }

      // Move reports/<goalId>/ → archive/<goalId>/reports/ (if exists)
      const reportsDir = path.join(this.baseDir, "reports", goalId);
      try {
        await fsp.access(reportsDir);
        const archiveReportsDir = path.join(stagingBase, "reports");
        await fsp.cp(reportsDir, archiveReportsDir, { recursive: true });
      } catch (e: unknown) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }

      await this.atomicWrite(this.archiveCompleteMarkerPath(stagingBase), {
        goalId,
        completed_at: new Date().toISOString(),
      });
      await this.commitArchiveGoal(stagingBase, archiveBase);
      await this.cleanupActiveGoalState(goalId);
      archived = true;
    });
    return archived;
  }

  /**
   * Returns the goal IDs of all archived goals under <base>/archive/.
   */
  async listArchivedGoals(): Promise<string[]> {
    const archiveDir = path.join(this.baseDir, "archive");
    try {
      const entries = await fsp.readdir(archiveDir, { withFileTypes: true });
      const archived: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === ".staging") continue;
        const archiveBase = this.archiveGoalDir(entry.name);
        const hasCompleteMarker = await this.pathExists(this.archiveCompleteMarkerPath(archiveBase));
        const hasGoalJson = await this.pathExists(this.goalStorageLocation(entry.name, "archive").goalJsonPath);
        if (
          hasGoalJson &&
          hasCompleteMarker
        ) {
          archived.push(entry.name);
        }
      }
      return archived;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return [];
    }
  }

  async listGoalIds(): Promise<string[]> {
    const goalsDir = path.join(this.baseDir, "goals");
    try {
      const entries = await fsp.readdir(goalsDir, { withFileTypes: true });
      return entries.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return [];
    }
  }

  async listRecoverableArchivedGoalIds(): Promise<string[]> {
    const archiveDir = path.join(this.baseDir, "archive");
    try {
      const entries = await fsp.readdir(archiveDir, { withFileTypes: true });
      const recoverable: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === ".staging") continue;
        if (await this.pathExists(path.join(archiveDir, entry.name, "goal", "goal.json"))) {
          recoverable.push(entry.name);
        }
      }
      return recoverable;
    } catch (error: unknown) {
      if (this.isEnoent(error)) return [];
      throw error;
    }
  }

  async listTasks(goalId: string, options: { includeArchive?: boolean } = {}): Promise<Task[]> {
    const { activeDir, archiveDir } = this.taskStorageDirs(goalId);
    if (activeDir === null || archiveDir === null) {
      return [];
    }
    const activeTasks = await this.readTasksFromDir(activeDir);
    if (activeTasks.length > 0 || options.includeArchive === false) {
      return activeTasks;
    }
    return this.readTasksFromDir(archiveDir);
  }

  async loadTask(goalId: string, taskId: string, options: { includeArchive?: boolean } = {}): Promise<Task | null> {
    const relativeCandidates = [`tasks/${goalId}/${taskId}.json`];
    if (options.includeArchive !== false) {
      relativeCandidates.push(`archive/${goalId}/tasks/${taskId}.json`);
    }

    for (const relativePath of relativeCandidates) {
      const raw = await this.readRaw(relativePath);
      if (raw === null) continue;
      const parsed = TaskSchema.safeParse(raw);
      if (parsed.success) {
        return parsed.data;
      }
    }

    return null;
  }

  // ─── Goal Tree ───

  async saveGoalTree(tree: GoalTree): Promise<void> {
    const parsed = GoalTreeSchema.parse(tree);
    const filePath = path.join(
      this.baseDir,
      "goal-trees",
      `${parsed.root_id}.json`
    );
    await this.atomicWrite(filePath, parsed);
  }

  async loadGoalTree(rootId: string): Promise<GoalTree | null> {
    const filePath = path.join(this.baseDir, "goal-trees", `${rootId}.json`);
    const raw = await this.atomicRead<unknown>(filePath);
    if (raw === null) return null;
    return GoalTreeSchema.parse(raw);
  }

  async deleteGoalTree(rootId: string): Promise<boolean> {
    const filePath = path.join(this.baseDir, "goal-trees", `${rootId}.json`);
    try {
      await fsp.unlink(filePath);
      return true;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return false;
    }
  }

  // ─── Observation Log ───

  async saveObservationLog(log: ObservationLog): Promise<void> {
    const parsed = ObservationLogSchema.parse(log);
    await this.writeObservationLog(parsed.goal_id, "save_observation", parsed, true);
  }

  async loadObservationLog(goalId: string): Promise<ObservationLog | null> {
    const filePath = path.join(
      this.baseDir,
      "goals",
      goalId,
      "observations.json"
    );
    const raw = await this.atomicRead<unknown>(filePath);
    if (raw === null) return null;
    return ObservationLogSchema.parse(raw);
  }

  async appendObservation(goalId: string, entry: ObservationLogEntry): Promise<void> {
    const parsed = ObservationLogEntrySchema.parse(entry);
    this.assertObservationGoalId(goalId, parsed);
    await this.goalWriteCoordinator.protectedReadModifyWrite(
      goalId,
      "append_observation",
      async () => {
        const log = (await this.loadObservationLog(goalId)) ?? { goal_id: goalId, entries: [] };
        return {
          ...log,
          entries: this.capHistoryEntries([...log.entries, parsed]),
        };
      },
      async (log) => {
        const dir = await this.goalDir(goalId);
        await this.atomicWrite(path.join(dir, "observations.json"), log);
      }
    );
  }

  // ─── Gap History ───

  async saveGapHistory(goalId: string, history: GapHistoryEntry[]): Promise<void> {
    const parsed = history.map((e) => GapHistoryEntrySchema.parse(e));
    await this.writeGapHistory(goalId, "save_gap_history", parsed, true);
  }

  async loadGapHistory(goalId: string): Promise<GapHistoryEntry[]> {
    const filePath = path.join(
      this.baseDir,
      "goals",
      goalId,
      "gap-history.json"
    );
    const raw = await this.atomicRead<unknown[]>(filePath);
    if (raw === null) return [];
    return raw.map((e) => GapHistoryEntrySchema.parse(e));
  }

  async appendGapHistoryEntry(goalId: string, entry: GapHistoryEntry): Promise<void> {
    const parsed = GapHistoryEntrySchema.parse(entry);
    await this.goalWriteCoordinator.protectedReadModifyWrite(
      goalId,
      "append_gap_entry",
      async () => {
        const history = await this.loadGapHistory(goalId);
        return {
          goalId,
          entries: this.capHistoryEntries([...history, parsed]),
        };
      },
      async (payload) => {
        const dir = await this.goalDir(goalId);
        await this.atomicWrite(path.join(dir, "gap-history.json"), payload.entries);
      }
    );
  }

  async appendObservationAndSaveGoal(
    goalId: string,
    entry: ObservationLogEntry,
    updateGoal: (goal: Goal) => Goal
  ): Promise<void> {
    const parsed = ObservationLogEntrySchema.parse(entry);
    this.assertObservationGoalId(goalId, parsed);

    await this.goalWriteCoordinator.protectedReadModifyWrite(
      goalId,
      "append_observation_and_save_goal",
      async () => {
        const goal = await this.loadGoal(goalId);
        if (goal === null) {
          throw new StateError(`appendObservationAndSaveGoal: goal "${goalId}" not found`);
        }

        const observationLog = (await this.loadObservationLog(goalId)) ?? { goal_id: goalId, entries: [] };
        const updatedGoal = GoalSchema.parse(updateGoal(goal));
        if (updatedGoal.id !== goalId) {
          throw new StateError(`appendObservationAndSaveGoal: update changed goal id from "${goalId}" to "${updatedGoal.id}"`);
        }
        return {
          observationLog: {
            ...observationLog,
            entries: this.capHistoryEntries([...observationLog.entries, parsed]),
          },
          goal: updatedGoal,
        };
      },
      async (data) => {
        const dir = await this.goalDir(goalId);
        await this.atomicWrite(path.join(dir, "observations.json"), data.observationLog);
        await this.atomicWrite(path.join(dir, "goal.json"), data.goal);
      }
    );
  }

  /**
   * Save a pace snapshot to a milestone goal (persists to disk).
   */
  async savePaceSnapshot(goalId: string, snapshot: PaceSnapshot): Promise<void> {
    const goal = await this.loadGoal(goalId);
    if (!goal) {
      throw new StateError(`savePaceSnapshot: goal "${goalId}" not found`);
    }
    const updated: Goal = { ...goal, pace_snapshot: snapshot };
    const dir = await this.goalDir(goalId);
    await this.protectedWrite(goalId, "save_pace_snapshot", updated, async () => {
      await this.atomicWrite(path.join(dir, "goal.json"), GoalSchema.parse(updated));
    });
  }

  // ─── Goal Tree Traversal ───

  /**
   * BFS traversal starting at rootId.
   * Returns null if rootId doesn't exist, otherwise returns goals in BFS order.
   */
  private async bfsCollect(rootId: string): Promise<Goal[] | null> {
    const root = await this.loadGoal(rootId);
    if (root === null) return null;

    const result: Goal[] = [];
    const queue: string[] = [rootId];
    const visited = new Set<string>();

    for (let index = 0; index < queue.length; index++) {
      const currentId = queue[index];
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      const goal = await this.loadGoal(currentId);
      if (goal === null) continue;

      result.push(goal);

      for (const childId of goal.children_ids) {
        if (!visited.has(childId)) {
          queue.push(childId);
        }
      }
    }

    return result;
  }

  /**
   * Get the full goal tree rooted at rootId.
   * Returns null if the root goal doesn't exist.
   * Returns goals in BFS order: root first, then children level by level.
   */
  async getGoalTree(rootId: string): Promise<Goal[] | null> {
    return this.bfsCollect(rootId);
  }

  /**
   * Get all goals in the subtree of goalId (including goalId itself).
   * Returns [] if goal not found.
   */
  async getSubtree(goalId: string): Promise<Goal[]> {
    return (await this.bfsCollect(goalId)) ?? [];
  }

  /**
   * Update a goal that belongs to a tree, handling both goal and tree consistency.
   * Merges updates into the existing goal, preserving its id.
   * If the goal has a parent_id, ensures the parent's children_ids still includes this goal.
   */
  async updateGoalInTree(goalId: string, updates: Partial<Goal>): Promise<void> {
    const existingGoal = await this.loadGoal(goalId);
    if (existingGoal === null) {
      throw new StateError(`updateGoalInTree: goal "${goalId}" not found`);
    }

    const updatedGoal: Goal = {
      ...existingGoal,
      ...updates,
      id: existingGoal.id,  // id is immutable
    };

    await this.saveGoal(updatedGoal);

    // Ensure parent's children_ids still includes this goal
    if (existingGoal.parent_id !== null) {
      const parent = await this.loadGoal(existingGoal.parent_id);
      if (parent !== null && !parent.children_ids.includes(goalId)) {
        await this.saveGoal({
          ...parent,
          children_ids: [...parent.children_ids, goalId],
          updated_at: new Date().toISOString(),
        });
      }
    }
  }

  // ─── Utility ───

  /** Check whether a goal directory exists */
  async goalExists(goalId: string): Promise<boolean> {
    try {
      await fsp.access(path.join(this.baseDir, "goals", goalId, "goal.json"));
      return true;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return false;
    }
  }

  /**
   * Restore dimension values and trust balance from a loop crash-recovery checkpoint.
   * Uses Zod validation on both the checkpoint and the goal.
   * Returns the saved cycle_number so the caller can resume iteration counting,
   * or 0 if no checkpoint exists or restoration fails (non-fatal).
   */
  async restoreFromCheckpoint(
    goalId: string,
    adapterType: string,
    trustManager?: CheckpointTrustPort
  ): Promise<number> {
    try {
      const raw = await this.atomicRead<unknown>(
        path.join(this.baseDir, "goals", goalId, "checkpoint.json")
      );
      if (raw === null) return 0;

      const parseResult = LoopCheckpointSchema.safeParse(raw);
      if (!parseResult.success) {
        this.logger?.warn(`[StateManager] Invalid checkpoint for "${goalId}": ${parseResult.error.message}`);
        return 0;
      }
      const cp = parseResult.data;

      // Restore dimension values from snapshot
      if (cp.dimension_snapshot) {
        const goal = await this.loadGoal(goalId);
        if (goal !== null) {
          const updatedDimensions = goal.dimensions.map((dim) => {
            const snapshotVal = cp.dimension_snapshot![dim.name];
            return typeof snapshotVal === "number"
              ? { ...dim, current_value: snapshotVal }
              : dim;
          });
          await this.saveGoal({ ...goal, dimensions: updatedDimensions });
        }
      }

      // Restore trust balance for the adapter domain
      if (typeof cp.trust_snapshot === "number" && trustManager) {
    try {
      await trustManager.setOverride(adapterType, cp.trust_snapshot, "checkpoint_restore");
    } catch {
      // Non-fatal — trust restore failure should not abort the run
    }
      }

      return cp.cycle_number;
    } catch {
      // Checkpoint restore failure is non-fatal — caller starts from beginning
      return 0;
    }
  }

  /** Read raw JSON from any path relative to base dir */
  async readRaw(relativePath: string): Promise<unknown | null> {
    const resolved = path.resolve(this.baseDir, relativePath);
    if (!resolved.startsWith(path.resolve(this.baseDir) + path.sep)) {
      throw new Error(`Path traversal detected: ${relativePath}`);
    }
    return this.atomicRead<unknown>(resolved);
  }

  /** Write raw JSON to any path relative to base dir (atomic) */
  async writeRaw(relativePath: string, data: unknown): Promise<void> {
    const resolved = path.resolve(this.baseDir, relativePath);
    if (!resolved.startsWith(path.resolve(this.baseDir) + path.sep)) {
      throw new Error(`Path traversal detected: ${relativePath}`);
    }
    const filePath = resolved;
    const dir = path.dirname(filePath);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    // Use protectedWrite only for goal-scoped paths like goals/<goalId>/<filename>
    const parts = relativePath.split("/");
    if (relativePath.startsWith("goals/") && parts.length >= 3) {
      const goalId = parts[1];
      await this.protectedWrite(goalId, "write_raw", { path: relativePath, payload: data }, async () => {
        await this.atomicWrite(filePath, data);
      });
    } else {
      await this.atomicWrite(filePath, data);
    }
  }
}
