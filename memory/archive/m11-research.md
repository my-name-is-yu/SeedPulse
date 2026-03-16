# M11 Research Report: 戦略自律選択 + 実行品質

Research date: 2026-03-16
Source files read: `src/task-lifecycle.ts`, `src/memory-lifecycle.ts`, `src/satisficing-judge.ts`, `src/drive-scorer.ts`, `src/core-loop.ts`, `tests/task-lifecycle.test.ts`, `tests/satisficing-judge.test.ts`

---

## 1. generateTask() — Current Prompt Template

**Signature** (line 176):
```typescript
async generateTask(
  goalId: string,
  targetDimension: string,
  strategyId?: string,
  knowledgeContext?: string,
  adapterType?: string,
  existingTasks?: string[],
  workspaceContext?: string
): Promise<Task>
```

### Prompt construction (`buildTaskGenerationPrompt`, lines 912–1063)

The prompt is assembled from these sections, in this order:

1. **Goal section** — `goal.title` + `goal.description` (loaded from StateManager)
2. **Dimension section** — `targetDimension`, current value, threshold type/value, gap description
3. **Repository context section** — reads `package.json` in `process.cwd()` for `name` and `description` (best-effort, no throw)
4. **Adapter context section** — adapter-specific instruction block:
   - `github_issue` → issue title/body formatting rules
   - `openai_codex_cli` / `claude_code_cli` → no git commit/push in success criteria; file-only verification
   - other → generic adapter note
5. **Knowledge section** — injected `knowledgeContext` (from KnowledgeManager, optional)
6. **Workspace state section** — injected `workspaceContext` (from `contextProvider` DI, optional). Falls back to `"No workspace context available."` if not provided.
7. **Existing tasks section** — `existingTasks[]` list with dedup instruction (optional)
8. **Instruction block** — IMPORTANT constraints, schema definition, JSON format instructions

### What is currently MISSING from the prompt

- **Actual file contents** — no `cat file.ts` or `grep` results are included. The prompt only has `goal.description` and `package.json` name/description. This is the root cause of the M8 dogfooding problem (Codex only changing 1 comment line).
- **Current test/build output** — no `npm test` or `tsc --noEmit` results are injected.
- **Strategy history / past task outcomes** — `existingTasks` only contains task descriptions for dedup, not success/failure outcomes.
- **File structure / relevant code snippets** — not included unless `contextProvider` injects them.

### How `workspaceContext` reaches `generateTask()`

Flow: `CoreLoop.runOneIteration()` → step 7d (lines 942–951):
```typescript
if (this.deps.contextProvider) {
  workspaceContext = await this.deps.contextProvider(goalId, topDimension);
}
```
The `contextProvider` is a DI function `(goalId: string, dimensionName: string) => Promise<string>` registered in `CoreLoopDeps`. Currently it must be provided externally (e.g., CLIRunner). If absent, `workspaceContext` is `undefined` and the prompt falls back to `"No workspace context available."`.

### LLM call parameters

- System prompt: `"You are a task generation assistant..."` (fixed)
- `max_tokens: 2048`
- Response schema: `LLMGeneratedTaskSchema` (Zod) with 8 fields: `work_description`, `rationale`, `approach`, `success_criteria`, `scope_boundary`, `constraints`, `reversibility`, `estimated_duration`

---

## 2. executeTask() — Adapter Call Pattern

**Signature** (line 272):
```typescript
async executeTask(task: Task, adapter: IAdapter): Promise<AgentResult>
```

### Flow

1. Create execution session via `SessionManager.createSession("task_execution", goalId, taskId)`
2. Build context slots via `SessionManager.buildTaskExecutionContext(goalId, taskId)`
3. Build `prompt` string:
   - For `github_issue` adapter: JSON block `{ title, body }` in markdown code fence
   - For all others: `"You are an AI agent executing a task.\n\nTask: ...\n\nApproach: ...\n\nSuccess Criteria: ..."` + sorted context slots appended after `--- Context ---`
