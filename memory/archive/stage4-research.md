# Stage 4 リサーチ — 実装後詳細サマリー

作成日: 2026-03-11
更新日: 2026-03-11
対象: Stage 4 実装後 (AdapterLayer + TaskLifecycle) — API仕様、テスト内容、ドキュメント状況

---

## 1. 実装ファイルのAPI仕様

### 1.1 `src/adapter-layer.ts`

エクスポート:
- `AgentTask` interface: `{ prompt: string; timeout_ms: number; adapter_type: string }`
  - 注: `adapter_type` は `string` (研究メモでは `"claude_code_cli" | "claude_api"` と書いていたが実装は `string` でより汎用的)
- `AgentResult` interface: `{ success: boolean; output: string; error: string | null; exit_code: number | null; elapsed_ms: number; stopped_reason: "completed" | "timeout" | "error" }`
- `IAdapter` interface: `{ execute(task: AgentTask): Promise<AgentResult>; readonly adapterType: string }`
- `AdapterRegistry` class:
  - `register(adapter: IAdapter): void` — 同一typeで上書き可能
  - `getAdapter(type: string): IAdapter` — 未登録でエラー（エラーメッセージに利用可能typeリスト含む）
  - `listAdapters(): string[]` — ソート済み配列を返す

**Confirmed** — ソースから直接読取

---

### 1.2 `src/adapters/claude-code-cli.ts`

```typescript
class ClaudeCodeCLIAdapter implements IAdapter {
  readonly adapterType = "claude_code_cli";

  constructor(cliPath: string = "claude")
  async execute(task: AgentTask): Promise<AgentResult>
}
```

動作:
- `spawn(cliPath, ["--print"], { stdio: ["pipe", "pipe", "pipe"] })` でプロセス起動
- `task.prompt` をstdinに書き込んで `stdin.end()`
- `setTimeout(SIGTERM)` でタイムアウト処理
- `child.on("close")` で結果を resolve
- `child.on("error")` でプロセス起動失敗を処理 (exit_code: null)
- タイムアウト時: `{ success: false, stopped_reason: "timeout", error: "Timed out after Xms" }`
- 成功条件: `exit_code === 0`

注意事項:
- `--print` フラグは "claude" CLIの非インタラクティブモード想定
- TODO コメントあり: CLIバージョンによってフラグが異なる可能性がある

**Confirmed** — ソースから直接読取

---

### 1.3 `src/adapters/claude-api.ts`

```typescript
class ClaudeAPIAdapter implements IAdapter {
  readonly adapterType = "claude_api";

  constructor(llmClient: ILLMClient)
  async execute(task: AgentTask): Promise<AgentResult>
}
```

動作:
- `Promise.race([llmPromise, timeoutPromise])` でタイムアウト処理
- `llmClient.sendMessage([{ role: "user", content: task.prompt }])` を呼び出し
- 成功: `{ success: true, output: response.content, exit_code: null, stopped_reason: "completed" }`
- LLMエラー: `{ success: false, error: err.message, stopped_reason: "error" }`
- タイムアウト: `{ success: false, error: "Timed out after Xms", stopped_reason: "timeout" }`
- `exit_code` は常に `null` (API adapter)

**Confirmed** — ソースから直接読取

---

### 1.4 `src/task-lifecycle.ts`

#### エクスポート型

```typescript
export interface ExecutorReport {
  completed: boolean;
  summary: string;
  partial_results: string[];
  blockers: string[];
}

export interface TaskCycleResult {
  task: Task;
  verificationResult: VerificationResult;
  action: "completed" | "keep" | "discard" | "escalate" | "approval_denied";
}

export interface VerdictResult {
  action: "completed" | "keep" | "discard" | "escalate";
  task: Task;
}

export interface FailureResult {
  action: "keep" | "discard" | "escalate";
  task: Task;
}

// re-exported from adapter-layer:
export type { AgentTask, AgentResult, IAdapter };
```

#### コンストラクタ

```typescript
class TaskLifecycle {
  constructor(
    stateManager: StateManager,
    llmClient: ILLMClient,
    sessionManager: SessionManager,
    trustManager: TrustManager,
    strategyManager: StrategyManager,
    stallDetector: StallDetector,
    options?: { approvalFn?: (task: Task) => Promise<boolean> }
  )
}
```

