import { PortfolioSchema } from "../../base/types/strategy.js";
import {
  normalizeWaitMetadata,
  resolveWaitNextObserveAt,
  type WaitMetadata,
  type WaitStrategy,
} from "../../base/types/strategy.js";
import { isWaitStrategy } from "../../orchestrator/strategy/portfolio-allocation.js";

export interface WaitDeadlineResolution {
  next_observe_at: string | null;
  waiting_goals: Array<{
    goal_id: string;
    strategy_id: string;
    next_observe_at: string;
    wait_until: string;
    wait_reason: string;
  }>;
}

export interface WaitDeadlineResolverState {
  readRaw(path: string): Promise<unknown | null>;
}

export class WaitDeadlineResolver {
  constructor(private readonly stateManager: WaitDeadlineResolverState) {}

  async resolve(goalIds: string[]): Promise<WaitDeadlineResolution> {
    const waitingGoals: WaitDeadlineResolution["waiting_goals"] = [];

    for (const goalId of goalIds) {
      const rawPortfolio = await this.stateManager.readRaw(`strategies/${goalId}/portfolio.json`);
      if (!rawPortfolio) continue;

      const portfolio = PortfolioSchema.safeParse(rawPortfolio);
      if (!portfolio.success) continue;

      for (const strategy of portfolio.data.strategies) {
        if (!isWaitStrategy(strategy as Record<string, unknown>)) continue;
        if (strategy.state !== "active") continue;

        const waitStrategy = strategy as WaitStrategy;
        const rawMetadata = await this.stateManager.readRaw(
          `strategies/${goalId}/wait-meta/${waitStrategy.id}.json`
        );
        const metadata = normalizeWaitMetadata(waitStrategy, rawMetadata);
        const nextObserveAt = resolveNextObserveAt(waitStrategy, metadata);
        if (!nextObserveAt) continue;

        waitingGoals.push({
          goal_id: goalId,
          strategy_id: waitStrategy.id,
          next_observe_at: nextObserveAt,
          wait_until: waitStrategy.wait_until,
          wait_reason: waitStrategy.wait_reason,
        });
      }
    }

    waitingGoals.sort((a, b) => Date.parse(a.next_observe_at) - Date.parse(b.next_observe_at));

    return {
      next_observe_at: waitingGoals[0]?.next_observe_at ?? null,
      waiting_goals: waitingGoals,
    };
  }

  clampInterval(intervalMs: number, resolution: WaitDeadlineResolution, nowMs = Date.now()): number {
    return clampIntervalToNextWaitDeadline(intervalMs, resolution.next_observe_at, nowMs);
  }
}

export function resolveNextObserveAt(
  waitStrategy: WaitStrategy,
  metadata: WaitMetadata
): string | null {
  return resolveWaitNextObserveAt(waitStrategy, metadata);
}

export function getDueWaitGoalIds(
  resolution: WaitDeadlineResolution,
  nowMs = Date.now()
): string[] {
  const dueGoalIds = new Set<string>();
  for (const goal of resolution.waiting_goals) {
    const observeAtMs = Date.parse(goal.next_observe_at);
    if (!Number.isFinite(observeAtMs)) continue;
    if (observeAtMs <= nowMs) {
      dueGoalIds.add(goal.goal_id);
    }
  }
  return [...dueGoalIds];
}

export function clampIntervalToNextWaitDeadline(
  intervalMs: number,
  nextObserveAt: string | null | undefined,
  nowMs = Date.now()
): number {
  if (!nextObserveAt) return intervalMs;
  const nextObserveMs = Date.parse(nextObserveAt);
  if (!Number.isFinite(nextObserveMs)) return intervalMs;
  const waitMs = Math.max(0, nextObserveMs - nowMs);
  return Math.min(intervalMs, waitMs);
}
