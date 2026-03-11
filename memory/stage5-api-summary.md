# Stage 5 API Summary — Manual Test Reference

Generated from source reading of Stage 5 modules: `src/core-loop.ts` and `src/reporting-engine.ts`.

---

## 0. Prerequisite: All Stage 1-4 Modules + GapCalculator + DriveScorer

```ts
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { StateManager } from "./src/state-manager.js";
import { LLMClient } from "./src/llm-client.js";
import { ObservationEngine } from "./src/observation-engine.js";
import { DriveSystem } from "./src/drive-system.js";
import { TrustManager } from "./src/trust-manager.js";
import { SatisficingJudge } from "./src/satisficing-judge.js";
import { StallDetector } from "./src/stall-detector.js";
import { SessionManager } from "./src/session-manager.js";
import { StrategyManager } from "./src/strategy-manager.js";
import { TaskLifecycle } from "./src/task-lifecycle.js";
import { AdapterRegistry } from "./src/adapter-layer.js";
import { ClaudeAPIAdapter } from "./src/adapters/claude-api.js";
import { GapCalculator } from "./src/gap-calculator.js";
import { DriveScorer } from "./src/drive-scorer.js";
import { CoreLoop } from "./src/core-loop.js";
import { ReportingEngine } from "./src/reporting-engine.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-stage5-"));
const stateManager = new StateManager(tmpDir);
const llmClient = new LLMClient(); // requires ANTHROPIC_API_KEY in env

// Initialize all dependencies (see Stage 4 summary for Session/Trust/Stall/Strategy setup)
const observationEngine = new ObservationEngine(stateManager);
const driveSystem = new DriveSystem(stateManager);
const trustManager = new TrustManager(stateManager);
const satisficingJudge = new SatisficingJudge(stateManager);
const stallDetector = new StallDetector(stateManager);
const sessionManager = new SessionManager(stateManager);
const strategyManager = new StrategyManager(stateManager, llmClient);
const taskLifecycle = new TaskLifecycle(stateManager, llmClient, sessionManager, trustManager, strategyManager, stallDetector);

const registry = new AdapterRegistry();
registry.register(new ClaudeAPIAdapter(llmClient));

const gapCalculator = new GapCalculator(stateManager);
const driveScorer = new DriveScorer();

const reportingEngine = new ReportingEngine(stateManager);

// Cleanup after test:
// fs.rmSync(tmpDir, { recursive: true, force: true });
```

---

## 1. CoreLoop

**Source:** `src/core-loop.ts`

### Exported Types

```ts
interface GapCalculatorModule {
  calculateGapVector: (
    goalId: string,
    dimensions: Goal["dimensions"],
    globalUncertaintyWeight?: number
  ) => GapVector;
  aggregateGaps: (
    childGaps: number[],
    method?: "max" | "weighted_avg" | "sum",
    weights?: number[]
  ) => number;
}

interface DriveScorerModule {
  scoreAllDimensions: (
    gapVector: GapVector,
    context: DriveContext,
    config?: unknown
  ) => DriveScore[];
  rankDimensions: (scores: DriveScore[]) => DriveScore[];
}

interface ExecutionSummaryParams {
  goalId: string;
  loopIndex: number;
  observation: { dimensionName: string; progress: number; confidence: number }[];
  gapAggregate: number;
  taskResult: { taskId: string; action: string; dimension: string } | null;
  stallDetected: boolean;
  pivotOccurred: boolean;
  elapsedMs: number;
}

interface LoopConfig {
  maxIterations?: number;           // default: 100
  maxConsecutiveErrors?: number;    // default: 3
  delayBetweenLoopsMs?: number;     // default: 1000
  adapterType?: string;             // default: "claude_api"
}

interface LoopIterationResult {
  loopIndex: number;
  goalId: string;
  gapAggregate: number;
  driveScores: DriveScore[];
  taskResult: TaskCycleResult | null;
  stallDetected: boolean;
  stallReport: StallReport | null;
  pivotOccurred: boolean;
  completionJudgment: CompletionJudgment;
  elapsedMs: number;
  error: string | null;
}

interface LoopResult {
  goalId: string;
  totalIterations: number;
  finalStatus: "completed" | "stalled" | "max_iterations" | "error" | "stopped";
  iterations: LoopIterationResult[];
  startedAt: string;
  completedAt: string;
}

interface CoreLoopDeps {
  stateManager: StateManager;
  observationEngine: ObservationEngine;
  gapCalculator: GapCalculatorModule;
  driveScorer: DriveScorerModule;
  taskLifecycle: TaskLifecycle;
  satisficingJudge: SatisficingJudge;
  stallDetector: StallDetector;
  strategyManager: StrategyManager;
  reportingEngine: ReportingEngine;
  driveSystem: DriveSystem;
  adapterRegistry: AdapterRegistry;
}
```

