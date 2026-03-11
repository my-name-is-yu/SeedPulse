# Stage 4 API Summary — Manual Test Reference

Generated from source reading of all Stage 4 modules and their test files.

---

## 0. Prerequisite: StateManager + LLMClient

```ts
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { StateManager } from "./src/state-manager.js";
import { LLMClient } from "./src/llm-client.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-stage4-"));
const stateManager = new StateManager(tmpDir);
const llmClient = new LLMClient(); // requires ANTHROPIC_API_KEY in env

// Cleanup after test:
// fs.rmSync(tmpDir, { recursive: true, force: true });
```

---

## 1. AdapterLayer

**Source:** `src/adapter-layer.ts`

### Exported Types

```ts
interface AgentTask {
  prompt: string;
  timeout_ms: number;
  adapter_type: string;  // string (not a union — more generic than docs suggest)
}

interface AgentResult {
  success: boolean;
  output: string;
  error: string | null;
  exit_code: number | null;
  elapsed_ms: number;
  stopped_reason: "completed" | "timeout" | "error";
}

interface IAdapter {
  execute(task: AgentTask): Promise<AgentResult>;
  readonly adapterType: string;
}
```

### AdapterRegistry

```ts
import { AdapterRegistry } from "./src/adapter-layer.js";

const registry = new AdapterRegistry();

// Register an adapter (overwrites if same adapterType)
registry.register(adapter);  // IAdapter

// Get adapter by type (throws if not registered; error lists available types)
const adapter: IAdapter = registry.getAdapter("claude_api");

// List all registered types (sorted)
const types: string[] = registry.listAdapters();
```

---

## 2. ClaudeAPIAdapter

**Source:** `src/adapters/claude-api.ts`

```ts
import { ClaudeAPIAdapter } from "./src/adapters/claude-api.js";

const adapter = new ClaudeAPIAdapter(llmClient);  // ILLMClient — required
// adapter.adapterType === "claude_api"
```

Behavior:
- `Promise.race([llmPromise, timeoutPromise])` for timeout handling
- Calls `llmClient.sendMessage([{ role: "user", content: task.prompt }])`
- Success: `{ success: true, output: response.content, exit_code: null, stopped_reason: "completed" }`
- LLM error: `{ success: false, error: err.message, stopped_reason: "error" }`
- Timeout: `{ success: false, error: "Timed out after Xms", stopped_reason: "timeout" }`
- `exit_code` is always `null` (API adapter has no process exit codes)

---

## 3. ClaudeCodeCLIAdapter

**Source:** `src/adapters/claude-code-cli.ts`

```ts
import { ClaudeCodeCLIAdapter } from "./src/adapters/claude-code-cli.js";

const adapter = new ClaudeCodeCLIAdapter();          // uses "claude" as default CLI path
const adapter = new ClaudeCodeCLIAdapter("/path/to/claude");  // custom path
// adapter.adapterType === "claude_code_cli"
```

Behavior:
- `spawn(cliPath, ["--print"], { stdio: ["pipe", "pipe", "pipe"] })`
- Writes `task.prompt` to stdin, then calls `stdin.end()`
- `setTimeout(SIGTERM)` for timeout
- Resolves on `child.on("close")`; rejects/captures on `child.on("error")`
- Success condition: `exit_code === 0`
- Timeout: `{ success: false, stopped_reason: "timeout", error: "Timed out after Xms" }`
- Process start failure: `exit_code: null`

Note: `--print` flag assumes the "claude" CLI's non-interactive mode. TODO comment in source: flags may differ across CLI versions.

---

## 4. TaskLifecycle

**Source:** `src/task-lifecycle.ts`

### Exported Types

```ts
interface ExecutorReport {
  completed: boolean;
  summary: string;
  partial_results: string[];
  blockers: string[];
}

interface TaskCycleResult {
  task: Task;
  verificationResult: VerificationResult;
  action: "completed" | "keep" | "discard" | "escalate" | "approval_denied";
}

interface VerdictResult {
  action: "completed" | "keep" | "discard" | "escalate";
  task: Task;
}

interface FailureResult {
  action: "keep" | "discard" | "escalate";
  task: Task;
}

// Re-exported from adapter-layer:
export type { AgentTask, AgentResult, IAdapter };
```

### Constructor

```ts
import { TaskLifecycle } from "./src/task-lifecycle.js";
import { SessionManager } from "./src/session-manager.js";
import { TrustManager } from "./src/trust-manager.js";
import { StrategyManager } from "./src/strategy-manager.js";
import { StallDetector } from "./src/stall-detector.js";

const lifecycle = new TaskLifecycle(
  stateManager,     // StateManager — required
  llmClient,        // ILLMClient — required
  sessionManager,   // SessionManager — required
  trustManager,     // TrustManager — required
  strategyManager,  // StrategyManager — required
  stallDetector,    // StallDetector — required
  {
    approvalFn: async (task) => {
      // Default: (_task) => Promise.resolve(false) — safe-side default
      // Replace with readline implementation in CLI context
      return true;
    }
  }
);
```

