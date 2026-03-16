import { StateManager } from "./state-manager.js";
import { computeRawGap, normalizeGap } from "./gap-calculator.js";
import type { Goal, Dimension } from "./types/goal.js";
import type {
  CompletionJudgment,
  DimensionSatisfaction,
  IterationConstraints,
  ThresholdAdjustmentProposal,
  MappingProposal,
} from "./types/satisficing.js";
import type { IEmbeddingClient } from "./embedding-client.js";

/**
 * SatisficingJudge implements the completion judgment logic defined in satisficing.md.
 *
 * Responsibility: determine whether a goal (or individual dimension) is "good enough"
 * to declare done, applying progress ceilings based on confidence tiers.
 *
 * Key design rules:
 * - Completion requires ALL dimensions satisfied AND no low-confidence dimensions.
 * - Progress ceiling: high >= 0.85 → 1.0 | medium >= 0.50 → 0.85 | low < 0.50 → 0.60
 * - These ceiling values are from satisficing.md (distinct from ObservationEngine ceilings).
 * - null current_value is treated as fully unsatisfied.
 */
export class SatisficingJudge {
  private readonly stateManager: StateManager;
  private readonly embeddingClient?: IEmbeddingClient;
  private readonly onSatisficingJudgment?: (goalId: string, satisfiedDimensions: string[]) => void;

  constructor(
    stateManager: StateManager,
    embeddingClient?: IEmbeddingClient,  // Phase 2: for dimension mapping proposals
    onSatisficingJudgment?: (goalId: string, satisfiedDimensions: string[]) => void
  ) {
    this.stateManager = stateManager;
    this.embeddingClient = embeddingClient;
    this.onSatisficingJudgment = onSatisficingJudgment;
  }

  // ─── Confidence Tier Helpers ───

  private getConfidenceTier(confidence: number): "high" | "medium" | "low" {
    if (confidence >= 0.85) return "high";
    if (confidence >= 0.50) return "medium";
    return "low";
  }

  private getCeiling(tier: "high" | "medium" | "low"): number {
    switch (tier) {
      case "high":
        return 1.0;
      case "medium":
        return 0.85;
      case "low":
        return 0.60;
    }
  }

  // ─── Progress Calculation (inverse of gap) ───

  /**
   * Compute actual progress (0–1) toward satisfying a dimension.
   * Progress = 1 - normalized_gap, clamped to [0, 1].
   * For binary thresholds (present/match), either 0 or 1.
   * null current_value = 0 progress.
   */
  private computeActualProgress(dim: Dimension): number {
    const { current_value, threshold } = dim;

    if (current_value === null) return 0;

    const rawGap = computeRawGap(current_value, threshold);
    const normalizedGap = normalizeGap(rawGap, threshold, current_value);

    // Clamp to [0, 1] and invert: progress = 1 - gap
    const clamped = Math.min(1, Math.max(0, normalizedGap));
    return 1 - clamped;
  }

  // ─── Satisfaction Check ───

  /**
   * Determine whether a dimension's current_value meets its threshold.
   * Uses raw boolean logic (not gap magnitude) for the is_satisfied flag.
   */
  private isSatisfiedRaw(dim: Dimension): boolean {
    const { current_value, threshold } = dim;

    if (current_value === null) return false;

    switch (threshold.type) {
      case "min":
        return toNumber(current_value) >= threshold.value;
      case "max":
        return toNumber(current_value) <= threshold.value;
      case "range":
        return (
          toNumber(current_value) >= threshold.low &&
          toNumber(current_value) <= threshold.high
        );
      case "present":
        return isTruthy(current_value);
      case "match":
        return current_value === threshold.value;
    }
  }

  // ─── Public API ───

