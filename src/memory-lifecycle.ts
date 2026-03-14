import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ILLMClient } from "./llm-client.js";
import type { IEmbeddingClient } from "./embedding-client.js";
import type { VectorIndex } from "./vector-index.js";
import {
  ShortTermEntrySchema,
  LessonEntrySchema,
  StatisticalSummarySchema,
  MemoryIndexSchema,
  RetentionConfigSchema,
} from "./types/memory-lifecycle.js";
import type {
  ShortTermEntry,
  LessonEntry,
  StatisticalSummary,
  MemoryIndex,
  MemoryIndexEntry,
  CompressionResult,
  RetentionConfig,
  MemoryDataType,
} from "./types/memory-lifecycle.js";

// ─── LLM response schemas ───

const PatternExtractionResponseSchema = z.object({
  patterns: z.array(z.string()),
});

const LessonDistillationResponseSchema = z.object({
  lessons: z.array(
    z.object({
      type: z.enum(["strategy_outcome", "success_pattern", "failure_pattern"]),
      context: z.string(),
      action: z.string().optional(),
      outcome: z.string().optional(),
      lesson: z.string(),
      relevance_tags: z.array(z.string()).default([]),
      failure_reason: z.string().optional(),
      avoidance_hint: z.string().optional(),
      applicability: z.string().optional(),
    })
  ),
});