4. Set `timeoutMs` from `task.estimated_duration` (converted via `durationToMs()`) or 30 minutes default
5. Update task status to `"running"` and persist to `tasks/{goalId}/{taskId}.json`
6. **Dedup check** (optional): if `adapter.checkDuplicate` exists, call it. If duplicate, return synthetic success result without calling `adapter.execute()`.
7. Call `adapter.execute(agentTask)` — caught in try/catch; error → synthetic failure result
8. End session
9. Update task status: `"completed"` | `"timed_out"` | `"error"` based on `result.stopped_reason`

### Post-execution hooks

- No callbacks beyond `sessionManager.endSession()` and `stateManager.writeRaw()`.
- No memory lifecycle hooks in `executeTask()` itself.
- The `onTaskComplete` callback (for PortfolioManager) is called in `handleVerdict()` on `"pass"` verdict, NOT in `executeTask()`.

---

## 3. verifyTask() — L1/L2 Verification Logic

**Signature** (line 408):
```typescript
async verifyTask(task: Task, executionResult: AgentResult): Promise<VerificationResult>
```

### Short-circuit: GitHub issue URL

If `executionResult.success === true` AND output contains `github.com/.../issues/\d+`, return `pass` verdict (confidence 0.95) immediately without running L1/L2.

### L1 Mechanical Verification (`runMechanicalVerification`, line 1067)

1. Find first `success_criteria` item whose `verification_method` starts with one of: `npm`, `npx`, `pytest`, `sh`, `bash`, `node`, `make`, `cargo`, `go `, `gh `
2. If none found: `applicable=false` (L1 skipped)
3. If found but no `adapterRegistry`: `applicable=true, passed=true` (assumed pass — backward compat)
4. If registry available: pick first listed adapter, call `adapter.execute({ prompt: verificationCommand, timeout_ms: 30_000 })`
5. Timeout → `passed=false`; `exit_code === 0 && success` → `passed=true`

**Current limitation**: only the first mechanical criterion is checked. Multiple success criteria with commands are not all run.

### L2 LLM Review (`runLLMReview`, line 1157)

- Creates a `"task_review"` session
- Prompt: task description + approach + success_criteria list + execution output (first 2000 chars) + execution status
- System: `"You are an independent task reviewer..."`
- `max_tokens: 1024`
- Returns `{ "verdict": "pass"|"partial"|"fail", "reasoning": string, "criteria_met": number, "criteria_total": number }`
- Confidence: pass→0.8, partial→0.6, fail→0.8

### Contradiction resolution matrix (lines 454–496)

| L1 | L2 | Result |
|----|----|--------|
| applicable + pass | pass | pass (0.9) |
| applicable + pass | partial | partial (0.7) |
| applicable + pass | fail | re-review L2; if still fail → fail (0.8) |
| applicable + fail | pass | fail (0.85) — mechanical priority |
| applicable + fail | fail | fail (0.9) |
| not applicable | pass | pass (0.6) — lower confidence |
| not applicable | partial | partial (0.5) |
| not applicable | fail | fail (0.6) |

### Dimension updates

On `pass`: `+0.2` to `current_value` of all `target_dimensions` (clamped to [0,1])
On `partial`: `+0.15`
On `fail`: no updates

---

## 4. Memory Lifecycle Phase 2 Stubs — What Exists, What Needs Wiring

### What is implemented

All Phase 2 code IS implemented in `src/memory-lifecycle.ts`. The following methods exist and are functional:

**Drive-based compression** (lines 507–656):
- `getCompressionDelay(driveScores)` — returns `Map<dimension, delayFactor>` (1.0–2.0)
- `getDeadlineBonus(driveScores)` — returns `Map<dimension, bonus>` (0–0.3)
- `markForEarlyCompression(goalId, satisfiedDimensions[])` — marks dimensions in `earlyCompressionCandidates` Map
- `getEarlyCompressionCandidates(goalId)` — returns `Set<string>`
- `relevanceScore(entry, context)` — tag_match_ratio * drive_weight * freshness_factor
- `compressionDelay(goalId, dimension)` — returns retention_period * multiplier based on dissatisfaction
- `onSatisficingJudgment(goalId, dimension, isSatisfied)` — marks/unmarks for early compression

