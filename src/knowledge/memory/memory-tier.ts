import { z } from "zod";
import type {
  ShortTermEntry,
  MemoryIndexEntry,
  MemoryTier,
  TierBudget,
} from "../types/memory-lifecycle.js";

// ─── Constants ───

/** How many hours ago counts as "recent" for MemoryIndexEntry (no loop_number). */
const RECENT_HOURS = 5;

/** How many loops ago counts as "recent" for ShortTermEntry core classification. */
const RECENT_LOOPS = 5;

/** Core-eligible data types for ShortTermEntry. */
const CORE_DATA_TYPES: ReadonlySet<string> = new Set(["observation", "strategy"]);

// ─── Type guard ───

function isShortTermEntry(
  entry: ShortTermEntry | MemoryIndexEntry
): entry is ShortTermEntry {
  return "loop_number" in entry && "data_type" in entry;
}

// ─── classifyTier ───

/**
 * Classify a memory entry into a tier based on its goal membership and recency.
 *
 * - core:     active goal + core data type + recent (last 5 loops / 5 hours)
 * - recall:   active goal (other data types, or older)
 * - archival: completed goal OR not in any tracked goal
 *
 * Optional promotion/demotion params:
 * - satisfiedDimensions: if all entry dimensions are satisfied, demote core→recall
 * - highDissatisfactionDimensions: if any entry dimension is highly dissatisfied, promote recall→core
 */
export function classifyTier(
  entry: ShortTermEntry | MemoryIndexEntry,
  activeGoalIds: string[],
  completedGoalIds: string[],
  satisfiedDimensions?: string[],
  highDissatisfactionDimensions?: string[]
): MemoryTier {
  const activeSet = new Set(activeGoalIds);
  const completedSet = new Set(completedGoalIds);

  // Archival: goal is completed or unknown
  if (!activeSet.has(entry.goal_id)) {
    // Could be completed or simply unknown — both are archival
    return "archival";
  }

  // entry.goal_id is in activeGoalIds → at least recall
  let tier: MemoryTier;
  if (isShortTermEntry(entry)) {
    tier = classifyShortTermTier(entry, completedSet);
  } else {
    tier = classifyIndexEntryTier(entry);
  }

  // Sub-stage 2.1: core→recall demotion when all dimensions are satisfied
  if (tier === "core" && satisfiedDimensions && satisfiedDimensions.length > 0) {
    const entryDims = entry.dimensions;
    if (
      entryDims.length > 0 &&
      entryDims.every((d) => satisfiedDimensions.includes(d))
    ) {
      tier = "recall";
    }
  }

  // Sub-stage 2.2: recall→core promotion when any dimension has high dissatisfaction
  if (tier === "recall" && highDissatisfactionDimensions && highDissatisfactionDimensions.length > 0) {
    const entryDims = entry.dimensions;
    if (entryDims.some((d) => highDissatisfactionDimensions.includes(d))) {
      tier = "core";
    }
  }

  return tier;
}

function classifyShortTermTier(
  entry: ShortTermEntry,
  _completedSet: Set<string>
): MemoryTier {
  // Core requires: core data type + recent loop
  const isCoreType = CORE_DATA_TYPES.has(entry.data_type);
  if (!isCoreType) return "recall";

  // Check recency: loop_number (0-indexed, higher = more recent)
  // We don't know the current loop number, so we use a heuristic:
  // tags may include "recent"; otherwise we treat any loop_number > 0 check
  // by seeing if the entry has the "recent" tag, or we fall back to timestamp.
  // The spec says "from last 5 loops (compare loop_number if ShortTermEntry)".
  // Without knowing max loop, use timestamp as proxy: if within 5 * avg_loop_time.
  // Simpler: if tags include "recent" OR timestamp is within RECENT_HOURS hours.
  if (entry.tags.includes("recent")) return "core";

  const ageMs = Date.now() - new Date(entry.timestamp).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  if (ageHours <= RECENT_HOURS) return "core";

  return "recall";
}

function classifyIndexEntryTier(entry: MemoryIndexEntry): MemoryTier {
  // MemoryIndexEntry: no loop_number. Use last_accessed recency.
  // Core: has "recent" tag OR last_accessed within RECENT_HOURS
  if (entry.tags.includes("recent")) return "core";

  const ageMs = Date.now() - new Date(entry.last_accessed).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  if (ageHours <= RECENT_HOURS) return "core";

  return "recall";
}

// ─── sortByTier ───

const TIER_ORDER: Record<MemoryTier, number> = {
  core: 0,
  recall: 1,
  archival: 2,
};

/**
 * Sort entries: core first, then recall, then archival.
 * Within the same tier, preserve original order (stable).
 */
export function sortByTier(entries: MemoryIndexEntry[]): MemoryIndexEntry[] {
  // Stable sort: annotate with original index to preserve order within tier
  return entries
    .map((e, idx) => ({ e, idx }))
    .sort((a, b) => {
      const tierDiff = TIER_ORDER[a.e.memory_tier] - TIER_ORDER[b.e.memory_tier];
      if (tierDiff !== 0) return tierDiff;
      return a.idx - b.idx;
    })
    .map(({ e }) => e);
}

