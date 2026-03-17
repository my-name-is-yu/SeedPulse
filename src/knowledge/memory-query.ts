import * as path from "node:path";
import { z } from "zod";
import { LessonEntrySchema } from "../types/memory-lifecycle.js";
import type { LessonEntry } from "../types/memory-lifecycle.js";
import { readJsonFile } from "./memory-persistence.js";

// ─── Lesson query ───

export function queryLessons(
  memoryDir: string,
  tags: string[],
  dimensions: string[],
  maxCount: number
): LessonEntry[] {
  const results: LessonEntry[] = [];
  const seen = new Set<string>();

  // Query by-dimension lessons
  for (const dim of dimensions) {
    const byDimPath = path.join(
      memoryDir,
      "long-term",
      "lessons",
      "by-dimension",
      `${dim}.json`
    );
    const lessons =
      readJsonFile<LessonEntry[]>(byDimPath, z.array(LessonEntrySchema)) ?? [];
    for (const l of lessons) {
      if (
        !seen.has(l.lesson_id) &&
        l.status === "active" &&
        results.length < maxCount
      ) {
        results.push(l);
        seen.add(l.lesson_id);
      }
    }
  }

  // Query global lessons matching tags
  if (results.length < maxCount && tags.length > 0) {
    const globalPath = path.join(
      memoryDir,
      "long-term",
      "lessons",
      "global.json"
    );
    const globalLessons =
      readJsonFile<LessonEntry[]>(globalPath, z.array(LessonEntrySchema)) ?? [];
    const matching = globalLessons.filter(
      (l) =>
        !seen.has(l.lesson_id) &&
        l.status === "active" &&
        tags.some((t) => l.relevance_tags.includes(t))
    );
    // Sort by extracted_at descending (most recent first)
    matching.sort(
      (a, b) =>
        new Date(b.extracted_at).getTime() -
        new Date(a.extracted_at).getTime()
    );
    for (const l of matching) {
      if (results.length >= maxCount) break;
      results.push(l);
      seen.add(l.lesson_id);
    }
  }

  return results;
}

export function queryCrossGoalLessons(
  memoryDir: string,
  tags: string[],
  dimensions: string[],
  excludeGoalId: string,
  maxCount: number
): LessonEntry[] {
  const results: LessonEntry[] = [];
  const seen = new Set<string>();

  // Query global lessons (which include all goals)
  const globalPath = path.join(
    memoryDir,
    "long-term",
    "lessons",
    "global.json"
  );
  const globalLessons =
    readJsonFile<LessonEntry[]>(globalPath, z.array(LessonEntrySchema)) ?? [];

  // Filter to lessons from other goals that match tags or dimensions
  const crossGoalLessons = globalLessons.filter(
    (l) =>
      l.goal_id !== excludeGoalId &&
      l.status === "active" &&
      (tags.some((t) => l.relevance_tags.includes(t)) ||
        dimensions.some((d) => l.relevance_tags.includes(d)))
  );

  // Sort by recency
  crossGoalLessons.sort(
    (a, b) =>
      new Date(b.extracted_at).getTime() - new Date(a.extracted_at).getTime()
  );

  for (const l of crossGoalLessons) {
    if (results.length >= maxCount) break;
    if (!seen.has(l.lesson_id)) {
      results.push(l);
      seen.add(l.lesson_id);
    }
  }

  return results;
}