### Constructor

```ts
import { CoreLoop } from "./src/core-loop.js";

const coreLoop = new CoreLoop(
  {
    stateManager,
    observationEngine,
    gapCalculator,
    driveScorer,
    taskLifecycle,
    satisficingJudge,
    stallDetector,
    strategyManager,
    reportingEngine,
    driveSystem,
    adapterRegistry,
  },
  {
    maxIterations: 100,
    maxConsecutiveErrors: 3,
    delayBetweenLoopsMs: 1000,
    adapterType: "claude_api",
  }
);
```

### Public Methods

```ts
// 1. Run full loop until completion/error/stop
const loopResult: LoopResult = await coreLoop.run(goalId);
// Orchestrates: observe → gap calc → drive score → completion check → stall check → task cycle → report
// Loops until:
//   - completionJudgment.is_complete === true (finalStatus="completed")
//   - consecutive errors >= maxConsecutiveErrors (finalStatus="error")
//   - stallReport.escalation_level >= 3 (finalStatus="stalled")
//   - loopIndex >= maxIterations (finalStatus="max_iterations")
//   - stopped === true (finalStatus="stopped")
// Persists gap_history entries per iteration
// Calls reportingEngine.generateExecutionSummary & saveReport for each iteration

// 2. Run single iteration (internal, but can be called directly for testing)
const iterationResult: LoopIterationResult = await coreLoop.runOneIteration(goalId, loopIndex);
// Steps per iteration:
//   1. Load goal (error if not found or not active/waiting)
//   2. Call observationEngine.observe() if available (non-fatal if fails)
//   3. Calculate gap vector & aggregate gap
//   4. Score dimensions & rank by drive priority
//   5. Check completion (isGoalComplete)
//   6. Check per-dimension stall & global stall (via StallDetector)
//   7. Run task cycle (select → generate → approve → execute → verify → verdict)
//   8. Generate report & save
// Returns iteration result with all state filled

// 3. Stop the loop externally (e.g., SIGTERM)
coreLoop.stop();
// Sets stopped=true; next iteration breaks with finalStatus="stopped"

// 4. Check if stopped
const wasStopped: boolean = coreLoop.isStopped();
```

### Helper: buildDriveContext

```ts
import type { Goal } from "./src/types/goal.js";
import type { DriveContext } from "./src/types/drive.js";
import { buildDriveContext } from "./src/core-loop.js";

const driveContext: DriveContext = buildDriveContext(goal);
// Computes time_since_last_attempt (hours) per dimension from last_updated
// Deadline: goal.deadline converted to hours_remaining
// Opportunities: empty (computed inline, reserved for extensions)
```

### Key Implementation Notes

- **Observation step**: Calls `observationEngine.observe(goalId, methods)` if method exists; non-fatal on fail
- **Gap persistence**: Appends `gap_history` entries with normalized_weighted_gap + confidence vectors
- **Stall per-dimension**: Checks each dimension via `StallDetector.checkDimensionStall()`; on detection, calls `StrategyManager.onStallDetected()` to attempt pivot
- **Global stall**: If no per-dimension stall, checks global stall via `StallDetector.checkGlobalStall()`
- **Task cycle**: Uses adapter from `adapterRegistry.getAdapter(config.adapterType)`; if execution fails, reports error (non-fatal)
- **Completion re-check**: After task execution, re-checks `satisficingJudge.isGoalComplete()` to detect in-loop completion
- **Report generation**: Calls `reportingEngine.generateExecutionSummary()` + `saveReport()` for each iteration (non-fatal on fail)
- **Error counter**: Resets to 0 on successful iteration; increments on error; loop breaks if >= maxConsecutiveErrors
- **Stall escalation**: `stallReport.escalation_level >= 3` triggers "stalled" finalStatus

