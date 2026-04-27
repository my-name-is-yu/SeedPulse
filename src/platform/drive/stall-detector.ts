import type { StateManager } from "../../base/state/state-manager.js";
import type { ProgressPredictor } from "./progress-predictor.js";
import { StallReportSchema, StallStateSchema } from "../../base/types/stall.js";
import type { StallReport, StallState, StallAnalysis } from "../../base/types/stall.js";
import type { CharacterConfig } from "../../base/types/character.js";
import { DEFAULT_CHARACTER_CONFIG } from "../../base/types/character.js";
import { analyzeStallCause as analyzeGapHistory } from "./stall-detector/analysis.js";
import { detectRepetitivePatterns as detectTaskRepetition } from "./stall-detector/repetitive.js";
import {
  computeTimeThreshold,
  getAdjustedN,
  isZeroProgress,
} from "./stall-detector/thresholds.js";

// ─── Minimum score-improvement delta to reset stall detection ───
// Improvements smaller than this are treated as noise (no reset).
const MIN_IMPROVEMENT_DELTA = 0.05;

// ─── Achieved-dimension gap threshold ───
// When ALL recent window entries are at or below this value, the dimension is
// considered achieved (satisficed) and should not be flagged as stalled.
// Aligned with SatisficingJudge: a gap this small means the dimension value
// effectively meets its threshold. Kept separate from MIN_IMPROVEMENT_DELTA
// because the two concepts are distinct: noise vs. completion.
const ACHIEVED_GAP_THRESHOLD = 0.02;

// ─── Stall thresholds ───

const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const ESCALATION_CAP = 3;

// ─── Decay factor constants ───

const DECAY_FACTOR_STALLED = 0.6;
const RECOVERY_SCHEDULE: Array<{ loops: number; factor: number }> = [
  { loops: 0, factor: 0.75 },
  { loops: 2, factor: 0.9 },
  { loops: 4, factor: 1.0 },
];

// ─── Exported interfaces ───

export interface StallTaskHistoryEntry {
  strategy_id: string | null;
  output: string;
}

export interface RepetitivePatternResult {
  isRepetitive: boolean;
  pattern: 'identical_actions' | 'oscillating' | 'no_change' | null;
  confidence: number;
}

/**
 * StallDetector detects stalls (circuit breaker) in the PulSeed orchestrator loop.
 * Supports 4 stall types: dimension_stall, time_exceeded, consecutive_failure, global_stall.
 */
export class StallDetector {
  private readonly stateManager: StateManager;
  private readonly characterConfig: CharacterConfig;
  private readonly predictor?: ProgressPredictor;

  constructor(stateManager: StateManager, characterConfig?: CharacterConfig, predictor?: ProgressPredictor) {
    this.stateManager = stateManager;
    this.characterConfig = characterConfig ?? DEFAULT_CHARACTER_CONFIG;
    this.predictor = predictor;
  }

  private getAdjustedN(category?: string): number {
    return getAdjustedN(this.characterConfig, category);
  }

  private isZeroProgress(gapHistory: Array<{ normalized_gap: number }>): boolean {
    return isZeroProgress(gapHistory);
  }

  /**
   * Detect repetitive patterns in task execution history.
   * Checks for: identical_actions, oscillating, no_change patterns.
   */
  detectRepetitivePatterns(taskHistory: StallTaskHistoryEntry[]): RepetitivePatternResult {
    return detectTaskRepetition(taskHistory);
  }

  // ─── Public Methods ───

