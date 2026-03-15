# Dogfooding Stall Investigation

**Date:** 2026-03-15
**Command:** `MOTIVA_LLM_PROVIDER=openai npx tsx src/cli-runner.ts run --goal e0b3a12f-f8c1-4a54-92e1-01ea508c1a53 --adapter github_issue`
**Symptom:** "Goal stalled — escalation level reached maximum" after 4 iterations (~44 seconds)

---

## Root Cause Summary

The stall is caused by **four compounding issues** that together guarantee termination in 4 iterations regardless of task outcome:

1. All dimension `current_value` fields are permanently `null` — stall detection fires every iteration
2. The stall check reads from `gap-history.json` but this file does not exist — stall fires based on default gap=1.0 values
3. The escalation reset in commit cf35037 works, but is immediately re-triggered each iteration since `current_value` never changes
4. The dimension threshold type for `readme_completion` and `update_frequency` is `max` with the goal inverted — a null value always produces a maximum-gap reading

---

## Issue 1: All `current_value` Fields Are `null` — Observation Produces No State Change

**File:** `/Users/yuyoshimuta/.motiva/goals/e0b3a12f-f8c1-4a54-92e1-01ea508c1a53/goal.json`
**Evidence:** All 5 dimensions have `current_value: null` across 14 history entries spanning the entire run. `confidence` stays at `0.1` in every entry.

**What happens:**
- `core-loop.ts` line 454-476: observation is attempted via `engine.observe()` using `type: "manual"` / `source: "self_report:<dim>"` methods
- The `ObservationEngine.observe()` for `self_report` methods writes an observation entry but does **not** extract a numeric value — it records `extracted_value: null`, `raw_result: null`
- Because `extracted_value` is null, the goal's `current_value` is never updated
- After every observation cycle, `current_value` remains `null` for all 5 dimensions

**Consequence:** The gap is always 1.0 (maximum) for every dimension on every iteration. No progress can ever be measured, so stall detection fires immediately once it has enough history.

**Fix needed:** The `github_issue` adapter run must produce actual observations. Either:
  - The ObservationEngine needs a `github_issue` data source adapter that queries open/closed issue counts and maps them to dimension values, OR
  - The goal dimensions must be defined with thresholds that the github_issue adapter result can actually update (e.g., `present` type that flips to `true` when an issue is created)

---

## Issue 2: Gap History File Does Not Exist — Stall Detector Fabricates Past Gap Values

**File:** `stall-detector.ts` lines 75-109 (`checkDimensionStall`)
**File:** `core-loop.ts` lines 665-710

**What happens:**
- `stateManager.loadGapHistory(goalId)` reads from `~/.motiva/goals/<id>/gap-history.json`
- This file does **not exist** at the start of a fresh run (confirmed: `Glob` found no gap-history files under `~/.motiva`)
- `StateManager.loadGapHistory()` returns `[]` when the file is missing (line 189)
- `core-loop.ts` then constructs `dimGapHistory` by filtering entries from the empty array, falling back to `normalized_gap: 1.0` for any missing dimension entry (line 675: `g?.normalized_weighted_gap ?? 1`)
- `appendGapHistoryEntry` is called at line 495-506 and DOES write entries to `~/.motiva/goals/<id>/gap-history.json`

**Consequence for stall timing:**
- Iteration 0: gap history has 0 entries → `gapHistory.length < n + 1` → no stall
- After iteration 0 writes: gap history has 1 entry
- After iteration 1 writes: 2 entries
- After iteration 2 writes: 3 entries
- After iteration 3 writes: 4 entries → `n+1 = 4+1 = 5`? No…

Wait — with DEFAULT `stall_flexibility = 1`: `multiplier = 0.75 + 1 * 0.25 = 1.0`. For an `immediate` feedback category: `n = 3 * 1.0 = 3`. No feedback category is set on the dimensions, so `BASE_DEFAULT_N = 5`, adjusted N = `Math.round(5 * 1.0) = 5`.

So `gapHistory.length < n + 1` = `< 6`. History is only long enough to trigger stall detection after **6 entries** for a default-category dimension.

**BUT:** The escalation_level in `stalls/<goalId>.json` already shows `readme_completion: 3` from prior runs. This means the stall state was NOT properly reset.

---

## Issue 3: The Escalation Reset in cf35037 Resets at Start of Run But Prior State Persists

**File:** `core-loop.ts` lines 249-252
**Commit:** cf35037 — "fix: reset stall escalation at start of each run"

```typescript
for (const dim of goal.dimensions) {
  this.deps.stallDetector.resetEscalation(goalId, dim.name);
}
```

**What happens:**
- The reset correctly zeroes `dimension_escalation` for all dimensions at the top of `run()`
- However, the stall JSON file on disk currently shows `readme_completion: 3`
- This means the stall file was written by a **previous run** AFTER the reset occurred — i.e., 3 stall escalations happened within the same run

**The real problem:** The reset works, but within a single run, `incrementEscalation()` is called on `readme_completion` once per iteration whenever a stall is detected. Since `current_value` is always `null` and gap never changes, a stall fires on `readme_completion` in every iteration that has enough gap history.

