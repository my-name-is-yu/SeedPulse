import { StateManager } from "../state-manager.js";
import { GoalDependencyGraph } from "../goal/goal-dependency-graph.js";
import { VectorIndex } from "../knowledge/vector-index.js";
import type { IEmbeddingClient } from "../knowledge/embedding-client.js";
import { scoreDeadline } from "../drive/drive-scorer.js";
import {
  CrossGoalPortfolioConfigSchema,
} from "../types/cross-portfolio.js";
import type {
  CrossGoalAllocation,
  CrossGoalPortfolioConfig,
  GoalPriorityFactors,
  StrategyTemplate,
  CrossGoalRebalanceResult,
  CrossGoalRebalanceTrigger,
  MomentumInfo,
  MomentumTrend,
  DependencySchedule,
  DependencyPhase,
  AllocationStrategy,
  RebalanceAction,
} from "../types/cross-portfolio.js";
import type { Goal } from "../types/goal.js";

// ─── Helpers ───

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * CrossGoalPortfolio manages resource allocation and priority across multiple
 * active goals. It sits above individual PortfolioManager instances and answers
 * the question: "given N active goals, how should overall resources be split?"
 *
 * Responsibilities:
 *   - Calculate per-goal priority scores from 4 factors
 *   - Allocate resource shares proportionally
 *   - Rebalance on 4 trigger types
 *   - Recommend strategy templates using vector similarity
 *
 * CrossGoalPortfolio does NOT manage strategies within a single goal —
 * that remains the responsibility of PortfolioManager.
 */
export class CrossGoalPortfolio {
  private readonly stateManager: StateManager;
  private readonly goalDependencyGraph: GoalDependencyGraph;
  private readonly vectorIndex: VectorIndex;
  private readonly embeddingClient: IEmbeddingClient;
  private readonly config: CrossGoalPortfolioConfig;

  /** goalId → cached GoalPriorityFactors from the last calculation */
  private lastPriorities: Map<string, GoalPriorityFactors> = new Map();

  constructor(
    stateManager: StateManager,
    goalDependencyGraph: GoalDependencyGraph,
    vectorIndex: VectorIndex,
    embeddingClient: IEmbeddingClient,
    config?: Partial<CrossGoalPortfolioConfig>
  ) {
    this.stateManager = stateManager;
    this.goalDependencyGraph = goalDependencyGraph;
    this.vectorIndex = vectorIndex;
    this.embeddingClient = embeddingClient;
    this.config = CrossGoalPortfolioConfigSchema.parse(config ?? {});
  }

  // ─── Priority Calculation ───