**Semantic working memory** (lines 736+):
- `selectForWorkingMemorySemantic(goalId, query, dimensions, tags, maxEntries, driveScores?)` — async, uses VectorIndex + deadline bonus

### What is NOT wired yet (connection gaps)

1. **MemoryLifecycleManager ↔ DriveScorer**: `MemoryLifecycleManager` defines its own `IDriveScorer` interface (line 33) requiring `getDissatisfactionScore(dimension): number`. The real `DriveScorer` module exports `scoreAllDimensions()` and `rankDimensions()` (pure functions) — it does NOT have a `getDissatisfactionScore(dimension)` method on a class instance. A wrapper/adapter is needed.

2. **SatisficingJudge ↔ MemoryLifecycleManager callback**: `SatisficingJudge` constructor accepts `onSatisficingJudgment?: (goalId: string, satisfiedDimensions: string[]) => void`. In `CoreLoop`, when the `SatisficingJudge` is constructed, this callback is not currently wired to `memoryLifecycleManager.markForEarlyCompression()`.

3. **`compressionDelay()` integration**: `compressionDelay()` on `MemoryLifecycleManager` is implemented but not called from within any compression trigger path in the existing loop (the `onGoalClose()` path does not invoke it per-dimension).

4. **`selectForWorkingMemorySemantic()` not called from CoreLoop**: The loop uses `knowledgeManager.getRelevantKnowledge()` for context injection, not the semantic working memory selection.

---

## 5. SatisficingJudge Condition 3 — What's Needed

### Current state

`detectThresholdAdjustmentNeeded()` (line 283) implements:
- **Condition 1** (line 301): `>= 3 failures AND progress < 10%` → propose 20% threshold reduction
- **Condition 2** (line 319): bottleneck — all other dimensions satisfied, this one < 30% → propose 20% reduction

**Line 317**:
```typescript
// TODO: condition 3 (resource undershoot) deferred — requires task cost history
```

### What condition 3 requires

Per `satisficing.md` design intent, condition 3 (resource undershoot) is:
- Goal uses resources well below budget (< 50% of estimated resource) AND is still unsatisfied
- Suggests either the threshold is too high OR more resource should be allocated

**Data structure needed**: task cost history per goal/dimension, containing:
```typescript
interface TaskCostRecord {
  task_id: string;
  goal_id: string;
  dimension_name: string;
  estimated_duration: { value: number; unit: string } | null;
  actual_elapsed_ms: number;
  verdict: "pass" | "partial" | "fail";
  created_at: string;
}
```

**Where to get it**: `appendTaskHistory()` in `TaskLifecycle` (line 1310) currently writes:
```typescript
{ task_id, status, primary_dimension, consecutive_failure_count, completed_at }
```
It does NOT include `estimated_duration` or `actual_elapsed_ms`. These would need to be added.

**Judgment logic sketch** for condition 3:
```
if recent_tasks_for_dimension.count >= 3
   AND avg(actual_elapsed_ms) < 0.5 * avg(estimated_duration_ms)
   AND progress < 0.5
THEN propose threshold reduction
```

**Implementation path**:
1. Add `estimated_duration_ms` and `actual_elapsed_ms` to `appendTaskHistory()` payload
2. Load task history in `detectThresholdAdjustmentNeeded()`
3. Implement condition 3 logic

---

## 6. DriveScorer Interface — score() Return Type

`DriveScorer` (`src/drive-scorer.ts`) is a module of pure functions — there is NO class with a `score()` method.

### Exported functions

```typescript
// Score all dimensions in a GapVector
export function scoreAllDimensions(
  gapVector: GapVector,
  context: DriveContext,
  config?: DriveConfig
): DriveScore[]

// Sort DriveScore[] by final_score descending
export function rankDimensions(scores: DriveScore[]): DriveScore[]
```