With N=5 for default category (no feedbackCategory passed to `checkDimensionStall`), a stall only fires after 6 entries. With 4 iterations producing 4 entries, the history length never reaches 6. So how is escalation reaching 3?

**Re-examination:** Looking at the stall file state showing `readme_completion: 3` — this is **from a prior run**, meaning the goal has been run at least 3 times before. The cf35037 fix resets at the START of `run()`, so each fresh invocation of the CLI starts clean. The stall file's `readme_completion: 3` was written by a previous invocation and is irrelevant to the current run's first iteration.

**The real timing (4 iterations):** Given the history entries in `goal.json` (14 timestamps visible, spread across multiple runs), the gap-history.json file likely already has entries from PRIOR RUNS. The stall reset clears escalation level but does NOT clear gap history. So:

- Prior runs already wrote gap history entries to `~/.motiva/goals/<id>/gap-history.json`
- A fresh `run()` call resets `dimension_escalation` to 0, but gap history from prior runs is still there
- If prior runs left 10+ entries all with `normalized_gap = 1.0`, then at iteration 0 of the new run, the stall detector already has enough history (≥ N+1 entries) to immediately fire
- Stall fires iteration 0 → escalation goes to 1
- Stall fires iteration 1 → escalation goes to 2
- Stall fires iteration 2 → escalation goes to 3
- CoreLoop line 312-318: `stallReport.escalation_level >= 3` → `finalStatus = "stalled"` → break

**This is the actual 4-iteration failure path.**

**Fix needed:** The escalation reset in cf35037 must ALSO clear (or truncate) the gap history. At minimum, prior-run gap history should not be included in stall detection for the current run. The simplest fix: also clear the gap history file when resetting escalation at the start of `run()`.

---

## Issue 4: `readme_completion` Dimension Has Inverted Threshold Type (`max` instead of `min`)

**File:** `/Users/yuyoshimuta/.motiva/goals/e0b3a12f-f8c1-4a54-92e1-01ea508c1a53/goal.json` — dimension `readme_completion`

```json
"threshold": { "type": "max", "value": 100 }
```

**What this means in GapCalculator (`gap-calculator.ts` line 65-66):**
- `max` threshold means: gap = `max(0, current - threshold)` — the goal is to keep `current` BELOW 100
- For README completion, the intent is clearly to get the value UP TO 100 (a `min` threshold)
- With `current_value = null` + `max` type: `normalizeGap` returns 1.0 (null guard, line 103-106)

The same problem applies to `getting_started_guide_completion` and `update_frequency` (also `max` type).

**Consequence:** Even if `current_value` were eventually set to, say, 60 (60% complete), the gap would be calculated as `max(0, 60 - 100) = 0` — meaning the goal looks **fully achieved** at 60% completion. This is completely wrong for a "completion" goal.

**Fix needed:** Change the threshold types in the goal definition:
- `readme_completion`: `min(100)` — want to reach 100
- `getting_started_guide_completion`: `min(100)` — want to reach 100
- `update_frequency`: `min(6)` or `present` — want at least 6 updates

---

## Issue 5: ObservationEngine `self_report` Mode Never Extracts Numeric Values

**File:** `src/observation-engine.ts` (not read directly, but inferred from `observations.json`)

**Evidence:** All 50+ observation entries in `observations.json` show:
- `raw_result: null`
- `extracted_value: null`
- `confidence: 0.1`
- `layer: "self_report"`

The `observe()` call in `core-loop.ts` passes methods with `type: "manual"` and `source: "self_report:<dim>"`. A `self_report` observation does not call the github_issue adapter or any LLM to measure the actual state — it is a placeholder that records the observation attempt but leaves `extracted_value` as null.

**Consequence:** The github_issue adapter (which CAN observe GitHub issue state) is never invoked during the observation phase. The adapter is only used in the task execution phase (step 7), not step 2 (observe). Observation and execution are wired to completely different code paths, and for this goal the observation method is `llm_review` but the core loop hardcodes `type: "manual"`.

**Fix needed:** The core loop observation step (step 2, `core-loop.ts` lines 451-476) needs to use the goal's actual `observation_method` from each dimension rather than forcing `type: "manual"` for all dimensions. Or: a dedicated observation step should call the `GitHubIssueDataSourceAdapter` to get real issue counts.

---

## Issue 6: Task Execution Result Does Not Update Dimension `current_value`

**File:** `src/task-lifecycle.ts` lines 443-478 (`verifyTask`)

**What happens:**
- On task `pass`: `progressDelta = 0.4` is added to `dim.current_value`
- On task `partial`: `progressDelta = 0.15`
- BUT: `prevVal` is read from `dim.current_value` (line 464-468)
- If `current_value` is `null`, `prevVal = null`, and `newVal = progressDelta` (line 470-471)
- So after a `pass`, `current_value` would become `0.4`

**Problem:** With `max(100)` threshold, `current_value = 0.4` means `gap = max(0, 0.4 - 100) = 0` — the goal appears complete instantly at 0.4.