---

## 2. ReportingEngine

**Source:** `src/reporting-engine.ts`

### Exported Types

```ts
type ExecutionSummaryParams = {
  goalId: string;
  loopIndex: number;
  observation: { dimensionName: string; progress: number; confidence: number }[];
  gapAggregate: number;
  taskResult: { taskId: string; action: string; dimension: string } | null;
  stallDetected: boolean;
  pivotOccurred: boolean;
  elapsedMs: number;
};

type NotificationType =
  | "urgent"
  | "approval_required"
  | "stall_escalation"
  | "completed"
  | "capability_insufficient";

type NotificationContext = {
  goalId: string;
  message: string;
  details?: string;
};
```

### Constructor

```ts
import { ReportingEngine } from "./src/reporting-engine.js";

const reportingEngine = new ReportingEngine(stateManager);
// stateManager: StateManager (required for persist/load)
```

### Public Methods

```ts
// 1. Generate execution summary (per-loop report)
const report: Report = reportingEngine.generateExecutionSummary({
  goalId: "goal-001",
  loopIndex: 5,
  observation: [
    { dimensionName: "test_coverage", progress: 0.75, confidence: 0.9 },
  ],
  gapAggregate: 0.25,
  taskResult: {
    taskId: "task-uuid",
    action: "completed",
    dimension: "test_coverage",
  },
  stallDetected: false,
  pivotOccurred: false,
  elapsedMs: 12345,
});
// Generates markdown Report with:
//   - Observation results (table: Dimension | Progress | Confidence)
//   - Gap aggregate score
//   - Task result (taskId, action, dimension) or "No task executed"
//   - Status: stall_detected, strategy_pivot
//   - Elapsed time (converted to seconds)
// ReportSchema.parse validates; returns Report type
// Zod-compatible: id (UUID), report_type="execution_summary", goal_id, title, content (markdown), verbosity="standard", generated_at (ISO8601), delivered_at=null, read=false

// 2. Generate daily summary
const dailyReport: Report = reportingEngine.generateDailySummary(goalId);
// Loads all reports for goalId generated today
// Parses execution summaries: loop count, gap progression (first→last), stall/pivot counts
// Returns markdown Report with:
//   - Loops run today
//   - Stalls detected count
//   - Strategy pivots count
//   - Gap change (▼ reduced / ▲ grew)

// 3. Generate weekly report
const weeklyReport: Report = reportingEngine.generateWeeklyReport(goalId);
// Loads all daily summaries for last 7 days
// Aggregates: days with activity, total loops, total stalls, total pivots
// Builds trend section: daily progress change lines (chronological)
// Returns markdown Report with weekly summary

// 4. Save report (persist to disk)
reportingEngine.saveReport(report);
// Writes to: reports/<goalId>/<reportId>.json via stateManager.writeRaw()

// 5. Get report by ID
const retrieved: Report | null = reportingEngine.getReport(reportId);
// Searches across all reports; returns null if not found

// 6. List all reports (optionally filtered by goalId)
const allReports: Report[] = reportingEngine.listReports();
const goalReports: Report[] = reportingEngine.listReports(goalId);
// Loads all .json files from reports/<goalId>/ (or all reports/ if no goalId)
// Sorts by generated_at ascending
// Returns array of Report (ReportSchema-validated)

// 7. Format report for CLI output
const cliLine: string = reportingEngine.formatForCLI(report);
// Execution summary: "[Loop N] goalId | gap: X.XX | task: id (action) | Xs"
// Daily summary: "[Daily YYYY-MM-DD] goalId | N loops"
// Weekly report: "[Weekly YYYY-MM-DD] goalId | N total loops"
// Fallback: "[type] goalId | title"

// 8. Generate notification
const notification: Report = reportingEngine.generateNotification("stall_escalation", {
  goalId: "goal-001",
  message: "Escalation Level 3 reached for dimension test_coverage",
  details: "Recommend external intervention or goal recalibration",
});
// Type switches report_type & title:
//   - "urgent" → "urgent_alert"
//   - "approval_required" → "approval_request"
//   - "stall_escalation" → "stall_escalation"
//   - "completed" → "goal_completion"
//   - "capability_insufficient" → "capability_escalation"
// Generates markdown Report with message + optional details
```

