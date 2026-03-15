# Dogfood Phase B — Research Findings & Fix Plan

Research date: 2026-03-15

---

## QUESTION 1: How does CoreLoop decide which dimensions to observe from DataSource vs LLM?

**File: `src/core-loop.ts` lines 452–509**

The logic is:
1. Call `engine.getDataSources()` to get registered DataSource adapters.
2. For **every** goal dimension, iterate every DataSource and call `engine.observeFromDataSource(goalId, dim.name, ds.sourceId)`.
3. If that call **throws**, it logs a warning and tries the next source — the dimension is NOT added to `observedDimensions`.
4. Only dimensions that did NOT succeed in step 2 fall through to LLM `observe()` (self_report tier).

**Fallback: YES — LLM self_report is the fallback** (lines 489–498). If DataSource throws (or returns null → throws at line 370–374 of `observation-engine.ts`), the dimension falls to LLM observation.

**Root cause of Problem 1:**
`observeFromDataSource` in `src/observation-engine.ts` lines 370–374 throws explicitly when the DataSource returns `null`:
```
if (extractedValue === null || extractedValue === undefined) {
  throw new Error(`Data source "${sourceId}" returned null for dimension "${dimensionName}"`);
}
```
And `GitHubIssueDataSourceAdapter.query()` returns `{ value: null }` (not throws) for unknown dimensions (lines 85–92). So null propagates → `observeFromDataSource` throws → CoreLoop catches the throw, logs a warning, then tries the next DataSource. If no DataSource succeeds, the dimension is handed off to LLM self_report.

**This means the fallback IS already wired.** The LLM self_report fallback should be getting called for `readme_completeness`, `getting_started_exists`, `api_doc_coverage`. The problem may actually be that self_report uses `dim.current_value` (which starts as `null`) and propagates it forward, so gap scores stay at max but no "real" observation happens. **Confirmed** that this loop keeps running tasks every iteration because the dimensions never converge.

---

## QUESTION 2: How does ObservationEngine work? What observation strategies exist?

**File: `src/observation-engine.ts`**

Three layers (descending trust):
- `mechanical` — confidence [0.85, 1.0], ceiling 1.0 — used when DataSource returns a value
- `independent_review` — confidence [0.50, 0.84], ceiling 0.90 — not used in CoreLoop today
- `self_report` — confidence [0.10, 0.49], ceiling 0.70 — used as fallback (just re-records `dim.current_value`)

The `observe()` method (self_report path) does NOT call an LLM. It simply re-records `dim.current_value` as a self_report entry. So for dimensions with `current_value = null`, it records `extractedValue = null`, which triggers the floor threshold logic in gap-calculator.

**Confirmed: "LLM observation" is not actually LLM-powered — it's just a re-snapshot of current state.**

---

## QUESTION 3: What dimensions does GitHubIssueDataSourceAdapter provide? Can it be extended?

**File: `src/adapters/github-issue-datasource.ts` lines 78–92, 181–183**

Supported dimensions (hardcoded):
- `open_issue_count`
- `closed_issue_count`
- `total_issue_count`
- `completion_ratio`

For any other dimension name, query() returns `{ value: null, raw: [] }` immediately without spawning a process (line 85–92).

**Can it be extended?** Yes — adding more dimensions requires adding cases to the `knownDimensions` Set and implementing `gh`-based queries. Doc-quality dimensions (`readme_completeness`, `getting_started_exists`, `api_doc_coverage`) cannot be inferred from issue counts; they would require reading file contents (e.g., `gh api repos/:owner/:repo/contents/README.md` → parse length) or shell commands.

---

## QUESTION 4: How are tasks generated? Does task-lifecycle check for existing open issues?

**File: `src/task-lifecycle.ts`**

Task generation flow (`runTaskCycle`, lines 706–860):
1. `selectTargetDimension` — picks highest-drive-score dimension.
2. `generateTask` — calls LLM with a prompt (lines 864–976). The prompt includes goal title, dimension name, current value, target, and adapter context.
3. No deduplication. **There is NO check for existing open GitHub issues before creating a new one.** (`Grep` for `open_issue`, `existing.*issue`, `duplicate` returns zero matches in task-lifecycle.ts.)
4. For `github_issue` adapter type, `executeTask` formats the prompt as a `github-issue` JSON block with `title = work_description.split("\n")[0]` (line 278–281).

**Why issues #18 and #19 are identical:** The same dimension (`completion_ratio` or whichever maps closest) gets picked every iteration because the gap stays at max (observation returns null → self_report re-records null → gap stays high → same dimension always wins). The task generation LLM gets the same prompt twice and produces nearly-identical outputs. A new GitHub issue is created each time.

**Confirmed: No deduplication exists.**

---

## QUESTION 5: How is the GitHub issue created? Does the prompt include dimension info?

