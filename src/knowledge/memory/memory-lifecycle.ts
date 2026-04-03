import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { ILLMClient } from "../llm/llm-client.js";
import type { IEmbeddingClient } from "./embedding-client.js";
import type { VectorIndex } from "./vector-index.js";
import {
  ShortTermEntrySchema,
  LessonEntrySchema,
  RetentionConfigSchema,
  StatisticalSummarySchema,
} from "../types/memory-lifecycle.js";
import type {
  ShortTermEntry,
  LessonEntry,
  StatisticalSummary,
  MemoryIndex,
  CompressionResult,
  RetentionConfig,
  MemoryDataType,
} from "../types/memory-lifecycle.js";
import type { IDriveScorer } from "./drive-score-adapter.js";
export type { IDriveScorer } from "./drive-score-adapter.js";
export { DriveScoreAdapter } from "./drive-score-adapter.js";
import {
  atomicWriteAsync,
  readJsonFileAsync,
  getDataFile,
  generateId,
  getRetentionLimit,
} from "./memory-persistence.js";
import {
  initializeIndex,
  loadIndex,
  saveIndex,
  updateIndex,
  removeFromIndex,
  removeGoalFromIndex,
  touchIndexEntry,
  archiveOldestLongTermEntries,
  storeLessonsLongTerm,
} from "./memory-index.js";
import { updateStatistics } from "./memory-stats.js";
import { queryLessons, queryCrossGoalLessons } from "./memory-query.js";
import { extractPatterns, distillLessons, validateCompressionQuality } from "./memory-distill.js";
import {
  compressToLongTerm as _compressToLongTerm,
  compressAllRemainingToLongTerm as _compressAllRemainingToLongTerm,
  applyRetentionPolicy as _applyRetentionPolicy,
  runGarbageCollection as _runGarbageCollection,
  compressionDelay as _compressionDelay,
  type MemoryCompressionDeps,
} from "./memory-compression.js";
import {
  selectForWorkingMemory as _selectForWorkingMemory,
  selectForWorkingMemorySemantic as _selectForWorkingMemorySemantic,
  searchCrossGoalLessons as _searchCrossGoalLessons,
  relevanceScore as _relevanceScore,
  getCompressionDelay as _getCompressionDelay,
  getDeadlineBonus as _getDeadlineBonus,
  type MemorySelectionDeps,
} from "./memory-selection.js";

// ─── MemoryLifecycleManager ───
// NOTE: This file is ~666 lines. Most methods are thin wrappers delegating to
// memory-compression.ts, memory-selection.ts, and memory-phases.ts.
// Further size reduction requires splitting the re-export section into a
// dedicated barrel file — deferred to avoid circular dependency risk.

/**
 * MemoryLifecycleManager handles the 3-tier memory model:
 *   - Working Memory: view/selection from Short-term + Long-term (1 session lifetime)
 *   - Short-term Memory: raw data, configurable retention (default: 100 loops)
 *   - Long-term Memory: compressed lessons + statistics (permanent)
 *
 * Directory layout:
 *   <base>/memory/short-term/goals/<goal_id>/{experience-log,observations,strategies,tasks}.json
 *   <base>/memory/short-term/index.json
 *   <base>/memory/long-term/lessons/by-goal/<goal_id>.json
 *   <base>/memory/long-term/lessons/by-dimension/<dim>.json
 *   <base>/memory/long-term/lessons/global.json
 *   <base>/memory/long-term/statistics/<goal_id>.json
 *   <base>/memory/long-term/index.json
 *   <base>/memory/archive/<goal_id>/{lessons,statistics}.json
 */
export class MemoryLifecycleManager {
  private readonly baseDir: string;
  private readonly memoryDir: string;
  private readonly llmClient: ILLMClient;
  private readonly config: RetentionConfig;
  private readonly embeddingClient?: IEmbeddingClient;
  private readonly vectorIndex?: VectorIndex;
  private readonly driveScorer?: IDriveScorer;

  // Phase 2: internal map for early compression candidates
  private readonly earlyCompressionCandidates: Map<string, Set<string>> = new Map();