  /**
   * Check if a single dimension is satisfied with appropriate confidence ceiling.
   */
  isDimensionSatisfied(dim: Dimension): DimensionSatisfaction {
    const isSatisfied = this.isSatisfiedRaw(dim);
    const tier = this.getConfidenceTier(dim.confidence);
    const ceiling = this.getCeiling(tier);
    const actualProgress = this.computeActualProgress(dim);
    const effectiveProgress = Math.min(actualProgress, ceiling);

    // threshold_value for the schema — use numeric representation where applicable
    const thresholdValue = getNumericThresholdValue(dim);

    return {
      dimension_name: dim.name,
      is_satisfied: isSatisfied,
      current_value: toNumberOrNull(dim.current_value),
      threshold_value: thresholdValue,
      confidence: dim.confidence,
      confidence_tier: tier,
      effective_progress: effectiveProgress,
      progress_ceiling: ceiling,
    };
  }

  /**
   * Propose dimension mappings between subgoal and parent goal dimensions
   * using embedding similarity.
   */
  async proposeDimensionMapping(
    subgoalDimensions: Array<{ name: string; description?: string }>,
    parentGoalDimensions: Array<{ name: string; description?: string }>
  ): Promise<MappingProposal[]> {
    if (!this.embeddingClient) return [];

    const proposals: MappingProposal[] = [];

    for (const subDim of subgoalDimensions) {
      const subText = subDim.description ? `${subDim.name}: ${subDim.description}` : subDim.name;
      const subVector = await this.embeddingClient.embed(subText);

      let bestMatch: { name: string; similarity: number } | null = null;

      for (const parentDim of parentGoalDimensions) {
        const parentText = parentDim.description ? `${parentDim.name}: ${parentDim.description}` : parentDim.name;
        const parentVector = await this.embeddingClient.embed(parentText);
        const similarity = this.embeddingClient.cosineSimilarity(subVector, parentVector);

        if (!bestMatch || similarity > bestMatch.similarity) {
          bestMatch = { name: parentDim.name, similarity };
        }
      }

      if (bestMatch && bestMatch.similarity > 0.5) {
        proposals.push({
          subgoal_dimension: subDim.name,
          parent_dimension: bestMatch.name,
          similarity_score: bestMatch.similarity,
          suggested_aggregation: "avg",  // default; could be smarter
          confidence: Math.min(bestMatch.similarity, 0.9),
          reasoning: `Dimension "${subDim.name}" is semantically similar to parent dimension "${bestMatch.name}" (similarity: ${bestMatch.similarity.toFixed(3)})`,
        });
      }
    }

    return proposals;
  }

  /**
   * Determine if a goal is fully complete.
   * Complete iff all dimensions are satisfied AND no dimension has low confidence.
   */
  isGoalComplete(goal: Goal): CompletionJudgment {
    const dims = goal.dimensions;

    if (dims.length === 0) {
      return {
        is_complete: true,
        blocking_dimensions: [],
        low_confidence_dimensions: [],
        needs_verification_task: false,
        checked_at: new Date().toISOString(),
      };
    }

    const satisfactions = dims.map((d) => this.isDimensionSatisfied(d));

    const blockingDimensions = satisfactions
      .filter((s) => !s.is_satisfied)
      .map((s) => s.dimension_name);

    const lowConfidenceDimensions = satisfactions
      .filter((s) => s.confidence_tier === "low")
      .map((s) => s.dimension_name);

    // needs_verification_task: any dimension appears to meet threshold but confidence < 0.85
    const needsVerification = satisfactions.some(
      (s) => s.is_satisfied && s.confidence < 0.85
    );

    const isComplete =
      blockingDimensions.length === 0 && lowConfidenceDimensions.length === 0;

    if (this.onSatisficingJudgment) {
      const satisfiedDims = dims
        .filter(d => this.isDimensionSatisfied(d).is_satisfied)
        .map(d => d.name);
      if (satisfiedDims.length > 0) {
        this.onSatisficingJudgment(goal.id, satisfiedDims);
      }
    }

    return {
      is_complete: isComplete,
      blocking_dimensions: blockingDimensions,
      low_confidence_dimensions: lowConfidenceDimensions,
      needs_verification_task: needsVerification,
      checked_at: new Date().toISOString(),
    };
  }

