import * as path from "node:path";
import { z } from "zod";
import type { VectorIndex } from "../vector-index.js";
import {
  ShortTermEntrySchema,
} from "../../../base/types/memory-lifecycle.js";
import type {
  ShortTermEntry,
  LessonEntry,
} from "../../../base/types/memory-lifecycle.js";
import type { IDriveScorer } from "../drive-score-adapter.js";
import {
  readJsonFileAsync,
} from "./memory-persistence.js";
import { loadIndex, touchIndexEntry } from "./memory-index.js";
import { queryLessons, queryCrossGoalLessons } from "./memory-query.js";
import { classifyTier, sortByTier, computeDynamicBudget, filterByTierBudget, llmClassifyTier, getDeadlineBonus } from "./memory-tier.js";
export { getCompressionDelay, getDeadlineBonus } from "./memory-tier.js";

// ─── Deps interface ───

export interface MemorySelectionDeps {
  memoryDir: string;
  vectorIndex?: VectorIndex;
  driveScorer?: IDriveScorer;
}

// ─── relevanceScore ───

/**
 * Compute a relevance score for a short-term entry given a context.
 *
 * Score = tag_match_ratio * drive_weight * freshness_factor * (0.7 + 0.3 * importance_factor)
 *   - tag_match_ratio     = matching tags / total unique tags (0 if no tags)
 *   - drive_weight        = DriveScorer dissatisfaction score for first matching
 *                           dimension (1.0 if no DriveScorer or no dimensions)
 *   - freshness_factor    = Math.exp(-daysSinceCreation / 30)
 *   - importance_factor   = Math.log2(1 + accessCount) / Math.log2(11)
 *                           (0 accesses → 0, 10 accesses → 1.0; undefined → multiplier=1.0 for backward compat)
 */
export function relevanceScore(
  deps: Pick<MemorySelectionDeps, "driveScorer">,
  entry: ShortTermEntry,
  context: { goalId: string; dimensions: string[]; tags: string[] },
  accessCount?: number
): number {
  // 1. Tag match ratio
  const allTags = new Set([...entry.tags, ...context.tags]);
  const matchingTags = entry.tags.filter((t) => context.tags.includes(t)).length;
  const tagMatchRatio = allTags.size > 0 ? matchingTags / allTags.size : 0;

  // 2. Drive weight
  let driveWeight = 1.0;
  if (deps.driveScorer) {
    // Use the first dimension that matches entry dimensions or context dimensions
    const relevantDimensions = entry.dimensions.length > 0
      ? entry.dimensions
      : context.dimensions;
    if (relevantDimensions.length > 0) {
      const dim = relevantDimensions[0]!;
      driveWeight = deps.driveScorer.getDissatisfactionScore(dim);
      // Clamp to [0.1, 2]: floor at 0.1 so satisfied dimensions don't zero out tag-perfect matches
      driveWeight = Math.max(0.1, driveWeight);
    }
  }

  // 3. Freshness factor (exponential decay over 30 days)
  const createdAt = new Date(entry.timestamp).getTime();
  const daysSinceCreation = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
  const freshnessFactor = Math.exp(-daysSinceCreation / 30);

  // 4. Importance factor based on access_count (proxy for usage importance)
  //    0 accesses → 0, 10 accesses → 1.0; undefined → multiplier = 1.0 (backward compat)
  //    When accessCount is provided: multiplier = 0.7 + 0.3 * importanceFactor
  //    When accessCount is undefined: multiplier = 1.0 (preserves old formula exactly)
  const importanceMultiplier = accessCount === undefined
    ? 1.0
    : 0.7 + 0.3 * (Math.log2(1 + accessCount) / Math.log2(11));

  return tagMatchRatio * driveWeight * freshnessFactor * importanceMultiplier;
}

// ─── SelectionContext ───

export interface SelectionContext {
  maxEntries?: number;
  activeGoalIds?: string[];
  completedGoalIds?: string[];
  satisfiedDimensions?: string[];
  highDissatisfactionDimensions?: string[];
  maxDissatisfaction?: number;
  useLLMClassification?: boolean;
  llmClient?: { generateStructured: (...args: any[]) => Promise<any> };
}

// ─── selectForWorkingMemory ───

/**
 * Select relevant entries for working memory.
 * Phase 1: tag exact-match + recency sort.
 * Phase 2 (5.2b): semantic search fallback via VectorIndex if tag results are insufficient.
 * Phase 2 (5.2c): includes cross-goal lessons (up to 25% of budget).
 *
 * Tier-aware mode (optional): when activeGoalIds / completedGoalIds are provided,
 * classify entries into tiers and guarantee core-tier entries are included first.
 */