### Public Methods

```ts
// 1. Dimension selection (pure calculation, no LLM)
const dimension: string = lifecycle.selectTargetDimension(
  gapVector,    // GapVector
  driveContext  // DriveContext
);
// Uses DriveScorer.scoreAllDimensions + rankDimensions
// Throws if gaps.length === 0

// 2. Task generation (1 LLM call)
const task: Task = await lifecycle.generateTask(
  "goal-uuid",          // goalId: string
  "test_coverage",      // targetDimension: string
  "strategy-uuid"       // strategyId?: string (optional)
  // strategyId priority: explicit arg → activeStrategy?.id → null
);
// Parses via LLMGeneratedTaskSchema (Zod)
// Persists to: tasks/<goalId>/<taskId>.json

// 3. Approval check
const approved: boolean = await lifecycle.checkIrreversibleApproval(
  task,       // Task
  0.5         // confidence?: number (default: 0.5)
  // domain = task.task_category
  // If TrustManager.requiresApproval() === false → returns true (no approval needed)
  // If approval needed → calls approvalFn(task)
  // FIXME: Phase 2 — EthicsGate integration for task means check
);

// 4. Task execution
const result: AgentResult = await lifecycle.executeTask(
  task,     // Task
  adapter   // IAdapter
);
// Creates task_execution session, builds context, calls adapter.execute()
// Status: pending → running → completed/timed_out/error
// timeout_ms: derived from task.estimated_duration via durationToMs; default 30 minutes
// Catches adapter exceptions → { success: false, stopped_reason: "error", ... }

// 5. Three-layer verification
const verification: VerificationResult = await lifecycle.verifyTask(
  task,            // Task
  executionResult  // AgentResult
);
// Layer 1 (mechanical): detects mechanicalPrefixes (npm/npx/pytest/sh/bash/node/make/cargo/go)
//   → applicable: true, passed: true (assumed pass; does NOT actually run command)
//   → if no prefix detected: applicable: false (skipped)
// Layer 2 (LLM review): creates task_review session
// Layer 3 (executor self-report): parseExecutorReport from output
// Contradiction resolution:
//   L1 PASS + L2 PASS → pass (confidence 0.9)
//   L1 PASS + L2 FAIL → re-review
//   L1 FAIL + L2 PASS → fail (confidence 0.85)
//   L1 skip + L2 pass → pass (0.6), partial (0.5), fail (0.6)
// Persists to: verification/<taskId>/verification-result.json

// 6. Verdict handling
const verdict: VerdictResult = await lifecycle.handleVerdict(
  task,               // Task
  verificationResult  // VerificationResult
);
// pass: recordSuccess, failure_count=0, status=completed, appendTaskHistory
// partial + direction correct: keep + appendTaskHistory
// partial + direction wrong / fail: → handleFailure()

// 7. Failure handling
const failure: FailureResult = await lifecycle.handleFailure(
  task,               // Task
  verificationResult  // VerificationResult
);
// consecutive_failure_count++, recordFailure(domain)
// count >= 3: StallDetector.checkConsecutiveFailures + escalate
// direction correct (verdict="partial"): keep
// direction wrong + reversible: attemptRevert → success=discard, fail=setDimensionIntegrity("uncertain")+escalate
// direction wrong + irreversible/unknown: escalate

// 8. Full task cycle (select → generate → approve → execute → verify → verdict)
const cycleResult: TaskCycleResult = await lifecycle.runTaskCycle(
  "goal-uuid",    // goalId: string
  gapVector,      // GapVector
  driveContext,   // DriveContext
  adapter         // IAdapter
);
// approval denied → { action: "approval_denied", verificationResult.verdict="fail" }
```

### Key Implementation Notes

- **isDirectionCorrect**: `verdict === "partial"` → true; `verdict === "fail"` → false
- **durationToMs**: minutes=60K, hours=3.6M, days=86.4M, weeks=604.8M; unknown unit treated as hours
- **state_integrity**: `setDimensionIntegrity()` directly uses readRaw/writeRaw on `goals/<goalId>.json` (not in Zod schema)
- **Task history**: appended to `tasks/<goalId>/task-history.json` (array of `{ taskId, status, primary_dimension, consecutive_failure_count, completed_at }`)

---

## 5. Full Instantiation Pattern

