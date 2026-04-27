import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { GoalSchema } from "../types/goal.js";
import { TaskSchema } from "../types/task.js";
import type { Goal } from "../types/goal.js";
import type { Task } from "../types/task.js";
import type { Logger } from "../../runtime/logger.js";

const ARCHIVE_COMPLETE_MARKER = ".archive-complete.json";

export type GoalLocationKind = "active" | "archive";

export interface GoalStorageLocation {
  kind: GoalLocationKind;
  dir: string;
  goalJsonPath: string;
}

export interface GoalArchiveHelpers {
  baseDir: string;
  logger?: Logger;
  pathExists: (filePath: string) => Promise<boolean>;
  atomicRead: <T>(filePath: string) => Promise<T | null>;
  atomicWrite: (filePath: string, data: unknown) => Promise<void>;
  loadGoal: (goalId: string) => Promise<Goal | null>;
  cleanupActiveGoalState: (goalId: string) => Promise<void>;
  goalWriteProtectedOperation: (goalId: string, op: string, data: unknown, fn: () => Promise<void>) => Promise<void>;
  commitArchiveGoal: (stagingBase: string, archiveBase: string) => Promise<void>;
}

export function goalStorageLocation(baseDir: string, goalId: string, kind: GoalLocationKind): GoalStorageLocation {
  if (kind === "active") {
    const dir = path.join(baseDir, "goals", goalId);
    return { kind, dir, goalJsonPath: path.join(dir, "goal.json") };
  }

  const dir = path.join(baseDir, "archive", goalId);
  return { kind, dir, goalJsonPath: path.join(dir, "goal", "goal.json") };
}

export function archiveGoalDir(baseDir: string, goalId: string): string {
  return path.join(baseDir, "archive", goalId);
}

export function archiveGoalStagingDir(baseDir: string, goalId: string): string {
  return path.join(baseDir, "archive", ".staging", goalId);
}

export function archiveCompleteMarkerPath(archiveBase: string): string {
  return path.join(archiveBase, ARCHIVE_COMPLETE_MARKER);
}

export function resolveWithinBase(baseDir: string, ...segments: string[]): string | null {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, ...segments);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    return null;
  }
  return resolved;
}

export function taskStorageDirs(baseDir: string, goalId: string): { activeDir: string | null; archiveDir: string | null } {
  return {
    activeDir: resolveWithinBase(baseDir, "tasks", goalId),
    archiveDir: resolveWithinBase(baseDir, "archive", goalId, "tasks"),
  };
}

export async function readTasksFromDir(
  tasksDir: string,
  deps: {
    atomicRead: <T>(filePath: string) => Promise<T | null>;
    isEnoent: (error: unknown) => boolean;
  }
): Promise<Task[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(tasksDir);
  } catch (error: unknown) {
    if (deps.isEnoent(error)) return [];
    throw error;
  }

  const tasks: Task[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry === "task-history.json" || entry === "last-failure-context.json") {
      continue;
    }
    try {
      const raw = await deps.atomicRead<unknown>(path.join(tasksDir, entry));
      if (raw === null) continue;
      const parsed = TaskSchema.safeParse(raw);
      if (parsed.success) {
        tasks.push(parsed.data);
      }
    } catch (error: unknown) {
      if (!deps.isEnoent(error)) throw error;
    }
  }

  return tasks.sort((left, right) => right.created_at.localeCompare(left.created_at));
}

export async function resolveGoalLocation(
  baseDir: string,
  goalId: string,
  includeArchive: boolean,
  pathExistsFn: (filePath: string) => Promise<boolean>
): Promise<GoalStorageLocation | null> {
  const activeLocation = goalStorageLocation(baseDir, goalId, "active");
  if (await pathExistsFn(activeLocation.dir)) return activeLocation;

  if (!includeArchive) return null;

  const archiveLocation = goalStorageLocation(baseDir, goalId, "archive");
  if (await pathExistsFn(archiveLocation.dir)) return archiveLocation;
  return null;
}

export async function loadGoalForChildTraversal(
  goalId: string,
  location: GoalStorageLocation,
  deps: Pick<GoalArchiveHelpers, "atomicRead" | "loadGoal" | "logger">
): Promise<Goal | null> {
  try {
    if (location.kind === "archive") {
      const raw = await deps.atomicRead<unknown>(location.goalJsonPath);
      return raw === null ? null : GoalSchema.parse(raw);
    }

    return deps.loadGoal(goalId);
  } catch {
    const archivedLabel = location.kind === "archive" ? " archived" : "";
    deps.logger?.warn(`[StateManager] Skipping children of${archivedLabel} "${goalId}": goal.json unreadable`);
    return null;
  }
}

export async function visitChildGoals(
  goalId: string,
  location: GoalStorageLocation,
  visited: Set<string>,
  deps: Pick<GoalArchiveHelpers, "atomicRead" | "loadGoal" | "logger">,
  visit: (childId: string, visited: Set<string>) => Promise<boolean>
): Promise<void> {
  const goal = await loadGoalForChildTraversal(goalId, location, deps);
  if (goal === null) return;

  for (const childId of goal.children_ids) {
    await visit(childId, visited);
  }
}