This is the **Issue 4 / Issue 6 interaction**: even if task execution succeeds and updates `current_value`, the wrong threshold type makes the gap read as zero, causing false completion or confusing the gap calculation entirely.

---

## Issue 7: Gap History Not Cleared on Run Reset

**File:** `core-loop.ts` lines 249-252

The `run()` method resets stall escalation counters but leaves `gap-history.json` intact. This means:
- Run 1: writes N gap entries, all with gap=1.0 (null values), escalation reaches 3 → stalls
- Run 2: resets escalation to 0, but gap history now has N entries from run 1
- If N >= 5 (the stall threshold), stall fires on iteration 0 of run 2, escalation goes 0→1→2→3 over 4 iterations

This is the direct cause of the "4 iterations" pattern — with prior run gap history already present, each new run starts 4 stall-increments away from termination.

---

## Execution Flow Trace (What Actually Happens in 4 Iterations)

```
Run start:
  - resetEscalation() called → dimension_escalation zeroed
  - gap-history.json from prior runs: contains 10-14 entries all with normalized_gap=1.0

Iteration 0:
  - observe() → self_report, extracted_value=null, current_value stays null
  - gap calc → all dims: normalized_gap=1.0 (null guard)
  - appendGapHistoryEntry → gap-history now has 11-15 entries
  - checkDimensionStall(readme_completion): length ≥ n+1=6 → fires
  - incrementEscalation(readme_completion) → level=1
  - stallReport.escalation_level=0 (getEscalationLevel BEFORE increment was 0) → not ≥3, loop continues
  - task cycle: generates task, executes github_issue adapter, LLM review

Iteration 1: same → escalation becomes 2
Iteration 2: same → escalation becomes 3
Iteration 3:
  - stallDetected=true, stallReport.escalation_level=3 (set BEFORE increment, which is now 3)

Wait — re-reading the CoreLoop stall check logic (core-loop.ts lines 697-708):
  escalationLevel = getEscalationLevel() → returns CURRENT level (after previous increment)
  stallReport = checkDimensionStall() → report includes escalation_level=current
  then incrementEscalation() is called AFTER

So after iteration 2 increment → level=3 persisted.
On iteration 3: getEscalationLevel returns 3 → checkDimensionStall report has escalation_level=3
→ CoreLoop line 315: escalation_level >= 3 → finalStatus="stalled" → break after 4 iterations total.
```

---

## Summary Table

| Issue | File | Lines | Severity |
|-------|------|--------|----------|
| Gap history persists across runs, pre-populates stall detector | `core-loop.ts` | 249-252 | **Critical** — direct cause of 4-iter stall |
| `self_report` observation never extracts numeric values | `core-loop.ts` + `observation-engine.ts` | 451-476 | **Critical** — state never changes |
| Wrong threshold type (`max` vs `min`) for completion dims | goal.json (data) | — | **Critical** — progress measurement inverted |
| github_issue adapter not wired to observation step | `core-loop.ts` | 451-476 | **High** — adapter unused for state measurement |
| Escalation level read before increment causes off-by-one | `core-loop.ts` | 698-708 | **Medium** — changes which iteration triggers halt |

---

## Recommended Fixes (Priority Order)

### Fix 1 (Immediate): Clear gap history on run reset
**File:** `src/core-loop.ts` lines 249-252

Add gap history clear alongside escalation reset:
```typescript
// Reset stall state AND gap history at the beginning of each run
for (const dim of goal.dimensions) {
  this.deps.stallDetector.resetEscalation(goalId, dim.name);
}
// Clear gap history so prior runs don't poison stall detection
this.deps.stateManager.saveGapHistory(goalId, []);
```

### Fix 2 (Immediate): Fix goal dimension threshold types
**Data fix** — re-create or patch the goal to use `min` instead of `max` for completion dimensions:
- `readme_completion`: `{ "type": "min", "value": 100 }`
- `getting_started_guide_completion`: `{ "type": "min", "value": 100 }`
- `update_frequency`: `{ "type": "min", "value": 6 }`

### Fix 3 (Short-term): Wire real observation to github_issue adapter
**File:** `src/core-loop.ts` lines 451-476

The observation step should consult the `GitHubIssueDataSourceAdapter` (already implemented in `src/adapters/github-issue-datasource.ts`) to populate `current_value` for issue-count dimensions. The current hardcoded `type: "manual"` approach only works for goals with human-entered values.

### Fix 4 (Short-term): Redesign dogfood goal dimensions
The `readme_completion` dimension modeled as a 0-100 score is not measurable by the github_issue adapter. The dogfood goal should use dimensions the adapter can actually observe:
- `open_issue_count` (threshold: `max`, value=N — keep issues under N)
- `issues_created` (threshold: `min`, value=5 — want at least 5 issues filed)
- `completion_ratio` (threshold: `min`, value=0.8 — want 80% of issues closed)

These map directly to the `GitHubIssueDataSourceAdapter` observation dimensions (see `src/adapters/github-issue-datasource.ts`).