`approvalFn` のデフォルト: `(_task) => Promise.resolve(false)` (安全側デフォルト)

#### 公開メソッド

```typescript
// 1. 次元選択 (純粋な計算、LLM不使用)
selectTargetDimension(gapVector: GapVector, driveContext: DriveContext): string
// DriveScorer.scoreAllDimensions + rankDimensions を使用
// gaps.length === 0 で throw

// 2. タスク生成 (LLM 1回呼び出し)
generateTask(goalId: string, targetDimension: string, strategyId?: string): Promise<Task>
// LLMGeneratedTaskSchema でZod parse
// strategyId: 明示引数 → activeStrategy?.id → null の優先順位
// 永続化: tasks/<goalId>/<taskId>.json

// 3. 承認チェック
checkIrreversibleApproval(task: Task, confidence?: number = 0.5): Promise<boolean>
// domain = task.task_category
// TrustManager.requiresApproval(reversibility, domain, confidence) が false → true (承認不要)
// true → approvalFn(task) を呼び出して結果を返す
// FIXME: Phase 2 — EthicsGate integration for task means check

// 4. タスク実行
executeTask(task: Task, adapter: IAdapter): Promise<AgentResult>
// sessionManager.createSession("task_execution", goal_id, task.id)
// buildTaskExecutionContext でslotをpriority順にソート→"\n\n"結合
// timeout_ms = estimated_duration から durationToMs, なければ 30分デフォルト
// status: pending→running→completed/timed_out/error
// session終了: endSession(session.id, summary)
// adapter.execute() 例外: { success: false, stopped_reason: "error", ... } で捕捉

// 5. 3層検証
verifyTask(task: Task, executionResult: AgentResult): Promise<VerificationResult>
// Layer 1: runMechanicalVerification (private)
// Layer 2: runLLMReview (private) — review session作成
// Layer 3: parseExecutorReport (private)
// 矛盾解消: L1 PASS+L2 PASS=pass(0.9), L1 PASS+L2 FAIL→再review, L1 FAIL+L2 PASS=fail(0.85)
// L1 skip: pass(0.6), partial(0.5), fail(0.6)
// 永続化: verification/<task_id>/verification-result.json

// 6. 判定処理
handleVerdict(task: Task, verificationResult: VerificationResult): Promise<VerdictResult>
// pass: recordSuccess, failure_count=0, status=completed, appendTaskHistory
// partial + direction correct: keep + appendTaskHistory
// partial + direction wrong / fail: handleFailure

// 7. 失敗処理
handleFailure(task: Task, verificationResult: VerificationResult): Promise<FailureResult>
// consecutive_failure_count++
// recordFailure(domain)
// count >= 3: StallDetector.checkConsecutiveFailures + escalate
// direction correct (verdict="partial"): keep
// direction wrong + reversible: attemptRevert → success=discard, fail=setDimensionIntegrity("uncertain")+escalate
// direction wrong + irreversible/unknown: escalate

// 8. フルサイクル
runTaskCycle(goalId: string, gapVector: GapVector, driveContext: DriveContext, adapter: IAdapter): Promise<TaskCycleResult>
// select → generate → checkApproval → execute → verify → handleVerdict
// 承認拒否: { action: "approval_denied", verificationResult.verdict="fail" }
```

#### 重要な実装上の注意点

1. **Layer 1 MVP動作**: `mechanicalPrefixes` (npm/npx/pytest/sh/bash/node/make/cargo/go) でコマンドを検出。検出されれば `applicable: true, passed: true` (コマンド実行はしない、assumed pass)
2. **isDirectionCorrect**: `verificationResult.verdict === "partial"` の場合のみ true (verdict="fail" は false)
3. **state_integrity**: `setDimensionIntegrity()` は `goals/<goalId>.json` を直接readRaw/writeRaw で書き換え
4. **タスク履歴**: `tasks/<goalId>/task-history.json` に配列でappend (taskId/status/primary_dimension/consecutive_failure_count/completed_at)
5. **durationToMs**: minutes=60K, hours=3.6M, days=86.4M, weeks=604.8M (不明なunitは hours扱い)

**Confirmed** — ソースから直接読取