  /**
   * Calculate priority factors for each goal in the provided list.
   *
   * The 4 factors and their weights:
   *   w1=0.35  deadline_urgency    — how soon the goal must be finished
   *   w2=0.25  gap_severity        — worst-case normalized gap across dimensions
   *   w3=0.25  dependency_weight   — how many goals depend on this one
   *   w4=0.15  user_priority       — user-specified priority (1-5 → 0-1)
   *
   * After the weighted sum is computed, synergy/conflict edges from
   * GoalDependencyGraph adjust the final score before clamping to [0,1].
   *
   * @param goalIds — IDs of goals to evaluate (missing goals are skipped)
   * @returns GoalPriorityFactors[] sorted by computed_priority descending
   */
  calculateGoalPriorities(goalIds: string[]): GoalPriorityFactors[] {
    if (goalIds.length === 0) return [];

    const totalGoals = goalIds.length;
    const now = new Date();

    // --- Step 1: collect raw factors for each goal ---
    type RawFactors = {
      goalId: string;
      goal: Goal;
      deadlineUrgency: number;
      gapSeverity: number;
      dependencyWeight: number;
      userPriority: number;
    };

    const rawList: RawFactors[] = [];

    for (const goalId of goalIds) {
      const goal = this.stateManager.loadGoal(goalId);
      if (!goal) continue;

      // deadline_urgency — use scoreDeadline with maxGap=1 as the
      // normalized_weighted_gap input, then read the urgency value.
      let deadlineUrgency = 0;
      if (goal.deadline) {
        const deadlineMs = new Date(goal.deadline).getTime();
        const timeRemainingHours = (deadlineMs - now.getTime()) / (1000 * 60 * 60);
        const result = scoreDeadline(1, timeRemainingHours);
        // Normalize urgency to [0,1]. scoreDeadline with gap=1 means score == urgency.
        // urgency >= 1 (at minimum). We normalise by capping at the urgency-at-zero cap.
        // Use urgency directly but clamp to [0,1] after dividing by a reasonable max.
        // default urgency_steepness=2, deadline_horizon=168h → urgencyAtZero = exp(2) ≈ 7.39
        const urgencyAtZero = Math.exp(2); // exp(urgency_steepness)
        deadlineUrgency = clamp(result.urgency / urgencyAtZero, 0, 1);
      }

      // gap_severity — max normalized_weighted_gap across all dimensions
      // We approximate by treating each dimension's gap as proportional
      // to how far it is from its threshold relative to a known scale.
      // For simplicity (no GapCalculator instance injected), we derive a
      // rough severity from the dimension values directly.
      let gapSeverity = 0;
      for (const dim of goal.dimensions) {
        const dimGap = this._estimateDimensionGap(dim);
        if (dimGap > gapSeverity) {
          gapSeverity = dimGap;
        }
      }
      gapSeverity = clamp(gapSeverity, 0, 1);

      // dependency_weight — how many goals in the provided list depend on this goal
      const graph = this.goalDependencyGraph.getGraph();
      const dependentCount = graph.edges.filter(
        (e) =>
          e.from_goal_id === goalId &&
          e.type === "prerequisite" &&
          e.status === "active" &&
          goalIds.includes(e.to_goal_id)
      ).length;
      const dependencyWeight = totalGoals > 1 ? dependentCount / (totalGoals - 1) : 0;

      // user_priority — extract from goal constraints or metadata
      // Assume format "priority:N" (N in 1-5) anywhere in constraints
      let userPriority = 0.5; // default
      for (const constraint of goal.constraints) {
        const match = constraint.match(/\bpriority[:\s=]+(\d+)\b/i);
        if (match) {
          const level = parseInt(match[1]!, 10);
          userPriority = clamp(level / 5, 0, 1);
          break;
        }
      }

      rawList.push({
        goalId,
        goal,
        deadlineUrgency,
        gapSeverity,
        dependencyWeight: clamp(dependencyWeight, 0, 1),
        userPriority,
      });
    }

    if (rawList.length === 0) return [];

    // --- Step 2: compute weighted priority ---
    const W1 = 0.35;
    const W2 = 0.25;
    const W3 = 0.25;
    const W4 = 0.15;

    const withBase = rawList.map((r) => {
      const basePriority =
        W1 * r.deadlineUrgency +
        W2 * r.gapSeverity +
        W3 * r.dependencyWeight +
        W4 * r.userPriority;
      return { ...r, basePriority };
    });

    // --- Step 3: apply synergy / conflict adjustments ---
    const synergyBonus = this.config.synergy_bonus / 2; // split the config bonus equally
    const CONFLICT_PENALTY = 0.15;

    const goalIdSet = new Set(rawList.map((r) => r.goalId));

    // Build a lookup: goalId → index in withBase
    const indexMap = new Map<string, number>();
    withBase.forEach((r, i) => indexMap.set(r.goalId, i));

    // Adjust scores based on dependency edges between goals in the set
    const adjustments = new Array<number>(withBase.length).fill(0);
    const graph = this.goalDependencyGraph.getGraph();
    const seenPairs = new Set<string>();

    for (const edge of graph.edges) {
      if (edge.status !== "active") continue;
      if (!goalIdSet.has(edge.from_goal_id) || !goalIdSet.has(edge.to_goal_id)) continue;

      const pairKey = [edge.from_goal_id, edge.to_goal_id].sort().join("||");

      if (edge.type === "synergy") {
        if (!seenPairs.has(pairKey)) {
          seenPairs.add(pairKey);
          const idxA = indexMap.get(edge.from_goal_id);
          const idxB = indexMap.get(edge.to_goal_id);
          if (idxA !== undefined) adjustments[idxA]! += synergyBonus;
          if (idxB !== undefined) adjustments[idxB]! += synergyBonus;
        }
      } else if (edge.type === "conflict") {
        if (!seenPairs.has(pairKey)) {
          seenPairs.add(pairKey);
          // Penalise the lower-priority goal
          const idxA = indexMap.get(edge.from_goal_id);
          const idxB = indexMap.get(edge.to_goal_id);
          if (idxA !== undefined && idxB !== undefined) {
            const scoreA = withBase[idxA]!.basePriority;
            const scoreB = withBase[idxB]!.basePriority;
            if (scoreA <= scoreB) {
              adjustments[idxA]! -= CONFLICT_PENALTY;
            } else {
              adjustments[idxB]! -= CONFLICT_PENALTY;
            }
          }
        }
      }
    }

    // --- Step 4: produce final factors ---
    const result: GoalPriorityFactors[] = withBase.map((r, i) => {
      const computedPriority = clamp(r.basePriority + (adjustments[i] ?? 0), 0, 1);
      return {
        goal_id: r.goalId,
        deadline_urgency: r.deadlineUrgency,
        gap_severity: r.gapSeverity,
        dependency_weight: r.dependencyWeight,
        user_priority: r.userPriority,
        computed_priority: computedPriority,
      };
    });

    // Sort descending by computed_priority
    result.sort((a, b) => b.computed_priority - a.computed_priority);

    // Cache for rebalance
    for (const f of result) {
      this.lastPriorities.set(f.goal_id, f);
    }

    return result;
  }

