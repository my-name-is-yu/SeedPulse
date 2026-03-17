import { StrategyManager } from "./strategy/strategy-manager.js";
import { StateManager } from "./state-manager.js";
import { StrategySchema, PortfolioSchema } from "./types/strategy.js";
import type { Strategy, Portfolio, WaitStrategy } from "./types/strategy.js";
import { PortfolioConfigSchema } from "./types/portfolio.js";
import type {
  PortfolioConfig,
  EffectivenessRecord,
  TaskSelectionResult,
  RebalanceTrigger,
  RebalanceResult,
  AllocationAdjustment,
} from "./types/portfolio.js";

/**
 * PortfolioManager provides portfolio-level orchestration on top of StrategyManager.
 *
 * Responsibilities:
 * - Deterministic task-strategy selection (which strategy should generate the next task)
 * - Effectiveness measurement per strategy (gap delta / sessions consumed)
 * - Rebalance triggering and execution (allocation adjustment, termination)
 * - Wait-strategy lifecycle management
 *
 * PortfolioManager does NOT replace StrategyManager — it coordinates across strategies.
 */
export class PortfolioManager {
  private readonly strategyManager: StrategyManager;
  private readonly stateManager: StateManager;
  private readonly config: PortfolioConfig;

  /** goalId → timestamp of last rebalance */
  private readonly lastRebalanceTime: Map<string, number> = new Map();

  /** goalId → list of past rebalance results */
  private readonly rebalanceHistory: Map<string, RebalanceResult[]> =
    new Map();

  /** strategyId → timestamp of last task completion */
  private readonly lastTaskCompletionByStrategy: Map<string, number> =
    new Map();

  constructor(
    strategyManager: StrategyManager,
    stateManager: StateManager,
    config?: Partial<PortfolioConfig>
  ) {
    this.strategyManager = strategyManager;
    this.stateManager = stateManager;
    this.config = PortfolioConfigSchema.parse(config ?? {});
  }

  // ─── Public Methods ───

  /**
   * Select the next strategy that should generate a task for the given goal.
   *
   * Uses a deterministic "wait ratio" approach: for each active strategy,
   * compute (time since last task completion) / allocation. The strategy
   * with the highest ratio is the most "starved" and gets selected next.
   *
   * WaitStrategy instances are skipped (they do not generate tasks).
   * Returns null if no eligible active strategies exist.
   */
  selectNextStrategyForTask(goalId: string): TaskSelectionResult | null {
    const portfolio = this.strategyManager.getPortfolio(goalId);
    if (!portfolio) return null;

    const activeStrategies = portfolio.strategies.filter(
      (s) => s.state === "active" || s.state === "evaluating"
    );

    // Filter out WaitStrategy instances
    const eligible = activeStrategies.filter((s) => !this.isWaitStrategy(s));
    if (eligible.length === 0) return null;

    const now = Date.now();
    const portfolioCreatedAt = new Date(
      portfolio.last_rebalanced_at
    ).getTime();

    let bestStrategy: Strategy | null = null;
    let bestRatio = -Infinity;

    for (const strategy of eligible) {
      const lastCompletion =
        this.lastTaskCompletionByStrategy.get(strategy.id) ??
        (strategy.started_at
          ? new Date(strategy.started_at).getTime()
          : portfolioCreatedAt);

      const elapsed = now - lastCompletion;
      const allocation = strategy.allocation > 0 ? strategy.allocation : 0.01;
      const ratio = elapsed / allocation;

      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestStrategy = strategy;
      }
    }

    if (!bestStrategy) return null;