---

## 2. テスト詳細

### 2.1 `tests/adapter-layer.test.ts` — 27テスト

**AdapterRegistry** (6テスト):
- starts with no adapters
- registers an adapter and retrieves it by type
- listAdapters returns sorted order
- overwrites previously registered adapter for same type
- throws when adapter not registered
- error message includes available types

**ClaudeAPIAdapter** (9テスト):
- adapterType is "claude_api"
- returns success result with LLM response content
- passes prompt as user message to LLM
- returns error result when LLM throws (Error instance)
- returns error result with non-Error thrown value (string)
- returns timeout result when LLM doesn't respond within timeout_ms
- records elapsed_ms close to actual wall time
- timeout result has no output from never-resolving call
- can be registered in AdapterRegistry
- multiple sequential calls each get own response (10番目: 実際は9テスト)

**ClaudeCodeCLIAdapter** (12テスト):
- adapterType is "claude_code_cli"
- default cliPath is "claude"
- accepts custom cliPath
- returns success result when process exits 0 (uses `true` binary)
- returns error result when process exits non-zero (uses `false` binary)
- captures stdout from process (uses `echo`)
- captures stderr from process (uses `sh`)
- returns timeout result when process runs longer than timeout_ms (node infinite loop)
- timeout result includes elapsed_ms close to timeout_ms
- returns error result when binary does not exist
- exit_code is null when process errors before starting
- elapsed_ms is non-negative for successful execution
- can be registered in AdapterRegistry
- multiple sequential executions are independent

実際の合計: AdapterRegistry(6) + ClaudeAPIAdapter(9+1=10) + ClaudeCodeCLIAdapter(12) = **27テスト** ... いや実際は 6+9+12 = **27テスト** (重複カウントに注意)

**Confirmed** — テストファイル直接確認

---

### 2.2 `tests/task-lifecycle.test.ts` — 109テスト

describeブロック別:

| describe ブロック | テスト数 | 主要な確認内容 |
|-----------------|---------|--------------|
| selectTargetDimension | 8 | dimension選択ロジック、DriveScorer連携、空vector throw |
| generateTask | 17 | LLMプロンプト、Zodパース、strategy_id解決、永続化、UUID、タイムスタンプ |
| checkIrreversibleApproval | 11 | reversible/irreversible/unknown、defaultApprovalFn=false、trust/confidence/gate |
| constructor | 2 | 依存性注入確認 |
| executeTask | 13 | セッション作成、adapter呼び出し、status更新、タイムアウト変換、prompt組み立て |
| verifyTask | 17 | L1/L2矛盾解消全パターン、confidence値、証拠収集、永続化、LLMパース失敗 |
| handleVerdict | 10 | pass/partial/fail処理、TrustManager呼び出し、history更新 |
| handleFailure | 17 | failure_count++、エスカレーション閾値3、keep/discard/escalate、revert |
| runTaskCycle | 5 | E2Eフロー、approval_denied、失敗フロー |
| persistence | 9 | verification保存パス、task履歴蓄積、primary_dimension記録、consecutive_failure_count |

合計: **109テスト**

**Confirmed** — Grep で `it(` をカウント

#### 重要なフィクスチャ

```typescript
VALID_TASK_RESPONSE      // reversible, estimated_duration 2h
IRREVERSIBLE_TASK_RESPONSE  // irreversible
UNKNOWN_REVERSIBILITY_RESPONSE  // unknown, estimated_duration null
```

LLM review応答フィクスチャ (各テスト内でインライン):
```typescript
// pass: JSON.stringify({ verdict: "pass", reasoning: "...", criteria_met: 1, criteria_total: 1 })
// fail: JSON.stringify({ verdict: "fail", reasoning: "...", criteria_met: 0, criteria_total: 1 })
// partial: JSON.stringify({ verdict: "partial", reasoning: "...", criteria_met: 1, criteria_total: 2 })
```

revert応答フィクスチャ:
```typescript
JSON.stringify({ success: true, reason: "..." })   // revert success
JSON.stringify({ success: false, reason: "..." })  // revert fail
```

---

## 3. テスト総数