  // ─── Resource Allocation ───

  /**
   * Allocate resource shares across goals based on their priority scores.
   *
   * Rules:
   *   1. If goals > max_concurrent_goals, lowest priority goals get allocation=0
   *      and are labelled "waiting".
   *   2. Active goals (up to max_concurrent_goals) share 1.0 proportionally to
   *      computed_priority, with a floor of min_goal_share.
   *   3. Sum of active allocations = 1.0.
   *
   * @param priorities — output from calculateGoalPriorities
   * @param strategy   — optional AllocationStrategy (default: 'priority')
   * @param momentumMap — goalId → MomentumInfo, required when strategy.type === 'momentum'
   * @param depSchedule — DependencySchedule, required when strategy.type === 'dependency_aware'
   * @returns CrossGoalAllocation[] in the same order as priorities
   */
  allocateResources(
    priorities: GoalPriorityFactors[],
    strategy?: AllocationStrategy,
    momentumMap?: Map<string, MomentumInfo>,
    depSchedule?: DependencySchedule
  ): CrossGoalAllocation[] {
    if (priorities.length === 0) return [];

    const { max_concurrent_goals, min_goal_share } = this.config;

    // Split into active (top N) and waiting (rest), already sorted desc
    const activeCount = Math.min(priorities.length, max_concurrent_goals);
    const activePriorities = priorities.slice(0, activeCount);
    const waitingPriorities = priorities.slice(activeCount);

    // Build allocations for waiting goals (zero share)
    const waitingAllocations: CrossGoalAllocation[] = waitingPriorities.map((p) => ({
      goal_id: p.goal_id,
      priority: p.computed_priority,
      resource_share: 0,
      adjustment_reason: `waiting: exceeds max_concurrent_goals (${max_concurrent_goals})`,
    }));

    if (activePriorities.length === 0) return waitingAllocations;

    // Single goal gets everything
    if (activePriorities.length === 1) {
      return [
        {
          goal_id: activePriorities[0]!.goal_id,
          priority: activePriorities[0]!.computed_priority,
          resource_share: 1.0,
          adjustment_reason: "sole active goal",
        },
        ...waitingAllocations,
      ];
    }

    const n = activePriorities.length;

    // --- Strategy-specific weight computation ---
    const strategyType = strategy?.type ?? "priority";

    let weights: number[];
    let strategyReason: string;

    if (strategyType === "equal") {
      weights = activePriorities.map(() => 1);
      strategyReason = "equal allocation";
    } else if (strategyType === "momentum" && momentumMap && momentumMap.size > 0) {
      const momentumWeight = strategy?.momentumWeight ?? 0.5;
      // Blend priority and momentum velocity
      weights = activePriorities.map((p) => {
        const mom = momentumMap.get(p.goal_id);
        const vel = mom ? Math.max(mom.velocity, 0) : 0;
        return (1 - momentumWeight) * p.computed_priority + momentumWeight * vel;
      });
      strategyReason = "momentum-weighted";
    } else if (strategyType === "dependency_aware" && depSchedule) {
      // Goals on critical path and unblocked goals get a boost
      const criticalSet = new Set(depSchedule.criticalPath);
      // Determine which goals are currently unblocked (in phase 0 or phase whose blockedBy are empty)
      const unblockedGoals = new Set<string>();
      for (const phase of depSchedule.phases) {
        if (phase.blockedBy.length === 0) {
          for (const id of phase.goalIds) unblockedGoals.add(id);
        }
      }
      weights = activePriorities.map((p) => {
        let w = p.computed_priority;
        if (criticalSet.has(p.goal_id)) w *= 1.5;
        if (unblockedGoals.has(p.goal_id)) w *= 1.2;
        return w;
      });
      strategyReason = "dependency_aware";
    } else {
      // Default: priority-proportional
      weights = activePriorities.map((p) => p.computed_priority);
      strategyReason = "priority";
    }

    // Proportional allocation with guaranteed min_goal_share floor.
    //
    // Algorithm:
    //   1. Reserve min_goal_share for every active goal.
    //   2. Distribute the remaining budget (1 - n * min_goal_share) proportionally
    //      by computed weight.
    //   3. This guarantees every active goal has at least min_goal_share.
    //
    // Edge case: if n * min_goal_share >= 1 (too many goals for the floor to
    // allow proportional distribution), fall back to equal distribution.
    const reservedTotal = n * min_goal_share;

    let finalShares: number[];

    if (reservedTotal >= 1) {
      // No room for proportional top-up — give everyone an equal share
      finalShares = activePriorities.map(() => 1 / n);
    } else {
      const remainingBudget = 1 - reservedTotal;
      const totalWeight = weights.reduce((sum, w) => sum + w, 0);

      if (totalWeight === 0) {
        // All zero — split remaining budget equally
        finalShares = activePriorities.map(() => min_goal_share + remainingBudget / n);
      } else {
        finalShares = weights.map(
          (w) => min_goal_share + remainingBudget * (w / totalWeight)
        );
      }
    }

    // Track which goals received the floor for reason strings
    const totalWeightForReason = weights.reduce((sum, w) => sum + w, 0);
    const rawShares = totalWeightForReason === 0
      ? activePriorities.map(() => 1 / n)
      : weights.map((w) => w / totalWeightForReason);

    const activeAllocations: CrossGoalAllocation[] = activePriorities.map((p, i) => {
      const share = finalShares[i]!;
      const raw = rawShares[i]!;
      let reason: string;
      if (raw < min_goal_share) {
        reason = `min_goal_share floor applied (raw=${raw.toFixed(3)}, strategy=${strategyReason})`;
      } else {
        reason = `${strategyReason}: weight=${weights[i]!.toFixed(3)}`;
      }
      return {
        goal_id: p.goal_id,
        priority: p.computed_priority,
        resource_share: share,
        adjustment_reason: reason,
      };
    });

    return [...activeAllocations, ...waitingAllocations];
  }