  /**
   * Apply progress ceiling based on confidence tier.
   * Returns min(actualProgress, ceiling).
   */
  applyProgressCeiling(actualProgress: number, confidence: number): number {
    const tier = this.getConfidenceTier(confidence);
    const ceiling = this.getCeiling(tier);
    return Math.min(actualProgress, ceiling);
  }

  /**
   * Select dimensions to focus on in the next iteration.
   *
   * Algorithm:
   * 1. Exclude already-satisfied dimensions.
   * 2. Among remaining, sort by drive score (highest first).
   * 3. Take top max_dimensions.
   */
  selectDimensionsForIteration(
    dimensions: Dimension[],
    driveScores: Array<{ dimension_name: string; score: number }>,
    constraints?: IterationConstraints
  ): string[] {
    const maxDimensions = constraints?.max_dimensions ?? 3;
    const uncertaintyThreshold = constraints?.uncertainty_threshold ?? 0.50;

    // Build score lookup
    const scoreMap = new Map<string, number>(
      driveScores.map((ds) => [ds.dimension_name, ds.score])
    );

    // Filter out satisfied dimensions; mark low-confidence as needing observation first
    const candidates = dimensions
      .filter((dim) => !this.isSatisfiedRaw(dim))
      .filter((dim) => dim.confidence >= uncertaintyThreshold);

    // Sort by drive score descending
    candidates.sort((a, b) => {
      const scoreA = scoreMap.get(a.name) ?? 0;
      const scoreB = scoreMap.get(b.name) ?? 0;
      return scoreB - scoreA;
    });

    return candidates.slice(0, maxDimensions).map((d) => d.name);
  }

  /**
   * Detect dimensions where threshold adjustment may be warranted.
   *
   * Condition 1: >= 3 failures AND normalized_gap has not improved (no progress).
   * Condition 2: all other dimensions satisfied, this one is still far from threshold.
   */
  detectThresholdAdjustmentNeeded(
    goal: Goal,
    failureCounts: Map<string, number>
  ): ThresholdAdjustmentProposal[] {
    const proposals: ThresholdAdjustmentProposal[] = [];
    const dims = goal.dimensions;

    if (dims.length === 0) return proposals;

    const satisfactions = dims.map((d) => this.isDimensionSatisfied(d));
    const satisfiedSet = new Set(
      satisfactions.filter((s) => s.is_satisfied).map((s) => s.dimension_name)
    );

    for (const dim of dims) {
      const failures = failureCounts.get(dim.name) ?? 0;
      const progress = this.computeActualProgress(dim);

      // Condition 1: high failure count + no meaningful progress (< 10%)
      if (failures >= 3 && progress < 0.10) {
        const currentThreshold = getNumericThresholdValueForProposal(dim);
        if (currentThreshold !== null) {
          const proposedThreshold = currentThreshold * 0.8; // propose 20% reduction
          proposals.push({
            goal_id: goal.id,
            dimension_name: dim.name,
            current_threshold: currentThreshold,
            proposed_threshold: proposedThreshold,
            reason: "high_failure_no_progress",
            evidence: `${failures} failures with ${Math.round(progress * 100)}% progress toward threshold`,
          });
        }
      }

      // Condition 3: Resource undershoot — tasks complete much faster than estimated
      // but goal progress is stagnant, suggesting the threshold may be too ambitious.
      // Requires task cost history (actual_elapsed_ms + estimated_duration_ms fields).
      {
        const rawHistory = this.stateManager.readRaw(`tasks/${goal.id}/task-history.json`);
        const taskHistory = Array.isArray(rawHistory) ? rawHistory : [];

        const dimHistory = taskHistory.filter(
          (h: Record<string, unknown>) =>
            h.primary_dimension === dim.name &&
            typeof h.actual_elapsed_ms === "number" &&
            typeof h.estimated_duration_ms === "number" &&
            (h.estimated_duration_ms as number) > 0
        ) as Array<{ actual_elapsed_ms: number; estimated_duration_ms: number }>;

        if (dimHistory.length >= 3) {
          const avgEstimated =
            dimHistory.reduce((s, h) => s + h.estimated_duration_ms, 0) / dimHistory.length;
          const avgActual =
            dimHistory.reduce((s, h) => s + h.actual_elapsed_ms, 0) / dimHistory.length;

          if (avgActual < 0.5 * avgEstimated && progress < 0.5) {
            const currentThreshold = getNumericThresholdValueForProposal(dim);
            if (
              currentThreshold !== null &&
              !proposals.some((p) => p.dimension_name === dim.name)
            ) {
              proposals.push({
                goal_id: goal.id,
                dimension_name: dim.name,
                current_threshold: currentThreshold,
                proposed_threshold: currentThreshold * 0.85,
                reason: "resource_undershoot",
                evidence: `${dimHistory.length} tasks averaged ${Math.round(avgActual)}ms vs ${Math.round(avgEstimated)}ms estimated; goal progress at ${Math.round(progress * 100)}%`,
              });
            }
          }
        }
      }

      // Condition 2: bottleneck — all other dimensions satisfied, this one is far (< 30%)
      const othersAllSatisfied = dims
        .filter((d) => d.name !== dim.name)
        .every((d) => satisfiedSet.has(d.name));

      if (othersAllSatisfied && !satisfiedSet.has(dim.name) && progress < 0.30) {
        const currentThreshold = getNumericThresholdValueForProposal(dim);
        if (currentThreshold !== null && !proposals.some((p) => p.dimension_name === dim.name)) {
          const proposedThreshold = currentThreshold * 0.8;
          proposals.push({
            goal_id: goal.id,
            dimension_name: dim.name,
            current_threshold: currentThreshold,
            proposed_threshold: proposedThreshold,
            reason: "bottleneck_dimension",
            evidence: `All other dimensions satisfied; this dimension at ${Math.round(progress * 100)}% progress`,
          });
        }
      }
    }

    return proposals;
  }