### `DriveScore` type

```typescript
{
  dimension_name: string;
  dissatisfaction: number;  // raw dissatisfaction drive score
  deadline: number;         // raw deadline drive score
  opportunity: number;      // raw opportunity drive score
  final_score: number;      // max(dissatisfaction, deadline, opportunity) [or deadline if override]
  dominant_drive: "dissatisfaction" | "deadline" | "opportunity";
}
```

### `IDriveScorer` interface (in memory-lifecycle.ts)

```typescript
interface IDriveScorer {
  getDissatisfactionScore(dimension: string): number;
}
```

This interface is separate from the DriveScorer pure functions. For M11.3, a wrapper class is needed:
```typescript
class DriveScoreAdapter implements IDriveScorer {
  constructor(private scores: Map<string, DriveScore>) {}
  getDissatisfactionScore(dimension: string): number {
    return this.scores.get(dimension)?.dissatisfaction ?? 0;
  }
}
```

---

## 7. Core Loop Workspace Context Flow

### How context flows from CoreLoop to TaskLifecycle

```
CoreLoopDeps.contextProvider: (goalId, dimensionName) => Promise<string>
  ↓ called in runOneIteration() step 7d (lines 942-951)
    topDimension = driveScores[0]?.dimension_name ?? goal.dimensions[0]?.name
    workspaceContext = await contextProvider(goalId, topDimension)
  ↓ passed to taskLifecycle.runTaskCycle()
    runTaskCycle(goalId, gapVector, driveContext, adapter,
                 knowledgeContext, existingTasks, workspaceContext)
  ↓ passed to generateTask()
    generateTask(goalId, targetDimension, undefined,
                 knowledgeContext, adapter.adapterType, existingTasks, workspaceContext)
  ↓ injected in buildTaskGenerationPrompt() as "=== Current Workspace State ===" section
```

### Key observation

The `contextProvider` is the critical injection point for M11.1. It is already wired in the core loop and the prompt already has a placeholder section. Currently nothing provides real file contents — the provider must be implemented externally (e.g., in CLIRunner).

### Other context passed to generateTask()

- `knowledgeContext` — from `KnowledgeManager.getRelevantKnowledge(goalId, topDimension)` (step 7a)
- `existingTasks` — from `adapter.listExistingTasks()` if the adapter implements it (step 7c)
- `adapterType` — passed directly from `adapter.adapterType`

---

## 8. Implementation Recommendations per Sub-Milestone

### M11.1: タスク生成のコンテキスト強化

**Goal**: Provide actual file contents and grep results in the prompt so Codex generates specific, targeted tasks instead of trivial one-line changes.

**What already exists**:
- `contextProvider` DI hook in `CoreLoopDeps` — fully wired
- `workspaceContext` section in prompt — already renders as `=== Current Workspace State ===`
- `knowledgeContext` section — already renders as `Relevant domain knowledge:`

**What needs to be implemented**:

1. **`contextProvider` implementation** (new file or in CLIRunner):
   - Input: `(goalId, dimensionName)`
   - Logic: for the goal's description and dimension, identify relevant files using `grep`/`find`
   - Output: structured string with file contents (trimmed to ~2000 tokens), recent git diff, test results
   - Example output format:
     ```
     [File: src/foo.ts (lines 1-50)]
     <content>

     [Recent changes: git diff HEAD~1 --stat]
     <output>

     [Test status: npm test --reporter=dot 2>&1 | tail -20]
     <output>
     ```

2. **StrategyManager integration** — fetch past strategy outcomes and inject into `knowledgeContext`:
   - `strategyManager.getPortfolio(goalId)` → strategies with outcomes
   - Format as "Past strategy outcomes: Strategy X tried Y, result: Z"

3. **No changes to `generateTask()` or `buildTaskGenerationPrompt()`** — the injection point already exists.

**Files to touch**:
- `src/cli-runner.ts` — register a `contextProvider` when constructing `CoreLoop`
- Or new `src/context-provider.ts` module