  // ─── Rebalancing ───

  /**
   * Recalculate priorities for all currently active goals and produce a new
   * allocation plan.
   *
   * @param trigger — what caused this rebalance
   * @param goalIds — explicit list of goal IDs to consider; if omitted, the
   *                  IDs from the last calculateGoalPriorities call are used
   */
  rebalanceGoals(
    trigger: CrossGoalRebalanceTrigger,
    goalIds?: string[]
  ): CrossGoalRebalanceResult {
    const ids = goalIds ?? Array.from(this.lastPriorities.keys());
    const priorities = this.calculateGoalPriorities(ids);
    const allocations = this.allocateResources(priorities);

    return {
      timestamp: new Date().toISOString(),
      allocations,
      triggered_by: trigger,
    };
  }

  // ─── Template Recommendation ───

  /**
   * Search the VectorIndex for strategy templates that match the given goal.
   *
   * Matching is based on:
   *   1. Semantic similarity between the goal text and template hypothesis_pattern
   *   2. domain_tags overlap (at least 1 tag in common with the goal's domain tags)
   *   3. Final ranking: similarity × effectiveness_score (descending)
   *
   * The caller is responsible for having added StrategyTemplate objects to the
   * VectorIndex with their `template_id` as the entry id and metadata shaped
   * as StrategyTemplate fields.
   *
   * @param goalId — goal for which templates are requested
   * @param vectorIndex — the index to search (typically the instance-level one,
   *                      but callers may pass a different one for testing)
   * @param limit — number of results to return (default 3)
   */
  async getRecommendedTemplates(
    goalId: string,
    vectorIndex: VectorIndex,
    limit: number = 3
  ): Promise<StrategyTemplate[]> {
    const goal = this.stateManager.loadGoal(goalId);
    if (!goal) return [];

    // Build a query string from the goal
    const queryText = [goal.title, goal.description, ...goal.constraints]
      .filter(Boolean)
      .join(" ");

    if (!queryText.trim()) return [];

    // Search index — retrieve more than `limit` so we can filter by domain_tags
    const searchResults = await vectorIndex.search(queryText, limit * 5);

    if (searchResults.length === 0) return [];

    // Derive goal domain tags from constraints (format "domain:tag") or title words
    const goalDomainTags = this._extractDomainTags(goal);

    // Filter and score
    const scored: Array<{ template: StrategyTemplate; finalScore: number }> = [];

    for (const result of searchResults) {
      const meta = result.metadata as Record<string, unknown>;

      // Must have the required StrategyTemplate fields in metadata
      if (
        typeof meta["template_id"] !== "string" ||
        typeof meta["hypothesis_pattern"] !== "string" ||
        !Array.isArray(meta["domain_tags"]) ||
        typeof meta["effectiveness_score"] !== "number"
      ) {
        continue;
      }

      const domainTags = meta["domain_tags"] as string[];
      const effectivenessScore = meta["effectiveness_score"] as number;

      // Require at least 1 domain tag overlap — unless goal has no tags (then include all)
      if (goalDomainTags.length > 0) {
        const overlap = domainTags.filter((t) => goalDomainTags.includes(t)).length;
        if (overlap < 1) continue;
      }

      const template: StrategyTemplate = {
        template_id: meta["template_id"] as string,
        source_goal_id: typeof meta["source_goal_id"] === "string"
          ? (meta["source_goal_id"] as string)
          : "",
        source_strategy_id: typeof meta["source_strategy_id"] === "string"
          ? (meta["source_strategy_id"] as string)
          : "",
        hypothesis_pattern: meta["hypothesis_pattern"] as string,
        domain_tags: domainTags,
        effectiveness_score: effectivenessScore,
        applicable_dimensions: Array.isArray(meta["applicable_dimensions"])
          ? (meta["applicable_dimensions"] as string[])
          : [],
        embedding_id: typeof meta["embedding_id"] === "string"
          ? (meta["embedding_id"] as string)
          : null,
        created_at: typeof meta["created_at"] === "string"
          ? (meta["created_at"] as string)
          : new Date().toISOString(),
      };

      const finalScore = result.similarity * effectivenessScore;
      scored.push({ template, finalScore });
    }

    // Sort by finalScore descending and return top `limit`
    scored.sort((a, b) => b.finalScore - a.finalScore);
    return scored.slice(0, limit).map((s) => s.template);
  }