  /**
   * Judge completion of an entire goal tree by checking all children recursively.
   * Non-leaf nodes are complete when all children are completed or cancelled(merged).
   *
   * @param rootId The ID of the root goal of the tree.
   * @returns CompletionJudgment for the root node.
   */
  judgeTreeCompletion(rootId: string): CompletionJudgment {
    const goal = this.stateManager.loadGoal(rootId);
    if (goal === null) {
      return {
        is_complete: false,
        blocking_dimensions: [],
        low_confidence_dimensions: [],
        needs_verification_task: false,
        checked_at: new Date().toISOString(),
      };
    }

    // Leaf node (no children): delegate to existing isGoalComplete
    if (!goal.children_ids || goal.children_ids.length === 0) {
      return this.isGoalComplete(goal);
    }

    // Non-leaf node: check all children recursively
    const blockingDimensions: string[] = [];
    const lowConfidenceDimensions: string[] = [];
    let needsVerification = false;

    for (const childId of goal.children_ids) {
      const child = this.stateManager.loadGoal(childId);

      // Missing child is treated as blocking
      if (child === null) {
        blockingDimensions.push(childId);
        continue;
      }

      // Cancelled children count as complete (covers "merged" prune reason)
      if (child.status === "cancelled") {
        continue;
      }

      // Recurse into child
      const childJudgment = this.judgeTreeCompletion(childId);

      if (!childJudgment.is_complete) {
        // Aggregate child's blocking and low-confidence dimensions
        for (const dim of childJudgment.blocking_dimensions) {
          if (!blockingDimensions.includes(dim)) {
            blockingDimensions.push(dim);
          }
        }
        for (const dim of childJudgment.low_confidence_dimensions) {
          if (!lowConfidenceDimensions.includes(dim)) {
            lowConfidenceDimensions.push(dim);
          }
        }
      }

      if (childJudgment.needs_verification_task) {
        needsVerification = true;
      }
    }

    const isComplete = blockingDimensions.length === 0 && lowConfidenceDimensions.length === 0;

    return {
      is_complete: isComplete,
      blocking_dimensions: blockingDimensions,
      low_confidence_dimensions: lowConfidenceDimensions,
      needs_verification_task: needsVerification,
      checked_at: new Date().toISOString(),
    };
  }

