import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import {
  LessonEntrySchema,
  MemoryIndexSchema,
} from "../types/memory-lifecycle.js";
import type {
  ShortTermEntry,
  LessonEntry,
  MemoryIndex,
  MemoryIndexEntry,
} from "../types/memory-lifecycle.js";
import { atomicWriteAsync, readJsonFileAsync, generateId } from "./memory-persistence.js";

// ─── Index management ───

export async function initializeIndex(memoryDir: string, layer: "short-term" | "long-term"): Promise<void> {
  const indexPath = path.join(memoryDir, layer, "index.json");
  try {
    await fsp.access(indexPath);
  } catch {
    const emptyIndex: MemoryIndex = MemoryIndexSchema.parse({
      version: 1,
      last_updated: new Date().toISOString(),
      entries: [],
    });
    await fsp.mkdir(path.dirname(indexPath), { recursive: true });
    await atomicWriteAsync(indexPath, emptyIndex);
  }
}

export async function loadIndex(memoryDir: string, layer: "short-term" | "long-term"): Promise<MemoryIndex> {
  const indexPath = path.join(memoryDir, layer, "index.json");
  const raw = await readJsonFileAsync<MemoryIndex>(indexPath, MemoryIndexSchema);
  if (raw === null) {
    return MemoryIndexSchema.parse({
      version: 1,
      last_updated: new Date().toISOString(),
      entries: [],
    });
  }
  return raw;
}

export async function saveIndex(
  memoryDir: string,
  layer: "short-term" | "long-term",
  index: MemoryIndex
): Promise<void> {
  const indexPath = path.join(memoryDir, layer, "index.json");
  try {
    await fsp.mkdir(path.dirname(indexPath), { recursive: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const updated = MemoryIndexSchema.parse({
    ...index,
    last_updated: new Date().toISOString(),
  });
  await atomicWriteAsync(indexPath, updated);
}

export async function updateIndex(
  memoryDir: string,
  layer: "short-term" | "long-term",
  entry: MemoryIndexEntry
): Promise<void> {
  const index = await loadIndex(memoryDir, layer);
  index.entries.push(entry);
  await saveIndex(memoryDir, layer, index);
}

export async function removeFromIndex(
  memoryDir: string,
  layer: "short-term" | "long-term",
  entryIds: Set<string>
): Promise<void> {
  const index = await loadIndex(memoryDir, layer);
  index.entries = index.entries.filter(
    (ie) => !entryIds.has(ie.entry_id)
  );
  await saveIndex(memoryDir, layer, index);
}

export async function removeGoalFromIndex(
  memoryDir: string,
  layer: "short-term" | "long-term",
  goalId: string
): Promise<void> {
  const index = await loadIndex(memoryDir, layer);
  index.entries = index.entries.filter((ie) => ie.goal_id !== goalId);
  await saveIndex(memoryDir, layer, index);
}

export async function touchIndexEntry(
  memoryDir: string,
  layer: "short-term" | "long-term",
  indexId: string
): Promise<void> {
  const index = await loadIndex(memoryDir, layer);
  const now = new Date().toISOString();
  const updated = index.entries.map((ie) => {
    if (ie.id === indexId) {
      return { ...ie, last_accessed: now, access_count: ie.access_count + 1 };
    }
    return ie;
  });
  await saveIndex(memoryDir, layer, { ...index, entries: updated });
}

export async function archiveOldestLongTermEntries(memoryDir: string): Promise<void> {
  const index = await loadIndex(memoryDir, "long-term");

  // Sort by last_accessed ascending (oldest first)
  const sorted = [...index.entries].sort(
    (a, b) =>
      new Date(a.last_accessed).getTime() -
      new Date(b.last_accessed).getTime()
  );

  // Archive oldest 10% of entries
  const archiveCount = Math.max(1, Math.floor(sorted.length * 0.1));
  const toArchive = sorted.slice(0, archiveCount);
  const toArchiveIds = new Set(toArchive.map((ie) => ie.entry_id));

  // Remove from active index
  index.entries = index.entries.filter(
    (ie) => !toArchiveIds.has(ie.entry_id)
  );
  await saveIndex(memoryDir, "long-term", index);
}

// ─── Lesson storage ───

export async function storeLessonsLongTerm(
  memoryDir: string,
  goalId: string,
  lessons: LessonEntry[],
  sourceEntries: ShortTermEntry[]
): Promise<void> {
  // 1. Store by-goal
  const byGoalPath = path.join(
    memoryDir,
    "long-term",
    "lessons",
    "by-goal",
    `${goalId}.json`
  );
  const existingByGoal =
    (await readJsonFileAsync<LessonEntry[]>(byGoalPath, z.array(LessonEntrySchema))) ?? [];
  await atomicWriteAsync(byGoalPath, [...existingByGoal, ...lessons]);

  // 2. Store by-dimension (for each unique dimension in source entries)
  const allDimensions = new Set(sourceEntries.flatMap((e) => e.dimensions));
  for (const dim of allDimensions) {
    if (!dim) continue;
    const byDimPath = path.join(
      memoryDir,
      "long-term",
      "lessons",
      "by-dimension",
      `${dim}.json`
    );
    const existingByDim =
      (await readJsonFileAsync<LessonEntry[]>(byDimPath, z.array(LessonEntrySchema))) ?? [];
    // Store lessons that have this dimension's tag or are from these source entries
    const relevantLessons = lessons.filter(
      (l) =>
        l.relevance_tags.includes(dim) ||
        l.relevance_tags.length === 0 // include all if no tags
    );
    if (relevantLessons.length > 0) {
      await atomicWriteAsync(byDimPath, [...existingByDim, ...relevantLessons]);
    }
  }

  // 3. Store in global (all lessons are cross-goal knowledge)
  const globalPath = path.join(
    memoryDir,
    "long-term",
    "lessons",
    "global.json"
  );
  const existingGlobal =
    (await readJsonFileAsync<LessonEntry[]>(globalPath, z.array(LessonEntrySchema))) ?? [];
  await atomicWriteAsync(globalPath, [...existingGlobal, ...lessons]);

  // 4. Update long-term index
  const now = new Date().toISOString();
  for (const lesson of lessons) {
    await updateIndex(memoryDir, "long-term", {
      id: generateId("ltidx"),
      goal_id: goalId,
      dimensions: sourceEntries
        .filter((e) =>
          lesson.source_loops.includes(`loop_${e.loop_number}`)
        )
        .flatMap((e) => e.dimensions),
      tags: lesson.relevance_tags,
      timestamp: lesson.extracted_at,
      data_file: path.join(
        "lessons",
        "by-goal",
        `${goalId}.json`
      ),
      entry_id: lesson.lesson_id,
      last_accessed: now,
      access_count: 0,
      embedding_id: null,
      memory_tier: "recall" as const,
    });
  }
}