export async function listArchivedGoals(baseDir: string, pathExistsFn: (filePath: string) => Promise<boolean>): Promise<string[]> {
  const archiveDir = path.join(baseDir, "archive");
  try {
    const entries = await fsp.readdir(archiveDir, { withFileTypes: true });
    const archived: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".staging") continue;
      const archiveBase = archiveGoalDir(baseDir, entry.name);
      const hasCompleteMarker = await pathExistsFn(archiveCompleteMarkerPath(archiveBase));
      const hasGoalJson = await pathExistsFn(goalStorageLocation(baseDir, entry.name, "archive").goalJsonPath);
      if (hasGoalJson && hasCompleteMarker) {
        archived.push(entry.name);
      }
    }
    return archived;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

export async function listRecoverableArchivedGoalIds(baseDir: string, pathExistsFn: (filePath: string) => Promise<boolean>): Promise<string[]> {
  const archiveDir = path.join(baseDir, "archive");
  try {
    const entries = await fsp.readdir(archiveDir, { withFileTypes: true });
    const recoverable: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".staging") continue;
      if (await pathExistsFn(path.join(archiveDir, entry.name, "goal", "goal.json"))) {
        recoverable.push(entry.name);
      }
    }
    return recoverable;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

async function copyActiveArchiveRemnants(baseDir: string, goalId: string, archiveBase: string, pathExistsFn: (filePath: string) => Promise<boolean>): Promise<void> {
  const tasksDir = path.join(baseDir, "tasks", goalId);
  if (await pathExistsFn(tasksDir)) {
    await fsp.cp(tasksDir, path.join(archiveBase, "tasks"), { recursive: true });
  }

  const strategiesDir = path.join(baseDir, "strategies", goalId);
  if (await pathExistsFn(strategiesDir)) {
    await fsp.cp(strategiesDir, path.join(archiveBase, "strategies"), { recursive: true });
  }

  const stallsFile = path.join(baseDir, "stalls", `${goalId}.json`);
  if (await pathExistsFn(stallsFile)) {
    await fsp.cp(stallsFile, path.join(archiveBase, "stalls.json"));
  }

  const reportsDir = path.join(baseDir, "reports", goalId);
  if (await pathExistsFn(reportsDir)) {
    await fsp.cp(reportsDir, path.join(archiveBase, "reports"), { recursive: true });
  }
}

export async function archiveGoalState(
  goalId: string,
  visited: Set<string>,
  deps: GoalArchiveHelpers
): Promise<boolean> {
  let archived = false;
  await deps.goalWriteProtectedOperation(goalId, "archive_goal", { goalId }, async () => {
    const archiveBase = archiveGoalDir(deps.baseDir, goalId);
    const stagingBase = archiveGoalStagingDir(deps.baseDir, goalId);
    const archiveLocation = goalStorageLocation(deps.baseDir, goalId, "archive");
    const archiveExists = await deps.pathExists(archiveBase);
    const archiveCompleteMarkerExists = await deps.pathExists(archiveCompleteMarkerPath(archiveBase));
    const archiveGoalJsonExists = await deps.pathExists(archiveLocation.goalJsonPath);
    const activeLocation = await resolveGoalLocation(deps.baseDir, goalId, false, deps.pathExists);
    const location = archiveCompleteMarkerExists
      ? archiveLocation
      : activeLocation ?? (archiveGoalJsonExists ? archiveLocation : null);

    if (location === null) {
      await fsp.rm(stagingBase, { recursive: true, force: true });
      return;
    }

    await visitChildGoals(goalId, location, visited, deps, async (childId, childVisited) =>
      archiveGoalState(childId, childVisited, deps)
    );

    if (archiveCompleteMarkerExists) {
      await fsp.rm(stagingBase, { recursive: true, force: true });
      await deps.cleanupActiveGoalState(goalId);
      archived = true;
      return;
    }

    if (archiveExists && activeLocation === null) {
      await fsp.rm(stagingBase, { recursive: true, force: true });
      await copyActiveArchiveRemnants(deps.baseDir, goalId, archiveBase, deps.pathExists);
      await deps.atomicWrite(archiveCompleteMarkerPath(archiveBase), {
        goalId,
        completed_at: new Date().toISOString(),
      });
      await deps.cleanupActiveGoalState(goalId);
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

    const archiveGoalDirPath = path.join(stagingBase, "goal");
    await fsp.cp(location.dir, archiveGoalDirPath, {
      recursive: true,
      filter: (source) => path.basename(source) !== ".lock",
    });

    const archivedGoalJsonPath = path.join(archiveGoalDirPath, "goal.json");
    try {
      const archivedRaw = await deps.atomicRead<unknown>(archivedGoalJsonPath);
      if (archivedRaw !== null && typeof archivedRaw === "object") {
        await deps.atomicWrite(archivedGoalJsonPath, { ...(archivedRaw as Record<string, unknown>), status: "archived" });
      } else {
        deps.logger?.warn(`[StateManager] Could not update status to "archived" for "${goalId}": goal.json missing or not an object`);
      }
    } catch (err) {
      deps.logger?.warn(`[StateManager] Could not update status to "archived" for "${goalId}": ${String(err)}`);
    }

    await copyActiveArchiveRemnants(deps.baseDir, goalId, stagingBase, deps.pathExists);
    await deps.atomicWrite(archiveCompleteMarkerPath(stagingBase), {
      goalId,
      completed_at: new Date().toISOString(),
    });
    await deps.commitArchiveGoal(stagingBase, archiveBase);
    await deps.cleanupActiveGoalState(goalId);
    archived = true;
  });
  return archived;
}