  /**
   * Propagate subgoal completion to the parent goal's matching dimension.
   *
   * Phase 2: supports dimension_mapping for aggregation-based propagation.
   * - If any subgoal dimension has dimension_mapping set, use aggregation path.
   * - Mixed: mapped dimensions use aggregation; unmapped dimensions fall back to name matching.
   * - Backwards compatible: if no dimensions have dimension_mapping, behaves like MVP.
   *
   * @param subgoalId The subgoal's ID (used for name matching in MVP path).
   * @param parentGoalId The parent goal's ID to update.
   * @param subgoalDimensions Optional subgoal dimensions for aggregation mapping.
   *   When omitted, falls back to MVP name-based matching only.
   */
  propagateSubgoalCompletion(
    subgoalId: string,
    parentGoalId: string,
    subgoalDimensions?: import("./types/goal.js").Dimension[]
  ): void {
    const parentGoal = this.stateManager.loadGoal(parentGoalId);
    if (parentGoal === null) {
      throw new Error(
        `propagateSubgoalCompletion: parent goal "${parentGoalId}" not found`
      );
    }

    const now = new Date().toISOString();

    // Phase 2: if subgoalDimensions are provided and any has dimension_mapping, use aggregation path
    if (subgoalDimensions && subgoalDimensions.length > 0) {
      const mappedDims = subgoalDimensions.filter((d) => d.dimension_mapping !== null);
      const unmappedDims = subgoalDimensions.filter((d) => d.dimension_mapping === null);

      // Process mapped dimensions: group by parent_dimension
      const parentDimUpdates = new Map<string, number>();

      if (mappedDims.length > 0) {
        // Group subgoal dimensions by target parent_dimension
        const grouped = new Map<string, import("./types/goal.js").Dimension[]>();
        for (const dim of mappedDims) {
          const mapping = dim.dimension_mapping!;
          const existing = grouped.get(mapping.parent_dimension) ?? [];
          existing.push(dim);
          grouped.set(mapping.parent_dimension, existing);
        }

        // Compute aggregated value for each parent dimension
        for (const [parentDimName, dims] of grouped) {
          const aggregation = dims[0]!.dimension_mapping!.aggregation;

          const numericValues: number[] = [];
          const fulfillmentRatios: number[] = [];

          for (const dim of dims) {
            const cv = dim.current_value;
            if (typeof cv === "number") {
              numericValues.push(cv);
            } else if (typeof cv === "boolean") {
              numericValues.push(cv ? 1 : 0);
            } else if (typeof cv === "string") {
              const parsed = Number(cv);
              if (!isNaN(parsed)) {
                numericValues.push(parsed);
              } else {
                // Non-numeric in avg mode: skip with warning
                if (aggregation === "avg") {
                  console.warn(
                    `propagateSubgoalCompletion: skipping non-numeric current_value "${cv}" for dimension "${dim.name}" in avg aggregation`
                  );
                }
              }
            }
            // For all_required: also compute fulfillment ratio
            if (aggregation === "all_required") {
              const progress = this.computeActualProgress(dim);
              fulfillmentRatios.push(progress);
            }
          }

          const thresholds = dims.map((d) => {
            const th = d.threshold;
            if (th.type === "min") return th.value;
            if (th.type === "max") return th.value;
            if (th.type === "range") return th.high;
            return 1;
          });

          const aggregated =
            aggregation === "all_required"
              ? aggregateValues(fulfillmentRatios, aggregation, thresholds)
              : aggregateValues(numericValues, aggregation, thresholds);

          parentDimUpdates.set(parentDimName, aggregated);
        }
      }

      // Build updated dimensions array for the parent goal
      let updatedDimensions = parentGoal.dimensions.map((d) => {
        if (parentDimUpdates.has(d.name)) {
          return { ...d, current_value: parentDimUpdates.get(d.name)!, last_updated: now };
        }
        return d;
      });

      // Process unmapped dimensions: fall back to name-based matching (MVP path)
      for (const unmappedDim of unmappedDims) {
        const matchedIndex = updatedDimensions.findIndex(
          (d) => d.name === unmappedDim.name || d.name.includes(unmappedDim.name)
        );
        if (matchedIndex !== -1) {
          const matchedDim = updatedDimensions[matchedIndex]!;
          const satisfiedValue = getSatisfiedValue(matchedDim);
          updatedDimensions = updatedDimensions.map((d, i) =>
            i === matchedIndex ? { ...d, current_value: satisfiedValue, last_updated: now } : d
          );
        }
      }

      this.stateManager.saveGoal({
        ...parentGoal,
        dimensions: updatedDimensions,
        updated_at: now,
      });
      return;
    }

    // MVP path: name-based matching (backwards compatible)
    const matchedDimIndex = parentGoal.dimensions.findIndex(
      (d) => d.name === subgoalId || d.name.includes(subgoalId)
    );

    if (matchedDimIndex === -1) {
      // No matching dimension — nothing to propagate
      return;
    }

    const matchedDim = parentGoal.dimensions[matchedDimIndex]!;

    // Set current_value to threshold value so isDimensionSatisfied returns true
    const satisfiedValue = getSatisfiedValue(matchedDim);

    const updatedDimensions = parentGoal.dimensions.map((d, i) =>
      i === matchedDimIndex
        ? { ...d, current_value: satisfiedValue, last_updated: now }
        : d
    );

    this.stateManager.saveGoal({
      ...parentGoal,
      dimensions: updatedDimensions,
      updated_at: now,
    });
  }
}

