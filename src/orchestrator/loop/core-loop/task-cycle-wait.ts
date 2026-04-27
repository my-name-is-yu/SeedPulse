import * as path from "node:path";
import type { Goal } from "../../../base/types/goal.js";
import type { WaitExpiryOutcome } from "../../../base/types/strategy.js";
import { ApprovalStore } from "../../../runtime/store/approval-store.js";
import { buildWaitApprovalId } from "../../strategy/portfolio-rebalance.js";
import type { LoopIterationResult } from "./contracts.js";
import type { PhaseCtx } from "./preparation.js";
import { buildWaitObservationActivationContext } from "./task-cycle-stall.js";

const WAIT_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const WAIT_APPROVAL_REMINDER_MS = 15 * 60 * 1000;

export interface WaitStrategyObservationDecision {
  observeOnly: boolean;
  newGenerationNeeded: boolean;
  outcome: WaitExpiryOutcome | null;
}

interface PendingWaitOutcome {
  strategyId: string;
  outcome: WaitExpiryOutcome;
}

export async function evaluateWaitStrategiesForObserveOnly(
  ctx: PhaseCtx,
  goalId: string,
  goal: Goal,
  result: LoopIterationResult
): Promise<WaitStrategyObservationDecision> {
  if (!ctx.deps.portfolioManager) {
    return { observeOnly: false, newGenerationNeeded: false, outcome: null };
  }

  const waitActivationContext = buildWaitObservationActivationContext(
    ctx,
    goalId,
    goal,
    await ctx.deps.stateManager.loadGapHistory(goalId)
  );

  try {
    const portfolio = await ctx.deps.strategyManager.getPortfolio(goalId);
    if (!portfolio) {
      return { observeOnly: false, newGenerationNeeded: false, outcome: null };
    }

    let firstNotDue: PendingWaitOutcome | null = null;

    for (const strategy of portfolio.strategies) {
      if (strategy.state !== "active" || !ctx.deps.portfolioManager.isWaitStrategy(strategy)) {
        continue;
      }

      const waitOutcome = await ctx.deps.portfolioManager.handleWaitStrategyExpiry(
        goalId,
        strategy.id,
        waitActivationContext
      );
      if (!waitOutcome) {
        continue;
      }

      if (waitOutcome.status === "not_due") {
        firstNotDue ??= { strategyId: strategy.id, outcome: waitOutcome };
        continue;
      }

      result.waitStrategyId = strategy.id;
      result.waitExpiryOutcome = waitOutcome;
      result.waitObserveOnly = true;
      result.waitExpired = true;

      if (waitOutcome.status === "approval_required") {
        result.waitApprovalId = await persistWaitApprovalPending(ctx, goalId, strategy, waitOutcome);
      }

      const waitTrigger = waitOutcome.rebalance_trigger ?? null;
      if (waitTrigger) {
        const rebalanceResult = await ctx.deps.portfolioManager.rebalance(goalId, waitTrigger);
        if (rebalanceResult.new_generation_needed) {
          await ctx.deps.strategyManager.onStallDetected(
            goalId,
            3,
            goal.origin ?? "general",
            waitActivationContext
          );
          result.waitObserveOnly = false;
          return { observeOnly: false, newGenerationNeeded: true, outcome: waitOutcome };
        }
      }
      return { observeOnly: true, newGenerationNeeded: false, outcome: waitOutcome };
    }

    if (firstNotDue) {
      result.waitStrategyId = firstNotDue.strategyId;
      result.waitExpiryOutcome = firstNotDue.outcome;
      result.waitObserveOnly = true;
      result.waitSuppressed = true;
      return { observeOnly: true, newGenerationNeeded: false, outcome: firstNotDue.outcome };
    }
  } catch (err) {
    ctx.logger?.warn("CoreLoop: wait observation failed (non-fatal)", {
      goalId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { observeOnly: false, newGenerationNeeded: false, outcome: null };
}

async function persistWaitApprovalPending(
  ctx: PhaseCtx,
  goalId: string,
  strategy: { id: string; wait_until?: unknown },
  outcome: WaitExpiryOutcome
): Promise<string | undefined> {
  const strategyId = strategy.id;
  try {
    const now = Date.now();
    const approvalId = buildWaitApprovalId(goalId, strategyId);
    const timeoutMs = WAIT_APPROVAL_TIMEOUT_MS;
    const nextObserveAt = new Date(now + WAIT_APPROVAL_REMINDER_MS).toISOString();
    const expiresAt = new Date(now + timeoutMs).toISOString();
    const task = {
      id: `wait:${strategyId}`,
      description: outcome.details ?? "WaitStrategy requires approval before continuing",
      action: "wait_strategy_resume_approval",
    };

    if (ctx.deps.waitApprovalBroker) {
      void ctx.deps.waitApprovalBroker.requestApproval(goalId, task, timeoutMs, approvalId).catch((err) => {
        ctx.logger?.warn("CoreLoop: wait approval broker request failed", {
          goalId,
          strategyId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      await postponeWaitObservationForApproval(ctx, goalId, strategy, approvalId, nextObserveAt, expiresAt);
      return approvalId;
    }

    const baseDir = typeof ctx.deps.stateManager.getBaseDir === "function"
      ? ctx.deps.stateManager.getBaseDir()
      : null;
    if (!baseDir) return undefined;

    const approvalStore = new ApprovalStore(path.join(baseDir, "runtime"));
    await approvalStore.savePending({
      approval_id: approvalId,
      goal_id: goalId,
      request_envelope_id: approvalId,
      correlation_id: approvalId,
      state: "pending",
      created_at: now,
      expires_at: now + timeoutMs,
      payload: {
        task,
        wait_strategy_id: strategyId,
        wait_outcome: outcome,
      },
    });
    await postponeWaitObservationForApproval(ctx, goalId, strategy, approvalId, nextObserveAt, expiresAt);
    return approvalId;
  } catch (err) {
    ctx.logger?.warn("CoreLoop: failed to persist wait approval request", {
      goalId,
      strategyId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

async function postponeWaitObservationForApproval(
  ctx: PhaseCtx,
  goalId: string,
  strategy: { id: string; wait_until?: unknown },
  approvalId: string,
  nextObserveAt: string,
  expiresAt: string
): Promise<void> {
  try {
    const metadataPath = `strategies/${goalId}/wait-meta/${strategy.id}.json`;
    const raw = await ctx.deps.stateManager.readRaw(metadataPath);
    const metadata = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const waitUntil = typeof metadata["wait_until"] === "string"
      ? metadata["wait_until"]
      : typeof strategy.wait_until === "string"
        ? strategy.wait_until
        : nextObserveAt;
    const conditions = Array.isArray(metadata["conditions"]) && metadata["conditions"].length > 0
      ? metadata["conditions"]
      : [{ type: "time_until", until: waitUntil }];

    await ctx.deps.stateManager.writeRaw(metadataPath, {
      ...metadata,
      schema_version: 1,
      wait_until: waitUntil,
      conditions,
      resume_plan: metadata["resume_plan"] ?? { action: "complete_wait" },
      next_observe_at: nextObserveAt,
      latest_observation: {
        status: "pending",
        evidence: {
          approval_pending: true,
          approval_id: approvalId,
        },
        next_observe_at: nextObserveAt,
        confidence: 1,
        resume_hint: "waiting_for_approval",
      },
      approval_pending: {
        approval_id: approvalId,
        requested_at: new Date().toISOString(),
        next_reminder_at: nextObserveAt,
        expires_at: expiresAt,
      },
    });
  } catch (err) {
    ctx.logger?.warn("CoreLoop: failed to postpone wait observation for approval", {
      goalId,
      strategyId: strategy.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