**Tests**: 1 test verifying `contextProvider` is called with correct `(goalId, dimensionName)` and its output appears in the prompt.

---

### M11.2: 実行スコープ制御

**Goal**: Pre-estimate diff scope, require approval for large changes, and run build/test after execution.

**What already exists**:
- `checkIrreversibleApproval()` — approval flow is already wired for irreversible tasks
- `task.scope_boundary.blast_radius` field exists in Task schema
- `runMechanicalVerification()` — already calls adapter for L1; can be reused for post-build check

**What needs to be added**:

1. **Scope size estimation before execution**: In `runTaskCycle()` step 3c or between approval and execution, call LLM to estimate number of files/lines affected. If blast_radius is "wide" or estimated changes > threshold, elevate `reversibility` to trigger approval flow.

2. **Post-execution build/test check**: After `executeTask()` returns `success=true`, run a lightweight `npm run build 2>&1` or `npm test` via the adapter as a health check. This is separate from L1 mechanical verification (which checks specific success criteria).
   - Hook location: `runTaskCycle()` between steps 4 (execute) and 5 (verify)
   - Or enhance `runMechanicalVerification()` to also run build

3. **Diff size gating**: If adapter supports it, call `adapter.listExistingTasks()` before/after to detect large scope creep.

**Files to touch**: `src/task-lifecycle.ts`

**Tests**: mock adapter that simulates failing build; verify task is flagged.

---

### M11.3: Drive-based Memory Management

**Goal**: Wire `MemoryLifecycleManager` Phase 2 helpers to actual DriveScorer output.

**What already exists**: All Phase 2 methods are implemented. Only wiring is missing.

**What needs to be done**:

1. **Create `DriveScoreAdapter`** (can be a small class in `memory-lifecycle.ts` or a separate file):
   ```typescript
   class DriveScoreAdapter implements IDriveScorer {
     private scores: Map<string, number>; // dimension → dissatisfaction
     update(driveScores: DriveScore[]): void {
       this.scores = new Map(driveScores.map(s => [s.dimension_name, s.dissatisfaction]));
     }
     getDissatisfactionScore(dimension: string): number {
       return this.scores.get(dimension) ?? 0;
     }
   }
   ```

2. **Wire `DriveScoreAdapter` update in CoreLoop step 4** (after drive scoring):
   ```typescript
   if (this.deps.memoryLifecycleManager?.driveScorer) {
     (this.deps.memoryLifecycleManager.driveScorer as DriveScoreAdapter).update(driveScores);
   }
   ```

3. **Wire `SatisficingJudge.onSatisficingJudgment` callback to `MemoryLifecycleManager`**:
   In the `CoreLoop` constructor (or wherever `SatisficingJudge` is instantiated):
   ```typescript
   new SatisficingJudge(
     stateManager,
     embeddingClient,
     (goalId, satisfiedDimensions) => {
       memoryLifecycleManager?.markForEarlyCompression(goalId, satisfiedDimensions);
     }
   )
   ```

4. **Expose `driveScorer` field as settable on `MemoryLifecycleManager`** or pass via constructor.

**Files to touch**: `src/memory-lifecycle.ts`, `src/core-loop.ts`

**Tests**:
- `getCompressionDelay()` with mock scores — already testable
- Integration test: after CoreLoop iteration with high dissatisfaction score, verify `compressionDelay()` returns 2x retention period

---

### M11.4: SatisficingJudge resource undershoot (condition 3)

**Goal**: Implement condition 3 in `detectThresholdAdjustmentNeeded()`.

**Prerequisites**: task cost data must be captured first.

**Step 1 — Extend `appendTaskHistory()`** in `TaskLifecycle` (line 1310):
```typescript
history.push({
  task_id: task.id,
  status: task.status,
  primary_dimension: task.primary_dimension,
  consecutive_failure_count: task.consecutive_failure_count,
  completed_at: task.completed_at ?? new Date().toISOString(),
  estimated_duration_ms: task.estimated_duration ? durationToMs(task.estimated_duration) : null,
  actual_elapsed_ms: task.started_at && task.completed_at
    ? new Date(task.completed_at).getTime() - new Date(task.started_at).getTime()
    : null,
});
```