    return {
      strategy_id: bestStrategy.id,
      reason: `Highest wait ratio (${bestRatio.toFixed(0)}ms/alloc) — most starved for task execution`,
      wait_ratio: bestRatio,
    };
  }

  /**
   * Calculate effectiveness records for all active strategies of a goal.
   *
   * effectiveness_score = gap_delta_attributed / sessions_consumed
   *
   * Uses dimension-target matching (method 2): sum gap changes in each
   * strategy's target_dimensions and attribute them to that strategy.
   *
   * Requires a minimum number of task completions (default 3) before
   * producing a non-null score.
   */
  calculateEffectiveness(goalId: string): EffectivenessRecord[] {
    const portfolio = this.strategyManager.getPortfolio(goalId);
    if (!portfolio) return [];

    const activeStrategies = portfolio.strategies.filter(
      (s) => s.state === "active" || s.state === "evaluating"
    );

    const now = new Date().toISOString();
    const records: EffectivenessRecord[] = [];

    for (const strategy of activeStrategies) {
      const sessionsConsumed = strategy.tasks_generated.length;
      const gapDelta = this.calculateGapDeltaForStrategy(strategy, goalId);

      let score: number | null = null;
      if (sessionsConsumed >= this.config.effectiveness_min_tasks) {
        score =
          sessionsConsumed > 0 ? gapDelta / sessionsConsumed : 0;
      }

      records.push({
        strategy_id: strategy.id,
        gap_delta_attributed: gapDelta,
        sessions_consumed: sessionsConsumed,
        effectiveness_score: score,
        last_calculated_at: now,
      });
    }

    return records;
  }

  /**
   * Check whether a rebalance is needed for the given goal.
   *
   * Two trigger types:
   * - periodic: rebalance_interval has elapsed since last rebalance
   * - score_change: any effectiveness_score changed 50%+ since last rebalance
   *
   * Returns the trigger or null.
   */
  shouldRebalance(goalId: string): RebalanceTrigger | null {
    const now = Date.now();

    // Check periodic trigger
    const lastRebalance = this.lastRebalanceTime.get(goalId) ?? 0;
    const intervalMs = this.config.rebalance_interval_hours * 60 * 60 * 1000;
    if (lastRebalance > 0 && now - lastRebalance >= intervalMs) {
      return {
        type: "periodic",
        strategy_id: null,
        details: `Rebalance interval (${this.config.rebalance_interval_hours}h) has elapsed`,
      };
    }

    // Check score change trigger
    const currentRecords = this.calculateEffectiveness(goalId);
    const history = this.rebalanceHistory.get(goalId) ?? [];
    if (history.length === 0) return null;

    const lastResult = history[history.length - 1];

    // Find strategies that existed at last rebalance and compare scores
    for (const record of currentRecords) {
      if (record.effectiveness_score === null) continue;

      // Look up previous score from portfolio at last rebalance time
      const portfolio = this.strategyManager.getPortfolio(goalId);
      if (!portfolio) continue;

      const strategy = portfolio.strategies.find(
        (s) => s.id === record.strategy_id
      );
      if (!strategy || strategy.effectiveness_score === null) continue;

      const previousScore = strategy.effectiveness_score;
      if (previousScore === 0) continue;

      const changeRatio = Math.abs(
        (record.effectiveness_score - previousScore) / previousScore
      );
      if (changeRatio >= 0.5) {
        return {
          type: "score_change",
          strategy_id: record.strategy_id,
          details: `Effectiveness score changed by ${(changeRatio * 100).toFixed(0)}% (${previousScore.toFixed(3)} → ${record.effectiveness_score.toFixed(3)})`,
        };
      }
    }

    return null;
  }

  /**
   * Execute a rebalance for the given goal based on the trigger.
   *
   * Logic (design doc sec 6.3):
   * - All scores null: no change
   * - Score ratio < 2.0: no change
   * - Score ratio >= 2.0: increase high-performer allocation, decrease low-performer
   *   (respect min 0.1)
   * - Check termination conditions and terminate if met
   * - If all terminated: set new_generation_needed = true
   * - Redistribute terminated strategy allocation proportionally
   */
  rebalance(goalId: string, trigger: RebalanceTrigger): RebalanceResult {
    const now = new Date().toISOString();
    const records = this.calculateEffectiveness(goalId);
    const portfolio = this.strategyManager.getPortfolio(goalId);

    const result: RebalanceResult = {
      triggered_by: trigger.type,
      timestamp: now,
      adjustments: [],
      terminated_strategies: [],
      new_generation_needed: false,
    };

    if (!portfolio) {
      this.recordRebalance(goalId, result);
      return result;
    }

    const activeStrategies = portfolio.strategies.filter(
      (s) => s.state === "active" || s.state === "evaluating"
    );

    // Check termination conditions first
    for (const strategy of activeStrategies) {
      if (this.checkTermination(strategy, records)) {
        this.strategyManager.updateState(strategy.id, "terminated");
        result.terminated_strategies.push(strategy.id);
      }
    }

    // Get remaining active strategies after terminations
    const remainingStrategies = activeStrategies.filter(
      (s) => !result.terminated_strategies.includes(s.id)
    );

    // If all strategies terminated, signal new generation needed
    if (
      remainingStrategies.length === 0 &&
      result.terminated_strategies.length > 0
    ) {
      result.new_generation_needed = true;
      this.recordRebalance(goalId, result);
      return result;
    }

    // Redistribute terminated strategies' allocation if any were terminated
    if (result.terminated_strategies.length > 0 && remainingStrategies.length > 0) {
      const freedAllocation = result.terminated_strategies.reduce(
        (sum, sid) => {
          const s = activeStrategies.find((st) => st.id === sid);
          return sum + (s?.allocation ?? 0);
        },
        0
      );
      this.redistributeAllocation(
        goalId,
        remainingStrategies,
        records,
        freedAllocation,
        result
      );
    }

    // Score-based rebalancing for remaining strategies
    const scoredRecords = records.filter(
      (r) =>
        r.effectiveness_score !== null &&
        remainingStrategies.some((s) => s.id === r.strategy_id)
    );

    if (scoredRecords.length >= 2) {
      const scores = scoredRecords.map((r) => r.effectiveness_score!);
      const maxScore = Math.max(...scores);
      const minScore = Math.min(...scores);

      if (minScore > 0 && maxScore / minScore >= this.config.score_ratio_threshold) {
        this.adjustAllocations(goalId, remainingStrategies, scoredRecords, result);
      }
    }

    this.recordRebalance(goalId, result);
    return result;
  }

  /**
   * Check whether a strategy should be terminated.
   *
   * Three conditions (design doc sec 6.4):
   * 1. Lowest effectiveness score for 3 consecutive rebalances at min allocation
   * 2. consecutive_stall_count >= 3
   * 3. Resource consumption > 2x estimate
   */
  checkTermination(
    strategy: Strategy,
    records: EffectivenessRecord[]
  ): boolean {
    // Condition 2: consecutive stall count
    if (strategy.consecutive_stall_count >= this.config.termination_stall_count) {
      return true;
    }

    // Condition 3: resource overconsumption
    const sessionsConsumed = strategy.tasks_generated.length;
    const estimatedSessions = strategy.resource_estimate.sessions;
    if (
      estimatedSessions > 0 &&
      sessionsConsumed >
        estimatedSessions * this.config.termination_resource_multiplier
    ) {
      return true;
    }

    // Condition 1: lowest score for N consecutive rebalances at min allocation
    if (strategy.allocation <= this.config.min_allocation) {
      const record = records.find((r) => r.strategy_id === strategy.id);
      if (record?.effectiveness_score !== null && record !== undefined) {
        const otherScores = records
          .filter(
            (r) =>
              r.strategy_id !== strategy.id &&
              r.effectiveness_score !== null
          )
          .map((r) => r.effectiveness_score!);

        if (otherScores.length > 0) {
          const isLowest = otherScores.every(
            (s) => s >= record.effectiveness_score!
          );
          if (isLowest) {
            const history = this.rebalanceHistory.get(strategy.goal_id) ?? [];
            const recentCount = this.countConsecutiveLowestRebalances(
              strategy.id,
              history
            );
            if (recentCount >= this.config.termination_min_rebalances) {
              return true;
            }
          }
        }
      }
    }

    return false;
  }

  /**
   * Activate multiple strategies with initial allocation.
   *
   * Single strategy: allocation = 1.0
   * Multiple: equal split as default, respecting min 0.1 and max 0.7, sum = 1.0
   */
  activateStrategies(goalId: string, strategyIds: string[]): void {
    if (strategyIds.length === 0) return;

    const allocations = this.calculateInitialAllocations(strategyIds.length);

    for (let i = 0; i < strategyIds.length; i++) {
      const strategyId = strategyIds[i];
      // Activate through strategyManager (handles state transition)
      this.strategyManager.updateState(strategyId, "active");

      // Set allocation by updating portfolio directly
      this.updateStrategyAllocation(goalId, strategyId, allocations[i]);
    }
  }

  /**
   * Check if a strategy is a WaitStrategy (has wait-specific fields).
   */
  isWaitStrategy(strategy: Strategy): boolean {
    const waitFields = strategy as Record<string, unknown>;
    return (
      typeof waitFields["wait_reason"] === "string" &&
      typeof waitFields["wait_until"] === "string" &&
      typeof waitFields["measurement_plan"] === "string"
    );
  }

  /**
   * Handle expiry of a WaitStrategy.
   *
   * When wait_until has passed:
   * - Gap improved: return null (let the wait strategy continue its evaluation)
   * - Gap unchanged: activate fallback strategy if one exists
   * - Gap worsened: return rebalance trigger
   */
  handleWaitStrategyExpiry(
    goalId: string,
    strategyId: string
  ): RebalanceTrigger | null {
    const portfolio = this.strategyManager.getPortfolio(goalId);
    if (!portfolio) return null;

    const strategy = portfolio.strategies.find((s) => s.id === strategyId);
    if (!strategy || !this.isWaitStrategy(strategy)) return null;

    const waitStrategy = strategy as unknown as WaitStrategy;
    const waitUntil = new Date(waitStrategy.wait_until).getTime();
    const now = Date.now();

    // Not yet expired
    if (now < waitUntil) return null;

    // Measure gap change since strategy started
    const startGap = strategy.gap_snapshot_at_start;
    if (startGap === null) return null;

    const currentGap = this.getCurrentGapForDimension(
      goalId,
      strategy.primary_dimension
    );
    if (currentGap === null) return null;

    const gapDelta = currentGap - startGap; // negative = improved

    if (gapDelta < 0) {
      // Gap improved — wait was justified
      return null;
    }

    if (gapDelta === 0) {
      // Gap unchanged — activate fallback if available
      if (waitStrategy.fallback_strategy_id) {
        const fallback = portfolio.strategies.find(
          (s) => s.id === waitStrategy.fallback_strategy_id
        );
        if (fallback && fallback.state === "candidate") {
          this.strategyManager.updateState(fallback.id, "active");
        }
      }
      return null;
    }

    // Gap worsened — trigger rebalance
    return {
      type: "stall_detected",
      strategy_id: strategyId,
      details: `WaitStrategy expired with gap worsening: ${startGap.toFixed(3)} → ${currentGap.toFixed(3)}`,
    };
  }

  /**
   * Record a task completion timestamp for a strategy.
   * Called externally when a task finishes execution.
   */
  recordTaskCompletion(strategyId: string): void {
    this.lastTaskCompletionByStrategy.set(strategyId, Date.now());
  }

  /**
   * Get the rebalance history for a goal.
   */
  getRebalanceHistory(goalId: string): RebalanceResult[] {
    return this.rebalanceHistory.get(goalId) ?? [];
  }

  /**
   * Select the next strategy to execute across multiple goals.
   *
   * Uses CrossGoalPortfolio's allocation to determine which goal gets the
   * next turn (most underserved relative to its allocation), then selects
   * a strategy within that goal using selectNextStrategyForTask().
   *
   * Returns null if no strategies are available across all goals.
   */
  async selectNextStrategyAcrossGoals(
    goalIds: string[],
    goalAllocations: Map<string, number>
  ): Promise<{
    goal_id: string;
    strategy_id: string | null;
    selection_reason: string;
  } | null> {
    if (goalIds.length === 0) return null;

    const now = Date.now();

    // Sort goals by "most underserved": fewest tasks relative to their allocation
    const goalTaskCounts = this.goalTaskCounts;
    const scored = goalIds.map((goalId) => {
      const allocation = goalAllocations.get(goalId) ?? (1 / goalIds.length);
      const taskCount = goalTaskCounts.get(goalId) ?? 0;
      // Goals with allocation > 0 and fewest tasks relative to allocation are most underserved
      // Use (taskCount / allocation) as the "saturation ratio" — lower = more underserved
      const saturation = allocation > 0 ? taskCount / allocation : Infinity;
      return { goalId, saturation, allocation };
    });

    // Sort ascending by saturation (most underserved first)
    scored.sort((a, b) => a.saturation - b.saturation);

    // Try each goal in order until one has an available strategy
    for (const { goalId, saturation } of scored) {
      const allocation = goalAllocations.get(goalId) ?? 0;
      if (allocation <= 0) {
        // Skip goals with zero allocation (waiting state)
        continue;
      }

      const selectionResult = this.selectNextStrategyForTask(goalId);
      if (selectionResult !== null) {
        return {
          goal_id: goalId,
          strategy_id: selectionResult.strategy_id,
          selection_reason: `Goal selected (saturation=${saturation.toFixed(2)}, allocation=${allocation.toFixed(2)}): ${selectionResult.reason}`,
        };
      }
    }

    return null;
  }

  /**
   * Track how many tasks have been dispatched per goal.
   * Updated via recordGoalTaskDispatched().
   */
  readonly goalTaskCounts: Map<string, number> = new Map();

  /**
   * Record that a task was dispatched for the given goal.
   * Used by selectNextStrategyAcrossGoals() to track saturation.
   */
  recordGoalTaskDispatched(goalId: string): void {
    this.goalTaskCounts.set(goalId, (this.goalTaskCounts.get(goalId) ?? 0) + 1);
  }

  // ─── Private Helpers ───

  /**
   * Calculate gap delta attributed to a strategy using dimension-target matching.
   * Sums gap changes across the strategy's target_dimensions.
   */
  private calculateGapDeltaForStrategy(
    strategy: Strategy,
    goalId: string
  ): number {
    let totalDelta = 0;

    for (const dimension of strategy.target_dimensions) {
      const currentGap = this.getCurrentGapForDimension(goalId, dimension);
      if (currentGap === null) continue;

      // Use gap_snapshot_at_start as baseline if available
      const baseline = strategy.gap_snapshot_at_start ?? 1.0;
      const delta = baseline - currentGap; // positive = improvement (gap closed)
      totalDelta += delta;
    }

    return totalDelta;
  }

  /**
   * Get the current gap value for a specific dimension of a goal.
   * Reads from gap history persisted by StateManager.
   */
  private getCurrentGapForDimension(
    goalId: string,
    dimension: string
  ): number | null {
    // Read gap history from state — convention: gaps/<goalId>/current.json
    const raw = this.stateManager.readRaw(
      `gaps/${goalId}/current.json`
    );
    if (!raw || typeof raw !== "object") return null;

    const gaps = raw as Record<string, unknown>;
    const dimensionGap = gaps[dimension];
    if (typeof dimensionGap === "number") return dimensionGap;

    // Try nested structure: { dimensions: { [dim]: { normalized_weighted_gap: number } } }
    const dimensions = gaps["dimensions"];
    if (dimensions && typeof dimensions === "object") {
      const dimData = (dimensions as Record<string, unknown>)[dimension];
      if (dimData && typeof dimData === "object") {
        const nwg = (dimData as Record<string, unknown>)[
          "normalized_weighted_gap"
        ];
        if (typeof nwg === "number") return nwg;
      }
    }

    return null;
  }

  /**
   * Calculate initial allocations for N strategies.
   * Single: [1.0]. Multiple: equal split clamped to [min, max], sum = 1.0.
   */
  private calculateInitialAllocations(count: number): number[] {
    if (count === 1) return [1.0];

    const { min_allocation, max_allocation } = this.config;
    let base = 1.0 / count;

    // Clamp to bounds
    base = Math.max(min_allocation, Math.min(max_allocation, base));

    const allocations = new Array<number>(count).fill(base);

    // Normalize to sum = 1.0
    const sum = allocations.reduce((a, b) => a + b, 0);
    if (sum > 0 && Math.abs(sum - 1.0) > 0.001) {
      const factor = 1.0 / sum;
      for (let i = 0; i < allocations.length; i++) {
        allocations[i] = Math.max(
          min_allocation,
          Math.min(max_allocation, allocations[i] * factor)
        );
      }
      // Final adjustment on last element to ensure exact sum
      const finalSum = allocations
        .slice(0, -1)
        .reduce((a, b) => a + b, 0);
      allocations[allocations.length - 1] = Math.max(
        min_allocation,
        1.0 - finalSum
      );
    }

    return allocations;
  }

  /**
   * Update a single strategy's allocation in the portfolio.
   * Reads portfolio, modifies the strategy, and writes back.
   */
  private updateStrategyAllocation(
    goalId: string,
    strategyId: string,
    allocation: number
  ): void {
    const portfolio = this.strategyManager.getPortfolio(goalId);
    if (!portfolio) return;

    const updated: Portfolio = {
      ...portfolio,
      strategies: portfolio.strategies.map((s) =>
        s.id === strategyId
          ? StrategySchema.parse({ ...s, allocation })
          : s
      ),
    };

    this.stateManager.writeRaw(
      `strategies/${goalId}/portfolio.json`,
      PortfolioSchema.parse(updated)
    );
  }

  /**
   * Redistribute freed allocation proportionally among remaining strategies
   * based on effectiveness scores.
   */
  private redistributeAllocation(
    goalId: string,
    remaining: Strategy[],
    records: EffectivenessRecord[],
    freedAllocation: number,
    result: RebalanceResult
  ): void {
    if (remaining.length === 0 || freedAllocation <= 0) return;

    // Get scores for proportional distribution
    const scoredRemaining = remaining.map((s) => {
      const record = records.find((r) => r.strategy_id === s.id);
      return {
        strategy: s,
        score: record?.effectiveness_score ?? 0,
      };
    });

    const totalScore = scoredRemaining.reduce((sum, r) => sum + Math.max(r.score, 0), 0);

    for (const { strategy, score } of scoredRemaining) {
      const proportion =
        totalScore > 0
          ? Math.max(score, 0) / totalScore
          : 1.0 / remaining.length;
      const additionalAllocation = freedAllocation * proportion;
      const oldAllocation = strategy.allocation;
      const newAllocation = Math.min(
        this.config.max_allocation,
        oldAllocation + additionalAllocation
      );

      if (Math.abs(newAllocation - oldAllocation) > 0.001) {
        this.updateStrategyAllocation(goalId, strategy.id, newAllocation);
        result.adjustments.push({
          strategy_id: strategy.id,
          old_allocation: oldAllocation,
          new_allocation: newAllocation,
          reason: "Redistribution from terminated strategy",
        });
      }
    }
  }

  /**
   * Adjust allocations based on effectiveness scores.
   * Increases high-performers, decreases low-performers.
   */
  private adjustAllocations(
    goalId: string,
    strategies: Strategy[],
    scoredRecords: EffectivenessRecord[],
    result: RebalanceResult
  ): void {
    // Sort by effectiveness score descending
    const sorted = [...scoredRecords].sort(
      (a, b) => (b.effectiveness_score ?? 0) - (a.effectiveness_score ?? 0)
    );

    const totalScore = sorted.reduce(
      (sum, r) => sum + Math.max(r.effectiveness_score ?? 0, 0),
      0
    );
    if (totalScore <= 0) return;

    const adjustments: AllocationAdjustment[] = [];
    const newAllocations: Map<string, number> = new Map();

    // Calculate target allocations proportional to scores
    for (const record of sorted) {
      const strategy = strategies.find((s) => s.id === record.strategy_id);
      if (!strategy) continue;

      const proportion = Math.max(record.effectiveness_score ?? 0, 0) / totalScore;
      let targetAllocation = proportion; // sum of proportions = 1.0

      // Clamp to bounds
      targetAllocation = Math.max(
        this.config.min_allocation,
        Math.min(this.config.max_allocation, targetAllocation)
      );

      newAllocations.set(strategy.id, targetAllocation);
    }

    // Normalize to sum = 1.0
    const rawSum = Array.from(newAllocations.values()).reduce(
      (a, b) => a + b,
      0
    );
    if (rawSum > 0 && Math.abs(rawSum - 1.0) > 0.001) {
      const factor = 1.0 / rawSum;
      for (const [id, alloc] of newAllocations) {
        newAllocations.set(
          id,
          Math.max(this.config.min_allocation, alloc * factor)
        );
      }
    }

    // Apply changes
    for (const [strategyId, newAllocation] of newAllocations) {
      const strategy = strategies.find((s) => s.id === strategyId);
      if (!strategy) continue;

      const oldAllocation = strategy.allocation;
      if (Math.abs(newAllocation - oldAllocation) > 0.001) {
        this.updateStrategyAllocation(goalId, strategyId, newAllocation);
        adjustments.push({
          strategy_id: strategyId,
          old_allocation: oldAllocation,
          new_allocation: newAllocation,
          reason: `Score-based rebalancing (effectiveness: ${
            scoredRecords
              .find((r) => r.strategy_id === strategyId)
              ?.effectiveness_score?.toFixed(3) ?? "N/A"
          })`,
        });
      }
    }

    result.adjustments.push(...adjustments);
  }

  /**
   * Count how many consecutive recent rebalances a strategy has been the lowest scorer.
   */
  private countConsecutiveLowestRebalances(
    strategyId: string,
    history: RebalanceResult[]
  ): number {
    let count = 0;

    // Walk backwards through history
    for (let i = history.length - 1; i >= 0; i--) {
      const rebalance = history[i];
      // A strategy being adjusted down or being present in adjustments
      // with lowest allocation indicates it was lowest
      const adjustment = rebalance.adjustments.find(
        (a) => a.strategy_id === strategyId
      );
      if (adjustment && adjustment.new_allocation <= this.config.min_allocation) {
        count++;
      } else {
        break; // Streak broken
      }
    }

    return count;
  }

  /**
   * Record a rebalance result and update tracking state.
   */
  private recordRebalance(goalId: string, result: RebalanceResult): void {
    this.lastRebalanceTime.set(goalId, Date.now());

    const history = this.rebalanceHistory.get(goalId) ?? [];
    history.push(result);
    this.rebalanceHistory.set(goalId, history);

    // Persist rebalance history
    this.stateManager.writeRaw(
      `strategies/${goalId}/rebalance-history.json`,
      history
    );
  }
}
