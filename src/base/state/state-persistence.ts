import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { writeJsonFileAtomic } from "../utils/json-io.js";
import type { Logger } from "../runtime/logger.js";

/**
 * Standalone file I/O helpers extracted from StateManager.
 * These functions are pure utilities with no class-state dependencies.
 */

/** Initialize required subdirectories under baseDir. */
export async function initDirs(baseDir: string): Promise<void> {
  const dirs = [
    baseDir,
    path.join(baseDir, "goals"),
    path.join(baseDir, "goal-trees"),
    path.join(baseDir, "events"),
    path.join(baseDir, "events", "archive"),
    path.join(baseDir, "reports"),
    path.join(baseDir, "reports", "daily"),
    path.join(baseDir, "reports", "weekly"),
    path.join(baseDir, "reports", "notifications"),
    path.join(baseDir, "checkpoints"),
  ];
  for (const dir of dirs) {
    await fsp.mkdir(dir, { recursive: true });
  }
}

/** Atomically write JSON data to filePath. Silently skips if base dir is missing (e.g. test cleanup). */
export async function atomicWrite(filePath: string, data: unknown): Promise<void> {
  try {
    await writeJsonFileAtomic(filePath, data);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/** Safely read and parse JSON from filePath. Returns null if file is missing or JSON is corrupt. */
export async function atomicRead<T>(filePath: string, logger?: Logger): Promise<T | null> {
  let content: string;
  try {
    content = await fsp.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  try {
    return JSON.parse(content) as T;
  } catch (err) {
    logger?.warn(`[StateManager] Corrupt JSON at ${filePath}: ${err}`);
    console.warn(`[StateManager] Corrupt JSON at ${filePath}, returning null:`, err);
    return null;
  }
}
