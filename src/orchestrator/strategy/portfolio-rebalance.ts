/**
 * portfolio-rebalance.ts
 *
 * Pure/stateless helpers for PortfolioManager rebalancing logic.
 * Functions here take configuration and data as explicit parameters
 * and return results without side effects (except via the provided
 * callbacks).
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type {
  PortfolioConfig,
  EffectivenessRecord,
  RebalanceResult,
  AllocationAdjustment,
  RebalanceTrigger,
  TaskSelectionResult,
} from "../../base/types/portfolio.js";
import {
  normalizeWaitMetadata,
  resolveWaitNextObserveAt,
  type Strategy,
  type WaitCondition,
  type WaitMetadata,
  type WaitObservationResult,
  type WaitExpiryOutcome,
  type WaitStrategy,
} from "../../base/types/strategy.js";
import { CapabilityRegistrySchema } from "../../base/types/capability.js";

const DEFAULT_WAIT_REOBSERVE_MS = 5 * 60 * 1000;

/**
 * Get the current gap value for a specific dimension of a goal.
 * Reads from gap data provided by the caller (StateManager.readRaw).
 */
export async function getCurrentGapForDimension(
  goalId: string,
  dimension: string,
  readRaw: (path: string) => unknown | Promise<unknown>
): Promise<number | null> {
  const raw = await readRaw(`gaps/${goalId}/current.json`);
  if (!raw || typeof raw !== "object") return null;

  const gaps = raw as Record<string, unknown>;
  const dimensionGap = gaps[dimension];
  if (typeof dimensionGap === "number") return dimensionGap;

  const dimensions = gaps["dimensions"];
  if (dimensions && typeof dimensions === "object") {
    const dimData = (dimensions as Record<string, unknown>)[dimension];
    if (dimData && typeof dimData === "object") {
      const nwg = (dimData as Record<string, unknown>)["normalized_weighted_gap"];
      if (typeof nwg === "number") return nwg;
    }
  }

  return null;
}

/**
 * Calculate gap delta attributed to a strategy using dimension-target matching.
 * Sums gap improvements across the strategy's target_dimensions.
 */
export async function calculateGapDeltaForStrategy(
  strategy: Strategy,
  goalId: string,
  readRaw: (path: string) => unknown | Promise<unknown>
): Promise<number> {
  let totalDelta = 0;

  for (const dimension of strategy.target_dimensions) {
    const currentGap = await getCurrentGapForDimension(goalId, dimension, readRaw);
    if (currentGap === null) continue;

    const baseline = strategy.gap_snapshot_at_start ?? 1.0;
    const delta = baseline - currentGap;
    totalDelta += delta;
  }

  return totalDelta;
}

/**
 * Calculate initial equal-split allocations for N strategies.
 * Single strategy: [1.0].
 * Multiple: equal split clamped to [min_allocation, max_allocation], sum = 1.0.
 */
export function calculateInitialAllocations(
  count: number,
  config: Pick<PortfolioConfig, "min_allocation" | "max_allocation">
): number[] {
  if (count === 1) return [1.0];

  const { min_allocation, max_allocation } = config;
  let base = 1.0 / count;

  base = Math.max(min_allocation, Math.min(max_allocation, base));

  const allocations = new Array<number>(count).fill(base);

  const sum = allocations.reduce((a, b) => a + b, 0);
  if (sum > 0 && Math.abs(sum - 1.0) > 0.001) {
    const factor = 1.0 / sum;
    for (let i = 0; i < allocations.length; i++) {
      allocations[i] = Math.max(
        min_allocation,
        Math.min(max_allocation, allocations[i] * factor)
      );
    }
    const finalSum = allocations.slice(0, -1).reduce((a, b) => a + b, 0);
    allocations[allocations.length - 1] = Math.max(
      min_allocation,
      1.0 - finalSum
    );
  }

  return allocations;
}

/**
 * Count how many consecutive recent rebalances a strategy has been the lowest scorer
 * (i.e., was adjusted down to min_allocation).
 */
export function countConsecutiveLowestRebalances(
  strategyId: string,
  history: RebalanceResult[],
  minAllocation: number
): number {
  let count = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const rebalance = history[i];
    const adjustment = rebalance.adjustments.find(
      (a) => a.strategy_id === strategyId
    );
    if (adjustment && adjustment.new_allocation <= minAllocation) {
      count++;
    } else {
      break;
    }
  }

  return count;
}

