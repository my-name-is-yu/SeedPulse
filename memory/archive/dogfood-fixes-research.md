# Dogfooding Fix Research
Date: 2026-03-15

---

## Issue 1: Verification Accuracy (LLM verifier returns fail/partial when execution succeeds)

### Flow Summary

`runTaskCycle` (task-lifecycle.ts:664) calls:
1. `executeTask` → returns `AgentResult { success: boolean, output: string, ... }`
2. `verifyTask` (line 800) → always runs 2-layer LLM verification regardless of `executionResult.success`
3. `handleVerdict` → uses the verdict

### Root Cause

In `runLLMReview` (task-lifecycle.ts:884), the LLM reviewer sees the raw execution output and independently decides pass/partial/fail. **There is no short-circuit path when `executionResult.success === true`.**

The prompt at line 908–925 passes:
- `Execution Success: ${executionResult.success}`
- `Execution Output (first 2000 chars): ...`

But the LLM reviewer is instructed (line 930): `"Do NOT consider the executor's self-assessment."` — and `success=true` is treated as executor self-assessment, so the LLM appropriately ignores it and makes its own judgment based on output content.

The real problem: if the output contains an issue URL like `https://github.com/org/repo/issues/42`, the success_criteria may say something vague like "GitHub issue created with clear description", but the LLM reviewer sees only the first 2000 chars of output and must infer whether criteria are met. If the criteria or reasoning are ambiguous, it downgrades to partial/fail.

Additionally in `runMechanicalVerification` (line 855), L1 only fires if a success criterion's `verification_method` starts with `npm`, `npx`, `pytest`, `sh`, `bash`, `node`, `make`, `cargo`, or `go`. A criterion like `"gh issue list --label motiva --json number,title,state"` starts with `gh` — **not in the prefix list** — so L1 is skipped entirely (returns `applicable: false`). This means only L2 (LLM review) determines the verdict, with lower confidence (line 396–407) and no mechanical grounding.

### Exact Lines

- `runMechanicalVerification`: task-lifecycle.ts lines 855–882
  - mechanicalPrefixes list: line 859 — missing `gh`
- `runLLMReview`: task-lifecycle.ts lines 884–958
  - L1 skip path (L1 not applicable → L2 only): lines 396–407
- `verifyTask` contradiction resolution: lines 362–413

### Suggested Fix (minimal)

**Fix A**: Add `"gh "` to `mechanicalPrefixes` at line 859 so that `gh issue list ...` criteria trigger L1.

```typescript
// line 859 — add "gh "
const mechanicalPrefixes = ["npm", "npx", "pytest", "sh", "bash", "node", "make", "cargo", "go ", "gh "];
```

**Fix B**: When `executionResult.success === true` AND the output contains a URL matching `github.com/.*/issues/\d+`, treat L1 as applicable+passed without running a shell command. Add this check at the top of `runMechanicalVerification`:

```typescript
// After hasMechanicalCriteria check — add before the MVP pass return:
const hasIssueUrl = /github\.com\/.+\/issues\/\d+/.test(executionResult.output ?? "");
if (hasIssueUrl) {
  return { applicable: true, passed: true, description: "GitHub issue URL found in output" };
}
```

This short-circuit is safe: a URL in the output is mechanical evidence of creation. Note: `runMechanicalVerification` does not receive `executionResult` in its signature (line 855) — it only receives `task`. To implement Fix B, the signature needs to accept `executionResult: AgentResult` as a second parameter, and the caller `verifyTask` (line 353) must pass it.

**Recommended**: Fix A is zero-risk (1-line change). Fix B requires signature change but gives real mechanical evidence.

---

## Issue 2: Task Generation Prompt — Vague Tasks

### Root Cause

`buildTaskGenerationPrompt` (task-lifecycle.ts lines 815–851) builds the prompt using only:
- `goalId` (a UUID string, e.g. `"abc-123"`)
- `targetDimension` (e.g. `"readme_completeness"`)
- optional `knowledgeContext`

The prompt text (line 824):
```
Generate a task to improve the "${targetDimension}" dimension for goal "${goalId}".
```

**The LLM has no information about:**
- What the goal's actual title or description is
- What the current state/value is (e.g. current_value=0.0)
- What the target/threshold is (e.g. need to reach 0.8)
- What adapter will execute the task (e.g. github_issue adapter — so the output should be an issue creation)
- What repository or domain context exists

With only a dimension name like `"readme_completeness"` and a UUID for goalId, the LLM generates generic tasks like "Review and triage all open issues" rather than concrete adapter-aware tasks like "Create 1 GitHub issue titled 'Add README.md with Getting Started section'".

### Exact Lines

- `buildTaskGenerationPrompt`: task-lifecycle.ts lines 815–851
- Called from `generateTask` at line 168
- Called from `runTaskCycle` at line 675

### Suggested Fix (minimal)

Inject goal context into the prompt. `generateTask` already has access to `this.stateManager`, so load the goal before calling `buildTaskGenerationPrompt`:

```typescript
// In generateTask (line 162), before calling buildTaskGenerationPrompt:
const goalData = this.stateManager.readRaw(`goals/${goalId}.json`) as Record<string, unknown> | null;
const goalTitle = typeof goalData?.title === "string" ? goalData.title : goalId;
const goalDesc = typeof goalData?.description === "string" ? goalData.description : "";
const dimensions = Array.isArray(goalData?.dimensions) ? goalData.dimensions as Array<Record<string,unknown>> : [];
const targetDimState = dimensions.find(d => d.name === targetDimension);
const currentVal = typeof targetDimState?.current_value === "number" ? targetDimState.current_value : 0;
const targetVal = typeof targetDimState?.target_value === "number" ? targetDimState.target_value : 1;

const prompt = this.buildTaskGenerationPrompt(goalId, targetDimension, knowledgeContext, {
  goalTitle, goalDesc, currentVal, targetVal
});
```

Then update `buildTaskGenerationPrompt` to accept and use this context:

```
Goal: "${goalTitle}"
Description: ${goalDesc}
Target dimension: "${targetDimension}" (current: ${currentVal}, target: ${targetVal})
```

Additionally, if adapter type is known (it is not passed to `generateTask` currently), injecting `adapterType: "github_issue"` into the prompt so the LLM knows the task output will become a GitHub issue would dramatically improve specificity. This requires threading `adapter.adapterType` from `runTaskCycle` (line 675) through to `generateTask`.

**Minimal change (no signature change needed)**: Load goal data inside `buildTaskGenerationPrompt` using `this.stateManager` directly, since it is a private method on the same class that has access to `this.stateManager`.

---

## Issue 3: handleFailure Task State Reset (started_at/status overwrite)

### Investigation

Examining `handleFailure` (task-lifecycle.ts lines 598–657):

```typescript
const updatedTask = {
  ...task,                                              // line 603–605
  consecutive_failure_count: task.consecutive_failure_count + 1,
};
this.stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, updatedTask);  // line 612–615
```

The `task` parameter passed into `handleFailure` is the **original pre-execution task object** spread from `handleVerdict` (line 584: `return this.handleFailure(task, verificationResult)`), where `task` comes from the `handleVerdict` parameter at line 503.

Tracing back: `handleVerdict` is called from `runTaskCycle` line 804:
```typescript
const verdictResult = await this.handleVerdict(task, verificationResult);
```

Where `task` was the original task returned from `generateTask` at line 675 — this task has `status: "pending"` (set at line 211) and no `started_at`.

However, `executeTask` (line 255) creates `runningTask = { ...task, status: "running", started_at: ... }` at line 286, writes it to disk at line 287, then returns `result` (AgentResult). The **in-memory `task` variable in `runTaskCycle` is never updated** to reflect the running/completed state written to disk.

So when `handleFailure` receives `task` and does `{ ...task, consecutive_failure_count: ... }`, it spreads the stale in-memory task (which still has `status: "pending"` or `status: "completed"` from `generateTask`, not `status: "error"` from disk). Then it writes this back to disk, **overwriting the disk state that `executeTask` wrote**.

### Exact Lines

- `executeTask` writes running task to disk: line 287
  - `runningTask = { ...task, status: "running", started_at: ... }`
- `executeTask` writes final status to disk: lines 321–327
  - `status: "completed" | "timed_out" | "error"`
- `runTaskCycle` never refreshes `task` from disk after `executeTask` returns: lines 796–804
- `handleVerdict` receives stale `task`: line 804
- `handleFailure` spreads stale task and overwrites disk: lines 603–615

### Confirmed Bug

`handleFailure` overwrites `status` and `started_at` with stale values from the pre-execution task object. The task on disk ends up with the pre-execution status instead of `"error"`.

### Suggested Fix (minimal)

In `runTaskCycle`, after `executeTask` returns and before `verifyTask`/`handleVerdict`, reload the task from disk:

```typescript
// After line 796 (executeTask call), before line 800 (verifyTask):
const taskOnDisk = this.stateManager.readRaw(`tasks/${task.goal_id}/${task.id}.json`) as Task | null;
const taskForVerification = taskOnDisk ?? task;

// Then pass taskForVerification to verifyTask and handleVerdict:
const verificationResult = await this.verifyTask(taskForVerification, executionResult);
const verdictResult = await this.handleVerdict(taskForVerification, verificationResult);
```

This ensures `handleFailure` spreads the disk-accurate task (with `status: "error"`, `started_at`, `completed_at`) rather than the stale pending task. The fix is 3 lines in `runTaskCycle` only — no changes to `handleFailure` itself.

---

## Summary Table

| Issue | File | Key Lines | Fix Size |
|-------|------|-----------|----------|
| 1: Verification — `gh` not in mechanicalPrefixes | task-lifecycle.ts | 859 | 1 line |
| 1b: Verification — no short-circuit for issue URL | task-lifecycle.ts | 855–882 | ~8 lines + signature change |
| 2: Task prompt missing goal context | task-lifecycle.ts | 815–851 | ~15 lines in buildTaskGenerationPrompt |
| 3: handleFailure stale task overwrite | task-lifecycle.ts | 796–804 | 3 lines in runTaskCycle |

---

## Gaps / Not Determined

- Whether `success_criteria` generated for dogfood tasks actually include `gh`-prefixed verification methods — would require inspecting a live LLM-generated task JSON from `~/.motiva/tasks/`.
- Whether `task.status` type allows `"pending"` at the point `handleFailure` is called, or whether TypeScript narrows it (it does not — status is a union of all values).
- `core-loop.ts` does not contain any verification or task generation logic — it delegates entirely to `taskLifecycle.runTaskCycle`. No issues found in CoreLoop for these three bugs.
