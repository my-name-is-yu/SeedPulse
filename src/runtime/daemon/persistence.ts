import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../../base/utils/json-io.js";
import { DaemonStateSchema } from "../../base/types/daemon.js";
import type { DaemonState } from "../../base/types/daemon.js";
import type { Logger } from "../logger.js";
import type { RuntimeOwnershipCoordinator } from "./runtime-ownership.js";
import type { ShutdownMarker } from "./types.js";

export async function saveDaemonStateFile(
  baseDir: string,
  state: DaemonState,
  logger: Logger,
): Promise<void> {
  const statePath = path.join(baseDir, "daemon-state.json");
  try {
    await writeJsonFileAtomic(statePath, state);
  } catch (err) {
    logger.warn("Failed to save daemon state", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function loadDaemonStateFile(baseDir: string): Promise<DaemonState | null> {
  const statePath = path.join(baseDir, "daemon-state.json");
  const data = await readJsonFileOrNull(statePath);
  if (data === null) {
    return null;
  }
  try {
    return DaemonStateSchema.parse(data);
  } catch {
    return null;
  }
}

export async function restoreInterruptedGoals(
  baseDir: string,
  goalIds: string[],
  logger: Logger,
): Promise<string[]> {
  const saved = await loadDaemonStateFile(baseDir);
  if (!saved) {
    return goalIds;
  }

  const recoverableGoals = new Set<string>(saved.interrupted_goals ?? []);
  const shouldRecoverActiveGoals =
    recoverableGoals.size === 0 &&
    saved.active_goals.length > 0 &&
    saved.status !== "stopped";

  if (shouldRecoverActiveGoals) {
    for (const goalId of saved.active_goals) {
      recoverableGoals.add(goalId);
    }
  }

  if (recoverableGoals.size === 0) {
    return goalIds;
  }

  const merged = Array.from(new Set([...goalIds, ...recoverableGoals]));
  if (merged.length > goalIds.length) {
    logger.info("Restored interrupted goals from previous run", {
      interrupted: [...recoverableGoals],
      source: shouldRecoverActiveGoals ? "active_goals" : "interrupted_goals",
      merged,
    });
  }
  return merged;
}

export async function writeShutdownMarkerFile(
  baseDir: string,
  marker: ShutdownMarker,
  logger: Logger,
): Promise<void> {
  const markerPath = path.join(baseDir, "shutdown-state.json");
  try {
    await writeJsonFileAtomic(markerPath, marker);
  } catch (err) {
    logger.warn("Failed to write shutdown marker", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function readShutdownMarkerFile(baseDir: string): Promise<ShutdownMarker | null> {
  const markerPath = path.join(baseDir, "shutdown-state.json");
  return readJsonFileOrNull<ShutdownMarker>(markerPath);
}

export async function deleteShutdownMarkerFile(baseDir: string): Promise<void> {
  const markerPath = path.join(baseDir, "shutdown-state.json");
  try {
    await fsp.unlink(markerPath);
  } catch {
    // File may not exist — ignore
  }
}

export async function checkCrashRecoveryMarker(baseDir: string, logger: Logger): Promise<void> {
  const marker = await readShutdownMarkerFile(baseDir);
  if (!marker) {
    return;
  }

  if (marker.state === "clean_shutdown") {
    logger.info("Resuming from clean shutdown", {
      previous_loop_index: marker.loop_index,
      previous_goals: marker.goal_ids,
      shutdown_at: marker.timestamp,
    });
  } else {
    logger.warn("Recovering from crash — previous instance did not shut down cleanly", {
      previous_loop_index: marker.loop_index,
      previous_goals: marker.goal_ids,
      last_seen_at: marker.timestamp,
    });
  }

  await deleteShutdownMarkerFile(baseDir);
}

export async function cleanupDaemonRun(params: {
  baseDir: string;
  state: DaemonState;
  currentGoalIds: string[];
  currentLoopIndex: number;
  runtimeOwnership: RuntimeOwnershipCoordinator;
  logger: Logger;
}): Promise<void> {
  const {
    baseDir,
    state,
    currentGoalIds,
    currentLoopIndex,
    runtimeOwnership,
    logger,
  } = params;

  const wasCrashed = state.status === "crashed";
  if (!wasCrashed) {
    state.status = "stopped";
    if (state.interrupted_goals === undefined) {
      state.interrupted_goals = [...state.active_goals];
    }
  }

  await saveDaemonStateFile(baseDir, state, logger);
  await runtimeOwnership.releaseLeadership();
  await runtimeOwnership.saveFinalHealth(wasCrashed ? "failed" : "degraded");
  await writeShutdownMarkerFile(
    baseDir,
    {
      goal_ids: currentGoalIds,
      loop_index: currentLoopIndex,
      timestamp: new Date().toISOString(),
      reason: wasCrashed ? "max_retries" : "stop",
      state: wasCrashed ? "running" : "clean_shutdown",
    },
    logger,
  );

  logger.info("Daemon stopped", {
    loop_count: state.loop_count,
    crash_count: state.crash_count,
  });
}