  /**
   * Check if a single dimension's gap has not improved for N loops.
   * N is determined by the feedbackCategory (immediate/medium_term/long_term).
   */
  checkDimensionStall(
    goalId: string,
    dimensionName: string,
    gapHistory: Array<{ normalized_gap: number }>,
    feedbackCategory?: string
  ): StallReport | null {
    const n = this.getAdjustedN(feedbackCategory);

    if (gapHistory.length < n + 1) {
      // Not enough history to determine a stall
      return null;
    }

    // Zero-progress detection: after confirming sufficient history,
    // check if recent entries show no progress at all
    if (this.isZeroProgress(gapHistory)) {
      return StallReportSchema.parse({
        stall_type: "dimension_stall",
        goal_id: goalId,
        dimension_name: dimensionName,
        task_id: null,
        detected_at: new Date().toISOString(),
        escalation_level: 0,
        suggested_cause: "approach_failure",
        decay_factor: DECAY_FACTOR_STALLED,
      });
    }

    const recent = gapHistory.slice(-n - 1);
    const oldest = recent[0].normalized_gap;
    const latest = recent[recent.length - 1].normalized_gap;

    // Achieved dimensions (all window entries near zero) are not stalled — they're done.
    // Checking the full window prevents a single noisy data point from suppressing a real stall.
    const isAchieved = recent.every(e => e.normalized_gap <= ACHIEVED_GAP_THRESHOLD);
    if (isAchieved) return null;

    // "No improvement" = latest gap has not decreased by at least MIN_IMPROVEMENT_DELTA
    // Trivial improvements (< 0.05) are treated as noise and do not reset stall detection.
    if (oldest - latest >= MIN_IMPROVEMENT_DELTA) {
      // Meaningful improvement — check predictor for early warning before returning null
      return this.checkPredictedStall(goalId, dimensionName, recent) ?? null;
    }

    return StallReportSchema.parse({
      stall_type: "dimension_stall",
      goal_id: goalId,
      dimension_name: dimensionName,
      task_id: null,
      detected_at: new Date().toISOString(),
      escalation_level: 0,
      suggested_cause: "approach_failure",
      decay_factor: DECAY_FACTOR_STALLED,
    });
  }

  /**
   * Check if a task has exceeded its time threshold (estimate × 2, or default by category).
   */
  checkTimeExceeded(task: {
    task_id?: string;
    goal_id: string;
    estimated_duration?: { value: number; unit: string } | null;
    started_at?: string | null;
    task_category?: string;
  }): StallReport | null {
    if (!task.started_at) {
      return null;
    }

    const startedAt = new Date(task.started_at);
    const now = new Date();
    const elapsedMs = now.getTime() - startedAt.getTime();
    const elapsedHours = elapsedMs / (1000 * 60 * 60);

    const thresholdHours = this.computeTimeThreshold(task.estimated_duration, task.task_category);

    if (elapsedHours <= thresholdHours) {
      return null;
    }

    return StallReportSchema.parse({
      stall_type: "time_exceeded",
      goal_id: task.goal_id,
      dimension_name: null,
      task_id: task.task_id ?? null,
      detected_at: new Date().toISOString(),
      escalation_level: 0,
      suggested_cause: "external_dependency",
      decay_factor: DECAY_FACTOR_STALLED,
    });
  }

  /**
   * Check if a dimension has had 3+ consecutive failures.
   */
  checkConsecutiveFailures(
    goalId: string,
    dimensionName: string,
    consecutiveFailureCount: number
  ): StallReport | null {
    if (consecutiveFailureCount < CONSECUTIVE_FAILURE_THRESHOLD) {
      return null;
    }

    return StallReportSchema.parse({
      stall_type: "consecutive_failure",
      goal_id: goalId,
      dimension_name: dimensionName,
      task_id: null,
      detected_at: new Date().toISOString(),
      escalation_level: 0,
      suggested_cause: "approach_failure",
      decay_factor: DECAY_FACTOR_STALLED,
    });
  }