```ts
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { StateManager } from "./src/state-manager.js";
import { LLMClient } from "./src/llm-client.js";
import { SessionManager } from "./src/session-manager.js";
import { TrustManager } from "./src/trust-manager.js";
import { StrategyManager } from "./src/strategy-manager.js";
import { StallDetector } from "./src/stall-detector.js";
import { TaskLifecycle } from "./src/task-lifecycle.js";
import { ClaudeCodeCLIAdapter } from "./src/adapters/claude-code-cli.js";
import { ClaudeAPIAdapter } from "./src/adapters/claude-api.js";
import { AdapterRegistry } from "./src/adapter-layer.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-stage4-"));
const stateManager = new StateManager(tmpDir);
const llmClient = new LLMClient(); // ANTHROPIC_API_KEY required

const sessionManager = new SessionManager(stateManager);
const trustManager = new TrustManager(stateManager);
const strategyManager = new StrategyManager(stateManager, llmClient);
const stallDetector = new StallDetector(stateManager);

const registry = new AdapterRegistry();
registry.register(new ClaudeAPIAdapter(llmClient));
registry.register(new ClaudeCodeCLIAdapter()); // requires "claude" CLI in PATH

const lifecycle = new TaskLifecycle(
  stateManager,
  llmClient,
  sessionManager,
  trustManager,
  strategyManager,
  stallDetector,
  { approvalFn: async (task) => true } // auto-approve for testing
);
```

---

## 6. Dependency Graph

```
StateManager          (no deps)
LLMClient             (no deps)
  ↓
SessionManager        (StateManager)
TrustManager          (StateManager)
StallDetector         (StateManager)
StrategyManager       (StateManager + ILLMClient)
  ↓
AdapterRegistry       (no deps)
ClaudeAPIAdapter      (ILLMClient)
ClaudeCodeCLIAdapter  (no deps; optionally: cliPath string)
  ↓
TaskLifecycle         (StateManager + ILLMClient + SessionManager + TrustManager + StrategyManager + StallDetector)
```

---

## 7. GapVector / DriveContext Minimal Fixture

```ts
import type { GapVector } from "./src/types/gap.js";
import type { DriveContext } from "./src/types/drive.js";

const gapVector: GapVector = {
  goal_id: "goal-001",
  gaps: [
    {
      dimension_name: "test_coverage",
      raw_gap: 0.3,
      normalized_gap: 0.3,
      normalized_weighted_gap: 0.35,
      confidence: 0.8,
      uncertainty_weight: 1.0,
    }
  ],
  timestamp: new Date().toISOString(),
};

const driveContext: DriveContext = {
  time_since_last_attempt: { test_coverage: 24 }, // hours
  deadlines: { test_coverage: null },
  opportunities: {},
};
```

---

## 8. LLM Response Fixtures for verifyTask

```ts
// Layer 2 (LLM review) responses used inline in tests:
const PASS_REVIEW    = JSON.stringify({ verdict: "pass",    reasoning: "All criteria met.",     criteria_met: 1, criteria_total: 1 });
const FAIL_REVIEW    = JSON.stringify({ verdict: "fail",    reasoning: "Criteria not met.",     criteria_met: 0, criteria_total: 1 });
const PARTIAL_REVIEW = JSON.stringify({ verdict: "partial", reasoning: "Some criteria met.",    criteria_met: 1, criteria_total: 2 });

// Revert attempt responses (handleFailure, reversible task):
const REVERT_SUCCESS = JSON.stringify({ success: true,  reason: "Successfully reverted." });
const REVERT_FAIL    = JSON.stringify({ success: false, reason: "Could not revert." });
```

---

## 9. Manual Test Gate Conditions (from roadmap.md)

1. All unit tests pass: `npx vitest run`
2. ClaudeAPIAdapter completes generate → execute → verify for a simple task
3. `approvalFn` is called when an irreversible action is detected
4. `escalate` action fires when `consecutive_failure_count >= 3`
5. `consecutive_failure_count` increments and resets correctly

---

## 10. Import Paths (ESM — .js extension required)

```ts
import { AdapterRegistry } from "./src/adapter-layer.js";
import type { AgentTask, AgentResult, IAdapter } from "./src/adapter-layer.js";
import { ClaudeCodeCLIAdapter } from "./src/adapters/claude-code-cli.js";
import { ClaudeAPIAdapter } from "./src/adapters/claude-api.js";
import { TaskLifecycle } from "./src/task-lifecycle.js";
import type { ExecutorReport, TaskCycleResult, VerdictResult, FailureResult } from "./src/task-lifecycle.js";

// Stage 3 dependencies also needed for TaskLifecycle:
import { SessionManager } from "./src/session-manager.js";
import { StrategyManager } from "./src/strategy-manager.js";

// Stage 2 dependencies:
import { TrustManager } from "./src/trust-manager.js";
import { StallDetector } from "./src/stall-detector.js";
```

---

## 11. Confidence Labels

All findings are **Confirmed** — extracted directly from source files (`src/adapter-layer.ts`, `src/adapters/claude-code-cli.ts`, `src/adapters/claude-api.ts`, `src/task-lifecycle.ts`) and cross-referenced with test files (`tests/adapter-layer.test.ts` — 27 tests, `tests/task-lifecycle.test.ts` — 109 tests).

Notable behaviors:
- **Layer 1 MVP**: does NOT run verification commands; `mechanicalPrefixes` match → `assumed pass`
- **isDirectionCorrect**: only `verdict="partial"` returns true; `verdict="fail"` returns false
- **approvalFn default**: `false` (safe-side); must be injected for any real approval flow
- **EthicsGate in TaskLifecycle**: Phase 2 only (FIXME comment in source; not active in Stage 4)