  // ─── Momentum ───

  /**
   * Calculate momentum for a single goal based on recent state snapshots.
   *
   * @param goalId — goal to evaluate
   * @param snapshots — array of recent progress values (0-1), ordered oldest → newest
   *                    (typically last 5 iterations). Minimum 2 values required.
   * @returns MomentumInfo
   */
  calculateMomentum(goalId: string, snapshots: number[]): MomentumInfo {
    if (snapshots.length === 0) {
      return { goalId, recentProgress: 0, velocity: 0, trend: "stalled" };
    }

    if (snapshots.length === 1) {
      return { goalId, recentProgress: 0, velocity: 0, trend: "stalled" };
    }

    // recentProgress = total delta from first to last snapshot
    const recentProgress = snapshots[snapshots.length - 1]! - snapshots[0]!;

    // velocity = smoothed average per-step delta (EMA-style: weight recent steps more)
    const deltas: number[] = [];
    for (let i = 1; i < snapshots.length; i++) {
      deltas.push(snapshots[i]! - snapshots[i - 1]!);
    }

    // Simple smoothed velocity: weighted average where later deltas have higher weight
    let weightedSum = 0;
    let weightTotal = 0;
    for (let i = 0; i < deltas.length; i++) {
      const w = i + 1; // weight increases for more recent deltas
      weightedSum += deltas[i]! * w;
      weightTotal += w;
    }
    const velocity = weightTotal > 0 ? weightedSum / weightTotal : 0;

    // Trend detection:
    //   stalled:       velocity ≈ 0 (< 0.005)
    //   accelerating:  later half average > earlier half average
    //   decelerating:  later half average < earlier half average (by ≥ threshold)
    //   steady:        otherwise
    let trend: MomentumTrend;

    const STALL_THRESHOLD = 0.005;
    if (Math.abs(velocity) < STALL_THRESHOLD) {
      trend = "stalled";
    } else if (deltas.length >= 2) {
      const mid = Math.floor(deltas.length / 2);
      const earlyAvg = deltas.slice(0, mid).reduce((s, d) => s + d, 0) / mid;
      const lateAvg = deltas.slice(mid).reduce((s, d) => s + d, 0) / (deltas.length - mid);

      const ACCEL_THRESHOLD = 0.002;
      if (lateAvg > earlyAvg + ACCEL_THRESHOLD) {
        trend = "accelerating";
      } else if (lateAvg < earlyAvg - ACCEL_THRESHOLD) {
        trend = "decelerating";
      } else {
        trend = "steady";
      }
    } else {
      // Only 1 delta — classify by sign
      trend = velocity > 0 ? "steady" : "stalled";
    }

    return { goalId, recentProgress, velocity, trend };
  }