export async function selectForWorkingMemory(
  deps: MemorySelectionDeps,
  goalId: string,
  dimensions: string[],
  tags: string[],
  ctx: SelectionContext = {}
): Promise<{ shortTerm: ShortTermEntry[]; lessons: LessonEntry[] }> {
  const {
    maxEntries = 10,
    activeGoalIds,
    completedGoalIds,
    satisfiedDimensions,
    highDissatisfactionDimensions,
    maxDissatisfaction,
    useLLMClassification,
    llmClient,
  } = ctx;
  // 1. Tag-based query: short-term entries for this goal matching dimensions/tags
  const stIndex = await loadIndex(deps.memoryDir, "short-term");
  let matchingIndexEntries = stIndex.entries.filter(
    (ie) =>
      ie.goal_id === goalId &&
      (dimensions.some((d) => ie.dimensions.includes(d)) ||
        tags.some((t) => ie.tags.includes(t)))
  );

  // Sort by composite score (recency + importance + relevance) descending
  // before tier re-ordering. Entries without driveScorer fall back to freshness * importance.
  const context = { goalId, dimensions, tags };
  matchingIndexEntries.sort((a, b) => {
    // Build a minimal ShortTermEntry-like object from the index entry for scoring
    const entryA = { tags: a.tags, dimensions: a.dimensions, timestamp: a.last_accessed } as ShortTermEntry;
    const entryB = { tags: b.tags, dimensions: b.dimensions, timestamp: b.last_accessed } as ShortTermEntry;
    return (
      relevanceScore(deps, entryB, context, b.access_count) -
      relevanceScore(deps, entryA, context, a.access_count)
    );
  });

  // Tier-aware mode: classify, update memory_tier, then sort by tier
  if (activeGoalIds !== undefined) {
    const resolvedCompleted = completedGoalIds ?? [];
    for (const ie of matchingIndexEntries) {
      ie.memory_tier = classifyTier(
        ie,
        activeGoalIds,
        resolvedCompleted,
        satisfiedDimensions,
        highDissatisfactionDimensions
      );
    }

    // Sub-stage 2.5: LLM classification override (after rule-based)
    if (useLLMClassification && llmClient) {
      const llmTiers = await llmClassifyTier(
        matchingIndexEntries,
        { goalId, dimensions, gap: maxDissatisfaction },
        llmClient
      );
      for (const ie of matchingIndexEntries) {
        const llmTier = llmTiers.get(ie.entry_id);
        if (llmTier !== undefined) {
          ie.memory_tier = llmTier;
        }
      }
    }

    matchingIndexEntries = sortByTier(matchingIndexEntries);
  }

  // Sub-stage 2.3: dynamic budget determines core guarantee ratio
  // Budget filtering is applied to the loaded entries (not index), so small sets still work
  const dynamicBudget = activeGoalIds !== undefined
    ? computeDynamicBudget(maxDissatisfaction ?? 0)
    : { core: 1.0, recall: 0.0, archival: 0.0 };

  const coreGuarantee = activeGoalIds !== undefined
    ? Math.ceil(maxEntries * dynamicBudget.core)
    : maxEntries;

  const shortTermEntries: ShortTermEntry[] = [];
  const seenEntryIds = new Set<string>();

  // Pass 1: fill core-guaranteed slots
  if (activeGoalIds !== undefined) {
    const coreEntries = matchingIndexEntries.filter(
      (ie) => ie.memory_tier === "core"
    );
    for (const idxEntry of coreEntries) {
      if (shortTermEntries.length >= coreGuarantee) break;
      if (seenEntryIds.has(idxEntry.entry_id)) continue;

      const found = await loadShortTermEntry(deps, idxEntry);
      if (found) {
        shortTermEntries.push(found);
        seenEntryIds.add(idxEntry.entry_id);
        void touchIndexEntry(deps.memoryDir, "short-term", idxEntry.id);
      }
    }
  }

  // Pass 2: fill remaining budget (recall first, then archival if space)
  const recallCandidates = activeGoalIds !== undefined
    ? matchingIndexEntries.filter((ie) => ie.memory_tier === "recall")
    : matchingIndexEntries;

  for (const idxEntry of recallCandidates) {
    if (shortTermEntries.length >= maxEntries) break;
    if (seenEntryIds.has(idxEntry.entry_id)) continue;

    const found = await loadShortTermEntry(deps, idxEntry);
    if (found) {
      shortTermEntries.push(found);
      seenEntryIds.add(idxEntry.entry_id);
      void touchIndexEntry(deps.memoryDir, "short-term", idxEntry.id);
    }
  }

  // Pass 2b: archival entries — use semantic search if VectorIndex available
  if (activeGoalIds !== undefined && shortTermEntries.length < maxEntries) {
    const archivalCandidates = matchingIndexEntries.filter(
      (ie) => ie.memory_tier === "archival" && !seenEntryIds.has(ie.entry_id)
    );

    if (archivalCandidates.length > 0) {
      let orderedArchival = archivalCandidates;

      if (deps.vectorIndex) {
        // Derive query from dimensions and tags for semantic ranking
        const query = [...dimensions, ...tags].join(" ");
        const archivalLimit = maxEntries - shortTermEntries.length;
        try {
          const metaResults = await deps.vectorIndex.searchMetadata(query, archivalLimit * 2);
          const metaIds = new Set(metaResults.map((r) => r.id));
          // Put semantically matched entries first, then remaining by recency
          const semantic = archivalCandidates.filter((ie) => metaIds.has(ie.entry_id));
          const rest = archivalCandidates.filter((ie) => !metaIds.has(ie.entry_id));
          orderedArchival = [...semantic, ...rest];
        } catch {
          // Graceful fallback to existing order on error
        }
      }

      for (const idxEntry of orderedArchival) {
        if (shortTermEntries.length >= maxEntries) break;
        if (seenEntryIds.has(idxEntry.entry_id)) continue;

        const found = await loadShortTermEntry(deps, idxEntry);
        if (found) {
          shortTermEntries.push(found);
          seenEntryIds.add(idxEntry.entry_id);
          void touchIndexEntry(deps.memoryDir, "short-term", idxEntry.id);
        }
      }
    }
  } else if (activeGoalIds === undefined) {
    // Non-tier-aware: already handled by recallCandidates = matchingIndexEntries above
  }

  // Phase 2 (5.2b): If results are fewer than needed and VectorIndex available, do sync lookup
  // Note: selectForWorkingMemorySemantic (async) handles full semantic search.
  // Here we merge from the index directly.
  if (shortTermEntries.length < maxEntries && deps.vectorIndex) {
    // Pull all goal entries from the short-term index (not yet in result set) as semantic candidates
    const remaining = stIndex.entries.filter(
      (ie) => ie.goal_id === goalId && !seenEntryIds.has(ie.entry_id)
    );

    // Sort by access count + recency as a proxy
    remaining.sort(
      (a, b) =>
        b.access_count - a.access_count ||
        new Date(b.last_accessed).getTime() - new Date(a.last_accessed).getTime()
    );

    for (const idxEntry of remaining) {
      if (shortTermEntries.length >= maxEntries) break;
      if (seenEntryIds.has(idxEntry.entry_id)) continue;

      const found = await loadShortTermEntry(deps, idxEntry);
      if (found) {
        shortTermEntries.push(found);
        seenEntryIds.add(idxEntry.entry_id);
      }
    }

    // Re-sort by relevanceScore if driveScorer is available
    if (deps.driveScorer) {
      shortTermEntries.sort(
        (a, b) =>
          relevanceScore(deps, b, { goalId, dimensions, tags }) -
          relevanceScore(deps, a, { goalId, dimensions, tags })
      );
    }
  }

  // 2. Query long-term lessons matching tags (cross-goal OK for lessons)
  const goalLessons = await queryLessons(deps.memoryDir, tags, dimensions, Math.ceil(maxEntries * 0.75));

  // Phase 2 (5.2c): Include cross-goal lessons (up to 25% of budget)
  const crossGoalBudget = Math.max(1, Math.floor(maxEntries * 0.25));
  const crossGoalLessonList = await queryCrossGoalLessons(
    deps.memoryDir,
    tags,
    dimensions,
    goalId,
    crossGoalBudget
  );

  // Deduplicate cross-goal lessons against goal lessons
  const seenLessonIds = new Set(goalLessons.map((l) => l.lesson_id));
  const dedupedCrossGoal = crossGoalLessonList.filter(
    (l) => !seenLessonIds.has(l.lesson_id)
  );

  const lessons = [...goalLessons, ...dedupedCrossGoal];

  return { shortTerm: shortTermEntries, lessons };
}