// ─── MemoryLifecycleManager ───

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

  // Phase 2: internal map for early compression candidates
  private readonly earlyCompressionCandidates: Map<string, Set<string>> = new Map();

  constructor(
    baseDir: string,
    llmClient: ILLMClient,
    config?: Partial<RetentionConfig>,
    embeddingClient?: IEmbeddingClient,
    vectorIndex?: VectorIndex
  ) {
    this.baseDir = baseDir;
    this.memoryDir = path.join(baseDir, "memory");
    this.llmClient = llmClient;
    this.config = RetentionConfigSchema.parse(config ?? {});
    this.embeddingClient = embeddingClient;
    this.vectorIndex = vectorIndex;
  }

  // ─── Directory Initialization ───

  /** Create directory structure for memory storage */
  initializeDirectories(): void {
    const dirs = [
      path.join(this.memoryDir, "short-term", "goals"),
      path.join(this.memoryDir, "long-term", "lessons", "by-goal"),
      path.join(this.memoryDir, "long-term", "lessons", "by-dimension"),
      path.join(this.memoryDir, "long-term", "statistics"),
      path.join(this.memoryDir, "archive"),
    ];
    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Initialize index files if they don't exist
    this.initializeIndex("short-term");
    this.initializeIndex("long-term");
    // Initialize global lessons file
    const globalPath = path.join(
      this.memoryDir,
      "long-term",
      "lessons",
      "global.json"
    );
    if (!fs.existsSync(globalPath)) {
      this.atomicWrite(globalPath, []);
    }
  }

  // ─── Short-term Memory ───

  /**
   * Record an entry to short-term memory.
   * Appends to the appropriate data file and updates the short-term index.
   */
  recordToShortTerm(
    goalId: string,
    dataType: MemoryDataType,
    data: Record<string, unknown>,
    options?: {
      loopNumber?: number;
      dimensions?: string[];
      tags?: string[];
    }
  ): ShortTermEntry {
    // Ensure goal directory exists
    const goalDir = path.join(
      this.memoryDir,
      "short-term",
      "goals",
      goalId
    );
    fs.mkdirSync(goalDir, { recursive: true });

    const now = new Date().toISOString();
    const entry = ShortTermEntrySchema.parse({
      id: this.generateId("st"),
      goal_id: goalId,
      data_type: dataType,
      loop_number: options?.loopNumber ?? 0,
      timestamp: now,
      dimensions: options?.dimensions ?? [],
      tags: options?.tags ?? [],
      data,
    });

    // Append to appropriate file
    const dataFile = this.getDataFile(goalId, dataType);
    const existing = this.readJsonFile<ShortTermEntry[]>(
      dataFile,
      z.array(ShortTermEntrySchema)
    );
    const entries = existing ?? [];
    entries.push(entry);
    this.atomicWrite(dataFile, entries);

    // Update short-term index
    this.updateIndex("short-term", {
      id: this.generateId("idx"),
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
    const now = new Date().toISOString();
    const dataFile = this.getDataFile(goalId, dataType);
    const allEntries =
      this.readJsonFile<ShortTermEntry[]>(
        dataFile,
        z.array(ShortTermEntrySchema)
      ) ?? [];

    // Determine the retention limit for this goal
    const retentionLimit = this.getRetentionLimit(goalId);

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
      const patterns = await this.extractPatterns(expiredEntries);

      // Step 2: Distill lessons from patterns
      const rawLessons = await this.distillLessons(patterns, expiredEntries);

      // Attach metadata to each lesson
      const sourceLoops = expiredEntries.map((e) => `loop_${e.loop_number}`);
      lessons = rawLessons.map((l) =>
        LessonEntrySchema.parse({
          ...l,
          lesson_id: this.generateId("lesson"),
          goal_id: goalId,
          source_loops: sourceLoops,
          extracted_at: now,
          status: "active",
          superseded_by: undefined,
        })
      );

      // Step 3: Quality check
      qualityCheck = this.validateCompressionQuality(lessons, expiredEntries);

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
      this.storeLessonsLongTerm(goalId, lessons, expiredEntries);

      // Step 5: Update statistics
      this.updateStatistics(goalId, expiredEntries);

      // Step 6: Purge compressed short-term entries (only if compression succeeded)
      const compressedIds = new Set(expiredEntries.map((e) => e.id));
      const remaining = allEntries.filter((e) => !compressedIds.has(e.id));
      this.atomicWrite(dataFile, remaining);

      // Remove purged entries from the short-term index
      this.removeFromIndex("short-term", compressedIds);
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

  // ─── Working Memory Selection ───

  /**
   * Select relevant entries for working memory.
   * MVP: tag exact-match + recency sort (no embeddings).
   */
  selectForWorkingMemory(
    goalId: string,
    dimensions: string[],
    tags: string[],
    maxEntries: number = 10
  ): { shortTerm: ShortTermEntry[]; lessons: LessonEntry[] } {
    // 1. Query short-term entries for this goal matching dimensions/tags
    const stIndex = this.loadIndex("short-term");
    const matchingIndexEntries = stIndex.entries.filter(
      (ie) =>
        ie.goal_id === goalId &&
        (dimensions.some((d) => ie.dimensions.includes(d)) ||
          tags.some((t) => ie.tags.includes(t)))
    );

    // Sort by last_accessed descending
    matchingIndexEntries.sort(
      (a, b) =>
        new Date(b.last_accessed).getTime() -
        new Date(a.last_accessed).getTime()
    );

    // Load the actual entries
    const shortTermEntries: ShortTermEntry[] = [];
    const seenEntryIds = new Set<string>();

    for (const idxEntry of matchingIndexEntries) {
      if (shortTermEntries.length >= maxEntries) break;
      if (seenEntryIds.has(idxEntry.entry_id)) continue;

      const dataFilePath = path.join(
        this.memoryDir,
        "short-term",
        idxEntry.data_file
      );
      const allEntries =
        this.readJsonFile<ShortTermEntry[]>(
          dataFilePath,
          z.array(ShortTermEntrySchema)
        ) ?? [];
      const found = allEntries.find((e) => e.id === idxEntry.entry_id);
      if (found) {
        shortTermEntries.push(found);
        seenEntryIds.add(idxEntry.entry_id);

        // Update access metadata in index
        this.touchIndexEntry("short-term", idxEntry.id);
      }
    }

    // 2. Query long-term lessons matching tags (cross-goal OK for lessons)
    const lessons = this.queryLessons(tags, dimensions, maxEntries);

    return { shortTerm: shortTermEntries, lessons };
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
    const result = new Map<string, number>();
    for (const { dimension, dissatisfaction } of driveScores) {
      if (dissatisfaction > 0.7) {
        const delayFactor = Math.min(2.0, 1 + dissatisfaction);
        result.set(dimension, delayFactor);
      } else {
        result.set(dimension, 1.0);
      }
    }
    return result;
  }

  /**
   * Deadline drive: boost Working Memory priority up to 30%.
   * For each dimension, bonus = min(deadline * 0.3, 0.3).
   * Returns map of dimension -> bonus_factor.
   */
  getDeadlineBonus(
    driveScores: Array<{ dimension: string; deadline: number }>
  ): Map<string, number> {
    const result = new Map<string, number>();
    for (const { dimension, deadline } of driveScores) {
      result.set(dimension, Math.min(deadline * 0.3, 0.3));
    }
    return result;
  }

  /**
   * SatisficingJudge hook: mark satisfied dimensions for early compression.
   * Records these dimensions as candidates for early compression.
   */
  markForEarlyCompression(goalId: string, satisfiedDimensions: string[]): void {
    if (!this.earlyCompressionCandidates.has(goalId)) {
      this.earlyCompressionCandidates.set(goalId, new Set());
    }
    const candidates = this.earlyCompressionCandidates.get(goalId)!;
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
    // Fall back to sync method if no vectorIndex
    if (!this.vectorIndex) {
      return this.selectForWorkingMemory(goalId, dimensions, tags, maxEntries);
    }

    // Compute deadline bonuses per dimension
    const deadlineBonus = driveScores
      ? this.getDeadlineBonus(driveScores.map((d) => ({ dimension: d.dimension, deadline: d.deadline })))
      : new Map<string, number>();

    const maxBonus = deadlineBonus.size > 0
      ? Math.max(...Array.from(deadlineBonus.values()))
      : 0;

    // Search vector index for semantically similar entries
    const searchResults = await this.vectorIndex.search(query, maxEntries * 2, 0.0);

    // Filter to this goal's entries
    const goalResults = searchResults.filter(
      (r) => r.metadata.goal_id === goalId
    );

    // Load short-term index for recency data
    const stIndex = this.loadIndex("short-term");
    const indexEntryMap = new Map(
      stIndex.entries.map((ie) => [ie.entry_id, ie])
    );

    // Score entries by combining semantic score + recency + deadline bonus
    const now = Date.now();
    const scoredEntries: Array<{ entry: ShortTermEntry; combinedScore: number }> = [];
    const seenEntryIds = new Set<string>();

    for (const result of goalResults) {
      if (seenEntryIds.has(result.id)) continue;

      const idxEntry = indexEntryMap.get(result.id);
      if (!idxEntry) continue;

      // Compute recency score: normalize last_accessed relative to now
      const ageMs = now - new Date(idxEntry.last_accessed).getTime();
      const ageHours = ageMs / (1000 * 60 * 60);
      const recencyScore = Math.max(0, 1 - ageHours / (24 * 7)); // decay over 1 week

      const combinedScore = result.similarity + recencyScore * 0.3 + maxBonus;

      // Load the actual entry from disk
      const dataFilePath = path.join(
        this.memoryDir,
        "short-term",
        idxEntry.data_file
      );
      const allEntries =
        this.readJsonFile<ShortTermEntry[]>(
          dataFilePath,
          z.array(ShortTermEntrySchema)
        ) ?? [];
      const found = allEntries.find((e) => e.id === idxEntry.entry_id);
      if (found) {
        scoredEntries.push({ entry: found, combinedScore });
        seenEntryIds.add(result.id);
        this.touchIndexEntry("short-term", idxEntry.id);
      }
    }

    // Sort by combined score descending and take top maxEntries
    scoredEntries.sort((a, b) => b.combinedScore - a.combinedScore);
    const shortTermEntries = scoredEntries
      .slice(0, maxEntries)
      .map((s) => s.entry);

    // Still use tag/dimension-based lesson query for long-term
    const lessons = this.queryLessons(tags, dimensions, maxEntries);

    return { shortTerm: shortTermEntries, lessons };
  }

  // ─── Retention Policy ───

  /**
   * Apply retention policy — check each data type and trigger compression if needed.
   */
  async applyRetentionPolicy(goalId: string): Promise<CompressionResult[]> {
    const dataTypes: MemoryDataType[] = [
      "experience_log",
      "observation",
      "strategy",
      "task",
      "knowledge",
    ];

    const results: CompressionResult[] = [];

    for (const dataType of dataTypes) {
      const dataFile = this.getDataFile(goalId, dataType);
      if (!fs.existsSync(dataFile)) continue;

      const entries =
        this.readJsonFile<ShortTermEntry[]>(
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
      const retentionLimit = this.getRetentionLimit(goalId);

      // Trigger compression if span of loops exceeds retention limit
      if (maxLoopNumber - minLoopNumber >= retentionLimit) {
        const result = await this.compressToLongTerm(goalId, dataType);
        results.push(result);
      }
    }

    return results;
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
      const dataFile = this.getDataFile(goalId, dataType);
      if (!fs.existsSync(dataFile)) continue;

      const entries =
        this.readJsonFile<ShortTermEntry[]>(
          dataFile,
          z.array(ShortTermEntrySchema)
        ) ?? [];
      if (entries.length === 0) continue;

      try {
        // Force-compress all remaining entries regardless of loop count
        await this.compressAllRemainingToLongTerm(goalId, dataType, entries);
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

    if (fs.existsSync(goalShortTermDir)) {
      fs.mkdirSync(archiveGoalDir, { recursive: true });

      // Archive all files from the short-term goal directory
      const files = fs.readdirSync(goalShortTermDir);
      for (const file of files) {
        const srcPath = path.join(goalShortTermDir, file);
        const destPath = path.join(archiveGoalDir, file);
        fs.copyFileSync(srcPath, destPath);
      }

      // Remove from short-term
      fs.rmSync(goalShortTermDir, { recursive: true, force: true });

      // Remove goal's entries from short-term index
      this.removeGoalFromIndex("short-term", goalId);
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

    if (fs.existsSync(byGoalLessonsPath)) {
      fs.mkdirSync(archiveGoalDir, { recursive: true });
      const archiveLessonsPath = path.join(archiveGoalDir, "lessons.json");
      const existingArchive =
        this.readJsonFile<LessonEntry[]>(
          archiveLessonsPath,
          z.array(LessonEntrySchema)
        ) ?? [];
      const goalLessons =
        this.readJsonFile<LessonEntry[]>(
          byGoalLessonsPath,
          z.array(LessonEntrySchema)
        ) ?? [];
      this.atomicWrite(archiveLessonsPath, [
        ...existingArchive,
        ...goalLessons,
      ]);
    }

    if (fs.existsSync(statisticsPath)) {
      fs.mkdirSync(archiveGoalDir, { recursive: true });
      const archiveStatsPath = path.join(archiveGoalDir, "statistics.json");
      const stats = this.readJsonFile<StatisticalSummary>(
        statisticsPath,
        StatisticalSummarySchema
      );
      if (stats) {
        this.atomicWrite(archiveStatsPath, stats);
      }
    }

    // Step 4: Mark all goal lessons as archived in long-term
    if (fs.existsSync(byGoalLessonsPath)) {
      const lessons =
        this.readJsonFile<LessonEntry[]>(
          byGoalLessonsPath,
          z.array(LessonEntrySchema)
        ) ?? [];
      const archived = lessons.map((l) =>
        LessonEntrySchema.parse({ ...l, status: "archived" })
      );
      this.atomicWrite(byGoalLessonsPath, archived);
    }

    void reason; // used for potential future audit logging
  }

  // ─── Statistics ───

  /**
   * Read and return the statistical summary for a goal.
   */
  getStatistics(goalId: string): StatisticalSummary | null {
    const statsPath = path.join(
      this.memoryDir,
      "long-term",
      "statistics",
      `${goalId}.json`
    );
    return this.readJsonFile<StatisticalSummary>(
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
    const shortTermGoalsDir = path.join(
      this.memoryDir,
      "short-term",
      "goals"
    );

    if (!fs.existsSync(shortTermGoalsDir)) return;

    const goalDirs = fs
      .readdirSync(shortTermGoalsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const shortTermLimitBytes =
      this.config.size_limits.short_term_per_goal_mb * 1024 * 1024;

    // Check short-term size per goal
    for (const goalId of goalDirs) {
      const goalDir = path.join(shortTermGoalsDir, goalId);
      const size = this.getDirectorySize(goalDir);

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
            await this.compressToLongTerm(goalId, dataType);
          } catch {
            // Compression failure is non-fatal for GC
          }
        }
      }
    }

    // Check long-term total size
    const longTermDir = path.join(this.memoryDir, "long-term");
    if (fs.existsSync(longTermDir)) {
      const longTermSize = this.getDirectorySize(longTermDir);
      const longTermLimitBytes =
        this.config.size_limits.long_term_total_mb * 1024 * 1024;

      if (longTermSize > longTermLimitBytes) {
        // Archive oldest (by last_accessed) lessons from long-term index
        this.archiveOldestLongTermEntries();
      }
    }
  }

  // ─── Private: Index Management ───

  private initializeIndex(layer: "short-term" | "long-term"): void {
    const indexPath = path.join(this.memoryDir, layer, "index.json");
    if (!fs.existsSync(indexPath)) {
      const emptyIndex: MemoryIndex = MemoryIndexSchema.parse({
        version: 1,
        last_updated: new Date().toISOString(),
        entries: [],
      });
      fs.mkdirSync(path.dirname(indexPath), { recursive: true });
      this.atomicWrite(indexPath, emptyIndex);
    }
  }

  private loadIndex(layer: "short-term" | "long-term"): MemoryIndex {
    const indexPath = path.join(this.memoryDir, layer, "index.json");
    const raw = this.readJsonFile<MemoryIndex>(indexPath, MemoryIndexSchema);
    if (raw === null) {
      return MemoryIndexSchema.parse({
        version: 1,
        last_updated: new Date().toISOString(),
        entries: [],
      });
    }
    return raw;
  }

  private saveIndex(layer: "short-term" | "long-term", index: MemoryIndex): void {
    const indexPath = path.join(this.memoryDir, layer, "index.json");
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    const updated = MemoryIndexSchema.parse({
      ...index,
      last_updated: new Date().toISOString(),
    });
    this.atomicWrite(indexPath, updated);
  }

  private updateIndex(
    layer: "short-term" | "long-term",
    entry: MemoryIndexEntry
  ): void {
    const index = this.loadIndex(layer);
    index.entries.push(entry);
    this.saveIndex(layer, index);
  }

  private removeFromIndex(
    layer: "short-term" | "long-term",
    entryIds: Set<string>
  ): void {
    const index = this.loadIndex(layer);
    index.entries = index.entries.filter(
      (ie) => !entryIds.has(ie.entry_id)
    );
    this.saveIndex(layer, index);
  }

  private removeGoalFromIndex(
    layer: "short-term" | "long-term",
    goalId: string
  ): void {
    const index = this.loadIndex(layer);
    index.entries = index.entries.filter((ie) => ie.goal_id !== goalId);
    this.saveIndex(layer, index);
  }

  private touchIndexEntry(
    layer: "short-term" | "long-term",
    indexId: string
  ): void {
    const index = this.loadIndex(layer);
    const now = new Date().toISOString();
    const updated = index.entries.map((ie) => {
      if (ie.id === indexId) {
        return { ...ie, last_accessed: now, access_count: ie.access_count + 1 };
      }
      return ie;
    });
    this.saveIndex(layer, { ...index, entries: updated });
  }

  private archiveOldestLongTermEntries(): void {
    const index = this.loadIndex("long-term");

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
    this.saveIndex("long-term", index);
  }

  // ─── Private: Lesson Storage ───

  private storeLessonsLongTerm(
    goalId: string,
    lessons: LessonEntry[],
    sourceEntries: ShortTermEntry[]
  ): void {
    // 1. Store by-goal
    const byGoalPath = path.join(
      this.memoryDir,
      "long-term",
      "lessons",
      "by-goal",
      `${goalId}.json`
    );
    const existingByGoal =
      this.readJsonFile<LessonEntry[]>(byGoalPath, z.array(LessonEntrySchema)) ??
      [];
    this.atomicWrite(byGoalPath, [...existingByGoal, ...lessons]);

    // 2. Store by-dimension (for each unique dimension in source entries)
    const allDimensions = new Set(sourceEntries.flatMap((e) => e.dimensions));
    for (const dim of allDimensions) {
      if (!dim) continue;
      const byDimPath = path.join(
        this.memoryDir,
        "long-term",
        "lessons",
        "by-dimension",
        `${dim}.json`
      );
      const existingByDim =
        this.readJsonFile<LessonEntry[]>(byDimPath, z.array(LessonEntrySchema)) ??
        [];
      // Store lessons that have this dimension's tag or are from these source entries
      const relevantLessons = lessons.filter(
        (l) =>
          l.relevance_tags.includes(dim) ||
          l.relevance_tags.length === 0 // include all if no tags
      );
      if (relevantLessons.length > 0) {
        this.atomicWrite(byDimPath, [...existingByDim, ...relevantLessons]);
      }
    }

    // 3. Store in global (all lessons are cross-goal knowledge)
    const globalPath = path.join(
      this.memoryDir,
      "long-term",
      "lessons",
      "global.json"
    );
    const existingGlobal =
      this.readJsonFile<LessonEntry[]>(
        globalPath,
        z.array(LessonEntrySchema)
      ) ?? [];
    this.atomicWrite(globalPath, [...existingGlobal, ...lessons]);

    // 4. Update long-term index
    const now = new Date().toISOString();
    for (const lesson of lessons) {
      this.updateIndex("long-term", {
        id: this.generateId("ltidx"),
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

  // ─── Private: Statistics ───

  private updateStatistics(
    goalId: string,
    entries: ShortTermEntry[]
  ): void {
    const statsPath = path.join(
      this.memoryDir,
      "long-term",
      "statistics",
      `${goalId}.json`
    );
    const now = new Date().toISOString();

    // Load existing or create fresh
    const existing = this.readJsonFile<StatisticalSummary>(
      statsPath,
      StatisticalSummarySchema
    );

    // Compute task statistics from task entries
    const taskEntries = entries.filter((e) => e.data_type === "task");
    const taskCategoryMap = new Map<
      string,
      { total: number; success: number; durations: number[] }
    >();

    for (const entry of taskEntries) {
      const category =
        typeof entry.data["task_category"] === "string"
          ? entry.data["task_category"]
          : "unknown";
      const status =
        typeof entry.data["status"] === "string" ? entry.data["status"] : "";
      const durationHours =
        typeof entry.data["duration_hours"] === "number"
          ? entry.data["duration_hours"]
          : 0;

      const current = taskCategoryMap.get(category) ?? {
        total: 0,
        success: 0,
        durations: [],
      };
      current.total++;
      if (status === "completed") current.success++;
      if (durationHours > 0) current.durations.push(durationHours);
      taskCategoryMap.set(category, current);
    }

    const taskStats = Array.from(taskCategoryMap.entries()).map(
      ([category, stats]) => ({
        task_category: category,
        goal_id: goalId,
        stats: {
          total_count: stats.total,
          success_rate:
            stats.total > 0 ? stats.success / stats.total : 0,
          avg_duration_hours:
            stats.durations.length > 0
              ? stats.durations.reduce((a, b) => a + b, 0) /
                stats.durations.length
              : 0,
          common_failure_reason: undefined,
        },
        period: this.computePeriod(entries),
        updated_at: now,
      })
    );

    // Compute dimension statistics from observation entries
    const observationEntries = entries.filter(
      (e) => e.data_type === "observation"
    );
    const dimMap = new Map<string, number[]>();

    for (const entry of observationEntries) {
      for (const dim of entry.dimensions) {
        const value =
          typeof entry.data["value"] === "number" ? entry.data["value"] : null;
        if (value !== null) {
          const arr = dimMap.get(dim) ?? [];
          arr.push(value);
          dimMap.set(dim, arr);
        }
      }
    }

    const dimensionStats = Array.from(dimMap.entries())
      .filter(([, values]) => values.length > 0)
      .map(([dim, values]) => {
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const variance =
          values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) /
          values.length;
        const stdDev = Math.sqrt(variance);
        const trend = this.computeTrend(values);
        return {
          dimension_name: dim,
          goal_id: goalId,
          stats: {
            avg_value: avg,
            std_deviation: stdDev,
            trend,
            anomaly_frequency: 0,
            observation_count: values.length,
          },
          period: this.computePeriod(entries),
          updated_at: now,
        };
      });

    // Overall stats
    const totalLoops = entries.length > 0
      ? entries[entries.length - 1]!.loop_number -
        entries[0]!.loop_number +
        1
      : 0;
    const totalTasks = taskEntries.length;
    const successfulTasks = taskEntries.filter(
      (e) => e.data["status"] === "completed"
    ).length;
    const overallSuccessRate =
      totalTasks > 0 ? successfulTasks / totalTasks : 0;

    // Merge with existing stats
    const mergedTaskStats = this.mergeTaskStats(
      existing?.task_stats ?? [],
      taskStats
    );
    const mergedDimStats = this.mergeDimStats(
      existing?.dimension_stats ?? [],
      dimensionStats
    );

    const summary = StatisticalSummarySchema.parse({
      goal_id: goalId,
      task_stats: mergedTaskStats,
      dimension_stats: mergedDimStats,
      overall: {
        total_loops:
          (existing?.overall.total_loops ?? 0) + totalLoops,
        total_tasks:
          (existing?.overall.total_tasks ?? 0) + totalTasks,
        overall_success_rate: overallSuccessRate,
        active_period: this.computePeriod(entries),
      },
      updated_at: now,
    });

    this.atomicWrite(statsPath, summary);
  }

  private mergeTaskStats(
    existing: StatisticalSummary["task_stats"],
    incoming: StatisticalSummary["task_stats"]
  ): StatisticalSummary["task_stats"] {
    const map = new Map(existing.map((s) => [s.task_category, s]));
    for (const inc of incoming) {
      const prev = map.get(inc.task_category);
      if (!prev) {
        map.set(inc.task_category, inc);
        continue;
      }
      const totalCount = prev.stats.total_count + inc.stats.total_count;
      const prevSuccess = prev.stats.success_rate * prev.stats.total_count;
      const incSuccess = inc.stats.success_rate * inc.stats.total_count;
      map.set(inc.task_category, {
        ...inc,
        stats: {
          total_count: totalCount,
          success_rate: totalCount > 0 ? (prevSuccess + incSuccess) / totalCount : 0,
          avg_duration_hours:
            (prev.stats.avg_duration_hours + inc.stats.avg_duration_hours) / 2,
          common_failure_reason: inc.stats.common_failure_reason,
        },
      });
    }
    return Array.from(map.values());
  }

  private mergeDimStats(
    existing: StatisticalSummary["dimension_stats"],
    incoming: StatisticalSummary["dimension_stats"]
  ): StatisticalSummary["dimension_stats"] {
    const map = new Map(existing.map((s) => [s.dimension_name, s]));
    for (const inc of incoming) {
      map.set(inc.dimension_name, inc); // Replace with latest computation
    }
    return Array.from(map.values());
  }

  private computeTrend(
    values: number[]
  ): "rising" | "falling" | "stable" {
    if (values.length < 2) return "stable";
    const first = values.slice(0, Math.floor(values.length / 2));
    const second = values.slice(Math.floor(values.length / 2));
    const avgFirst = first.reduce((a, b) => a + b, 0) / first.length;
    const avgSecond = second.reduce((a, b) => a + b, 0) / second.length;
    const delta = avgSecond - avgFirst;
    const threshold = Math.abs(avgFirst) * 0.05; // 5% change threshold
    if (delta > threshold) return "rising";
    if (delta < -threshold) return "falling";
    return "stable";
  }

  private computePeriod(entries: ShortTermEntry[]): string {
    if (entries.length === 0) return "unknown";
    const timestamps = entries.map((e) => e.timestamp).sort();
    const first = timestamps[0]?.slice(0, 10) ?? "unknown";
    const last = timestamps[timestamps.length - 1]?.slice(0, 10) ?? "unknown";
    return first === last ? first : `${first} to ${last}`;
  }

  // ─── Private: Force-compress remaining entries on goal close ───

  private async compressAllRemainingToLongTerm(
    goalId: string,
    dataType: MemoryDataType,
    entries: ShortTermEntry[]
  ): Promise<void> {
    if (entries.length === 0) return;

    const now = new Date().toISOString();
    const patterns = await this.extractPatterns(entries);
    const rawLessons = await this.distillLessons(patterns, entries);
    const sourceLoops = entries.map((e) => `loop_${e.loop_number}`);

    const lessons: LessonEntry[] = rawLessons.map((l) =>
      LessonEntrySchema.parse({
        ...l,
        lesson_id: this.generateId("lesson"),
        goal_id: goalId,
        source_loops: sourceLoops,
        extracted_at: now,
        status: "active",
        superseded_by: undefined,
      })
    );

    this.storeLessonsLongTerm(goalId, lessons, entries);
    this.updateStatistics(goalId, entries);

    void dataType; // type info available for future audit logging
  }

  // ─── Private: Lesson Query ───

  private queryLessons(
    tags: string[],
    dimensions: string[],
    maxCount: number
  ): LessonEntry[] {
    const results: LessonEntry[] = [];
    const seen = new Set<string>();

    // Query by-dimension lessons
    for (const dim of dimensions) {
      const byDimPath = path.join(
        this.memoryDir,
        "long-term",
        "lessons",
        "by-dimension",
        `${dim}.json`
      );
      const lessons =
        this.readJsonFile<LessonEntry[]>(byDimPath, z.array(LessonEntrySchema)) ??
        [];
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
        this.memoryDir,
        "long-term",
        "lessons",
        "global.json"
      );
      const globalLessons =
        this.readJsonFile<LessonEntry[]>(
          globalPath,
          z.array(LessonEntrySchema)
        ) ?? [];
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

  // ─── Private: LLM Helpers ───

  /**
   * Call LLM to extract recurring patterns from a set of short-term entries.
   */
  private async extractPatterns(
    entries: ShortTermEntry[]
  ): Promise<string[]> {
    const prompt = `Analyze the following experience log entries and extract recurring patterns, key insights, and lessons learned. Focus on what worked, what failed, and why.

Return a JSON object with a "patterns" array of pattern strings:
{
  "patterns": ["pattern 1", "pattern 2", ...]
}

Entries (${entries.length} total):
${JSON.stringify(
  entries.slice(0, 20).map((e) => ({
    data_type: e.data_type,
    loop_number: e.loop_number,
    dimensions: e.dimensions,
    tags: e.tags,
    data: e.data,
  })),
  null,
  2
)}`;

    const response = await this.llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      {
        system:
          "You are a pattern extraction engine. Analyze experience logs and identify recurring patterns, successes, and failures. Respond with JSON only.",
        max_tokens: 2048,
      }
    );

    try {
      const parsed = this.llmClient.parseJSON(
        response.content,
        PatternExtractionResponseSchema
      );
      return parsed.patterns;
    } catch {
      return [];
    }
  }

  /**
   * Call LLM to convert extracted patterns into structured LessonEntry objects.
   */
  private async distillLessons(
    patterns: string[],
    entries: ShortTermEntry[]
  ): Promise<Array<{
    type: "strategy_outcome" | "success_pattern" | "failure_pattern";
    context: string;
    action?: string;
    outcome?: string;
    lesson: string;
    relevance_tags: string[];
    failure_reason?: string;
    avoidance_hint?: string;
    applicability?: string;
  }>> {
    if (patterns.length === 0) return [];

    const failureEntries = entries.filter(
      (e) =>
        e.data["status"] === "failed" ||
        e.data["verdict"] === "fail" ||
        e.data["outcome"] === "failure"
    );

    const prompt = `Convert the following patterns into structured lessons. For each pattern, determine if it represents a strategy outcome, success pattern, or failure pattern.

Patterns:
${patterns.map((p, i) => `${i + 1}. ${p}`).join("\n")}

Failure context (${failureEntries.length} failure entries found):
${JSON.stringify(
  failureEntries.slice(0, 5).map((e) => e.data),
  null,
  2
)}

Return a JSON object with a "lessons" array:
{
  "lessons": [
    {
      "type": "strategy_outcome" | "success_pattern" | "failure_pattern",
      "context": "what situation this lesson applies to",
      "action": "what action was taken (optional)",
      "outcome": "what result occurred (optional)",
      "lesson": "the key lesson learned",
      "relevance_tags": ["tag1", "tag2"],
      "failure_reason": "why it failed (for failure_pattern only)",
      "avoidance_hint": "how to avoid next time (for failure_pattern only)",
      "applicability": "when to apply (for success_pattern only)"
    }
  ]
}`;

    const response = await this.llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      {
        system:
          "You are a lesson distillation engine. Convert experience patterns into structured, actionable lessons. Respond with JSON only.",
        max_tokens: 4096,
      }
    );

    try {
      const parsed = this.llmClient.parseJSON(
        response.content,
        LessonDistillationResponseSchema
      );
      // Normalize: ensure relevance_tags is always a string[]
      return parsed.lessons.map((l) => ({
        ...l,
        relevance_tags: l.relevance_tags ?? [],
      }));
    } catch {
      return [];
    }
  }

  /**
   * Validate compression quality.
   * MVP check: lesson_count >= failure_count * 0.5
   */
  private validateCompressionQuality(
    lessons: LessonEntry[],
    entries: ShortTermEntry[]
  ): { passed: boolean; failure_coverage_ratio: number; contradictions_found: number } {
    // Count failure entries
    const failureCount = entries.filter(
      (e) =>
        e.data["status"] === "failed" ||
        e.data["verdict"] === "fail" ||
        e.data["outcome"] === "failure"
    ).length;

    // MVP ratio check: lessons >= failures * 0.5
    const lessonCount = lessons.length;
    const failure_coverage_ratio =
      failureCount === 0
        ? 1
        : Math.min(1, lessonCount / (failureCount * 0.5));
    const passed =
      failureCount === 0 || lessonCount >= failureCount * 0.5;

    // Contradiction detection: check for lessons with opposite type covering same context
    let contradictions_found = 0;
    for (let i = 0; i < lessons.length; i++) {
      for (let j = i + 1; j < lessons.length; j++) {
        const a = lessons[i]!;
        const b = lessons[j]!;
        const isOppositeType =
          (a.type === "success_pattern" && b.type === "failure_pattern") ||
          (a.type === "failure_pattern" && b.type === "success_pattern");
        const sharesTag = a.relevance_tags.some((t) =>
          b.relevance_tags.includes(t)
        );
        if (isOppositeType && sharesTag) {
          contradictions_found++;
        }
      }
    }

    return {
      passed,
      failure_coverage_ratio,
      contradictions_found,
    };
  }

  // ─── Private: File Helpers ───

  private atomicWrite(filePath: string, data: unknown): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  }

  private readJsonFile<T>(filePath: string, schema: z.ZodTypeAny): T | null {
    if (!fs.existsSync(filePath)) return null;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const raw = JSON.parse(content) as unknown;
      return schema.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /**
   * Map MemoryDataType to the corresponding short-term JSON file path.
   */
  private getDataFile(goalId: string, dataType: MemoryDataType): string {
    const fileNames: Record<MemoryDataType, string> = {
      experience_log: "experience-log.json",
      observation: "observations.json",
      strategy: "strategies.json",
      task: "tasks.json",
      knowledge: "knowledge.json",
    };
    return path.join(
      this.memoryDir,
      "short-term",
      "goals",
      goalId,
      fileNames[dataType]
    );
  }

  private generateId(prefix: string): string {
    return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  }

  /**
   * Compute total size of a directory recursively in bytes.
   */
  private getDirectorySize(dirPath: string): number {
    if (!fs.existsSync(dirPath)) return 0;
    let total = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += this.getDirectorySize(entryPath);
      } else {
        try {
          total += fs.statSync(entryPath).size;
        } catch {
          // Ignore stat errors
        }
      }
    }
    return total;
  }

  /**
   * Get the retention loop limit for a goal, considering goal_type_overrides.
   * Since goalId does not encode goal type in MVP, use default unless caller
   * configures an override keyed by goalId prefix.
   */
  private getRetentionLimit(goalId: string): number {
    // Check if any override key is a prefix of goalId
    for (const [key, limit] of Object.entries(
      this.config.goal_type_overrides
    )) {
      if (goalId.startsWith(key) || goalId.includes(key)) {
        return limit;
      }
    }
    return this.config.default_retention_loops;
  }
}