  // ─── Dependency Scheduling ───

  /**
   * Build a phased dependency schedule for the given goals using the provided
   * GoalDependencyGraph instance.
   *
   * The schedule uses topological sort to group goals into phases where all
   * goals in a phase can run concurrently. Phase 0 contains goals with no
   * prerequisites; subsequent phases contain goals whose prerequisites are
   * all satisfied by earlier phases.
   *
   * The critical path is the longest chain of prerequisite edges through the
   * DAG (measured in number of nodes).
   *
   * @param goalIds — IDs of goals to schedule
   * @param graph — the GoalDependencyGraph instance to query
   * @returns DependencySchedule
   */
  buildDependencySchedule(
    goalIds: string[],
    graph: GoalDependencyGraph
  ): DependencySchedule {
    if (goalIds.length === 0) {
      return { phases: [], criticalPath: [] };
    }

    const goalSet = new Set(goalIds);

    // Build adjacency: prereqMap[child] = Set of parents that must complete first
    const prereqMap = new Map<string, Set<string>>();
    for (const id of goalIds) {
      prereqMap.set(id, new Set());
    }

    for (const id of goalIds) {
      const blockers = graph.getBlockingGoals(id).filter((b) => goalSet.has(b));
      for (const blocker of blockers) {
        prereqMap.get(id)!.add(blocker);
      }
    }

    // Kahn's algorithm for topological sort into phases
    const phases: DependencyPhase[] = [];
    const completed = new Set<string>();
    const remaining = new Set(goalIds);

    let phaseIndex = 0;
    while (remaining.size > 0) {
      // Goals whose all prerequisites are completed
      const readyGoals: string[] = [];
      for (const id of remaining) {
        const prereqs = prereqMap.get(id)!;
        const allSatisfied = [...prereqs].every((p) => completed.has(p));
        if (allSatisfied) {
          readyGoals.push(id);
        }
      }

      if (readyGoals.length === 0) {
        // Cycle detected or unresolvable — put all remaining in one phase
        const cycleGoals = [...remaining];
        const blockedBy = cycleGoals.flatMap((id) =>
          [...(prereqMap.get(id) ?? [])].filter((p) => !completed.has(p))
        );
        phases.push({
          phase: phaseIndex,
          goalIds: cycleGoals,
          blockedBy: [...new Set(blockedBy)],
        });
        break;
      }

      // Collect the set of blockers for this phase's goals
      const phaseBlockedBy = readyGoals.flatMap((id) =>
        [...(prereqMap.get(id) ?? [])]
      );

      phases.push({
        phase: phaseIndex,
        goalIds: readyGoals,
        blockedBy: [...new Set(phaseBlockedBy)],
      });

      for (const id of readyGoals) {
        completed.add(id);
        remaining.delete(id);
      }

      phaseIndex++;
    }

    // Critical path: longest chain of prerequisite edges (BFS/DFS from each node)
    const criticalPath = this._computeCriticalPath(goalIds, prereqMap);

    return { phases, criticalPath };
  }