  /**
   * Check if ALL dimensions show no improvement for loopThreshold loops.
   * Returns null if any dimension improved.
   */
  checkGlobalStall(
    goalId: string,
    allDimensionGaps: Map<string, Array<{ normalized_gap: number }>>,
    loopThreshold = this.getAdjustedN()
  ): StallReport | null {
    if (allDimensionGaps.size === 0) {
      return null;
    }

    let zeroProgressCount = 0;
    let achievedCount = 0;

    for (const [, gapHistory] of allDimensionGaps) {
      if (gapHistory.length < loopThreshold + 1) {
        // Not enough data for this dimension — treat as not stalled (insufficient evidence)
        return null;
      }

      if (this.isZeroProgress(gapHistory)) {
        zeroProgressCount++;
        continue;
      }

      const recent = gapHistory.slice(-loopThreshold - 1);
      const oldest = recent[0].normalized_gap;
      const latest = recent[recent.length - 1].normalized_gap;

      // Skip achieved dimensions — they're done, not stalled.
      // A near-complete goal must not be flagged as "goal_infeasible".
      const isAchieved = recent.every(e => e.normalized_gap <= ACHIEVED_GAP_THRESHOLD);
      if (isAchieved) {
        achievedCount++;
        continue;
      }

      if (oldest - latest >= MIN_IMPROVEMENT_DELTA) {
        // At least one dimension improved meaningfully — not a global stall
        return null;
      }
    }

    // If all dimensions are achieved (or zero-progress with all achieved), no stall
    if (achievedCount + zeroProgressCount === allDimensionGaps.size && achievedCount > 0) {
      return null;
    }

    // Only trigger zero-progress global stall if ALL dimensions are zero-progress
    if (zeroProgressCount === allDimensionGaps.size) {
      return StallReportSchema.parse({
        stall_type: "global_stall",
        goal_id: goalId,
        dimension_name: null,
        task_id: null,
        detected_at: new Date().toISOString(),
        escalation_level: 0,
        suggested_cause: "goal_infeasible",
        decay_factor: DECAY_FACTOR_STALLED,
      });
    }

    // All remaining (non-achieved) dimensions are non-improving (normal stall path)
    return StallReportSchema.parse({
      stall_type: "global_stall",
      goal_id: goalId,
      dimension_name: null,
      task_id: null,
      detected_at: new Date().toISOString(),
      escalation_level: 0,
      suggested_cause: "goal_infeasible",
      decay_factor: DECAY_FACTOR_STALLED,
    });
  }

  /**
   * Classify the root cause of a stall based on stall type and goal context.
   */
  classifyStallCause(
    stallType: string,
    goal: { dimensions?: Array<{ confidence?: number }> }
  ): string {
    // Check for low-confidence dimensions → information_deficit
    const hasLowConfidence = goal.dimensions?.some(
      (d) => d.confidence !== undefined && d.confidence < 0.5
    );

    if (hasLowConfidence) {
      return "information_deficit";
    }

    switch (stallType) {
      case "dimension_stall":
        return "approach_failure";

      case "time_exceeded":
        return "external_dependency";

      case "consecutive_failure":
        return "approach_failure";

      case "global_stall":
        return "goal_infeasible";

      default:
        return "approach_failure";
    }
  }

  /**
   * Analyze the root cause of a stall from gap history.
   * Returns a StallAnalysis with cause, confidence, evidence, and recommended_action.
   *
   * Patterns:
   *   - oscillating (high variance, stable mean) → parameter_issue → REFINE
   *   - flat (near-zero variance, near-zero delta) → strategy_wrong → PIVOT
   *   - diverging (monotonically increasing trend) → goal_unreachable → ESCALATE
   *   - fallback (unclear) → strategy_wrong → PIVOT
   */
  analyzeStallCause(gapHistory: Array<{ normalized_gap: number }>): StallAnalysis {
    return analyzeGapHistory(gapHistory);
  }

  /**
   * Compute the decay_factor for the dissatisfaction drive score.
   * - Stalled: 0.6
   * - Recently recovered: follows a schedule (0.75 → 0.90 → 1.0)
   * - Normal (not stalled, no recovery): 1.0
   */
  computeDecayFactor(isStalled: boolean, loopsSinceRecovery: number | null): number {
    if (isStalled) {
      return DECAY_FACTOR_STALLED;
    }

    if (loopsSinceRecovery === null) {
      // Not stalled, no recent recovery
      return 1.0;
    }

    // Recovery schedule: find the highest threshold that has been reached
    let factor = 1.0;
    for (const { loops, factor: scheduledFactor } of RECOVERY_SCHEDULE) {
      if (loopsSinceRecovery >= loops) {
        factor = scheduledFactor;
      }
    }

    return factor;
  }