  constructor(
    baseDir: string,
    llmClient: ILLMClient,
    config?: Partial<RetentionConfig>,
    embeddingClient?: IEmbeddingClient,
    vectorIndex?: VectorIndex,
    driveScorer?: IDriveScorer
  ) {
    this.baseDir = baseDir;
    this.memoryDir = path.join(baseDir, "memory");
    this.llmClient = llmClient;
    this.config = RetentionConfigSchema.parse(config ?? {});
    this.embeddingClient = embeddingClient;
    this.vectorIndex = vectorIndex;
    this.driveScorer = driveScorer;
  }

  // ─── Private: build deps objects ───

  private get compressionDeps(): MemoryCompressionDeps {
    return {
      memoryDir: this.memoryDir,
      llmClient: this.llmClient,
      config: this.config,
      vectorIndex: this.vectorIndex,
      driveScorer: this.driveScorer,
      earlyCompressionCandidates: this.earlyCompressionCandidates,
    };
  }

  private get selectionDeps(): MemorySelectionDeps {
    return {
      memoryDir: this.memoryDir,
      vectorIndex: this.vectorIndex,
      driveScorer: this.driveScorer,
    };
  }

  // ─── Directory Initialization ───

  /** Create directory structure for memory storage */
  async initializeDirectories(): Promise<void> {
    const dirs = [
      path.join(this.memoryDir, "short-term", "goals"),
      path.join(this.memoryDir, "long-term", "lessons", "by-goal"),
      path.join(this.memoryDir, "long-term", "lessons", "by-dimension"),
      path.join(this.memoryDir, "long-term", "statistics"),
      path.join(this.memoryDir, "archive"),
    ];
    for (const dir of dirs) {
      await fsp.mkdir(dir, { recursive: true });
    }
    // Initialize index files if they don't exist
    await initializeIndex(this.memoryDir, "short-term");
    await initializeIndex(this.memoryDir, "long-term");
    // Initialize global lessons file
    const globalPath = path.join(
      this.memoryDir,
      "long-term",
      "lessons",
      "global.json"
    );
    try {
      await fsp.access(globalPath);
    } catch {
      await atomicWriteAsync(globalPath, []);
    }
  }

  // ─── Short-term Memory ───

  /**
   * Record an entry to short-term memory.
   * Appends to the appropriate data file and updates the short-term index.
   */
  async recordToShortTerm(
    goalId: string,
    dataType: MemoryDataType,
    data: Record<string, unknown>,
    options?: {
      loopNumber?: number;
      dimensions?: string[];
      tags?: string[];
    }
  ): Promise<ShortTermEntry> {
    // Ensure goal directory exists
    const goalDir = path.join(
      this.memoryDir,
      "short-term",
      "goals",
      goalId
    );
    await fsp.mkdir(goalDir, { recursive: true });

    const now = new Date().toISOString();
    const entry = ShortTermEntrySchema.parse({
      id: generateId("st"),
      goal_id: goalId,
      data_type: dataType,
      loop_number: options?.loopNumber ?? 0,
      timestamp: now,
      dimensions: options?.dimensions ?? [],
      tags: options?.tags ?? [],
      data,
    });

    // Append to appropriate file
    const dataFile = getDataFile(this.memoryDir, goalId, dataType);
    const existing = await readJsonFileAsync<ShortTermEntry[]>(
      dataFile,
      z.array(ShortTermEntrySchema)
    );
    const entries = existing ?? [];
    entries.push(entry);
    await atomicWriteAsync(dataFile, entries);

    // Update short-term index
    await updateIndex(this.memoryDir, "short-term", {
      id: generateId("idx"),
      goal_id: goalId,
      dimensions: entry.dimensions,
      tags: entry.tags,
      timestamp: entry.timestamp,
      data_file: path.relative(
        path.join(this.memoryDir, "short-term"),
        dataFile
      ),
      entry_id: entry.id,
      last_accessed: now,
      access_count: 0,
      embedding_id: null,
      memory_tier: entry.memory_tier,
    });

    // Phase 2: fire-and-forget embedding indexing
    if (this.vectorIndex) {
      const textToEmbed = `${dataType}: ${JSON.stringify(data).slice(0, 500)}`;
      this.vectorIndex
        .add(entry.id, textToEmbed, { goal_id: goalId, data_type: dataType })
        .then(() => {
          entry.embedding_id = entry.id;
        })
        .catch(() => {
          // Non-fatal: embedding failures are ignored
        });
    }

    return entry;
  }

