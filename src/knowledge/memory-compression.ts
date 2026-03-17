import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ILLMClient } from "../llm/llm-client.js";
import type { VectorIndex } from "./vector-index.js";
import {
  ShortTermEntrySchema,
  LessonEntrySchema,
  RetentionConfigSchema,
} from "../types/memory-lifecycle.js";
import type {
  ShortTermEntry,
  LessonEntry,
  CompressionResult,
  RetentionConfig,
  MemoryDataType,
} from "../types/memory-lifecycle.js";
import type { IDriveScorer } from "./drive-score-adapter.js";
import {
  atomicWrite,
  readJsonFile,
  getDataFile,
  generateId,
  getDirectorySize,
  getRetentionLimit,
} from "./memory-persistence.js";
import {
  extractPatterns,
  distillLessons,
  validateCompressionQuality,
  storeLessonsLongTerm,
  updateStatistics,
  removeFromIndex,
  archiveOldestLongTermEntries,
} from "./memory-phases.js";

// ─── Deps interface ───

export interface MemoryCompressionDeps {
  memoryDir: string;
  llmClient: ILLMClient;
  config: RetentionConfig;
  vectorIndex?: VectorIndex;
  driveScorer?: IDriveScorer;
  earlyCompressionCandidates: Map<string, Set<string>>;
}

// ─── compressionDelay ───

/**
 * Compute the effective retention period for a goal/dimension combination.
 *
 * If DriveScorer is available:
 *   dissatisfaction > 0.7 → retention_period * 2.0
 *   dissatisfaction > 0.4 → retention_period * 1.5
 *   otherwise             → retention_period
 * If no DriveScorer → retention_period (unchanged).
 */
export function compressionDelay(
  deps: Pick<MemoryCompressionDeps, "config" | "driveScorer">,
  goalId: string,
  dimension: string
): number {
  const retentionPeriod = getRetentionLimit(deps.config, goalId);

  if (!deps.driveScorer) {
    return retentionPeriod;
  }

  const dissatisfaction = deps.driveScorer.getDissatisfactionScore(dimension);

  if (dissatisfaction > 0.7) {
    return retentionPeriod * 2.0;
  } else if (dissatisfaction > 0.4) {
    return retentionPeriod * 1.5;
  }
  return retentionPeriod;
}

// ─── compressToLongTerm ───

/**
 * Compress short-term entries to long-term using LLM-based pattern extraction.
 * Never deletes short-term data if LLM compression fails.
 */