// ─── computeDynamicBudget ───

/**
 * Compute tier budget based on max dissatisfaction score.
 * Higher dissatisfaction → more budget for core tier.
 */
export function computeDynamicBudget(maxDissatisfaction: number): TierBudget {
  if (maxDissatisfaction > 0.7) return { core: 0.70, recall: 0.25, archival: 0.05 };
  if (maxDissatisfaction > 0.4) return { core: 0.60, recall: 0.30, archival: 0.10 };
  return { core: 0.50, recall: 0.35, archival: 0.15 };
}

// ─── filterByTierBudget ───

/**
 * Apply per-tier count limits from a TierBudget.
 *
 * TierBudget values are fractions [0, 1] of the total entry count.
 * Converts fractions to absolute counts based on entries.length.
 * At minimum, each tier gets Math.ceil(fraction * total) slots.
 *
 * Core entries are guaranteed first (up to their count limit),
 * then recall, then archival.
 * Entries are expected to already be sorted (sortByTier).
 */
export function filterByTierBudget(
  entries: MemoryIndexEntry[],
  budget: TierBudget
): MemoryIndexEntry[] {
  const total = entries.length;
  if (total === 0) return [];

  // Convert fractions to counts
  const coreMax = Math.round(budget.core * total);
  const recallMax = Math.round(budget.recall * total);
  const archivalMax = Math.round(budget.archival * total);

  const result: MemoryIndexEntry[] = [];
  let coreCount = 0;
  let recallCount = 0;
  let archivalCount = 0;

  for (const entry of entries) {
    if (entry.memory_tier === "core" && coreCount < coreMax) {
      result.push(entry);
      coreCount++;
    } else if (entry.memory_tier === "recall" && recallCount < recallMax) {
      result.push(entry);
      recallCount++;
    } else if (entry.memory_tier === "archival" && archivalCount < archivalMax) {
      result.push(entry);
      archivalCount++;
    }
  }

  return result;
}

// ─── Drive helpers (used by selection + compression) ───

/**
 * Dissatisfaction drive: delay compression up to 2x for high-dissatisfaction dimensions.
 * For each dimension, if dissatisfaction > 0.7, delay_factor = 1 + dissatisfaction (max 2.0).
 * Returns map of dimension -> delay_factor.
 */
export function getCompressionDelay(
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
export function getDeadlineBonus(
  driveScores: Array<{ dimension: string; deadline: number }>
): Map<string, number> {
  const result = new Map<string, number>();
  for (const { dimension, deadline } of driveScores) {
    result.set(dimension, Math.min(deadline * 0.3, 0.3));
  }
  return result;
}

// ─── llmClassifyTier ───

const LLMTierResponseSchema = z.object({
  classifications: z.array(
    z.object({
      entry_id: z.string(),
      tier: z.string(), // will be sanitized
    })
  ),
});

/**
 * Use an LLM to classify entry tiers based on active goal context.
 * Falls back to rule-based classifyTier on any error.
 */
export async function llmClassifyTier(
  entries: MemoryIndexEntry[],
  activeGoalContext: { goalId: string; dimensions: string[]; gap?: number },
  llmClient: { generateStructured: (...args: any[]) => Promise<any> }
): Promise<Map<string, MemoryTier>> {
  if (entries.length === 0) return new Map();

  const validTiers: MemoryTier[] = ["core", "recall", "archival"];

  const prompt = `You are classifying memory entries for an AI agent into tiers.

Active goal: ${activeGoalContext.goalId}
Goal dimensions: ${activeGoalContext.dimensions.join(", ")}
${activeGoalContext.gap !== undefined ? `Current gap: ${activeGoalContext.gap}` : ""}

Entries to classify:
${entries.map((e) => `- id: ${e.entry_id}, dimensions: [${e.dimensions.join(", ")}], tags: [${e.tags.join(", ")}], last_accessed: ${e.last_accessed}`).join("\n")}

Classify each entry into one of: core (actively needed now), recall (may be needed soon), archival (background reference).

Respond with JSON: {"classifications": [{"entry_id": "<id>", "tier": "core|recall|archival"}, ...]}`;

  try {
    const raw = await llmClient.generateStructured(prompt);
    const parsed = LLMTierResponseSchema.parse(raw);

    const result = new Map<string, MemoryTier>();
    for (const item of parsed.classifications) {
      const tier = validTiers.includes(item.tier as MemoryTier)
        ? (item.tier as MemoryTier)
        : "archival"; // sanitize out-of-enum values
      result.set(item.entry_id, tier);
    }
    return result;
  } catch (err) {
    console.error("[llmClassifyTier] error, falling back to rule-based:", err);
    // Fallback: rule-based classification using active goal
    const result = new Map<string, MemoryTier>();
    for (const entry of entries) {
      result.set(
        entry.entry_id,
        classifyTier(entry, [activeGoalContext.goalId], [])
      );
    }
    return result;
  }
}