  // ─── Long-term Compression ───

  /**
   * Compress short-term entries to long-term using LLM-based pattern extraction.
   * Never deletes short-term data if LLM compression fails.
   */
  async compressToLongTerm(
    goalId: string,
    dataType: MemoryDataType
  ): Promise<CompressionResult> {
    return _compressToLongTerm(this.compressionDeps, goalId, dataType);
  }

  // ─── Working Memory Selection ───

  /**
   * Select relevant entries for working memory.
   * Phase 1: tag exact-match + recency sort.
   * Phase 2 (5.2b): semantic search fallback via VectorIndex if tag results are insufficient.
   * Phase 2 (5.2c): includes cross-goal lessons (up to 25% of budget).
   */
  async selectForWorkingMemory(
    goalId: string,
    dimensions: string[],
    tags: string[],
    maxEntries: number = 10
  ): Promise<{ shortTerm: ShortTermEntry[]; lessons: LessonEntry[] }> {
    return _selectForWorkingMemory(this.selectionDeps, goalId, dimensions, tags, { maxEntries });
  }

  /**
   * Tier-aware variant of selectForWorkingMemory.
   * Passes satisfiedDimensions, highDissatisfactionDimensions, and maxDissatisfaction
   * to enable core↔recall promotion/demotion and dynamic budget allocation.
   */
  async selectForWorkingMemoryTierAware(
    goalId: string,
    dimensions: string[],
    tags: string[],
    maxEntries: number,
    activeGoalIds: string[],
    completedGoalIds: string[],
    satisfiedDimensions: string[],
    highDissatisfactionDimensions: string[],
    maxDissatisfaction: number
  ): Promise<{ shortTerm: ShortTermEntry[]; lessons: LessonEntry[] }> {
    return _selectForWorkingMemory(
      this.selectionDeps,
      goalId,
      dimensions,
      tags,
      {
        maxEntries,
        activeGoalIds,
        completedGoalIds,
        satisfiedDimensions,
        highDissatisfactionDimensions,
        maxDissatisfaction,
      }
    );
  }

  // ─── Phase 2: Drive-based Memory Management ───

  /**
   * Dissatisfaction drive: delay compression up to 2x for high-dissatisfaction dimensions.
   * For each dimension, if dissatisfaction > 0.7, delay_factor = 1 + dissatisfaction (max 2.0).
   * Returns map of dimension -> delay_factor.
   */
  getCompressionDelay(
    driveScores: Array<{ dimension: string; dissatisfaction: number }>
  ): Map<string, number> {
    return _getCompressionDelay(driveScores);
  }

  /**
   * Deadline drive: boost Working Memory priority up to 30%.
   * For each dimension, bonus = min(deadline * 0.3, 0.3).
   * Returns map of dimension -> bonus_factor.
   */
  getDeadlineBonus(
    driveScores: Array<{ dimension: string; deadline: number }>
  ): Map<string, number> {
    return _getDeadlineBonus(driveScores);
  }

  /**
   * SatisficingJudge hook: mark satisfied dimensions for early compression.
   * Records these dimensions as candidates for early compression.
   */
  markForEarlyCompression(goalId: string, satisfiedDimensions: string[]): void {
    if (!this.earlyCompressionCandidates.has(goalId)) {
      this.earlyCompressionCandidates.set(goalId, new Set());
    }
    const candidates = this.earlyCompressionCandidates.get(goalId) ?? new Set<string>();
    for (const dim of satisfiedDimensions) {
      candidates.add(dim);
    }
  }

  /**
   * Return the set of dimensions marked for early compression for a goal.
   */
  getEarlyCompressionCandidates(goalId: string): Set<string> {
    return this.earlyCompressionCandidates.get(goalId) ?? new Set();
  }

  // ─── Phase 2 (5.2a): Drive-scorer-aware helpers ───

