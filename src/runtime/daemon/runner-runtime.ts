import { checkCrashRecoveryMarker, deleteShutdownMarkerFile, readShutdownMarkerFile, writeShutdownMarkerFile } from "./index.js";
import { rotateDaemonLog, calculateAdaptiveInterval as calcAdaptiveInterval } from "./health.js";
import type { Logger } from "../logger.js";
import type { ShutdownMarker } from "./index.js";
import type { DaemonConfig, DaemonState } from "../../base/types/daemon.js";

export function refreshDaemonOperationalState(
  state: DaemonState,
  currentGoalIds: string[]
): void {
  state.active_goals = [...currentGoalIds];
  if (state.status === "crashed" || state.status === "stopping") {
    return;
  }
  state.status = currentGoalIds.length === 0 ? "idle" : "running";
}

export function sleepWithAbort(
  ms: number,
  setAbortController: (controller: AbortController | null) => void
): Promise<void> {
  const abortController = new AbortController();
  setAbortController(abortController);
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    abortController.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  }).finally(() => {
    setAbortController(null);
  });
}

export function calculateDaemonAdaptiveInterval(
  config: DaemonConfig,
  baseInterval: number,
  goalsActivatedThisCycle: number,
  maxGapScore: number,
  consecutiveIdleCycles: number
): number {
  return calcAdaptiveInterval(
    baseInterval,
    goalsActivatedThisCycle,
    maxGapScore,
    consecutiveIdleCycles,
    config.adaptive_sleep
  );
}

export async function writeDaemonShutdownMarker(
  baseDir: string,
  marker: ShutdownMarker,
  logger: Logger
): Promise<void> {
  await writeShutdownMarkerFile(baseDir, marker, logger);
}

export async function readDaemonShutdownMarker(baseDir: string): Promise<ShutdownMarker | null> {
  return readShutdownMarkerFile(baseDir);
}

export async function deleteDaemonShutdownMarker(baseDir: string): Promise<void> {
  await deleteShutdownMarkerFile(baseDir);
}

export async function checkDaemonCrashRecovery(baseDir: string, logger: Logger): Promise<void> {
  await checkCrashRecoveryMarker(baseDir, logger);
}

export async function rotateDaemonRunnerLog(
  config: DaemonConfig,
  logPath: string,
  logDir: string,
  logger: Logger
): Promise<void> {
  const maxSizeBytes = config.log_rotation.max_size_mb * 1024 * 1024;
  const maxFiles = config.log_rotation.max_files;
  await rotateDaemonLog(logPath, logDir, maxSizeBytes, maxFiles, logger);
}