  // ─── Stall Rebalancing ───

  /**
   * Detect stalled goals and redistribute their resources to progressing goals.
   *
   * A goal is considered stalled if its MomentumInfo.trend === 'stalled'.
   * Resources from stalled goals are redistributed proportionally to
   * non-stalled goals based on their velocity.
   *
   * @param currentAllocations — current CrossGoalAllocation array
   * @param momentumMap — goalId → MomentumInfo
   * @returns array of RebalanceActions taken (empty if no stalled goals)
   */
  rebalanceOnStall(
    currentAllocations: CrossGoalAllocation[],
    momentumMap: Map<string, MomentumInfo>
  ): RebalanceAction[] {
    const actions: RebalanceAction[] = [];

    if (currentAllocations.length === 0) return actions;

    const stalled: CrossGoalAllocation[] = [];
    const progressing: CrossGoalAllocation[] = [];

    for (const alloc of currentAllocations) {
      const mom = momentumMap.get(alloc.goal_id);
      if (!mom || mom.trend === "stalled") {
        stalled.push(alloc);
      } else {
        progressing.push(alloc);
      }
    }

    if (stalled.length === 0) return actions;

    // Nothing to redistribute to
    if (progressing.length === 0) return actions;

    // Calculate total share to redistribute
    const redistributeTotal = stalled.reduce((s, a) => s + a.resource_share, 0);

    // Compute target shares for progressing goals, weighted by velocity
    const totalVelocity = progressing.reduce((s, a) => {
      const mom = momentumMap.get(a.goal_id);
      return s + Math.max(mom?.velocity ?? 0, 0);
    }, 0);

    for (const alloc of stalled) {
      actions.push({
        goalId: alloc.goal_id,
        action: "reduce",
        reason: "stalled: momentum velocity ≈ 0",
        previousShare: alloc.resource_share,
        newShare: 0,
      });
    }

    for (const alloc of progressing) {
      const mom = momentumMap.get(alloc.goal_id);
      const vel = Math.max(mom?.velocity ?? 0, 0);
      const bonus =
        totalVelocity > 0
          ? redistributeTotal * (vel / totalVelocity)
          : redistributeTotal / progressing.length;
      const newShare = clamp(alloc.resource_share + bonus, 0, 1);

      actions.push({
        goalId: alloc.goal_id,
        action: "increase",
        reason: `received share from stalled goals (velocity=${vel.toFixed(4)})`,
        previousShare: alloc.resource_share,
        newShare,
      });
    }

    return actions;
  }

  // ─── Private helpers ───