// ─── Internal helper ───

async function loadShortTermEntry(
  deps: Pick<MemorySelectionDeps, "memoryDir">,
  idxEntry: import("../../../base/types/memory-lifecycle.js").MemoryIndexEntry
): Promise<ShortTermEntry | undefined> {
  const dataFilePath = path.join(
    deps.memoryDir,
    "short-term",
    idxEntry.data_file
  );
  const allEntries =
    (await readJsonFileAsync<ShortTermEntry[]>(
      dataFilePath,
      z.array(ShortTermEntrySchema)
    )) ?? [];
  return allEntries.find((e) => e.id === idxEntry.entry_id);
}

// ─── searchCrossGoalLessons ───

/**
 * Search long-term lessons across ALL goals using semantic search.
 * Falls back to tag-based global search if VectorIndex is unavailable.
 *
 * @param query  - natural language search query
 * @param topK   - maximum number of lessons to return (default 5)
 */
export async function searchCrossGoalLessons(
  deps: Pick<MemorySelectionDeps, "memoryDir" | "vectorIndex">,
  query: string,
  topK = 5
): Promise<LessonEntry[]> {
  const { LessonEntrySchema } = await import("../../../base/types/memory-lifecycle.js");

  if (deps.vectorIndex) {
    // Semantic search in vector index
    const results = await deps.vectorIndex.search(query, topK * 2, 0.0);

    // Filter to lesson entries (metadata.is_lesson === true)
    const lessonResults = results.filter((r) => r.metadata.is_lesson === true);

    // Load actual lessons from global file
    const globalPath = path.join(
      deps.memoryDir,
      "long-term",
      "lessons",
      "global.json"
    );
    const globalLessons =
      (await readJsonFileAsync<LessonEntry[]>(
        globalPath,
        z.array(LessonEntrySchema)
      )) ?? [];

    const lessonMap = new Map(globalLessons.map((l) => [l.lesson_id, l]));
    const matched: LessonEntry[] = [];
    for (const r of lessonResults) {
      const lesson = lessonMap.get(r.id);
      if (lesson && lesson.status === "active") {
        matched.push(lesson);
        if (matched.length >= topK) break;
      }
    }

    // If we got enough results from semantic search, return them
    if (matched.length > 0) {
      return matched;
    }
  }

  // Fallback: tag-based global search
  const { LessonEntrySchema: LessonSchema } = await import("../../../base/types/memory-lifecycle.js");
  const globalPath = path.join(
    deps.memoryDir,
    "long-term",
    "lessons",
    "global.json"
  );
  const globalLessons =
    (await readJsonFileAsync<LessonEntry[]>(
      globalPath,
      z.array(LessonSchema)
    )) ?? [];

  // Simple text match on lesson content
  const queryLower = query.toLowerCase();
  const matching = globalLessons.filter(
    (l) =>
      l.status === "active" &&
      (l.lesson.toLowerCase().includes(queryLower) ||
        l.context.toLowerCase().includes(queryLower) ||
        l.relevance_tags.some((t) => t.toLowerCase().includes(queryLower)))
  );

  // Sort by recency
  matching.sort(
    (a, b) =>
      new Date(b.extracted_at).getTime() - new Date(a.extracted_at).getTime()
  );

  return matching.slice(0, topK);
}

