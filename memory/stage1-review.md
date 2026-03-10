# Stage 1 Implementation Review

Reviewed: 2026-03-10
Reviewer: QA agent (claude-sonnet-4-6)
Files reviewed: src/types/*.ts, src/state-manager.ts, src/gap-calculator.ts, src/index.ts, tests/state-manager.test.ts, tests/gap-calculator.test.ts

---

## Overall Assessment: NEEDS REVISION

One P0 bug (null-value raw_gap for `max` type), several P1 design mismatches, and minor P2 quality issues. The pipeline structure is sound and tests are well-written; the issues are targeted and fixable.

---

## PASS Items

- **Gap pipeline structure**: Three-step pipeline (raw → normalized → weighted) matches gap-calculation.md §1–3 exactly. Confidence adjustment applied only once (§3), no triple-application.
- **All 5 threshold types implemented**: min, max, range, present, match all present in `computeRawGap` and `normalizeGap`.
- **Zero-division guards**: Correct for min (threshold=0 → 1.0 or 0.0), range (halfWidth=0 → same), max (threshold=0 → cap at 1.0).
- **null current_value handling**: Returns normalized_gap=1.0 and skips confidence weighting. Correct per gap-calculation.md §1 and §3.
- **Null guard for confidence weighting**: `applyConfidenceWeight` correctly passes through the gap when `currentValueIsNull=true`.
- **Aggregation methods**: max (bottleneck default), weighted_avg, sum all implemented per gap-calculation.md §6.
- **Trust constants**: HIGH_TRUST_THRESHOLD=20, HIGH_CONFIDENCE_THRESHOLD=0.50, TRUST_SUCCESS_DELTA=+3, TRUST_FAILURE_DELTA=-10. All match trust-and-safety.md §2 exactly.
- **TrustBalance schema**: balance range [-100, +100] with correct defaults. Matches design.
- **ActionQuadrant enum**: `autonomous`, `execute_with_confirm`, `observe_and_propose` — correct 3-quadrant mapping (note: design has 4 quadrants, 2 of which use the same "execute with confirm" behavior — collapsing them is fine here).
- **Stall enums**: StallTypeEnum (dimension_stall, time_exceeded, consecutive_failure, global_stall) and StallCauseEnum (information_deficit, approach_failure, capability_limit, external_dependency, goal_infeasible) match stall-detection.md §2 and §3.
- **StateManager atomic writes**: Writes to `.tmp` then `fs.renameSync` — correct pattern. Test confirms no `.tmp` files remain after write.
- **StateManager file layout**: `goals/<id>/goal.json`, `goals/<id>/observations.json`, `goals/<id>/gap-history.json`, `goal-trees/<root_id>.json` — matches design.
- **Constructor base dir override**: `constructor(baseDir?: string)` — tests correctly use temp dir.
- **ESM imports**: All internal imports use `.js` extensions. Correct for ESM TypeScript.
- **Zod pattern**: All schemas export both the schema object and the inferred type. Clean.
- **Barrel exports**: `src/index.ts` and `src/types/index.ts` export everything needed. No obvious missing exports.
- **Test coverage breadth**: All 5 threshold types tested for computeRawGap, normalizeGap, and full pipeline. StateManager CRUD, atomic writes, and all 4 data types tested. 57 + 22 = 79 tests total.
- **Doc example verification test** (`gap-calculator.test.ts` line 537): Verifies the exact examples from gap-calculation.md. Good.

---

## FAIL Items

### P0: Incorrect null raw_gap for `max` threshold

**File**: `src/gap-calculator.ts`, line 44
**Code**:
```typescript
case "max":
  return threshold.value; // treat as max gap from 0 to threshold
```

**Problem**: For a `max(N)` threshold, the raw_gap formula is `max(0, current - threshold)`. The "maximum possible gap" when current=null is NOT `threshold.value` — it is undefined/unbounded. The design in gap-calculation.md §1 (null guard) says: "数値型（min/max/range）→ raw_gap = threshold 全体を未達とみなす最大ギャップ". For `min`, returning `threshold.value` makes sense (full undershoot from 0 to threshold). For `max`, returning `threshold.value` is wrong: the gap for `max` is `current - threshold`, not `threshold - current`. A null value on a `max` threshold represents exceeding the threshold by an unknown amount; returning `threshold.value` (e.g., 0.05) makes the raw_gap 0.05 for a max(0.05) threshold — but normalized, 0.05/0.05=1.0, which is correct by coincidence. However, semantically this is the wrong formula and will produce incorrect results if threshold=0 (0/0 falls into the guard) or in any context where raw_gap is used directly (not normalized).

**Correct fix**: For null + max, the intent is maximum gap (1.0 normalized). Since raw_gap for max is `current - threshold`, the "maximum gap" when current=null should represent `current ≫ threshold`. A clean approach matching the min pattern: return `threshold.value` only makes sense if the normalization `raw_gap / threshold` gives 1.0, which it does when threshold≠0. But this is logically inconsistent (we're returning a value shaped like the wrong formula). The clearest fix is to set null raw_gap for `max` to a sentinel that normalizes to 1.0. If we keep the current convention (return threshold.value for null on numeric types), the test at line 47 passes, but the semantic correctness depends entirely on the normalizer dividing by the same threshold. **At minimum, this must be explicitly documented as a convention, not left as a coincidence.** A safer approach: return `null` guard at `normalizeGap` level directly (already done — `currentValue === null → return 1.0`), and for `max` null raw_gap return any positive value. The current code is fragile if threshold=0: `computeRawGap(null, {type:"max", value:0})` returns 0, then `normalizeGap(0, {type:"max",value:0}, null)` returns 1.0 (null guard) — OK. But if someone calls `computeRawGap` independently and uses the raw value, they get 0 for max null, which is misleading.

**Recommended fix** (minimal): Change the `max` null case to use a non-zero sentinel consistent with the formula. The `min` convention (return threshold.value) is defensible for `min` because `threshold - 0 = threshold`. For `max` the formula is `current - threshold`; returning `threshold.value` has no formula basis. The least surprising fix: for `max` null, return `threshold.value` and add a comment explaining it is a conventional maximum placeholder, not derived from the formula — OR, simpler, accept that the null guard in `normalizeGap` at line 99 handles all numeric null cases correctly regardless of raw_gap value, and change the max null raw_gap to any positive number (e.g., `threshold.value` with an explicit comment).

**Verdict**: The test at line 45–47 (`expect(computeRawGap(null, threshold)).toBe(0.05)`) passes, and the normalized result is 1.0 due to the normalizer's null guard. The pipeline end-result is correct. However, the raw_gap value itself (0.05 for max) is semantically wrong, which will cause confusion when this value is used outside the normalizer or when `threshold.value = 0`. Mark as **P0** because it is a formula-level bug that is currently masked by the null guard in step 2.

---

### P1-A: `max` normalization guard is incorrect for threshold=0

**File**: `src/gap-calculator.ts`, lines 111–113
**Code**:
```typescript
case "max": {
  if (threshold.value === 0) {
    return Math.min(rawGap, 1.0);
  }
  return rawGap / threshold.value;
}
```

**Design spec** (gap-calculation.md §2 `max(N)` guard): "ガード条件: `threshold = 0` の場合、`raw_gap` をそのまま使用し 1.0 にキャップする"

**Problem**: The design says "raw_gap をそのまま使用し 1.0 にキャップする", which means `min(raw_gap, 1.0)`. The code does `Math.min(rawGap, 1.0)`. This is correct.

**Test** (line 157–162):
```typescript
expect(normalizeGap(0, t, 0)).toBe(0.0);       // raw_gap=0 → 0. ✓
expect(normalizeGap(0.5, t, 0.5)).toBe(0.5);   // min(0.5, 1.0) = 0.5 ✓
expect(normalizeGap(2.0, t, 2.0)).toBe(1.0);   // min(2.0, 1.0) = 1.0 ✓
```

**Verdict**: PASS. This is implemented correctly. No issue.

---

### P1-B: `GapAggregationEnum` uses wrong values

**File**: `src/types/core.ts`, lines 105–106
**Code**:
```typescript
export const GapAggregationEnum = z.enum(["max", "weighted_avg", "sum"]);
```

**File**: `src/gap-calculator.ts`, line 238
```typescript
method: "max" | "weighted_avg" | "sum" = "max"
```

**Design spec** (gap-calculation.md §6): The three aggregation methods are **max** (bottleneck), **weighted_avg**, and **sum**. The default is max (bottleneck). This matches the code exactly.

**However**, `src/types/core.ts` also defines `AggregationTypeEnum` at line 100:
```typescript
export const AggregationTypeEnum = z.enum(["min", "avg", "max", "all_required"]);
```

This enum is used in `DimensionMappingSchema` (`goal.ts` line 43) for sub-goal to parent dimension propagation. The design doc `state-vector.md` §4 lists three aggregation modes: "最小値集約" (min), "加重平均集約" (weighted average), "いずれか集約" (max/OR). The implementation maps these as `min`, `avg`, `max`, `all_required`. The `all_required` value has no direct counterpart in the state-vector.md §4 table, but is a reasonable addition. The `avg` name differs from `weighted_avg` in GapAggregationEnum — two different enum names for the same concept applied in different contexts is potentially confusing but not wrong since they are used in different schemas. This is a **P2** naming inconsistency, not a P1.

**Verdict**: No P1 issue here. The GapAggregationEnum ("max"/"weighted_avg"/"sum") is correct.

---

### P1-C: `ContextSlot.priority` range is wrong

**File**: `src/types/session.ts`, line 16
**Code**:
```typescript
priority: z.number().min(1).max(6),
```

**Design spec** (session-and-context.md §4): The priority table lists 6 levels (1 through 6). `max(6)` is correct for this.

**Verdict**: PASS. This is correct.

---

### P1-D: `GoalSchema` missing `weight` field on dimensions for `AggregationTypeEnum` in child propagation

**File**: `src/types/goal.ts`, lines 23–37 (`DimensionSchema`)
**Code**: Has `weight: z.number().default(1.0)` — present.

**Verdict**: PASS.

---

### P1-E: `DimensionSchema` history entries reference `source_observation_id` but the field in observation.md §8 is described as a UUID string

**File**: `src/types/goal.ts`, line 17
**Code**:
```typescript
source_observation_id: z.string(),
```

**Design spec** (observation.md §8): "observation_id: このエントリを一意に識別するUUID". The type `z.string()` is correct (UUID is a string). No Zod UUID validation, but that is acceptable.

**Verdict**: PASS.

---

### P1-F: Missing `heartbeat_at` field on task execution state

**File**: `src/types/task.ts`
**Design spec** (task-lifecycle.md §4): The execution_state includes:
```
status: "running" | "completed" | "timed_out" | "error"
started_at: timestamp
timeout_at: timestamp
heartbeat_at: timestamp  // 最終応答確認時刻
```

The `TaskSchema` has `status`, `started_at`, `completed_at`, `timeout_at`. **`heartbeat_at` is absent.**

**Impact**: The stall detection mechanism (time_exceeded) needs to check whether a running task is still alive. Without `heartbeat_at`, there is no way to detect a silently hung execution session. The design explicitly calls this out as a monitored field.

**Severity**: P1 — field required by design, absent from implementation.

**Fix**: Add `heartbeat_at: z.string().nullable().default(null)` to TaskSchema.

---

### P1-G: Missing `task_category` enum definition — stored as free string

**File**: `src/types/task.ts`, line 51
**Code**:
```typescript
task_category: z.string().default("normal"),
```

**Design spec** (task-lifecycle.md §2.8, stall-detection.md §2.3): The stall detection for consecutive failures counts "同一次元 × 同一タスクカテゴリ". The roadmap mentions `knowledge_acquisition` as a named category (impl-roadmap-research.md). Using a free string loses enum validation and makes the comparison in stall detection fragile.

**Severity**: P2 — not breaking, but using a Zod enum here (or at least documenting the known values) would be better. Keeping as P2.

---

### P1-H: `EvidenceSchema.layer` values differ from `ObservationLayerEnum`

**File**: `src/types/task.ts`, line 65
**Code**:
```typescript
layer: z.enum(["mechanical", "task_reviewer", "self_report"]),
```

**File**: `src/types/core.ts`, line 92
**Code**:
```typescript
export const ObservationLayerEnum = z.enum([
  "mechanical",
  "independent_review",
  "self_report",
]);
```

**Problem**: `EvidenceSchema.layer` uses `"task_reviewer"` but `ObservationLayerEnum` uses `"independent_review"`. These represent the same layer (Layer 2 in the observation system). task-lifecycle.md §5 uses the term "Task Reviewer" and "Reviewer" but the layer name in observation.md §8 is `independent_review`. The implementation introduces a second string for the same concept, creating an inconsistency that will cause confusion when evidence layer values are compared against observation layer values.

**Severity**: P1 — introduces a naming inconsistency between two schemas that represent the same concept. Either `EvidenceSchema.layer` should use `ObservationLayerEnum` directly, or the value should be `"independent_review"` to match.

**Fix**: Change `EvidenceSchema.layer` to use `z.enum(["mechanical", "independent_review", "self_report"])` or reuse `ObservationLayerEnum`.

---

### P1-I: `GoalSchema` missing `state_integrity` field

**File**: `src/types/goal.ts`
**Design spec** (task-lifecycle.md §6, discard path): When a revert fails, the dimension gets `state_integrity: "uncertain"` and Motiva stops autonomous task selection for that dimension until the human sets it back to `"ok"`. This field is not in `DimensionSchema` or `GoalSchema`.

**Severity**: P1 — required for the discard/revert failure path which is explicitly designed behavior.

**Fix**: Add `state_integrity: z.enum(["ok", "uncertain"]).default("ok")` to `DimensionSchema`.

---

### P1-J: `GoalSchema` uses non-nullable `created_at`/`updated_at` but no default

**File**: `src/types/goal.ts`, lines 113–114
**Code**:
```typescript
created_at: z.string(),
updated_at: z.string(),
```

These are required (no `.default()`). This is correct for required timestamps — callers must supply them. The test fixture (`makeGoal`) correctly provides them via `new Date().toISOString()`. No issue.

**Verdict**: PASS.

---

### P2-A: `AggregationTypeEnum` `"avg"` vs. `"weighted_avg"` naming inconsistency

**File**: `src/types/core.ts`, line 100
**Code**:
```typescript
export const AggregationTypeEnum = z.enum(["min", "avg", "max", "all_required"]);
```

Used in `DimensionMappingSchema` for sub-goal to parent dimension propagation. The corresponding gap aggregation enum uses `"weighted_avg"` not `"avg"`. The state-vector.md §4 uses the term "加重平均集約". `"avg"` could be interpreted as unweighted mean, which is different from `"weighted_avg"`. Using `"weighted_avg"` here as well would be more consistent and less ambiguous.

**Severity**: P2.

---

### P2-B: `StateManager.appendObservation` does not validate `goalId` matches `entry.goal_id`

**File**: `src/state-manager.ts`, line 156
**Code**:
```typescript
appendObservation(goalId: string, entry: ObservationLogEntry): void {
  const parsed = ObservationLogEntrySchema.parse(entry);
  let log = this.loadObservationLog(goalId);
  ...
```

If `goalId !== entry.goal_id`, a silent mismatch occurs. The log is saved under `goalId` but the entry records a different `goal_id`. No validation that they match. Low risk in practice (callers are expected to pass consistent values) but worth a guard assertion.

**Severity**: P2.

---

### P2-C: Test for `normalizeGap` with `max` threshold and `threshold=0` does not match the cap behavior exactly

**File**: `tests/gap-calculator.test.ts`, line 159
**Code**:
```typescript
expect(normalizeGap(0.5, t, 0.5)).toBe(0.5);
```

With `threshold={type:"max", value:0}` and `rawGap=0.5`, `Math.min(0.5, 1.0) = 0.5`. Test passes, and the result is correct. However, this test value (0.5) happens to be below the cap so the cap is not exercised. The test at line 161 (`normalizeGap(2.0, t, 2.0) = 1.0`) does exercise the cap. Coverage is adequate.

**Severity**: P2 (minor gap in boundary coverage, not a bug).

---

### P2-D: No test for `aggregateGaps` with empty array and `"sum"` method

**File**: `tests/gap-calculator.test.ts`
The test at line 489 tests `aggregateGaps([], "sum")` and expects 0. This IS present. No issue.

**Verdict**: PASS.

---

## Summary Table

| ID | Severity | File | Issue |
|----|----------|------|-------|
| P0-A | P0 | `src/gap-calculator.ts:44` | null raw_gap for `max` type uses wrong formula (`threshold.value`); semantically incorrect though pipeline end-result is accidentally correct when threshold≠0. |
| P1-F | P1 | `src/types/task.ts` | Missing `heartbeat_at` field on TaskSchema (required by task-lifecycle.md §4 execution_state). |
| P1-H | P1 | `src/types/task.ts:65` | `EvidenceSchema.layer` uses `"task_reviewer"` but the canonical layer name across all design docs is `"independent_review"` (ObservationLayerEnum). Creates a naming inconsistency. |
| P1-I | P1 | `src/types/goal.ts` | Missing `state_integrity` field on DimensionSchema (required by task-lifecycle.md §6 discard/revert-failure path). |
| P2-A | P2 | `src/types/core.ts:100` | `AggregationTypeEnum` uses `"avg"` but parallel GapAggregationEnum and design docs use `"weighted_avg"`. Ambiguous naming. |
| P2-B | P2 | `src/state-manager.ts:156` | `appendObservation` does not assert `goalId === entry.goal_id`. Silent mismatch possible. |
| P2-G | P2 | `src/types/task.ts:51` | `task_category` is a free string with no enum validation. Known values ("normal", "knowledge_acquisition") should be enumerated. |

---

## Suggested Fixes (Priority Order)

### Fix 1 (P0): Clarify null raw_gap for `max` type

In `src/gap-calculator.ts` around line 44, add explicit comment and change the return value to make the intent clear:

```typescript
case "max":
  // null current_value on a max threshold: unknown exceedance.
  // We return threshold.value as a conventional placeholder.
  // The normalizer's null guard (normalizeGap → currentValue===null → 1.0)
  // ensures normalized_gap=1.0 regardless of this raw value.
  // Guard: if threshold.value=0, we'd return 0 here but normalizeGap still
  // returns 1.0 for null, so the pipeline is safe.
  return threshold.value > 0 ? threshold.value : 1; // ensure positive raw_gap
```

### Fix 2 (P1-F): Add `heartbeat_at` to TaskSchema

```typescript
heartbeat_at: z.string().nullable().default(null),
```

### Fix 3 (P1-H): Align `EvidenceSchema.layer` with `ObservationLayerEnum`

Replace inline enum in `task.ts:65`:
```typescript
layer: ObservationLayerEnum,  // import from "./core.js"
```

### Fix 4 (P1-I): Add `state_integrity` to DimensionSchema

```typescript
state_integrity: z.enum(["ok", "uncertain"]).default("ok"),
```

### Fix 5 (P2-A): Rename `"avg"` to `"weighted_avg"` in `AggregationTypeEnum`

```typescript
export const AggregationTypeEnum = z.enum(["min", "weighted_avg", "max", "all_required"]);
```

Update `DimensionMappingSchema` and any tests that reference `"avg"`.