**Step 2 — Load task cost history in `detectThresholdAdjustmentNeeded()`**:
```typescript
// Load task history for cost analysis
const taskHistory = this.stateManager.readRaw(`tasks/${goal.id}/task-history.json`) as TaskHistoryEntry[] | null;
```

**Step 3 — Implement condition 3** (insert after condition 1, before condition 2 in the loop):
```typescript
// Condition 3: resource undershoot — tasks complete well under budget but goal still unsatisfied
if (taskHistory && progress < 0.5) {
  const dimHistory = taskHistory.filter(
    h => h.primary_dimension === dim.name &&
         h.estimated_duration_ms !== null &&
         h.actual_elapsed_ms !== null
  );
  if (dimHistory.length >= 3) {
    const avgEstimated = avg(dimHistory.map(h => h.estimated_duration_ms!));
    const avgActual = avg(dimHistory.map(h => h.actual_elapsed_ms!));
    if (avgActual < 0.5 * avgEstimated && avgEstimated > 0) {
      proposals.push({
        goal_id: goal.id,
        dimension_name: dim.name,
        current_threshold: currentThreshold,
        proposed_threshold: currentThreshold * 0.85, // less aggressive than conditions 1/2
        reason: "resource_undershoot",
        evidence: `${dimHistory.length} tasks averaged ${Math.round(avgActual/60000)}min vs ${Math.round(avgEstimated/60000)}min estimated; goal at ${Math.round(progress*100)}% progress`,
      });
    }
  }
}
```

**Note**: `ThresholdAdjustmentProposal.reason` type must be extended to include `"resource_undershoot"`.

**Files to touch**: `src/task-lifecycle.ts` (extend `appendTaskHistory`), `src/satisficing-judge.ts` (condition 3), `src/types/satisficing.ts` (extend reason union)

**Tests**:
- 3 tasks with actual < 50% of estimated, goal progress < 50% → proposal generated
- 2 tasks (below threshold) → no proposal
- actual >= 50% of estimated → no proposal

---

## 9. Summary Table

| Sub-milestone | Core change | Files | Risk |
|---|---|---|---|
| M11.1 | contextProvider impl (file contents + grep) | `cli-runner.ts` or new `context-provider.ts` | Low — pure addition, no existing logic changed |
| M11.2 | Scope estimation + post-build check | `task-lifecycle.ts` | Medium — adds LLM call before execution; may slow loop |
| M11.3 | Wire DriveScorer to MemoryLifecycle + SatisficingJudge callback | `memory-lifecycle.ts`, `core-loop.ts` | Low — all methods exist; wiring only |
| M11.4 | Task cost tracking + condition 3 | `task-lifecycle.ts`, `satisficing-judge.ts`, `types/satisficing.ts` | Low — additive; doesn't change existing condition 1/2 |

---

## 10. Open Questions

1. **M11.1 contextProvider scope**: Should it read raw file contents (up to N lines) or run `grep` per dimension name? The latter is more targeted but requires heuristics for which files are relevant.

2. **M11.2 post-execution build**: Running `npm run build` after every task will add 5–30 seconds per iteration. Should it be gated behind a config flag (`runBuildAfterTask: boolean`)?

3. **M11.3 DriveScoreAdapter placement**: Should the adapter be constructed once per loop run and stored, or rebuilt each iteration? Given that dissatisfaction scores change per iteration, rebuilding each iteration is correct.

4. **M11.4 `reason` enum extension**: `ThresholdAdjustmentProposal.reason` is a string union in `src/types/satisficing.ts`. Adding `"resource_undershoot"` will require a schema update — check if any downstream consumers pattern-match on `reason`.

5. **M11.2 approval threshold**: What blast_radius or estimated change size triggers mandatory approval? This needs a concrete threshold (e.g., > 5 files or > 200 lines changed).