### Key Implementation Notes

- **Markdown formatting**: All reports use markdown tables/lists for consistency
- **Report persistence**: Via `stateManager.writeRaw()` at relative path `reports/<goalId>/<reportId>.json`
- **Gap parsing**: Daily/weekly summaries extract `**Score**: X.XXXX` from execution_summary content
- **Progress change**: Computes delta between first and last loop of the day (negative = gap reduced)
- **Trend parsing**: Extracts loops, gap change, dates from daily summaries to build weekly trend
- **File scanning**: `listReports()` uses `fs.readdirSync()` with `withFileTypes` to walk directory tree
- **Fallback to readRaw**: Loads .json via relative path `reports/<goalId>/<filename>`
- **Error tolerance**: `generateExecutionSummary()` validates via `ReportSchema.parse()`; missing fields use defaults (null, empty array)
- **CLI formatting**: Extracts key metrics via regex from markdown content (gap, taskId, loops, dates)

---

## 3. Full Instantiation Pattern (Stage 5)

```ts
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { StateManager } from "./src/state-manager.js";
import { LLMClient } from "./src/llm-client.js";
import { ObservationEngine } from "./src/observation-engine.js";
import { DriveSystem } from "./src/drive-system.js";
import { TrustManager } from "./src/trust-manager.js";
import { SatisficingJudge } from "./src/satisficing-judge.js";
import { StallDetector } from "./src/stall-detector.js";
import { SessionManager } from "./src/session-manager.js";
import { StrategyManager } from "./src/strategy-manager.js";
import { TaskLifecycle } from "./src/task-lifecycle.js";
import { AdapterRegistry } from "./src/adapter-layer.js";
import { ClaudeAPIAdapter } from "./src/adapters/claude-api.js";
import { GapCalculator } from "./src/gap-calculator.js";
import { DriveScorer } from "./src/drive-scorer.js";
import { CoreLoop } from "./src/core-loop.js";
import { ReportingEngine } from "./src/reporting-engine.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-stage5-"));
const stateManager = new StateManager(tmpDir);
const llmClient = new LLMClient();

// Stage 1-2 dependencies
const trustManager = new TrustManager(stateManager);
const stallDetector = new StallDetector(stateManager);
const driveSystem = new DriveSystem(stateManager);

// Stage 2-3 dependencies
const observationEngine = new ObservationEngine(stateManager);
const satisficingJudge = new SatisficingJudge(stateManager);
const sessionManager = new SessionManager(stateManager);
const strategyManager = new StrategyManager(stateManager, llmClient);

// Stage 4 dependencies
const registry = new AdapterRegistry();
registry.register(new ClaudeAPIAdapter(llmClient));
const taskLifecycle = new TaskLifecycle(
  stateManager,
  llmClient,
  sessionManager,
  trustManager,
  strategyManager,
  stallDetector,
  { approvalFn: async (task) => true }
);

// Stage 5 dependencies
const gapCalculator = new GapCalculator(stateManager);
const driveScorer = new DriveScorer();
const reportingEngine = new ReportingEngine(stateManager);

// CoreLoop assembly
const coreLoop = new CoreLoop(
  {
    stateManager,
    observationEngine,
    gapCalculator,
    driveScorer,
    taskLifecycle,
    satisficingJudge,
    stallDetector,
    strategyManager,
    reportingEngine,
    driveSystem,
    adapterRegistry: registry,
  },
  {
    maxIterations: 100,
    maxConsecutiveErrors: 3,
    delayBetweenLoopsMs: 1000,
    adapterType: "claude_api",
  }
);

// Run a goal
const result = await coreLoop.run("goal-uuid");
// result.finalStatus: "completed" | "stalled" | "max_iterations" | "error" | "stopped"
// result.iterations: LoopIterationResult[]
// result.totalIterations: number

// List reports for this goal
const reports = reportingEngine.listReports("goal-uuid");
for (const report of reports) {
  console.log(reportingEngine.formatForCLI(report));
}
```