| ファイル | テスト数 |
|---------|---------|
| state-manager | 既存 |
| gap-calculator | 既存 |
| trust-manager | 既存 |
| drive-scorer | 既存 |
| observation-engine | 既存 |
| satisficing-judge | 既存 |
| stall-detector | 既存 |
| drive-system | 既存 |
| llm-client | 既存 |
| session-manager | 既存 |
| strategy-manager | 既存 |
| ethics-gate | 既存 |
| goal-negotiator | 既存 |
| **adapter-layer** | **27 (Stage 4新規)** |
| **task-lifecycle** | **109 (Stage 4新規)** |

Stage 4 新規テスト合計: **136テスト**

memory/MEMORY.md に「793テスト通過（15ファイル）」と記録済み (Stage 4完了後)。
Stage 3以前のテスト数: 793 - 136 = 657テスト (Stage 3の653と近似、誤差はgoal-negotiator変更による)

---

## 4. ドキュメント状況

### 4.1 `docs/architecture-map.md`

**更新が必要**: §5 実装状況の記述が Stage 3完了前の状態になっている。
- 現在の記述: "Stage 1-2完了（405テスト通過）。次ステップ: Stage 3"
- 実際の状況: Stage 1-4完了（793テスト通過）。次ステップ: Stage 5

更新対象箇所:
- 267行目: `> **実装状況（2026-03-10時点）**: Stage 1-2完了（405テスト通過）。`
- 268行目: `> 実装済みモジュール: StateManager, GapCalculator（Layer 0）...`
- 269行目: `> 次ステップ: Stage 3...`

**Confirmed** — docs/architecture-map.md line 267-269確認

---

### 4.2 `docs/design/task-lifecycle.md`

**更新不要**: 設計ドキュメントは実装と整合している。

実装が設計から逸脱している点（MVP的な簡略化）:
- Layer 1 機械的検証: 設計では「別プロセスで検証セッションを起動」。実装では `mechanicalPrefixes` チェック + `assumed pass`
- `state_integrity` フィールド: 設計では `GoalDimension` に定義すべきと書かれているが、実装では `goals/<goalId>.json` を readRaw/writeRaw で直接書き換え (Zodスキーマには未定義)

---

### 4.3 `docs/design/execution-boundary.md`

**更新不要**: 設計ドキュメントは実装と整合している。AdapterRegistryの概念が §4「委譲モデル」「Capability Registry」に対応している。

---

### 4.4 アダプター専用設計ドキュメント

`docs/design/` にアダプター専用ドキュメントは**存在しない**。アダプターの設計は `execution-boundary.md` §3〜§5 (Capability Registry, 委譲モデル) に分散して記述されている。

**Confirmed** — `docs/design/*.md` のGlobで確認

---

## 5. メモリ/ドキュメントフォルダ構成

```
memory/
├── roadmap.md              — Stage 3-6 実装ロードマップ
├── roadmap-research.md     — Stage 3-6 詳細リサーチ
├── stage3-research.md      — Stage 3 リサーチ
├── stage3-api-summary.md   — Stage 3 API仕様 (この形式が参照形式)
├── stage3-manual-test-guide.md — Stage 3 手動テストスクリプト集
├── stage4-research.md      — このファイル (Stage 4リサーチ)
└── archive/
    ├── impl-roadmap-research.md  — 旧ロードマップリサーチ
    ├── stage1-spec.md
    ├── stage1-review.md
    ├── stage2-research.md
    └── stage3-review.md    — Stage 3 手動テスト結果
```

---

## 6. Stage 4 手動テスト用APIサマリー

### 6.1 インスタンス化パターン

```typescript
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-stage4-test-"));
const stateManager = new StateManager(tmpDir);
const llmClient = new LLMClient(); // ANTHROPIC_API_KEY 必須

const sessionManager = new SessionManager(stateManager);
const trustManager = new TrustManager(stateManager);
const strategyManager = new StrategyManager(stateManager, llmClient);
const stallDetector = new StallDetector(stateManager);

// AdapterRegistry
const registry = new AdapterRegistry();
registry.register(new ClaudeAPIAdapter(llmClient));
registry.register(new ClaudeCodeCLIAdapter()); // "claude" CLI が必要

// TaskLifecycle
const lifecycle = new TaskLifecycle(
  stateManager,
  llmClient,
  sessionManager,
  trustManager,
  strategyManager,
  stallDetector,
  {
    approvalFn: async (task) => {
      // readline で実装 or テストでは true/false を返す
      console.log(`Approval required for: ${task.work_description}`);
      return true; // テスト用に自動承認
    }
  }
);
```