/**
 * Redistribute freed allocation proportionally among remaining strategies
 * based on effectiveness scores.
 *
 * Calls updateAllocation(goalId, strategyId, newAllocation) for each change.
 */
export function redistributeAllocation(
  goalId: string,
  remaining: Strategy[],
  records: EffectivenessRecord[],
  freedAllocation: number,
  config: Pick<PortfolioConfig, "max_allocation">,
  result: RebalanceResult,
  updateAllocation: (
    goalId: string,
    strategyId: string,
    allocation: number
  ) => void
): void {
  if (remaining.length === 0 || freedAllocation <= 0) return;

  const scoredRemaining = remaining.map((s) => {
    const record = records.find((r) => r.strategy_id === s.id);
    return {
      strategy: s,
      score: record?.effectiveness_score ?? 0,
    };
  });

  const totalScore = scoredRemaining.reduce(
    (sum, r) => sum + Math.max(r.score, 0),
    0
  );

  for (const { strategy, score } of scoredRemaining) {
    const proportion =
      totalScore > 0
        ? Math.max(score, 0) / totalScore
        : 1.0 / remaining.length;
    const additionalAllocation = freedAllocation * proportion;
    const oldAllocation = strategy.allocation;
    const newAllocation = Math.min(
      config.max_allocation,
      oldAllocation + additionalAllocation
    );

    if (Math.abs(newAllocation - oldAllocation) > 0.001) {
      updateAllocation(goalId, strategy.id, newAllocation);
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
 *
 * Calls updateAllocation(goalId, strategyId, newAllocation) for each change.
 */
export function adjustAllocations(
  goalId: string,
  strategies: Strategy[],
  scoredRecords: EffectivenessRecord[],
  config: Pick<PortfolioConfig, "min_allocation" | "max_allocation">,
  result: RebalanceResult,
  updateAllocation: (
    goalId: string,
    strategyId: string,
    allocation: number
  ) => void
): void {
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

  for (const record of sorted) {
    const strategy = strategies.find((s) => s.id === record.strategy_id);
    if (!strategy) continue;

    const proportion =
      Math.max(record.effectiveness_score ?? 0, 0) / totalScore;
    let targetAllocation = proportion;

    targetAllocation = Math.max(
      config.min_allocation,
      Math.min(config.max_allocation, targetAllocation)
    );

    newAllocations.set(strategy.id, targetAllocation);
  }

  const rawSum = Array.from(newAllocations.values()).reduce((a, b) => a + b, 0);
  if (rawSum > 0 && Math.abs(rawSum - 1.0) > 0.001) {
    const factor = 1.0 / rawSum;
    for (const [id, alloc] of newAllocations) {
      newAllocations.set(
        id,
        Math.max(config.min_allocation, alloc * factor)
      );
    }
  }

  for (const [strategyId, newAllocation] of newAllocations) {
    const strategy = strategies.find((s) => s.id === strategyId);
    if (!strategy) continue;

    const oldAllocation = strategy.allocation;
    if (Math.abs(newAllocation - oldAllocation) > 0.001) {
      updateAllocation(goalId, strategyId, newAllocation);
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
 * Handle expiry of a WaitStrategy.
 *
 * When wait_until has passed:
 * - Gap improved: complete the WaitStrategy
 * - Gap unchanged: activate fallback strategy if one exists, otherwise trigger rebalance
 * - Gap worsened: terminate the WaitStrategy and trigger rebalance
 *
 * @param isWaitStrategy - predicate to detect WaitStrategy instances
 * @param getGap - get current gap for a dimension of a goal
 * @param updateState - transition a strategy to a new state
 * @param getPortfolioStrategies - get all strategies for a goal
 */
export async function handleWaitStrategyExpiry(
  goalId: string,
  strategyId: string,
  strategy: Strategy,
  isWaitStrategy: (s: Strategy) => boolean,
  getGap: (goalId: string, dimension: string) => number | null | Promise<number | null>,
  updateState: (strategyId: string, state: string) => void | Promise<void>,
  activateStrategy: ((goalId: string, strategyId: string) => void | Promise<void>) | undefined,
  getPortfolioStrategies: (goalId: string) => Strategy[] | Promise<Strategy[]>,
  getWaitMetadata?: (goalId: string, strategyId: string) => unknown | null | Promise<unknown | null>,
  getCapabilityRegistry?: () => unknown | null | Promise<unknown | null>,
  getWaitApprovalRecord?: (approvalId: string) => unknown | null | Promise<unknown | null>,
  writeWaitMetadata?: (goalId: string, strategyId: string, metadata: WaitMetadata) => void | Promise<void>,
  getStateBaseDir?: () => string | null | undefined
): Promise<WaitExpiryOutcome> {
  if (!isWaitStrategy(strategy)) {
    return {
      status: "unknown",
      goal_id: goalId,
      strategy_id: strategyId,
      details: "Strategy is not a WaitStrategy",
    };
  }

  const waitStrategy = strategy as unknown as WaitStrategy;
  const metadata = normalizeWaitMetadata(
    waitStrategy,
    await getWaitMetadata?.(goalId, strategyId)
  );
  const nextObserveAt = resolveWaitNextObserveAt(waitStrategy, metadata);
  const waitUntil = nextObserveAt ? new Date(nextObserveAt).getTime() : new Date(waitStrategy.wait_until).getTime();
  const now = Date.now();

  if (now < waitUntil) {
    return {
      status: "not_due",
      goal_id: goalId,
      strategy_id: strategyId,
      details: `WaitStrategy is not due until ${nextObserveAt ?? waitStrategy.wait_until}`,
    };
  }

  const approvalOutcome = await approvalOutcomeFromWaitMetadata(goalId, strategyId, metadata, getCapabilityRegistry, getWaitApprovalRecord);
  if (approvalOutcome) return approvalOutcome;

  const missingCapabilities = await missingRequiredCapabilities(metadata, getCapabilityRegistry);
  if (missingCapabilities.length > 0) {
    const details = `WaitStrategy observation capability missing: ${missingCapabilities.join(", ")}`;
    await persistWaitObservation(goalId, strategyId, metadata, {
      status: "failed",
      evidence: { missing_capabilities: missingCapabilities },
      next_observe_at: nextReobserveAt(now),
      confidence: 0.1,
      resume_hint: "capability_missing",
    }, writeWaitMetadata);
    return {
      status: "unknown",
      goal_id: goalId,
      strategy_id: strategyId,
      details,
      rebalance_trigger: {
        type: "stall_detected",
        strategy_id: strategyId,
        details,
      },
    };
  }

  const observation = await evaluateWaitConditions(metadata.conditions, metadata, {
    nowMs: now,
    stateBaseDir: getStateBaseDir?.() ?? null,
  });
  await persistWaitObservation(goalId, strategyId, metadata, observation, writeWaitMetadata);
  if (observation.status === "pending" || observation.status === "stale") {
    return {
      status: "not_due",
      goal_id: goalId,
      strategy_id: strategyId,
      details: observation.resume_hint ?? `WaitStrategy observation ${observation.status}`,
    };
  }
  if (observation.status === "failed" || observation.status === "expired") {
    return {
      status: "unknown",
      goal_id: goalId,
      strategy_id: strategyId,
      details: observation.resume_hint ?? `WaitStrategy observation ${observation.status}`,
      rebalance_trigger: {
        type: "stall_detected",
        strategy_id: strategyId,
        details: observation.resume_hint ?? `WaitStrategy observation ${observation.status}`,
      },
    };
  }

  const currentGap = await getGap(goalId, strategy.primary_dimension);
  if (currentGap === null) {
    await persistWaitObservation(goalId, strategyId, metadata, {
      status: "failed",
      evidence: { dimension: strategy.primary_dimension, reason: "gap_unavailable" },
      next_observe_at: nextReobserveAt(now),
      confidence: 0.1,
      resume_hint: `current gap is unavailable for ${strategy.primary_dimension}`,
    }, writeWaitMetadata);
    return {
      status: "unknown",
      goal_id: goalId,
      strategy_id: strategyId,
      details: `WaitStrategy expired but current gap is unavailable for ${strategy.primary_dimension}`,
    };
  }

  const startGap = strategy.gap_snapshot_at_start ?? currentGap;
  const gapDelta = currentGap - startGap;

  if (gapDelta < 0) {
    await updateState(strategyId, "completed");
    return {
      status: "improved",
      goal_id: goalId,
      strategy_id: strategyId,
      details: `WaitStrategy expired with gap improvement: ${startGap.toFixed(3)} → ${currentGap.toFixed(3)}`,
    };
  }

  if (gapDelta === 0) {
    if (waitStrategy.fallback_strategy_id) {
      const strategies = await getPortfolioStrategies(goalId);
      const fallback = strategies.find(
        (s) => s.id === waitStrategy.fallback_strategy_id
      );
      if (fallback && fallback.state === "candidate") {
        try {
          if (activateStrategy) {
            await activateStrategy(goalId, fallback.id);
          } else {
            await updateState(fallback.id, "active");
          }
          await updateState(strategyId, "terminated");
          return {
            status: "fallback_activated",
            goal_id: goalId,
            strategy_id: strategyId,
            details: `WaitStrategy expired unchanged; activated fallback strategy ${fallback.id}`,
          };
        } catch (err) {
          await updateState(strategyId, "terminated");
          const details = `WaitStrategy expired unchanged; fallback strategy ${fallback.id} could not be activated: ${err instanceof Error ? err.message : String(err)}`;
          return {
            status: "unchanged",
            goal_id: goalId,
            strategy_id: strategyId,
            details,
            rebalance_trigger: {
              type: "stall_detected",
              strategy_id: strategyId,
              details,
            },
          };
        }
      }
    }
    await updateState(strategyId, "terminated");
    const rebalanceTrigger: RebalanceTrigger = {
      type: "stall_detected",
      strategy_id: strategyId,
      details: `WaitStrategy expired with no gap improvement: ${startGap.toFixed(3)} → ${currentGap.toFixed(3)}`,
    };
    return {
      status: "unchanged",
      goal_id: goalId,
      strategy_id: strategyId,
      details: rebalanceTrigger.details,
      rebalance_trigger: rebalanceTrigger,
    };
  }

  await updateState(strategyId, "terminated");
  const rebalanceTrigger: RebalanceTrigger = {
    type: "stall_detected",
    strategy_id: strategyId,
    details: `WaitStrategy expired with gap worsening: ${startGap.toFixed(3)} → ${currentGap.toFixed(3)}`,
  };
  return {
    status: "worsened",
    goal_id: goalId,
    strategy_id: strategyId,
    details: rebalanceTrigger.details,
    rebalance_trigger: rebalanceTrigger,
  };
}

async function approvalOutcomeFromWaitMetadata(
  goalId: string,
  strategyId: string,
  metadata: WaitMetadata,
  getCapabilityRegistry?: () => unknown | null | Promise<unknown | null>,
  getWaitApprovalRecord?: (approvalId: string) => unknown | null | Promise<unknown | null>
): Promise<WaitExpiryOutcome | null> {
  const resumePlan = metadata.resume_plan;
  if (resumePlan.action === "request_approval") {
    const existingApproval = await getApprovedWaitApproval(goalId, strategyId, getWaitApprovalRecord);
    if (existingApproval) return null;
    return {
      status: "approval_required",
      goal_id: goalId,
      strategy_id: strategyId,
      details: resumePlan.reason ?? "WaitStrategy requires approval before continuing",
    };
  }

  const approvalPolicy = asRecord(metadata.approval_policy);
  if (!approvalPolicy) return null;

  const required = approvalPolicy["required"] === true || approvalPolicy["requires_approval"] === true;
  if (!required) return null;

  const existingApproval = await getApprovedWaitApproval(goalId, strategyId, getWaitApprovalRecord);
  if (existingApproval) return null;

  const capabilityName = typeof approvalPolicy["capability"] === "string"
    ? approvalPolicy["capability"]
    : typeof approvalPolicy["approved_capability"] === "string"
      ? approvalPolicy["approved_capability"]
      : null;
  if (capabilityName && await hasAvailableCapability(capabilityName, getCapabilityRegistry)) {
    return null;
  }

  return {
    status: "approval_required",
    goal_id: goalId,
    strategy_id: strategyId,
    details: capabilityName
      ? `WaitStrategy requires approved capability: ${capabilityName}`
      : "WaitStrategy requires approval before continuing",
  };
}

async function getApprovedWaitApproval(
  goalId: string,
  strategyId: string,
  getWaitApprovalRecord?: (approvalId: string) => unknown | null | Promise<unknown | null>
): Promise<boolean> {
  if (!getWaitApprovalRecord) return false;
  const record = await getWaitApprovalRecord(buildWaitApprovalId(goalId, strategyId));
  if (!record || typeof record !== "object") return false;
  return (record as Record<string, unknown>)["state"] === "approved";
}

async function missingRequiredCapabilities(
  metadata: WaitMetadata,
  getCapabilityRegistry?: () => unknown | null | Promise<unknown | null>
): Promise<string[]> {
  const raw = (metadata as Record<string, unknown>)["required_capabilities"];
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const missing: string[] = [];
  for (const item of raw) {
    const name = typeof item === "string"
      ? item
      : asRecord(item) && typeof asRecord(item)?.["name"] === "string"
        ? asRecord(item)?.["name"] as string
        : null;
    if (!name) continue;
    if (!await hasAvailableCapability(name, getCapabilityRegistry)) missing.push(name);
  }
  return missing;
}

async function hasAvailableCapability(
  capabilityName: string,
  getCapabilityRegistry?: () => unknown | null | Promise<unknown | null>
): Promise<boolean> {
  if (!getCapabilityRegistry) return false;
  const raw = await getCapabilityRegistry();
  const parsed = CapabilityRegistrySchema.safeParse(raw);
  if (!parsed.success) return false;
  return parsed.data.capabilities.some(
    (capability) => capability.name === capabilityName && capability.status === "available"
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

interface WaitConditionEvaluationContext {
  nowMs: number;
  stateBaseDir: string | null;
}

async function evaluateWaitConditions(
  conditions: WaitCondition[],
  metadata: WaitMetadata,
  context: WaitConditionEvaluationContext
): Promise<WaitObservationResult> {
  const results = await Promise.all(conditions.map((condition) => evaluateWaitCondition(condition, metadata, context)));
  const evidence = {
    conditions: results.map((result) => result.evidence),
  };

  const failed = results.find((result) => result.status === "failed" || result.status === "expired");
  if (failed) {
    return {
      status: failed.status,
      evidence,
      next_observe_at: nextReobserveAt(context.nowMs),
      confidence: 0.1,
      resume_hint: failed.resumeHint ?? null,
    };
  }

  const pending = results.find((result) => result.status === "pending" || result.status === "stale");
  if (pending) {
    return {
      status: pending.status,
      evidence,
      next_observe_at: pending.nextObserveAt ?? nextReobserveAt(context.nowMs),
      confidence: 0.4,
      resume_hint: pending.resumeHint ?? null,
    };
  }

  return {
    status: "satisfied",
    evidence,
    next_observe_at: null,
    confidence: 0.9,
    resume_hint: "wait_conditions_satisfied",
  };
}

interface ConditionEvaluation {
  status: WaitObservationResult["status"];
  evidence: Record<string, unknown>;
  nextObserveAt?: string | null;
  resumeHint?: string | null;
}

async function evaluateWaitCondition(
  condition: WaitCondition,
  metadata: WaitMetadata,
  context: WaitConditionEvaluationContext
): Promise<ConditionEvaluation> {
  try {
    switch (condition.type) {
      case "time_until": {
        const untilMs = Date.parse(condition.until);
        if (!Number.isFinite(untilMs)) {
          return failedCondition(condition, "invalid_time_until");
        }
        if (untilMs > context.nowMs) {
          return {
            status: "pending",
            evidence: { condition, due_at: condition.until },
            nextObserveAt: condition.until,
            resumeHint: `waiting until ${condition.until}`,
          };
        }
        return satisfiedCondition(condition, { due_at: condition.until });
      }
      case "file_exists": {
        const target = resolveConditionPath(condition.path, context.stateBaseDir);
        if (!target) return failedCondition(condition, `path escapes state base: ${condition.path}`);
        try {
          await fsp.access(target);
          return satisfiedCondition(condition, { path: target });
        } catch {
          return pendingCondition(condition, `file not found: ${condition.path}`);
        }
      }
      case "file_mtime_changed": {
        const target = resolveConditionPath(condition.path, context.stateBaseDir);
        if (!target) return failedCondition(condition, `path escapes state base: ${condition.path}`);
        try {
          const stats = await fsp.stat(target);
          if (stats.mtimeMs > condition.previous_mtime_ms) {
            return satisfiedCondition(condition, { path: target, mtime_ms: stats.mtimeMs });
          }
          return staleCondition(condition, `file mtime unchanged: ${condition.path}`, { path: target, mtime_ms: stats.mtimeMs });
        } catch {
          return pendingCondition(condition, `file not found: ${condition.path}`);
        }
      }
      case "process_session_exited": {
        const snapshot = await readProcessSessionSnapshot(condition.session_id, metadata, context.stateBaseDir);
        if (!snapshot) {
          return pendingCondition(condition, `process session metadata not found: ${condition.session_id}`);
        }
        const running = snapshot["running"] === true;
        const exited = running === false
          || snapshot["exitCode"] !== null && snapshot["exitCode"] !== undefined
          || typeof snapshot["exitedAt"] === "string"
          || typeof snapshot["signal"] === "string";
        if (exited) {
          return satisfiedCondition(condition, {
            session_id: condition.session_id,
            exitCode: snapshot["exitCode"] ?? null,
            signal: snapshot["signal"] ?? null,
            exitedAt: snapshot["exitedAt"] ?? null,
          });
        }
        if (typeof snapshot["pid"] === "number" && !isProcessAlive(snapshot["pid"])) {
          return satisfiedCondition(condition, {
            session_id: condition.session_id,
            pid: snapshot["pid"],
            inferred_exit: true,
          });
        }
        return staleCondition(condition, `process session still running: ${condition.session_id}`, {
          session_id: condition.session_id,
          pid: snapshot["pid"] ?? null,
        });
      }
      case "artifact_json_value": {
        const target = resolveConditionPath(condition.path, context.stateBaseDir);
        if (!target) return failedCondition(condition, `path escapes state base: ${condition.path}`);
        try {
          const parsed = JSON.parse(await fsp.readFile(target, "utf8"));
          const actual = readJsonPointer(parsed, condition.json_pointer);
          if (jsonEqual(actual, condition.expected)) {
            return satisfiedCondition(condition, { path: target, json_pointer: condition.json_pointer, actual });
          }
          return staleCondition(condition, `artifact value did not match: ${condition.path} ${condition.json_pointer}`, {
            path: target,
            json_pointer: condition.json_pointer,
            actual,
            expected: condition.expected,
          });
        } catch (err) {
          return pendingCondition(condition, `artifact JSON unavailable: ${condition.path}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      case "metric_threshold": {
        const actual = readMetric(metadata, condition.metric);
        if (typeof actual !== "number") {
          return pendingCondition(condition, `metric unavailable: ${condition.metric}`);
        }
        if (compareMetric(actual, condition.operator, condition.value)) {
          return satisfiedCondition(condition, { metric: condition.metric, actual, operator: condition.operator, value: condition.value });
        }
        return staleCondition(condition, `metric threshold not reached: ${condition.metric}`, {
          metric: condition.metric,
          actual,
          operator: condition.operator,
          value: condition.value,
        });
      }
    }
  } catch (err) {
    return failedCondition(condition, err instanceof Error ? err.message : String(err));
  }
}

function satisfiedCondition(condition: WaitCondition, evidence: Record<string, unknown> = {}): ConditionEvaluation {
  return { status: "satisfied", evidence: { condition, ...evidence } };
}

function pendingCondition(
  condition: WaitCondition,
  resumeHint: string,
  evidence: Record<string, unknown> = {}
): ConditionEvaluation {
  return { status: "pending", evidence: { condition, ...evidence }, resumeHint };
}

function staleCondition(
  condition: WaitCondition,
  resumeHint: string,
  evidence: Record<string, unknown> = {}
): ConditionEvaluation {
  return { status: "stale", evidence: { condition, ...evidence }, resumeHint };
}

function failedCondition(condition: WaitCondition, resumeHint: string): ConditionEvaluation {
  return { status: "failed", evidence: { condition, error: resumeHint }, resumeHint };
}

async function persistWaitObservation(
  goalId: string,
  strategyId: string,
  metadata: WaitMetadata,
  observation: WaitObservationResult,
  writeWaitMetadata?: (goalId: string, strategyId: string, metadata: WaitMetadata) => void | Promise<void>
): Promise<void> {
  if (!writeWaitMetadata) return;
  try {
    await writeWaitMetadata(goalId, strategyId, {
      ...metadata,
      next_observe_at: observation.next_observe_at,
      latest_observation: observation,
    });
  } catch {
    // Durable observation sidecars are fail-soft; wait expiry can still decide from live state.
  }
}

function nextReobserveAt(nowMs: number): string {
  return new Date(nowMs + DEFAULT_WAIT_REOBSERVE_MS).toISOString();
}

function resolveConditionPath(inputPath: string, stateBaseDir: string | null): string | null {
  const base = path.resolve(stateBaseDir ?? process.cwd());
  const resolved = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(base, inputPath);
  const relative = path.relative(base, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return resolved;
}

async function readProcessSessionSnapshot(
  sessionId: string,
  metadata: WaitMetadata,
  stateBaseDir: string | null
): Promise<Record<string, unknown> | null> {
  if (!isSafeSessionId(sessionId)) return null;
  const refs = metadata.process_refs.filter((ref) => ref["session_id"] === sessionId);
  const candidates = [
    ...refs.flatMap((ref) => [
      typeof ref["metadata_path"] === "string" ? safeRuntimeMetadataPath(ref["metadata_path"], stateBaseDir) : null,
      typeof ref["metadata_relative_path"] === "string" && stateBaseDir
        ? resolveConditionPath(ref["metadata_relative_path"], stateBaseDir)
        : null,
    ]),
    stateBaseDir ? path.join(stateBaseDir, "runtime", "process-sessions", `${sessionId}.json`) : null,
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await fsp.readFile(candidate, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(sessionId) && sessionId !== "." && sessionId !== "..";
}

function safeRuntimeMetadataPath(inputPath: string, stateBaseDir: string | null): string | null {
  if (!stateBaseDir) return inputPath;
  const base = path.resolve(stateBaseDir);
  const resolved = path.resolve(inputPath);
  const relative = path.relative(base, resolved);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return resolved;
  }
  return null;
}

function readJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return value;
  const parts = pointer.startsWith("/")
    ? pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    : pointer.split(".");
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number.parseInt(part, 10);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readMetric(metadata: WaitMetadata, metric: string): number | null {
  const candidates: unknown[] = [
    (metadata as Record<string, unknown>)[metric],
    asRecord((metadata as Record<string, unknown>)["metrics"])?.[metric],
    metadata.latest_observation?.evidence[metric],
    asRecord(metadata.latest_observation?.evidence["metrics"])?.[metric],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number") return candidate;
  }
  return null;
}

function compareMetric(actual: number, operator: "lt" | "lte" | "eq" | "gte" | "gt", expected: number): boolean {
  switch (operator) {
    case "lt": return actual < expected;
    case "lte": return actual <= expected;
    case "eq": return actual === expected;
    case "gte": return actual >= expected;
    case "gt": return actual > expected;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function buildWaitApprovalId(goalId: string, strategyId: string): string {
  return `wait-${encodeURIComponent(goalId)}-${encodeURIComponent(strategyId)}`;
}

export function rebalanceTriggerFromWaitExpiryOutcome(
  outcome: WaitExpiryOutcome | null | undefined
): RebalanceTrigger | null {
  return outcome?.rebalance_trigger ?? null;
}

/**
 * Select the next strategy across multiple goals.
 *
 * Sorts goals by "saturation ratio" (tasks dispatched / allocation) — the most
 * underserved goal (lowest saturation) gets the next task. Within that goal,
 * selectStrategyForTask() picks the best strategy.
 *
 * @param goalTaskCounts - map of goalId → total tasks dispatched
 * @param selectStrategyForTask - select best strategy within one goal
 */
export async function selectNextStrategyAcrossGoals(
  goalIds: string[],
  goalAllocations: Map<string, number>,
  goalTaskCounts: Map<string, number>,
  selectStrategyForTask: (goalId: string) => TaskSelectionResult | null | Promise<TaskSelectionResult | null>
): Promise<{
  goal_id: string;
  strategy_id: string | null;
  selection_reason: string;
} | null> {
  if (goalIds.length === 0) return null;

  const scored = goalIds.map((goalId) => {
    const allocation = goalAllocations.get(goalId) ?? (1 / goalIds.length);
    const taskCount = goalTaskCounts.get(goalId) ?? 0;
    const saturation = allocation > 0 ? taskCount / allocation : Infinity;
    return { goalId, saturation, allocation };
  });

  scored.sort((a, b) => a.saturation - b.saturation);

  for (const { goalId, saturation } of scored) {
    const allocation = goalAllocations.get(goalId) ?? 0;
    if (allocation <= 0) continue;

    const selectionResult = await selectStrategyForTask(goalId);
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