---

## 4. Dependency Graph

```
StateManager              (no deps)
LLMClient                 (no deps)
  ↓
ObservationEngine         (StateManager)
DriveSystem               (StateManager)
TrustManager              (StateManager)
SatisficingJudge          (StateManager)
StallDetector             (StateManager)
SessionManager            (StateManager)
StrategyManager           (StateManager + ILLMClient)
  ↓
AdapterRegistry           (no deps)
ClaudeAPIAdapter          (ILLMClient)
TaskLifecycle             (StateManager + ILLMClient + SessionManager + TrustManager + StrategyManager + StallDetector)
  ↓
GapCalculator             (StateManager)
DriveScorer               (no deps)
ReportingEngine           (StateManager)
  ↓
CoreLoop                  (all of the above via CoreLoopDeps)
```

---

## 5. Goal Minimal Fixture (with dimensions)

```ts
import type { Goal } from "./src/types/goal.js";

const goal: Goal = {
  id: "goal-001",
  title: "Improve test coverage",
  description: "Increase unit test coverage to 80%",
  dimensions: [
    {
      name: "test_coverage",
      description: "Percentage of lines covered by unit tests",
      target_value: 0.8,
      current_value: 0.6,
      unit: "fraction",
      confidence: 0.85,
      last_updated: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
      dimension_type: "quantitative",
    },
    {
      name: "test_speed",
      description: "Average test execution time",
      target_value: 1.0, // 1 second
      current_value: 2.5,
      unit: "seconds",
      confidence: 0.7,
      last_updated: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // 1 day ago
      dimension_type: "quantitative",
    },
  ],
  deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days from now
  status: "active",
  created_at: new Date().toISOString(),
  last_modified: new Date().toISOString(),
  gap_aggregation: "min",
  uncertainty_weight: 1.0,
};
```

---

## 6. LoopIterationResult Minimal Fixture

```ts
import type { LoopIterationResult } from "./src/core-loop.js";

const iterationResult: LoopIterationResult = {
  loopIndex: 0,
  goalId: "goal-001",
  gapAggregate: 0.25,
  driveScores: [
    {
      dimension_name: "test_coverage",
      dissatisfaction_score: 0.4,
      deadline_score: 0.3,
      opportunity_score: 0,
      total_drive_score: 0.7,
      rank: 1,
    },
    {
      dimension_name: "test_speed",
      dissatisfaction_score: 0.15,
      deadline_score: 0.25,
      opportunity_score: 0,
      total_drive_score: 0.4,
      rank: 2,
    },
  ],
  taskResult: null,
  stallDetected: false,
  stallReport: null,
  pivotOccurred: false,
  completionJudgment: {
    is_complete: false,
    blocking_dimensions: ["test_coverage"],
    low_confidence_dimensions: ["test_speed"],
    needs_verification_task: false,
    checked_at: new Date().toISOString(),
  },
  elapsedMs: 5000,
  error: null,
};
```

---

## 7. ExecutionSummaryParams Fixture

```ts
import type { ExecutionSummaryParams } from "./src/core-loop.js";

const params: ExecutionSummaryParams = {
  goalId: "goal-001",
  loopIndex: 3,
  observation: [
    { dimensionName: "test_coverage", progress: 0.65, confidence: 0.88 },
    { dimensionName: "test_speed", progress: 2.2, confidence: 0.72 },
  ],
  gapAggregate: 0.22,
  taskResult: {
    taskId: "task-uuid-123",
    action: "completed",
    dimension: "test_coverage",
  },
  stallDetected: false,
  pivotOccurred: false,
  elapsedMs: 8234,
};

const report = reportingEngine.generateExecutionSummary(params);
reportingEngine.saveReport(report);
```

---

## 8. Manual Test Gate Conditions (from roadmap.md)