export async function compressToLongTerm(
  deps: MemoryCompressionDeps,
  goalId: string,
  dataType: MemoryDataType
): Promise<CompressionResult> {
  const now = new Date().toISOString();
  const dataFile = getDataFile(deps.memoryDir, goalId, dataType);
  const allEntries =
    readJsonFile<ShortTermEntry[]>(
      dataFile,
      z.array(ShortTermEntrySchema)
    ) ?? [];

  // Determine the retention limit for this goal
  const retentionLimit = getRetentionLimit(deps.config, goalId);

  // Find entries eligible for compression (loop_number exceeds retention limit)
  const maxLoopNumber = allEntries.reduce(
    (max, e) => Math.max(max, e.loop_number),
    0
  );
  const cutoffLoop = maxLoopNumber - retentionLimit;
  const expiredEntries = allEntries.filter(
    (e) => e.loop_number <= cutoffLoop
  );

  if (expiredEntries.length === 0) {
    return {
      goal_id: goalId,
      data_type: dataType,
      entries_compressed: 0,
      lessons_generated: 0,
      statistics_updated: false,
      quality_check: {
        passed: true,
        failure_coverage_ratio: 1,
        contradictions_found: 0,
      },
      compressed_at: now,
    };
  }

  let lessons: LessonEntry[] = [];
  let qualityCheck: {
    passed: boolean;
    failure_coverage_ratio: number;
    contradictions_found: number;
  } = {
    passed: false,
    failure_coverage_ratio: 0,
    contradictions_found: 0,
  };

  try {
    // Step 1: Extract patterns from entries
    const patterns = await extractPatterns(deps.llmClient, expiredEntries);

    // Step 2: Distill lessons from patterns
    const rawLessons = await distillLessons(deps.llmClient, patterns, expiredEntries);

    // Attach metadata to each lesson
    const sourceLoops = expiredEntries.map((e) => `loop_${e.loop_number}`);
    lessons = rawLessons.map((l) =>
      LessonEntrySchema.parse({
        ...l,
        lesson_id: generateId("lesson"),
        goal_id: goalId,
        source_loops: sourceLoops,
        extracted_at: now,
        status: "active",
        superseded_by: undefined,
      })
    );

    // Step 3: Quality check
    qualityCheck = validateCompressionQuality(lessons, expiredEntries);

    if (!qualityCheck.passed) {
      // Quality check failed — do NOT delete short-term data
      return {
        goal_id: goalId,
        data_type: dataType,
        entries_compressed: 0,
        lessons_generated: 0,
        statistics_updated: false,
        quality_check: {
          passed: false,
          failure_coverage_ratio: qualityCheck.failure_coverage_ratio,
          contradictions_found: qualityCheck.contradictions_found,
        },
        compressed_at: now,
      };
    }

    // Step 4: Store lessons in long-term (by-goal, by-dimension, global)
    storeLessonsLongTerm(deps.memoryDir, goalId, lessons, expiredEntries);

    // Phase 2 (5.2c): Auto-register lesson entries in VectorIndex
    if (deps.vectorIndex) {
      for (const lesson of lessons) {
        const lessonText = `${lesson.type}: ${lesson.context}. ${lesson.lesson}`;
        deps.vectorIndex
          .add(lesson.lesson_id, lessonText, {
            goal_id: goalId,
            is_lesson: true,
            lesson_type: lesson.type,
          })
          .catch(() => {
            // Non-fatal: embedding failures are ignored
          });
      }
    }

    // Step 5: Update statistics
    updateStatistics(deps.memoryDir, goalId, expiredEntries);

    // Step 6: Purge compressed short-term entries (only if compression succeeded)
    const compressedIds = new Set(expiredEntries.map((e) => e.id));
    const remaining = allEntries.filter((e) => !compressedIds.has(e.id));
    atomicWrite(dataFile, remaining);

    // Remove purged entries from the short-term index
    removeFromIndex(deps.memoryDir, "short-term", compressedIds);
  } catch {
    // LLM failure — never delete short-term data
    return {
      goal_id: goalId,
      data_type: dataType,
      entries_compressed: 0,
      lessons_generated: 0,
      statistics_updated: false,
      quality_check: {
        passed: false,
        failure_coverage_ratio: 0,
        contradictions_found: 0,
      },
      compressed_at: now,
    };
  }

  return {
    goal_id: goalId,
    data_type: dataType,
    entries_compressed: expiredEntries.length,
    lessons_generated: lessons.length,
    statistics_updated: true,
    quality_check: {
      passed: qualityCheck.passed,
      failure_coverage_ratio: qualityCheck.failure_coverage_ratio,
      contradictions_found: qualityCheck.contradictions_found,
    },
    compressed_at: now,
  };
}

// ─── compressAllRemainingToLongTerm ───

/**
 * Force-compress all remaining entries to long-term (used on goal close).
 */
export async function compressAllRemainingToLongTerm(
  deps: Pick<MemoryCompressionDeps, "memoryDir" | "llmClient">,
  goalId: string,
  dataType: MemoryDataType,
  entries: ShortTermEntry[]
): Promise<void> {
  if (entries.length === 0) return;

  const now = new Date().toISOString();
  const patterns = await extractPatterns(deps.llmClient, entries);
  const rawLessons = await distillLessons(deps.llmClient, patterns, entries);
  const sourceLoops = entries.map((e) => `loop_${e.loop_number}`);

  const lessons: LessonEntry[] = rawLessons.map((l) =>
    LessonEntrySchema.parse({
      ...l,
      lesson_id: generateId("lesson"),
      goal_id: goalId,
      source_loops: sourceLoops,
      extracted_at: now,
      status: "active",
      superseded_by: undefined,
    })
  );

  storeLessonsLongTerm(deps.memoryDir, goalId, lessons, entries);
  updateStatistics(deps.memoryDir, goalId, entries);

  void dataType; // type info available for future audit logging
}

// ─── applyRetentionPolicy ───