// ─── Pure Helper: aggregateValues ───

/**
 * Aggregate an array of numeric values using the specified strategy.
 *
 * @param values - Numeric values to aggregate.
 * @param aggregation - Strategy: "min" | "avg" | "max" | "all_required".
 * @param thresholds - For "all_required": fulfillment ratios are already computed (values = ratios).
 * @returns Aggregated value, or 0 if values array is empty.
 */
export function aggregateValues(
  values: number[],
  aggregation: "min" | "avg" | "max" | "all_required",
  thresholds?: number[]
): number {
  if (values.length === 0) return 0;

  switch (aggregation) {
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "avg": {
      const sum = values.reduce((acc, v) => acc + v, 0);
      return sum / values.length;
    }
    case "all_required":
      // values are fulfillment ratios (0..1); return the minimum ratio
      // (parent is "complete" only if all ratios = 1.0, expressed as min)
      return Math.min(...values);
  }
}

// ─── Helpers (non-exported) ───

function toNumber(value: number | string | boolean | null): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function isTruthy(value: number | string | boolean | null): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  return false;
}

function toNumberOrNull(value: number | string | boolean | null): number | null {
  if (value === null) return null;
  return toNumber(value);
}

/**
 * Extract a representative numeric threshold value for the DimensionSatisfaction schema.
 * Returns null for "present" (no numeric threshold).
 */
function getNumericThresholdValue(dim: Dimension): number | null {
  const { threshold } = dim;
  switch (threshold.type) {
    case "min":
      return threshold.value;
    case "max":
      return threshold.value;
    case "range":
      return threshold.high; // use upper bound as representative
    case "present":
      return null;
    case "match":
      return typeof threshold.value === "number" ? threshold.value : null;
  }
}

/**
 * Returns the numeric threshold for adjustment proposals.
 * Only applicable to numeric thresholds (min/max/range).
 */
function getNumericThresholdValueForProposal(dim: Dimension): number | null {
  const { threshold } = dim;
  switch (threshold.type) {
    case "min":
      return threshold.value;
    case "max":
      return threshold.value;
    case "range":
      return threshold.high;
    case "present":
    case "match":
      return null; // adjustment not meaningful for binary thresholds
  }
}

/**
 * Compute the value that fully satisfies the threshold (for propagation).
 */
function getSatisfiedValue(dim: Dimension): number | string | boolean | null {
  const { threshold } = dim;
  switch (threshold.type) {
    case "min":
      return threshold.value;
    case "max":
      return threshold.value;
    case "range":
      return (threshold.low + threshold.high) / 2;
    case "present":
      return true;
    case "match":
      return threshold.value;
  }
}