  /**
   * Compute the critical path (longest prerequisite chain) among the given goals.
   * Returns the sequence of goalIds on the critical path.
   */
  private _computeCriticalPath(
    goalIds: string[],
    prereqMap: Map<string, Set<string>>
  ): string[] {
    // dp[id] = longest path length ending at id (in nodes)
    const dp = new Map<string, number>();
    const parent = new Map<string, string | null>();

    function longestFrom(id: string): number {
      const cached = dp.get(id);
      if (cached !== undefined) return cached;

      const prereqs = prereqMap.get(id) ?? new Set();
      if (prereqs.size === 0) {
        dp.set(id, 1);
        parent.set(id, null);
        return 1;
      }

      let best = 0;
      let bestParent: string | null = null;
      for (const p of prereqs) {
        const len = longestFrom(p);
        if (len > best) {
          best = len;
          bestParent = p;
        }
      }

      dp.set(id, best + 1);
      parent.set(id, bestParent);
      return best + 1;
    }

    // Compute for all goals
    for (const id of goalIds) {
      longestFrom(id);
    }

    // Find the goal with the highest dp value
    let maxLen = 0;
    let maxGoal = goalIds[0] ?? "";
    for (const id of goalIds) {
      const len = dp.get(id) ?? 0;
      if (len > maxLen) {
        maxLen = len;
        maxGoal = id;
      }
    }

    if (maxLen === 0) return [];

    // Reconstruct path by following parent pointers
    const path: string[] = [];
    let current: string | null = maxGoal;
    while (current !== null) {
      path.unshift(current);
      current = parent.get(current) ?? null;
    }

    return path;
  }

  /**
   * Produce a rough [0,1] severity for a single goal dimension.
   *
   * For numeric thresholds we compute gap / scale.
   * For binary thresholds (present/match) we return 0 or 1.
   * Returns 0 when the dimension is already satisfied.
   */
  private _estimateDimensionGap(
    dim: Goal["dimensions"][number]
  ): number {
    const { current_value, threshold } = dim;

    if (current_value === null) return 1;

    switch (threshold.type) {
      case "min": {
        if (typeof current_value !== "number") return 0;
        const gap = threshold.value - current_value;
        if (gap <= 0) return 0;
        return threshold.value !== 0 ? clamp(gap / threshold.value, 0, 1) : 1;
      }
      case "max": {
        if (typeof current_value !== "number") return 0;
        const gap = current_value - threshold.value;
        if (gap <= 0) return 0;
        return threshold.value !== 0 ? clamp(gap / threshold.value, 0, 1) : 1;
      }
      case "range": {
        if (typeof current_value !== "number") return 0;
        const span = threshold.high - threshold.low;
        if (current_value < threshold.low) {
          const gap = threshold.low - current_value;
          return span > 0 ? clamp(gap / span, 0, 1) : 1;
        }
        if (current_value > threshold.high) {
          const gap = current_value - threshold.high;
          return span > 0 ? clamp(gap / span, 0, 1) : 1;
        }
        return 0;
      }
      case "present": {
        return current_value ? 0 : 1;
      }
      case "match": {
        return current_value === threshold.value ? 0 : 1;
      }
      default:
        return 0;
    }
  }

  /**
   * Extract domain tags from a goal's constraints and title.
   * Recognises constraints with format "domain:tagname" or "tag:tagname".
   */
  private _extractDomainTags(goal: Goal): string[] {
    const tags: string[] = [];
    for (const constraint of goal.constraints) {
      const match = constraint.match(/^(?:domain|tag)[:\s]+(.+)$/i);
      if (match) {
        tags.push(match[1]!.trim().toLowerCase());
      }
    }
    return tags;
  }

  // ─── Allocation Map ───

  /**
   * Get a goal_id → resource_share map for the given goal IDs.
   *
   * Recomputes allocations based on current goal states.
   * Returns a Map suitable for use by PortfolioManager.selectNextStrategyAcrossGoals().
   */
  getAllocationMap(goalIds: string[]): Map<string, number> {
    const priorities = this.calculateGoalPriorities(goalIds);
    const allocations = this.allocateResources(priorities);

    const map = new Map<string, number>();
    for (const alloc of allocations) {
      map.set(alloc.goal_id, alloc.resource_share);
    }

    // Fill in any goal IDs that were not computed (e.g. loadGoal returned null)
    const equalShare = goalIds.length > 0 ? 1.0 / goalIds.length : 0;
    for (const goalId of goalIds) {
      if (!map.has(goalId)) {
        map.set(goalId, equalShare);
      }
    }

    return map;
  }
}