**File: `src/adapters/github-issue.ts` + `src/task-lifecycle.ts` lines 274–287**

When `adapter.adapterType === "github_issue"`:
- `executeTask` builds a `github-issue` JSON block: `{"title": <first line of work_description>, "body": <full work_description>}`.
- The LLM task generation prompt includes: goal title, dimension name, current value, target, and this text: "This task will be executed via GitHub issue creation. IMPORTANT: The work_description should contain the issue title on the first line, followed by the issue body."
- The prompt does NOT include other goal dimensions or current open issues.
- `GitHubIssueAdapter.parsePrompt()` parses the JSON block to extract title/body/labels.

**Missing context causing generic/duplicate issues:** The task prompt doesn't tell the LLM what issues already exist. It also doesn't include the full set of unfulfilled dimensions, so when the same top-dimension keeps being selected, the LLM generates near-identical issues.

---

## QUESTION 6: How does GoalNegotiator inject DataSource dimensions?

**File: `src/goal-negotiator.ts` lines 395–419**

In `negotiate()` Step 2:
1. Calls `this.observationEngine.getAvailableDimensionInfo()` → returns DataSource dimension names.
2. Passes them to `buildDecompositionPrompt()` which instructs the LLM: "You MUST use the exact dimension names listed below. These are the only dimensions that can be automatically observed."
3. After LLM returns decomposition, runs `findBestDimensionMatch()` (lines 408–419, 1202–1219) — a token-overlap matcher with 30% threshold — to remap any LLM-generated dim names to DataSource dims.

**Root cause confirmed:** `readme_completeness` tokens = `[readme, completeness]`. DataSource dims = `[open, issue, count, closed, total, completion, ratio]`. No overlap → `findBestDimensionMatch` returns null. The LLM invented dimension names that don't match DataSource dims, and the post-process step failed to remap them.

**This means the initial negotiation prompt said "use exact names" but the LLM still chose custom names, and the fuzzy match didn't catch them (0% token overlap).**

---

## ROOT CAUSE SUMMARY

### Problem 1: Observation returns null for doc-quality dimensions

The goal was negotiated with dimensions `readme_completeness`, `getting_started_exists`, `api_doc_coverage` — names the LLM invented despite being told to prefer DataSource names. The DataSource only knows `open_issue_count / closed_issue_count / completion_ratio / total_issue_count`. When CoreLoop tries DataSource observation for the doc dims, `observeFromDataSource` throws (null → error). The LLM self_report fallback runs but only re-records the existing `null` value — so gap stays at max all the time, the loop never converges, and tasks keep firing.

### Problem 2: Duplicate/generic issues

Same dimension wins every iteration (gap never drops). Task generation prompt sees same context → LLM generates near-identical issues. No guard checks whether an open issue already exists before creating another one.

---

## FIX OPTIONS ANALYSIS

### Problem 1 — Observation fix options

**Option a) Change goal dimensions to match DataSource dims (completion_ratio, etc)**
- Requires re-running negotiation (`motiva negotiate`) with a better prompt or manually editing the goal JSON in `~/.motiva/goals/<id>.json`.
- No code change needed.
- **Fast but brittle**: doesn't fix the underlying mismatch — next dogfood run will have the same problem if the goal is re-negotiated.
- **Recommended as a one-time fix for the current run**, but needs a code fix too.

**Option b) Add dimension aliasing/mapping in the DataSource registration**
- Add a `dimension_mapping` config entry to the DataSource registration that maps `readme_completeness → completion_ratio`, etc.
- `observeFromDataSource` already uses `source.config.dimension_mapping?.[dimensionName]` (line 351–354 of observation-engine.ts) — it checks if there's a mapped expression and uses it as the dimension key.
- File to edit: wherever the DataSource is registered (in `src/cli-runner.ts` or the dogfooding setup script — needs to be confirmed).
- **Pros**: no schema change, no goal re-negotiation, works now.
- **Cons**: the mapping is static and must be set at DataSource registration time.
- **Viable, minimal code change**.

**Option c) Let CoreLoop fall back to LLM observation when DataSource returns null**
- The fallback ALREADY EXISTS for throws. The self_report path fires for unmatched dimensions.
- The actual issue is that self_report doesn't do anything meaningful — it just re-records `null`.
- A real LLM-powered observation would require calling `llmClient.sendMessage()` inside `observe()`. This is a significant change.
- **Not the minimal fix here.**

**Option d) Extend GitHubIssueDataSourceAdapter to provide doc-quality dimensions**
- Add a new dimension, e.g., `readme_present`, that calls `gh api repos/:owner/:repo/contents/README.md` and checks for 200 status.
- Then remap the goal dimensions to use these new names.
- **More accurate but requires more code**.