  /**
   * Compute a relevance score for a short-term entry given a context.
   *
   * Score = tag_match_ratio * drive_weight * freshness_factor
   *   - tag_match_ratio  = matching tags / total unique tags (0 if no tags)
   *   - drive_weight     = DriveScorer dissatisfaction score for first matching
   *                        dimension (1.0 if no DriveScorer or no dimensions)
   *   - freshness_factor = Math.exp(-daysSinceCreation / 30)
   */
  relevanceScore(
    entry: ShortTermEntry,
    context: { goalId: string; dimensions: string[]; tags: string[] }
  ): number {
    return _relevanceScore(this.selectionDeps, entry, context);
  }

  /**
   * Compute the effective retention period for a goal/dimension combination.
   *
   * If DriveScorer is available:
   *   dissatisfaction > 0.7 → retention_period * 2.0
   *   dissatisfaction > 0.4 → retention_period * 1.5
   *   otherwise             → retention_period
   * If no DriveScorer → retention_period (unchanged).
   */
  compressionDelay(goalId: string, dimension: string): number {
    return _compressionDelay(this.compressionDeps, goalId, dimension);
  }

  /**
   * Hook called when the SatisficingJudge determines a dimension is satisfied.
   * Marks the dimension for early compression if satisfied, clears the mark if not.
   */
  onSatisficingJudgment(
    goalId: string,
    dimension: string,
    isSatisfied: boolean
  ): void {
    if (isSatisfied) {
      // Mark dimension for early compression
      if (!this.earlyCompressionCandidates.has(goalId)) {
        this.earlyCompressionCandidates.set(goalId, new Set());
      }
      (this.earlyCompressionCandidates.get(goalId) ?? new Set<string>()).add(dimension);
    } else {
      // Remove from early compression candidates if previously marked
      const candidates = this.earlyCompressionCandidates.get(goalId);
      if (candidates) {
        candidates.delete(dimension);
      }
    }
  }

  // ─── Phase 2 (5.2c): Cross-Goal Lesson Search ───

  /**
   * Search long-term lessons across ALL goals using semantic search.
   * Falls back to tag-based global search if VectorIndex is unavailable.
   *
   * @param query  - natural language search query
   * @param topK   - maximum number of lessons to return (default 5)
   */
  async searchCrossGoalLessons(query: string, topK = 5): Promise<LessonEntry[]> {
    return _searchCrossGoalLessons(this.selectionDeps, query, topK);
  }

  // ─── Phase 2: Semantic Working Memory Selection ───

  /**
   * Semantic variant of selectForWorkingMemory.
   * Uses VectorIndex.search() to find semantically relevant entries.
   * Applies deadline bonus to relevance scores.
   * Falls back to existing sync method if no vectorIndex available.
   */
  async selectForWorkingMemorySemantic(
    goalId: string,
    query: string,
    dimensions: string[],
    tags: string[],
    maxEntries: number = 10,
    driveScores?: Array<{ dimension: string; dissatisfaction: number; deadline: number }>
  ): Promise<{ shortTerm: ShortTermEntry[]; lessons: LessonEntry[] }> {
    return _selectForWorkingMemorySemantic(
      this.selectionDeps,
      goalId,
      query,
      dimensions,
      tags,
      maxEntries,
      driveScores
    );
  }

  // ─── Retention Policy ───

  /**
   * Apply retention policy — check each data type and trigger compression if needed.
   * Phase 2 (5.2a): uses compressionDelay() per dimension for drive-based retention.
   */
  async applyRetentionPolicy(goalId: string): Promise<CompressionResult[]> {
    return _applyRetentionPolicy(this.compressionDeps, goalId);
  }

  // ─── Goal Close ───