  /**
   * Returns true if the plateau_until date is in the future (stall detection suppressed).
   */
  isSuppressed(plateauUntil: string | null): boolean {
    if (plateauUntil === null) {
      return false;
    }

    const until = new Date(plateauUntil);
    const now = new Date();
    return now < until;
  }

  /**
   * Load the StallState for a goal from StateManager.
   * Returns a default state if not found.
   */
  async getStallState(goalId: string): Promise<StallState> {
    const raw = await this.stateManager.readRaw(`stalls/${goalId}.json`);
    if (raw === null) {
      return StallStateSchema.parse({
        goal_id: goalId,
        dimension_escalation: {},
        global_escalation: 0,
        decay_factors: {},
        recovery_loops: {},
      });
    }

    return StallStateSchema.parse(raw);
  }

  /**
   * Persist the StallState for a goal via StateManager.
   */
  async saveStallState(goalId: string, state: StallState): Promise<void> {
    const parsed = StallStateSchema.parse(state);
    await this.stateManager.writeRaw(`stalls/${goalId}.json`, parsed);
  }

  /**
   * Get the current escalation level for a dimension (default: 0).
   */
  async getEscalationLevel(goalId: string, dimensionName: string): Promise<number> {
    const state = await this.getStallState(goalId);
    return state.dimension_escalation[dimensionName] ?? 0;
  }

  /**
   * Increment the escalation level for a dimension (cap at ESCALATION_CAP).
   * Persists and returns the new level.
   */
  async incrementEscalation(goalId: string, dimensionName: string): Promise<number> {
    const state = await this.getStallState(goalId);
    const current = state.dimension_escalation[dimensionName] ?? 0;
    const next = Math.min(current + 1, ESCALATION_CAP);
    state.dimension_escalation[dimensionName] = next;
    await this.saveStallState(goalId, state);
    return next;
  }

  /**
   * Reset the escalation level for a dimension to 0 and persist.
   */
  async resetEscalation(goalId: string, dimensionName: string): Promise<void> {
    const state = await this.getStallState(goalId);
    state.dimension_escalation[dimensionName] = 0;
    await this.saveStallState(goalId, state);
  }


  // ─── Private Helpers ───

  /**
   * Run ProgressPredictor on gap history and return a predicted stall report if warranted.
   * Returns null if no predictor, insufficient confidence, or no predicted stall.
   */
  private checkPredictedStall(
    goalId: string,
    dimensionName: string,
    gapHistory: Array<{ normalized_gap: number }>
  ): StallReport | null {
    if (!this.predictor) return null;

    const scores = gapHistory.map(e => e.normalized_gap);
    const prediction = this.predictor.predict(scores);
    if (!prediction || prediction.confidence <= 0.6) return null;

    if (prediction.trend === "stable") {
      return StallReportSchema.parse({
        stall_type: "predicted_plateau",
        goal_id: goalId,
        dimension_name: dimensionName,
        task_id: null,
        detected_at: new Date().toISOString(),
        escalation_level: 0,
        suggested_cause: "approach_failure",
        decay_factor: 0.3,
      });
    }

    if (prediction.trend === "worsening") {
      return StallReportSchema.parse({
        stall_type: "predicted_regression",
        goal_id: goalId,
        dimension_name: dimensionName,
        task_id: null,
        detected_at: new Date().toISOString(),
        escalation_level: 0,
        suggested_cause: "approach_failure",
        decay_factor: 0.5,
      });
    }

    return null;
  }

  /**
   * Compute the time threshold in hours for a task.
   */
  private computeTimeThreshold(
    estimatedDuration: { value: number; unit: string } | null | undefined,
    taskCategory?: string
  ): number {
    return computeTimeThreshold(estimatedDuration, taskCategory);
  }
}
