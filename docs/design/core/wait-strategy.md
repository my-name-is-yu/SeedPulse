# WaitStrategy Design Document

> Cross-cutting concern: WaitStrategy is not a standalone module. It is a schema
> (`strategy/types/strategy.ts`) with behavior split across PortfolioManager,
> StallDetector, TimeHorizonEngine, and StrategyManager. This document describes
> the integration seams. For schema details see portfolio-management.md §7; for
> stall suppression see stall-detection.md §2.5.

> Current implementation note: file paths and loop-phase names in this document predate parts of the CoreLoop redesign. Read the intent as current, but verify exact ownership against `src/orchestrator/strategy/`, `src/orchestrator/loop/`, and `src/platform/drive/`.

---

## 1. Why WaitStrategy Exists

Many actions have delayed effects: deploying a marketing campaign, publishing
documentation, training a model. When PulSeed detects no gap improvement after
such an action, the correct response is sometimes "wait and re-measure," not
"pivot." WaitStrategy formalizes this decision so that intentional waits are
distinguishable from genuine stalls. (vision.md §5.4: "Knowing when to measure
for meaningful results — this sense of timing is also part of strategy.")

---

## 2. Responsibility Boundary

| Module | Responsibility |
|--------|----------------|
| **TimeHorizonEngine** | "Can we afford to wait?" — `canAffordWait` closure inside `TimeBudgetWithWait` (time-horizon.md §10) |
| **PortfolioManager** | "Should we wait?" — expiry handling via `handleWaitStrategyExpiry`, duck-type check via `isWaitStrategy` (portfolio-management.md §7) |
| **StallDetector** | Evaluates `isSuppressed(plateauUntil)` when the loop decides whether a dimension should participate in stall detection (stall-detection.md §2.5) |
| **StrategyManager** | Creates WaitStrategy instances via `createWaitStrategy()` with `state=candidate`, `allocation=0`, and mirrors `wait_until` into the active task's `plateau_until` on activation |
| **CoreLoop task cycle** | Collects active WaitStrategies, suppresses stalled dimensions whose wait window is still open, and later calls expiry handling |

No single module owns the full wait lifecycle. This is intentional — each module
answers exactly one question.

---

## 3. Type Reference

WaitStrategy extends the base `Strategy` schema:

```typescript
// src/orchestrator/strategy/types/strategy.ts
export const WaitStrategySchema = StrategySchema.extend({
  wait_reason: z.string(),                    // Why we are waiting
  wait_until: z.string(),                     // ISO datetime — re-evaluation time
  measurement_plan: z.string(),               // How to measure post-wait
  fallback_strategy_id: z.string().nullable(), // Fallback if wait fails; null = rebalance
});
```

Key base-schema fields used by wait logic:

| Field | Type | Role |
|-------|------|------|
| `gap_snapshot_at_start` | `number \| null` | Baseline gap captured when strategy becomes active. `handleWaitStrategyExpiry` returns null (skips evaluation) if this is null. |
| `primary_dimension` | `string` | Canonical dimension for this wait. Expiry comparison and stall suppression both key off this field. |
| `allocation` | `number` | Always `0` for WaitStrategy — it generates no tasks. |

Duck-type detection (`isWaitStrategy` in `portfolio-allocation.ts`):

```typescript
export function isWaitStrategy(strategy: Record<string, unknown>): boolean {
  return (
    typeof strategy["wait_reason"] === "string" &&
    typeof strategy["wait_until"] === "string" &&
    typeof strategy["measurement_plan"] === "string"
  );
}
```

**Note on `gap_snapshot_at_start`**: `createWaitStrategy()` initializes this
field as `null`. The snapshot is captured when the strategy transitions to
`active` state (via `activateMultiple` in StrategyManager). If it remains null
at expiry time, the expiry handler silently returns null — no evaluation occurs.

---

## 4. Implemented Lifecycle

The lifecycle follows the path: **candidate → active → expiry check → outcome**.

**Creation** (`StrategyManager.createWaitStrategy`):
- Sets `state="candidate"`, `allocation=0`, `gap_snapshot_at_start=null`.
- WaitStrategy-specific fields (`wait_reason`, `wait_until`, `measurement_plan`,
  `fallback_strategy_id`) are stored in the portfolio and mirrored into
  `strategies/<goalId>/wait-meta/<strategyId>.json` for durable wait observation metadata.

**Activation**:
- Caller transitions state to `active`. At activation, `gap_snapshot_at_start`
  captures the current gap value — this becomes the baseline for expiry evaluation.
- If the activated strategy is a WaitStrategy, `StrategyManager.activateMultiple()`
  mirrors `wait_until` into the current task's `plateau_until`. The active task file
  is preferred; `task-history.json` is only a fallback lookup path.

**Expiry check** (`handleWaitStrategyExpiry` in `portfolio-rebalance.ts`):
1. If `!isWaitStrategy(strategy)` → skip.
2. If `now < wait_until` → skip (wait period not over).
3. If `gap_snapshot_at_start === null` → skip (no baseline to compare).
4. Compute `gapDelta = currentGap - startGap`.

| gapDelta | Outcome |
|----------|---------|
| `< 0` (gap improved) | Return null — wait succeeded, normal evaluation continues |
| `=== 0` (unchanged) | Activate `fallback_strategy_id` if it exists as a candidate; return null |
| `> 0` (gap worsened) | Return `RebalanceTrigger` with type `stall_detected` |

See portfolio-management.md §7.3 for the full wait execution flow.

---

## 5. CoreLoop Integration

In the current CoreLoop implementation, `iteration-kernel.ts` first checks
whether an active wait should keep the loop in observe-only mode. If the loop
does proceed, `task-cycle.ts` performs stall suppression and
`portfolio-manager.ts` handles WaitStrategy expiry:

```
for each active WaitStrategy in portfolio.strategies:
  if stallDetector.isSuppressed(strategy.wait_until):
    skip dimension stall detection for strategy.primary_dimension

for each strategy in portfolio.strategies:
  if portfolioManager.isWaitStrategy(strategy):
    trigger = portfolioManager.handleWaitStrategyExpiry(goalId, strategy.id)
    if trigger:
      portfolioManager.rebalance(goalId, trigger)
```

The observe-only check happens before normal task generation. Later expiry and
rebalance handling is non-fatal — a WaitStrategy failure does not abort the loop.

**Stall suppression**: The loop currently treats `WaitStrategy.wait_until` as the
authoritative suppression source and uses `StallDetector.isSuppressed(waitUntil)`
to suppress stall detection for the WaitStrategy's `primary_dimension`. This is
intentionally narrower than `target_dimensions`: a wait may be informed by
multiple dimensions, but the actual wait/no-wait decision, baseline snapshot,
and expiry judgment are all anchored to one canonical dimension. The task field
`plateau_until` is a mirror for task-local consumers that do not load the
portfolio. Suppression lifts automatically once the wait timestamp becomes past.

**Current gap**: The `canAffordWait` gate from TimeHorizonEngine is now wired
through CoreLoop stall recovery and wait-expiry fallback activation using
dimension-specific gap history. The remaining limitation is architectural:
external/manual activation paths can still omit the hook, and goals without
usable per-dimension history currently fail closed (the wait cannot be afforded)
rather than falling back to a softer heuristic.

---

## 6. Gaps & Future Work

| Gap | Description |
|-----|-------------|
| **canAffordWait coverage outside CoreLoop** | CoreLoop now passes a dimension-specific `canAffordWait` closure into wait activation and fallback activation, but callers outside that path can still invoke activation without supplying the hook. |
| **History-poor wait activation policy** | When a wait candidate has insufficient per-dimension gap history to estimate velocity, the current policy is fail-closed (`canAffordWait` returns false). This is safer than silently allowing waits, but it may be too strict for very new goals. |
| **Authoritative wait state is split across portfolio + task mirror** | The portfolio WaitStrategy is authoritative for CoreLoop suppression and expiry, while `task.plateau_until` is a best-effort mirror for task-local consumers. Consumers that only read task state must tolerate stale mirrors. |
| **Effect latency estimation** | Heuristic categorization of action types (e.g., "deploy" → hours, "marketing" → days) to auto-suggest `wait_until` durations. Currently the LLM proposes durations without structured guidance. |
| **Adaptive observation frequency** | Reducing observation frequency during waits to save tokens. `TimeHorizonEngine.suggestObservationInterval` exists (time-horizon.md §7) but is not connected to wait state. |
| **LLM-assisted duration estimation** | Using the LLM to estimate effect latency based on action type and domain context. |
| **Wait state telemetry** | Reporting/dashboard integration: time spent waiting, wait success rate, average wait duration vs. actual effect onset. |

---

## 7. Module Location

| Concern | File |
|---------|------|
| WaitStrategy schema + type | `src/orchestrator/strategy/types/strategy.ts` |
| `isWaitStrategy` duck-type check | `src/orchestrator/strategy/portfolio-allocation.ts` |
| `createWaitStrategy` | `src/orchestrator/strategy/strategy-manager.ts` |
| `handleWaitStrategyExpiry` | `src/orchestrator/strategy/portfolio-rebalance.ts` (called via `portfolio-manager.ts`) |
| Activation-time `plateau_until` mirror | `src/orchestrator/strategy/strategy-manager.ts` (`activateMultiple()` / `_applyWaitStrategyPlateauUntil()`) |
| `canAffordWait` closure | `src/platform/time/time-horizon-engine.ts` (`getTimeBudget` return value) |
| `TimeBudgetWithWait` type | `src/base/types/time-horizon.ts` |
| `isSuppressed` (plateau_until) | `src/platform/drive/stall-detector.ts` |
| CoreLoop wait iteration + stall suppression | `src/orchestrator/loop/core-loop/task-cycle.ts` / `src/orchestrator/loop/core-loop/iteration-kernel.ts` |

---

## 8. Design Note: TimeBudgetWithWait

```typescript
// src/base/types/time-horizon.ts
export type TimeBudgetWithWait = TimeBudget & {
  canAffordWait(waitHours: number): boolean;
};
```

This type is **not Zod-parseable** because it contains a closure. This is
intentional — `canAffordWait` captures `remainingHours`, `velocity`, and
`currentGap` at call time via the `getTimeBudget` signature:

```typescript
getTimeBudget(
  deadline: string | null,
  startTime: string,
  currentGap: number,
  initialGap: number,
  velocityPerHour: number
): TimeBudgetWithWait
```

The closure ensures the time check uses a consistent snapshot. Trade-off:
`TimeBudgetWithWait` cannot be serialized to JSON or validated with Zod. It
exists only as an in-memory computation result, never persisted.

`canAffordWait` behavior:
- **No deadline + positive velocity** → always `true` (perpetual goals can wait).
- **No deadline + zero/negative velocity** → `false` (stagnating goals should not wait).
- **With deadline** → checks whether post-wait required velocity would exceed the
  critical pacing threshold.

---

## Summary of Design Decisions

| Decision | Rationale |
|----------|-----------|
| No standalone module | WaitStrategy is a schema + behavior distributed across existing modules |
| Duck-type detection | Strategies are plain Zod-parsed objects; no class hierarchy |
| Closure for `canAffordWait` | Captures time snapshot consistently; avoids passing 5 parameters per call |
| `fallback_strategy_id` nullable | Not every wait has a fallback; null means rebalance from scratch |
| `plateau_until` mirrored onto tasks from WaitStrategy activation | Wait ownership starts in the strategy layer, while task-local mirroring keeps non-portfolio consumers aligned |
| Stall suppression is `primary_dimension`-only | Wait expiry also evaluates one canonical dimension; suppressing every `target_dimension` would hide unrelated stalls behind one wait |
| `allocation=0` for waits | WaitStrategy generates no tasks; allocation is nominal |