**Recommended fix for Problem 1 (minimal):**
- Combine a + b: manually edit the existing goal JSON to rename dimensions to DataSource-compatible names (one-time), AND add `findBestDimensionMatch` threshold improvement so future negotiations don't produce mismatches.
- OR: improve the `buildDecompositionPrompt` to list DataSource dimension names more forcefully at the TOP of the prompt so the LLM actually uses them as dimension names for doc-related concepts. The current prompt places the DataSource section at the bottom, after the example.

**The single most impactful minimal code fix:** Move the DataSource dimension list to the TOP of `buildDecompositionPrompt` output and strengthen the instruction to use exact names. File: `src/goal-negotiator.ts`, function `buildDecompositionPrompt` (lines 49–87).

### Problem 2 — Duplicate issue prevention

**Does task-lifecycle already deduplicate?** No. Zero deduplication logic exists.

**Minimal fix:**
Add a check in `executeTask` (or `runTaskCycle`) for `github_issue` adapter: before creating an issue, call `gh issue list --state open --label motiva --search "<title>"` and skip creation if an identical or similar issue is already open.

This requires changes to:
- `src/adapters/github-issue.ts` — add a `checkDuplicate(title: string): Promise<boolean>` method that calls `gh issue list --state open --search "..."` and checks for title overlap.
- `src/task-lifecycle.ts` — call `checkDuplicate` before `adapter.execute(agentTask)` when `adapter.adapterType === "github_issue"`.

**Alternative (simpler):** Change the task prompt to include a "do not create if an issue with the same title exists" instruction, but this is unreliable (the LLM cannot know what issues exist).

**Better alternative:** Query existing open issues at the START of each loop iteration and inject them into the task generation prompt so the LLM generates non-duplicate, dimension-specific tasks.

---

## MINIMAL FIX PLAN

### Fix A — Prevent future dimension mismatch in negotiation (Problem 1)
**File:** `src/goal-negotiator.ts` — `buildDecompositionPrompt()` (lines 49–87)
**Change:** Move the `dataSourcesSection` to appear BEFORE the example JSON, and make the instruction the first constraint listed. Strengthen wording from "You MUST use the exact dimension names" to a numbered constraint at the top.
**Independent:** Yes — does not touch any other file.

### Fix B — Add open-issue deduplication (Problem 2)
**File:** `src/adapters/github-issue.ts`
**Change:** Add `checkOpenIssueExists(title: string, repo?: string): Promise<boolean>` using `gh issue list --state open --search "<title>" --json number,title`.
**File:** `src/task-lifecycle.ts` — `executeTask()` (lines 258–344)
**Change:** When `adapter.adapterType === "github_issue"`, call `(adapter as GitHubIssueAdapter).checkOpenIssueExists(parsed.title)` before `adapter.execute()`. If exists → skip execution and return a synthetic "already_exists" result.
**Alternative (simpler, no task-lifecycle change):** Add the check inside `GitHubIssueAdapter.execute()` itself before `spawnCreate`. This keeps the change in one file.
**Independent of Fix A:** Yes.

### Fix C — Inject existing open issues into task generation prompt (Problem 2, better)
**File:** `src/task-lifecycle.ts` — `buildTaskGenerationPrompt()` (lines 864–976)
**Change:** Accept an optional `existingOpenIssues: string[]` param and include it in the prompt: "Existing open issues (do not duplicate): [titles]". CoreLoop would need to fetch this list at the start of each iteration.
**Depends on:** Requires CoreLoop to fetch issues and pass them to `runTaskCycle`. More invasive.

---

## PARALLELIZATION PLAN

All three fixes are file-independent:

| Fix | Files touched | Can parallelize with |
|-----|---------------|---------------------|
| Fix A (negotiation prompt) | `src/goal-negotiator.ts` only | B and C simultaneously |
| Fix B (dedup in github-issue.ts) | `src/adapters/github-issue.ts` only | A and C simultaneously |
| Fix C (task prompt injection) | `src/task-lifecycle.ts` only | A and B simultaneously |

**Recommended minimal pair to ship first:** Fix A + Fix B. Fix C is better but more invasive.

**One-time manual fix for current dogfood run:** Edit `~/.motiva/goals/<id>.json` and rename:
- `readme_completeness` → `completion_ratio`
- `getting_started_exists` → `open_issue_count`
- `api_doc_coverage` → `closed_issue_count`
(or delete the goal and re-negotiate after Fix A is deployed)

---

## GAPS / UNCERTAINTIES

- **Uncertain**: Whether the current goal JSON in `~/.motiva/` can be edited in place and resumed without full re-negotiation. Needs testing.
- **Uncertain**: Whether the `dimension_mapping` field in DataSourceConfig is currently set in the dogfood DataSource registration. Need to check the actual CLI invocation or config file.
- **Confirmed**: No LLM call happens in the self_report fallback — it's a state re-snapshot only.
- **Confirmed**: No deduplication of any kind exists in task generation or GitHub issue creation.