1. All unit tests pass: `npx vitest run`
2. CoreLoop instantiates with all Stage 1-4 modules + gapCalculator + reportingEngine
3. CoreLoop.run() completes one full iteration: observe → gap → score → completion → stall → task → report
4. ReportingEngine.generateExecutionSummary() produces valid markdown Report
5. ReportingEngine.saveReport() persists to `reports/<goalId>/<reportId>.json`
6. ReportingEngine.listReports(goalId) retrieves saved reports
7. CoreLoop.stop() sets stopped=true and breaks the loop with finalStatus="stopped"
8. CoreLoop breaks on finalStatus="completed" when SatisficingJudge.isGoalComplete() returns true
9. CoreLoop breaks on finalStatus="stalled" when stallReport.escalation_level >= 3
10. CoreLoop breaks on finalStatus="error" when consecutiveErrors >= maxConsecutiveErrors
11. Gap history entries are appended per iteration via `stateManager.appendGapHistoryEntry()`
12. Observation step is non-fatal (fails gracefully if observationEngine.observe() throws)

---

## 9. Key Extension Points for Stage 6 (CLIRunner)

- **buildDriveContext()**: Called in CoreLoop.runOneIteration() and runTaskCycle(); CLIRunner can pass custom time/deadline if needed
- **reportingEngine.generateDailySummary()** & **generateWeeklyReport()**: For scheduled report generation (cron/daemon in future stages)
- **reportingEngine.generateNotification()**: For alert/approval request UI in Stage 6
- **reportingEngine.formatForCLI()**: For pretty-printing reports in terminal
- **CoreLoop.stop()**: External signal handler (SIGTERM) to gracefully stop loop
- **approvalFn callback**: In TaskLifecycle, allows CLIRunner to inject readline approval prompts
- **adapterType config**: Allows CLIRunner to select "claude_api" vs "claude_code_cli" via LoopConfig

---

## 10. Import Paths (ESM — .js extension required)

```ts
import { CoreLoop, buildDriveContext } from "./src/core-loop.js";
import type { CoreLoopDeps, LoopConfig, LoopIterationResult, LoopResult, ExecutionSummaryParams } from "./src/core-loop.js";

import { ReportingEngine } from "./src/reporting-engine.js";
import type { NotificationType, NotificationContext } from "./src/reporting-engine.js";

// All Stage 1-4 imports (see stage4-api-summary.md)
import { StateManager } from "./src/state-manager.js";
import { LLMClient } from "./src/llm-client.js";
import { ObservationEngine } from "./src/observation-engine.js";
import { DriveSystem } from "./src/drive-system.js";
import { TrustManager } from "./src/trust-manager.js";
import { SatisficingJudge } from "./src/satisficing-judge.js";
import { StallDetector } from "./src/stall-detector.js";
import { SessionManager } from "./src/session-manager.js";
import { StrategyManager } from "./src/strategy-manager.js";
import { TaskLifecycle } from "./src/task-lifecycle.js";
import { AdapterRegistry } from "./src/adapter-layer.js";
import { GapCalculator } from "./src/gap-calculator.js";
import { DriveScorer } from "./src/drive-scorer.js";
```

---

## 11. Confidence Labels

All findings are **Confirmed** — extracted directly from source files (`src/core-loop.ts`, `src/reporting-engine.ts`) and cross-referenced with type definitions.

Notable behaviors:
- **CoreLoop.run()**: Loops until one of 5 exit conditions; each iteration calls all 8 pipeline stages (observe → gap → score → completion → stall → task → report)
- **Observation non-fatal**: If `observationEngine.observe()` throws or is unavailable, loop continues with current goal state
- **Stall detection**: Per-dimension stall checked first; if found, calls StrategyManager.onStallDetected() for pivot; if no pivot, checks global stall
- **Error tolerance**: Consecutive errors counted; 3+ triggers loop break with finalStatus="error"
- **Escalation exit**: stallReport.escalation_level >= 3 → finalStatus="stalled"
- **Report generation**: Called via tryGenerateReport() for each iteration; failures are non-fatal (logged silently)
- **Gap history persistence**: Appended per iteration with normalized_weighted_gap + confidence vectors
- **ReportSchema validation**: All reports go through Zod validation; invalid reports are skipped silently in listReports()
- **Daily/Weekly aggregation**: Parses markdown content via regex (error-prone but designed to be resilient)