  /**
   * Handle goal completion or cancellation.
   * Compresses all remaining short-term data, then archives.
   */
  async onGoalClose(
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

    // Step 1: Compress all remaining short-term data (best-effort)
    for (const dataType of dataTypes) {
      const dataFile = getDataFile(this.memoryDir, goalId, dataType);
      try { await fsp.access(dataFile); } catch { continue; }

      const entries =
        (await readJsonFileAsync<ShortTermEntry[]>(
          dataFile,
          z.array(ShortTermEntrySchema)
        )) ?? [];
      if (entries.length === 0) continue;

      try {
        // Force-compress all remaining entries regardless of loop count
        await _compressAllRemainingToLongTerm(this.compressionDeps, goalId, dataType, entries);
      } catch {
        // Failure is acceptable on close — proceed to archive anyway
      }
    }

    // Step 2: Archive short-term data directory
    const goalShortTermDir = path.join(
      this.memoryDir,
      "short-term",
      "goals",
      goalId
    );
    const archiveGoalDir = path.join(this.memoryDir, "archive", goalId);

    try {
      await fsp.access(goalShortTermDir);
      await fsp.mkdir(archiveGoalDir, { recursive: true });

      // Archive all files from the short-term goal directory
      const files = await fsp.readdir(goalShortTermDir);
      for (const file of files) {
        const srcPath = path.join(goalShortTermDir, file);
        const destPath = path.join(archiveGoalDir, file);
        await fsp.copyFile(srcPath, destPath);
      }

      // Remove from short-term
      await fsp.rm(goalShortTermDir, { recursive: true, force: true });

      // Remove goal's entries from short-term index
      await removeGoalFromIndex(this.memoryDir, "short-term", goalId);
    } catch {
      // goalShortTermDir doesn't exist, nothing to archive
    }

    // Step 3: Archive long-term data (lessons + statistics) for this goal
    const byGoalLessonsPath = path.join(
      this.memoryDir,
      "long-term",
      "lessons",
      "by-goal",
      `${goalId}.json`
    );
    const statisticsPath = path.join(
      this.memoryDir,
      "long-term",
      "statistics",
      `${goalId}.json`
    );

    try {
      await fsp.access(byGoalLessonsPath);
      await fsp.mkdir(archiveGoalDir, { recursive: true });
      const archiveLessonsPath = path.join(archiveGoalDir, "lessons.json");
      const existingArchive =
        (await readJsonFileAsync<LessonEntry[]>(
          archiveLessonsPath,
          z.array(LessonEntrySchema)
        )) ?? [];
      const goalLessons =
        (await readJsonFileAsync<LessonEntry[]>(
          byGoalLessonsPath,
          z.array(LessonEntrySchema)
        )) ?? [];
      await atomicWriteAsync(archiveLessonsPath, [
        ...existingArchive,
        ...goalLessons,
      ]);
    } catch {
      // byGoalLessonsPath doesn't exist, skip
    }

    try {
      await fsp.access(statisticsPath);
      await fsp.mkdir(archiveGoalDir, { recursive: true });
      const archiveStatsPath = path.join(archiveGoalDir, "statistics.json");
      const stats = await readJsonFileAsync<StatisticalSummary>(
        statisticsPath,
        StatisticalSummarySchema
      );
      if (stats) {
        await atomicWriteAsync(archiveStatsPath, stats);
      }
    } catch {
      // statisticsPath doesn't exist, skip
    }

    // Step 4: Mark all goal lessons as archived in long-term
    try {
      await fsp.access(byGoalLessonsPath);
      const lessons =
        (await readJsonFileAsync<LessonEntry[]>(
          byGoalLessonsPath,
          z.array(LessonEntrySchema)
        )) ?? [];
      const archived = lessons.map((l) =>
        LessonEntrySchema.parse({ ...l, status: "archived" })
      );
      await atomicWriteAsync(byGoalLessonsPath, archived);
    } catch {
      // byGoalLessonsPath doesn't exist, skip
    }

    void reason; // used for potential future audit logging
  }

  // ─── Statistics ───

  /**
   * Read and return the statistical summary for a goal.
   */
  async getStatistics(goalId: string): Promise<StatisticalSummary | null> {
    const statsPath = path.join(
      this.memoryDir,
      "long-term",
      "statistics",
      `${goalId}.json`
    );
    return readJsonFileAsync<StatisticalSummary>(
      statsPath,
      StatisticalSummarySchema
    );
  }

  // ─── Garbage Collection ───

  /**
   * Run garbage collection to enforce size limits.
   * Short-term: 10MB per goal (default). Long-term: 100MB total (default).
   */
  async runGarbageCollection(): Promise<void> {
    return _runGarbageCollection(this.compressionDeps);
  }
}