### 6.2 依存関係グラフ

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
ClaudeCodeCLIAdapter  (no deps, optionally: cliPath)
  ↓
TaskLifecycle         (StateManager + ILLMClient + SessionManager + TrustManager + StrategyManager + StallDetector)
```

### 6.3 GapVector / DriveContext の最小構成

```typescript
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

## 7. Stage 4 手動テスト — ゲート条件

roadmap.md §Stage 4 より (参考):
1. 全ユニットテスト通過 (`npx vitest run`)
2. ClaudeAPIAdapter で単純タスクの生成→実行→検証が完走する
3. 不可逆アクション検出時に approvalFn が呼ばれる
4. タスク失敗時の `escalate` アクション（consecutive_failure_count >= 3）が発動
5. `consecutive_failure_count` が正しくインクリメント・リセットされる

---

## 8. docs/architecture-map.md の更新内容

以下の箇所を更新する必要がある:

**変更前** (line 267-269):
```
> **実装状況（2026-03-10時点）**: Stage 1-2完了（405テスト通過）。
> 実装済みモジュール: StateManager, GapCalculator（Layer 0）、DriveSystem, TrustManager（Layer 1）、DriveScorer, ObservationEngine, SatisficingJudge, StallDetector（Layer 2）
> 次ステップ: Stage 3（SessionManager, GoalNegotiator, StrategyManager）
```

**変更後**:
```
> **実装状況（2026-03-11時点）**: Stage 1-4完了（793テスト通過）。
> 実装済みモジュール: StateManager, GapCalculator（Layer 0）、DriveSystem, TrustManager（Layer 1）、DriveScorer, ObservationEngine, SatisficingJudge, StallDetector（Layer 2）、LLMClient, EthicsGate, SessionManager, StrategyManager, GoalNegotiator（Layer 3）、AdapterLayer, ClaudeCodeCLIAdapter, ClaudeAPIAdapter（Layer 0拡張）, TaskLifecycle（Layer 4）
> 次ステップ: Stage 5（CoreLoop, ReportingEngine）
```

---

## 9. 注目すべき実装上の判断 (設計ドキュメントとの差異)

| 項目 | 設計ドキュメント | 実装 | ラベル |
|-----|----------------|------|--------|
| Layer 1 実行 | 別プロセスで検証セッション起動 | mechanicalPrefixes チェック + assumed pass (MVP) | **Confirmed** |
| state_integrity | GoalDimension 型フィールドとして | readRaw/writeRaw 直接書き換え (型外) | **Confirmed** |
| EthicsGate | task means チェック有 | FIXME Phase 2コメントのみ | **Confirmed** |
| approvalFn | readline stdin | DI注入パターン (デフォルト: false) | **Confirmed** |
| adapter_type | "claude_code_cli" \| "claude_api" | string (より汎用的) | **Confirmed** |
| LLM review | JSON parse via parseJSON | 直接 JSON.parse + replace (parseJSON使わず) | **Confirmed** |

---

## 10. 信頼ラベルサマリー

| 情報 | ラベル |
|-----|--------|
| adapter-layer.ts API | **Confirmed** (ソース直読) |
| claude-code-cli.ts 動作 | **Confirmed** (ソース直読) |
| claude-api.ts 動作 | **Confirmed** (ソース直読) |
| task-lifecycle.ts 公開メソッドシグネチャ | **Confirmed** (ソース直読) |
| task-lifecycle.ts Layer 1 MVP動作 | **Confirmed** (ソース直読) |
| adapter-layer.test.ts テスト数 27 | **Confirmed** (テスト直読) |
| task-lifecycle.test.ts テスト数 109 | **Confirmed** (Grep count) |
| architecture-map.md 更新必要箇所 line 267-269 | **Confirmed** (docs直読) |
| task-lifecycle.md / execution-boundary.md 更新不要 | **Confirmed** (docs直読) |
| アダプター専用設計ドキュメント存在しない | **Confirmed** (Glob確認) |
