import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import {
  ShortTermEntrySchema,
  LessonEntrySchema,
  StatisticalSummarySchema,
  type LessonEntry,
  type MemoryDataType,
  type ShortTermEntry,
  type StatisticalSummary,
} from "../../../base/types/memory-lifecycle.js";
import { atomicWriteAsync, readJsonFileAsync, getDataFile } from "./memory-persistence.js";
import { initializeIndex, removeGoalFromIndex } from "./memory-index.js";
import type { MemoryCompressionDeps } from "./memory-compression.js";
import { compressAllRemainingToLongTerm as _compressAllRemainingToLongTerm } from "./memory-compression.js";

export async function initializeMemoryDirectories(memoryDir: string): Promise<void> {
  const dirs = [
    path.join(memoryDir, "short-term", "goals"),
    path.join(memoryDir, "long-term", "lessons", "by-goal"),
    path.join(memoryDir, "long-term", "lessons", "by-dimension"),
    path.join(memoryDir, "long-term", "statistics"),
    path.join(memoryDir, "archive"),
  ];
  for (const dir of dirs) {
    await fsp.mkdir(dir, { recursive: true });
  }

  await initializeIndex(memoryDir, "short-term");
  await initializeIndex(memoryDir, "long-term");

  const globalPath = path.join(memoryDir, "long-term", "lessons", "global.json");
  try {
    await fsp.access(globalPath);
  } catch {
    await atomicWriteAsync(globalPath, []);
  }
}

export async function archiveGoalMemory(
  memoryDir: string,
  compressionDeps: MemoryCompressionDeps,
  goalId: string,
  reason: "completed" | "cancelled"
): Promise<void> {
  const dataTypes: MemoryDataType[] = [
    "experience_log",
    "observation",
    "strategy",
    "task",
    "knowledge",
  ];

  for (const dataType of dataTypes) {
    const dataFile = getDataFile(memoryDir, goalId, dataType);
    try {
      await fsp.access(dataFile);
    } catch {
      continue;
    }

    const entries =
      (await readJsonFileAsync<ShortTermEntry[]>(
        dataFile,
        z.array(ShortTermEntrySchema)
      )) ?? [];
    if (entries.length === 0) continue;

    try {
      await _compressAllRemainingToLongTerm(compressionDeps, goalId, dataType, entries);
    } catch {
      // Best-effort on close.
    }
  }

  const goalShortTermDir = path.join(memoryDir, "short-term", "goals", goalId);
  const archiveGoalDir = path.join(memoryDir, "archive", goalId);

  try {
    await fsp.access(goalShortTermDir);
    await fsp.mkdir(archiveGoalDir, { recursive: true });

    const files = await fsp.readdir(goalShortTermDir);
    for (const file of files) {
      await fsp.copyFile(path.join(goalShortTermDir, file), path.join(archiveGoalDir, file));
    }

    await fsp.rm(goalShortTermDir, { recursive: true, force: true });
    await removeGoalFromIndex(memoryDir, "short-term", goalId);
  } catch {
    // Nothing to archive.
  }

  const byGoalLessonsPath = path.join(memoryDir, "long-term", "lessons", "by-goal", `${goalId}.json`);
  const statisticsPath = path.join(memoryDir, "long-term", "statistics", `${goalId}.json`);

  try {
    await fsp.access(byGoalLessonsPath);
    await fsp.mkdir(archiveGoalDir, { recursive: true });
    const archiveLessonsPath = path.join(archiveGoalDir, "lessons.json");
    const existingArchive =
      (await readJsonFileAsync<LessonEntry[]>(archiveLessonsPath, z.array(LessonEntrySchema))) ?? [];
    const goalLessons =
      (await readJsonFileAsync<LessonEntry[]>(byGoalLessonsPath, z.array(LessonEntrySchema))) ?? [];
    await atomicWriteAsync(archiveLessonsPath, [...existingArchive, ...goalLessons]);
  } catch {
    // Skip if unavailable.
  }

  try {
    await fsp.access(statisticsPath);
    await fsp.mkdir(archiveGoalDir, { recursive: true });
    const archiveStatsPath = path.join(archiveGoalDir, "statistics.json");
    const stats = await readJsonFileAsync<StatisticalSummary>(statisticsPath, StatisticalSummarySchema);
    if (stats) {
      await atomicWriteAsync(archiveStatsPath, stats);
    }
  } catch {
    // Skip if unavailable.
  }

  try {
    await fsp.access(byGoalLessonsPath);
    const lessons =
      (await readJsonFileAsync<LessonEntry[]>(byGoalLessonsPath, z.array(LessonEntrySchema))) ?? [];
    const archived = lessons.map((lesson) => LessonEntrySchema.parse({ ...lesson, status: "archived" }));
    await atomicWriteAsync(byGoalLessonsPath, archived);
  } catch {
    // Skip if unavailable.
  }

  void reason;
}