// ─── selectForWorkingMemorySemantic ───

/**
 * Semantic variant of selectForWorkingMemory.
 * Uses VectorIndex.search() to find semantically relevant entries.
 * Applies deadline bonus to relevance scores.
 * Falls back to existing sync method if no vectorIndex available.
 */
export async function selectForWorkingMemorySemantic(
  deps: MemorySelectionDeps,
  goalId: string,
  query: string,
  dimensions: string[],
  tags: string[],
  maxEntries: number = 10,
  driveScores?: Array<{ dimension: string; dissatisfaction: number; deadline: number }>
): Promise<{ shortTerm: ShortTermEntry[]; lessons: LessonEntry[] }> {
  // Fall back to sync method if no vectorIndex
  if (!deps.vectorIndex) {
    return selectForWorkingMemory(deps, goalId, dimensions, tags, { maxEntries });
  }

  // Compute deadline bonuses per dimension
  const deadlineBonus = driveScores
    ? getDeadlineBonus(driveScores.map((d) => ({ dimension: d.dimension, deadline: d.deadline })))
    : new Map<string, number>();

  const maxBonus = deadlineBonus.size > 0
    ? Math.max(...Array.from(deadlineBonus.values()))
    : 0;

  // Search vector index for semantically similar entries
  const searchResults = await deps.vectorIndex.search(query, maxEntries * 2, 0.0);

  // Filter to this goal's entries
  const goalResults = searchResults.filter(
    (r) => r.metadata.goal_id === goalId
  );

  // Load short-term index for recency data
  const stIndex = await loadIndex(deps.memoryDir, "short-term");
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
      deps.memoryDir,
      "short-term",
      idxEntry.data_file
    );
    const allEntries =
      (await readJsonFileAsync<ShortTermEntry[]>(
        dataFilePath,
        z.array(ShortTermEntrySchema)
      )) ?? [];
    const found = allEntries.find((e) => e.id === idxEntry.entry_id);
    if (found) {
      scoredEntries.push({ entry: found, combinedScore });
      seenEntryIds.add(result.id);
      touchIndexEntry(deps.memoryDir, "short-term", idxEntry.id);
    }
  }

  // Sort by combined score descending and take top maxEntries
  scoredEntries.sort((a, b) => b.combinedScore - a.combinedScore);
  const shortTermEntries = scoredEntries
    .slice(0, maxEntries)
    .map((s) => s.entry);

  // Still use tag/dimension-based lesson query for long-term
  const lessons = await queryLessons(deps.memoryDir, tags, dimensions, maxEntries);

  return { shortTerm: shortTermEntries, lessons };
}