/**
 * Apply retention policy — check each data type and trigger compression if needed.
 * Phase 2 (5.2a): uses compressionDelay() per dimension for drive-based retention.
 */
export async function applyRetentionPolicy(
  deps: MemoryCompressionDeps,
  goalId: string
): Promise<CompressionResult[]> {
  const dataTypes: MemoryDataType[] = [
    "experience_log",
    "observation",
    "strategy",
    "task",
    "knowledge",
  ];

  const results: CompressionResult[] = [];

  for (const dataType of dataTypes) {
    const dataFile = getDataFile(deps.memoryDir, goalId, dataType);
    if (!fs.existsSync(dataFile)) continue;

    const entries =
      readJsonFile<ShortTermEntry[]>(
        dataFile,
        z.array(ShortTermEntrySchema)
      ) ?? [];

    if (entries.length === 0) continue;

    const maxLoopNumber = entries.reduce(
      (max, e) => Math.max(max, e.loop_number),
      0
    );
    const minLoopNumber = entries.reduce(
      (min, e) => Math.min(min, e.loop_number),
      Infinity
    );

    // Phase 2 (5.2a): compute effective retention limit using drive-based delay.
    // Use the dimensions present in the entries to find the most conservative (highest) delay.
    const allDimensions = [...new Set(entries.flatMap((e) => e.dimensions))];
    let effectiveRetentionLimit: number;
    if (allDimensions.length > 0 && deps.driveScorer) {
      // Take the maximum delay across all dimensions (most conservative = longest retention)
      effectiveRetentionLimit = Math.max(
        ...allDimensions.map((dim) => compressionDelay(deps, goalId, dim))
      );
    } else {
      effectiveRetentionLimit = getRetentionLimit(deps.config, goalId);
    }

    // Check for early compression candidates — reduce retention limit if any dimension is satisfied
    const earlyDims = deps.earlyCompressionCandidates.get(goalId);
    if (earlyDims && allDimensions.some(d => earlyDims.has(d))) {
      effectiveRetentionLimit = Math.min(effectiveRetentionLimit, Math.floor(getRetentionLimit(deps.config, goalId) * 0.5));
    }

    // Trigger compression if span of loops exceeds effective retention limit
    if (maxLoopNumber - minLoopNumber >= effectiveRetentionLimit) {
      const result = await compressToLongTerm(deps, goalId, dataType);
      results.push(result);
    }
  }

  return results;
}

// ─── runGarbageCollection ───

/**
 * Run garbage collection to enforce size limits.
 * Short-term: 10MB per goal (default). Long-term: 100MB total (default).
 */
export async function runGarbageCollection(
  deps: MemoryCompressionDeps
): Promise<void> {
  const shortTermGoalsDir = path.join(
    deps.memoryDir,
    "short-term",
    "goals"
  );

  if (!fs.existsSync(shortTermGoalsDir)) return;

  const goalDirs = fs
    .readdirSync(shortTermGoalsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const shortTermLimitBytes =
    deps.config.size_limits.short_term_per_goal_mb * 1024 * 1024;

  // Check short-term size per goal
  for (const goalId of goalDirs) {
    const goalDir = path.join(shortTermGoalsDir, goalId);
    const size = getDirectorySize(goalDir);

    if (size > shortTermLimitBytes) {
      // Trigger early compression for all data types
      const dataTypes: MemoryDataType[] = [
        "experience_log",
        "observation",
        "strategy",
        "task",
        "knowledge",
      ];
      for (const dataType of dataTypes) {
        try {
          await compressToLongTerm(deps, goalId, dataType);
        } catch {
          // Compression failure is non-fatal for GC
        }
      }
    }
  }

  // Check long-term total size
  const longTermDir = path.join(deps.memoryDir, "long-term");
  if (fs.existsSync(longTermDir)) {
    const longTermSize = getDirectorySize(longTermDir);
    const longTermLimitBytes =
      deps.config.size_limits.long_term_total_mb * 1024 * 1024;

    if (longTermSize > longTermLimitBytes) {
      // Archive oldest (by last_accessed) lessons from long-term index
      archiveOldestLongTermEntries(deps.memoryDir);
    }
  }
}

// Re-export RetentionConfigSchema for convenience
export { RetentionConfigSchema };
