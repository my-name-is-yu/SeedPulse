import * as fs from "node:fs";
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
import { atomicWrite, readJsonFile, generateId } from "./memory-persistence.js";

// ─── Index management ───

export function initializeIndex(memoryDir: string, layer: "short-term" | "long-term"): void {
  const indexPath = path.join(memoryDir, layer, "index.json");
  if (!fs.existsSync(indexPath)) {
    const emptyIndex: MemoryIndex = MemoryIndexSchema.parse({
      version: 1,
      last_updated: new Date().toISOString(),
      entries: [],
    });
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    atomicWrite(indexPath, emptyIndex);
  }
}

export function loadIndex(memoryDir: string, layer: "short-term" | "long-term"): MemoryIndex {
  const indexPath = path.join(memoryDir, layer, "index.json");
  const raw = readJsonFile<MemoryIndex>(indexPath, MemoryIndexSchema);
  if (raw === null) {
    return MemoryIndexSchema.parse({
      version: 1,
      last_updated: new Date().toISOString(),
      entries: [],
    });
  }
  return raw;
}

export function saveIndex(
  memoryDir: string,
  layer: "short-term" | "long-term",
  index: MemoryIndex
): void {
  const indexPath = path.join(memoryDir, layer, "index.json");
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  const updated = MemoryIndexSchema.parse({
    ...index,
    last_updated: new Date().toISOString(),
  });
  atomicWrite(indexPath, updated);
}

export function updateIndex(
  memoryDir: string,
  layer: "short-term" | "long-term",
  entry: MemoryIndexEntry
): void {
  const index = loadIndex(memoryDir, layer);
  index.entries.push(entry);
  saveIndex(memoryDir, layer, index);
}

export function removeFromIndex(
  memoryDir: string,
  layer: "short-term" | "long-term",
  entryIds: Set<string>
): void {
  const index = loadIndex(memoryDir, layer);
  index.entries = index.entries.filter(
    (ie) => !entryIds.has(ie.entry_id)
  );
  saveIndex(memoryDir, layer, index);
}

export function removeGoalFromIndex(
  memoryDir: string,
  layer: "short-term" | "long-term",
  goalId: string
): void {
  const index = loadIndex(memoryDir, layer);
  index.entries = index.entries.filter((ie) => ie.goal_id !== goalId);
  saveIndex(memoryDir, layer, index);
}

export function touchIndexEntry(
  memoryDir: string,
  layer: "short-term" | "long-term",
  indexId: string
): void {
  const index = loadIndex(memoryDir, layer);
  const now = new Date().toISOString();
  const updated = index.entries.map((ie) => {
    if (ie.id === indexId) {
      return { ...ie, last_accessed: now, access_count: ie.access_count + 1 };
    }
    return ie;
  });
  saveIndex(memoryDir, layer, { ...index, entries: updated });
}

export function archiveOldestLongTermEntries(memoryDir: string): void {
  const index = loadIndex(memoryDir, "long-term");

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
  saveIndex(memoryDir, "long-term", index);
}

// ─── Lesson storage ───

export function storeLessonsLongTerm(
  memoryDir: string,
  goalId: string,
  lessons: LessonEntry[],
  sourceEntries: ShortTermEntry[]
): void {
  // 1. Store by-goal
  const byGoalPath = path.join(
    memoryDir,
    "long-term",
    "lessons",
    "by-goal",
    `${goalId}.json`
  );
  const existingByGoal =
    readJsonFile<LessonEntry[]>(byGoalPath, z.array(LessonEntrySchema)) ?? [];
  atomicWrite(byGoalPath, [...existingByGoal, ...lessons]);

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
      readJsonFile<LessonEntry[]>(byDimPath, z.array(LessonEntrySchema)) ?? [];
    // Store lessons that have this dimension's tag or are from these source entries
    const relevantLessons = lessons.filter(
      (l) =>
        l.relevance_tags.includes(dim) ||
        l.relevance_tags.length === 0 // include all if no tags
    );
    if (relevantLessons.length > 0) {
      atomicWrite(byDimPath, [...existingByDim, ...relevantLessons]);
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
    readJsonFile<LessonEntry[]>(globalPath, z.array(LessonEntrySchema)) ?? [];
  atomicWrite(globalPath, [...existingGlobal, ...lessons]);

  // 4. Update long-term index
  const now = new Date().toISOString();
  for (const lesson of lessons) {
    updateIndex(memoryDir, "long-term", {
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
    });
  }
}
