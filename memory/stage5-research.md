# Stage 5 Research — CoreLoop + ReportingEngine

作成日: 2026-03-11
対象: Stage 5 実装担当 Worker

---

## 0. BLOCKER: progress_ceiling 数値不整合

**Stage 5 実装前に解決が必須。** CoreLoop は ObservationEngine と SatisficingJudge の両方を呼び出すため、ここで統一値を決定する。

### 各ソースの値

| ソース | self_report ceiling | independent_review ceiling |
|--------|--------------------|-----------------------------|
| `docs/design/observation.md` §4 | `0.70` | `0.90` |
| `docs/design/satisficing.md` §2 | `0.60` | `0.85` |
| **`src/observation-engine.ts` (実装済み)** | **`0.70`** | **`0.90`** |
| **`src/satisficing-judge.ts` (実装済み)** | **`0.60`** | **`0.85`** |

### 解決方針（推奨）

2つのモジュールは**異なる入力**を取っている点に注目すること:

- `ObservationEngine.applyProgressCeiling(progress, layer: ObservationLayer)` — 観測層（"mechanical" | "independent_review" | "self_report"）を引数に取る。入力フィルターとして機能。
- `SatisficingJudge.applyProgressCeiling(progress, confidence: number)` — 信頼度の数値を引数に取り、内部で tier 分類する。完了判断時の評価に使う。

コードコメント（`satisficing-judge.ts` L20）には明示的に "These ceiling values are from satisficing.md (distinct from ObservationEngine ceilings)" と記載されている。

**結論**: 両者は意図的に異なる値を使う設計。2つの役割が別物であるため、統一不要。ただし設計ドキュメントの記述が不整合なので、どちらかを修正するか「意図的に異なる」という説明をドキュメントに追記する必要がある。

実装担当者への指示: **現在のコード実装値をそのまま使う（変更不要）**。`memory/roadmap.md` の「数値不整合」ノートを解決済みとしてマークすること。

---

## 1. CoreLoop 設計

### 1.1 ループフロー（mechanism.md §2 より）

```
observe → gap → score → task → execute → verify → report → (repeat)
```

詳細ステップ:

| ステップ | 呼び出すモジュール | 内容 |
|---------|----------------|------|
| observe | ObservationEngine | post_task / periodic / event_driven の3タイミング観測 |
| gap | GapCalculator | 各次元の normalized_gap + confidence_weight 計算 |
| score | DriveScorer | 3駆動スコア（不満/締切/機会）で次元を優先順位付け |
| task | TaskLifecycle.runTaskCycle() | select → generate → approve → execute → verify → verdict |
| verify | TaskLifecycle 内部 (3層) | L1機械的 / L2独立LLMレビュー / L3自己申告 |
| report | ReportingEngine | 副作用として各ステップ後に通知判定 |
| completion check | SatisficingJudge.isGoalComplete() | 全次元が閾値超え + confidence 十分 → ループ停止 |
| stall check | StallDetector | 停滞検知 → StrategyManager.onStallDetected() |

### 1.2 ループ停止条件

- `SatisficingJudge.isGoalComplete(goal).is_complete === true`
- ユーザーによる手動停止 (SIGTERM)
- 停滞エスカレーション第3段階（CoreLoop はエスカレーション後にユーザーの判断待ちで停止 or 継続）

### 1.3 エラーハンドリング方針（roadmap.md §5-3 より）

- 各ステップで例外が発生してもループが安全に停止する
- LLMタイムアウト、ファイルI/Oエラーでグレースフルに処理
- 1ループあたりの最大LLM呼び出し数: 5回（ゲート条件）

### 1.4 ループ間の状態引き継ぎ

- 前ループの観測結果（`ObservationLog`）は StateManager 経由で次ループに継続
- `GapHistory` も StateManager に蓄積 (`appendGapHistoryEntry`)
- `StallState` も StateManager に永続化

### 1.5 停滞連動ピボット

```
StallDetector.checkDimensionStall() → StallReport 返却
→ StrategyManager.onStallDetected(goalId, stallReport) 呼び出し
→ StrategyManager が新候補生成 → activateBestCandidate()
→ CoreLoop は新しい activeStrategy で次のタスク生成サイクルへ
```

### 1.6 CoreLoop の依存モジュール（roadmap.md より）

```
ObservationEngine, GapCalculator, DriveScorer, TaskLifecycle,
SatisficingJudge, StallDetector, ReportingEngine
```

---

## 2. ReportingEngine 設計

### 2.1 レポート3種（reporting.md §2 より）

| 種別 | トリガー | 内容 |
|------|---------|------|
| 定期レポート（日次/週次） | 時刻ベース | 全ゴール進捗、次元別進捗、実行サマリー、戦略評価、リスク、次アクション |
| 即時通知 | 閾値/イベントベース | 緊急アラート / 承認要求 / 停滞エスカレーション / ゴール完了 / 能力不足 |
| 戦略変更通知 | 内部イベント | ピボット判断時に変更前/後と根拠を報告 |

### 2.2 コアループとの統合ポイント（reporting.md §4 より）

レポーティングはループの**副作用**として動作（ループ本体を変更しない）:

```
observe後 → [急変ありか？] → Yes: 緊急アラート生成
gap後     → [全次元閾値超えか？] → Yes: ゴール完了通知
戦略選択後 → [ピボットが発生したか？] → Yes: 戦略変更通知
タスク生成後 → [不可逆アクションか？] → Yes: 承認要求通知（TaskLifecycle内でも処理）
ループ継続後 → [スケジュール時刻か？] → Yes: 定期レポート生成
```

停滞との連動:
- 第1検知: レポートなし（自律対応）
- 第2検知: 次回定期レポートに停滞情報を含める
- 第3検知: 即時通知（エスカレーション）

### 2.3 MVP仕様（reporting.md §9 より）

- 配信: ファイル出力（Markdown）+ CLIログ
- 保存先: `~/.motiva/reports/daily/`, `weekly/`, `notifications/`
- ファイル名: 定期は日付 (`2026-03-10.md`)、通知はタイムスタンプ+種別 (`20260310-143022-alert-health.md`)
- 粒度: 3段階（minimal / standard / detailed）。daily は standard、weekly は detailed がデフォルト
- LLM関与: minimal レベルはテンプレート埋め込みのみ（LLM不要）。standard 以上でLLM使用

### 2.4 通知クールダウン（reporting.md §6.2 より）

```
urgent_alert: 0m（クールダウンなし）
approval_request: 0m
stall_escalation: 60m
strategy_change: 30m
goal_completion: 0m
```

### 2.5 ReportTypeEnum（src/types/core.ts より）

```ts
ReportTypeEnum = z.enum([
  "daily_summary", "weekly_report", "urgent_alert",
  "approval_request", "stall_escalation", "goal_completion",
  "strategy_change", "capability_escalation",
])
```

VerbosityLevelEnum = `"minimal" | "standard" | "detailed"`

Report スキーマ（src/types/report.ts）:
```ts
{
  id: string,
  report_type: ReportType,
  goal_id: string | null,
  title: string,
  content: string,
  verbosity: VerbosityLevel,
  generated_at: string,
  delivered_at: string | null,
  read: boolean,
}
```

ReportingSchedule スキーマ（src/types/report.ts）:
```ts
{
  daily_summary: { enabled, time, timezone, skip_if_no_activity },
  weekly_report: { enabled, day, time, timezone, skip_if_no_activity },
}
```

---

## 3. 全モジュール インターフェース

### 3.1 ObservationEngine（src/observation-engine.ts）

```ts
class ObservationEngine {
  constructor(stateManager: StateManager)

  applyProgressCeiling(progress: number, layer: ObservationLayer): number
  // LAYER_CONFIG: mechanical→1.0, independent_review→0.90, self_report→0.70

  getConfidenceTier(layer: ObservationLayer): { tier: ConfidenceTier; range: [number, number] }

  createObservationEntry(params: {
    goalId, dimensionName, layer, method, trigger, rawResult, extractedValue, confidence, notes?
  }): ObservationLogEntry

  needsVerificationTask(effectiveProgress: number, confidence: number, threshold: number): boolean

  resolveContradiction(entries: ObservationLogEntry[]): ObservationLogEntry

  applyObservation(goalId: string, entry: ObservationLogEntry): void
  // Mutates goal's dimension.current_value and confidence

  getObservationLog(goalId: string): ObservationLog
  saveObservationLog(goalId: string, log: ObservationLog): void
}
```

### 3.2 GapCalculator（src/gap-calculator.ts） — 純粋関数

```ts
function computeRawGap(threshold: Threshold, currentValue: unknown): number
function normalizeGap(rawGap: number, threshold: Threshold): number
function applyConfidenceWeight(normalizedGap: number, confidence: number): number

interface DimensionGapInput { name: string; threshold: Threshold; current_value: unknown; confidence: number }
function calculateDimensionGap(input: DimensionGapInput): GapEntry

function calculateGapVector(goalId: string, dimensions: DimensionGapInput[]): GapVector
function aggregateGaps(gaps: GapEntry[], aggregationType?: GapAggregation): number
```

### 3.3 DriveScorer（src/drive-scorer.ts） — 純粋関数

```ts
function scoreDissatisfaction(gap: GapEntry, timeSinceLastAttempt?: number): number
function scoreDeadline(gap: GapEntry, deadline: Date | null): number
function scoreOpportunity(gap: GapEntry, opportunities?: Record<string, unknown>): number
function computeOpportunityValue(...): number
function combineDriveScores(dissatisfaction, deadline, opportunity): DriveScore
function scoreAllDimensions(gaps: GapEntry[], driveContext: DriveContext): DriveScore[]
function rankDimensions(scores: DriveScore[]): DriveScore[]
```

### 3.4 TaskLifecycle（src/task-lifecycle.ts）

```ts
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

  selectTargetDimension(gapVector: GapVector, driveContext: DriveContext): string
  async generateTask(goalId, targetDimension, strategyId?): Promise<Task>
  async checkIrreversibleApproval(task, confidence?): Promise<boolean>
  async executeTask(task: Task, adapter: IAdapter): Promise<AgentResult>
  async verifyTask(task: Task, executionResult: AgentResult): Promise<VerificationResult>
  async handleVerdict(task, verificationResult): Promise<VerdictResult>
  async handleFailure(task, verificationResult): Promise<FailureResult>

  async runTaskCycle(goalId, gapVector, driveContext, adapter): Promise<TaskCycleResult>
  // Returns: { task, verificationResult, action: "completed"|"keep"|"discard"|"escalate"|"approval_denied" }
}
```

### 3.5 SatisficingJudge（src/satisficing-judge.ts）

```ts
class SatisficingJudge {
  constructor(stateManager: StateManager)

  isDimensionSatisfied(dim: Dimension): DimensionSatisfaction
  isGoalComplete(goal: Goal): CompletionJudgment
  // CompletionJudgment: { is_complete, blocking_dimensions, low_confidence_dimensions, needs_verification_task, checked_at }

  applyProgressCeiling(actualProgress: number, confidence: number): number
  // Tiers: confidence >= 0.85 → 1.0 | >= 0.50 → 0.85 | < 0.50 → 0.60

  propagateSubgoalCompletion(subgoalId: string, parentGoalId: string): void
}
```

### 3.6 StallDetector（src/stall-detector.ts）

```ts
class StallDetector {
  constructor(stateManager: StateManager)

  checkDimensionStall(goalId, dimensionName, gapHistory, feedbackCategory?): StallReport | null
  checkTimeExceeded(task): StallReport | null  // estimated × 2 threshold
  computeDecayFactor(isStalled: boolean, loopsSinceRecovery: number | null): number
  isSuppressed(plateauUntil: string | null): boolean
  getStallState(goalId: string): StallState
  saveStallState(goalId: string, state: StallState): void
  getEscalationLevel(goalId, dimensionName): number
  incrementEscalation(goalId, dimensionName): number
  resetEscalation(goalId, dimensionName): void
  checkConsecutiveFailures(goalId, count): StallReport | null  // used from TaskLifecycle
}
```

### 3.7 StrategyManager（src/strategy-manager.ts）

```ts
class StrategyManager {
  constructor(stateManager: StateManager, llmClient: ILLMClient)

  async generateCandidates(goalId, ...): Promise<Strategy[]>
  async activateBestCandidate(goalId: string): Promise<Strategy>
  async onStallDetected(goalId: string, stallReport: StallReport): Promise<void>
  // Triggers pivot: terminates current strategy → generateCandidates → activateBestCandidate
}
```

### 3.8 StateManager（src/state-manager.ts）

```ts
class StateManager {
  constructor(baseDir?: string)  // defaults to ~/.motiva/
  getBaseDir(): string

  saveGoal(goal: Goal): void
  loadGoal(goalId: string): Goal | null
  deleteGoal(goalId: string): boolean
  listGoalIds(): string[]

  saveGoalTree(tree: GoalTree): void
  loadGoalTree(rootId: string): GoalTree | null
  deleteGoalTree(rootId: string): boolean

  saveObservationLog(log: ObservationLog): void
  loadObservationLog(goalId: string): ObservationLog | null
  appendObservation(goalId: string, entry: ObservationLogEntry): void

  saveGapHistory(goalId: string, history: GapHistoryEntry[]): void
  loadGapHistory(goalId: string): GapHistoryEntry[]
  appendGapHistoryEntry(goalId: string, entry: GapHistoryEntry): void

  goalExists(goalId: string): boolean
  readRaw(relativePath: string): unknown | null
  writeRaw(relativePath: string, data: unknown): void
}
```

### 3.9 DriveSystem（src/drive-system.ts）

```ts
class DriveSystem {
  constructor(stateManager: StateManager, options?: { baseDir?: string })

  shouldActivate(goalId: string): boolean
  readEventQueue(): MotivaEvent[]
  archiveEvent(eventFileName: string): void
  processEvents(): MotivaEvent[]  // read + archive all pending events
  getSchedule(goalId: string): GoalSchedule | null
  updateSchedule(goalId: string, schedule: GoalSchedule): void
  isScheduleDue(goalId: string): boolean
  createDefaultSchedule(goalId: string, intervalHours: number): GoalSchedule
  prioritizeGoals(goalIds: string[], scores: Map<string, number>): string[]
}
```

---

## 4. テストパターン（task-lifecycle.test.ts より）

### 4.1 基本構造

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-stage5-test-"));
}

describe("CoreLoop", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  // ...
});
```

### 4.2 Mock LLM Client パターン

```ts
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../src/llm-client.js";
import { z } from "zod";

function createMockLLMClient(responses: string[]): ILLMClient {
  let callIndex = 0;
  return {
    async sendMessage(_messages: LLMMessage[], _options?: LLMRequestOptions): Promise<LLMResponse> {
      return {
        content: responses[callIndex++] ?? "",
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
      const match = content.match(/```json\n?([\s\S]*?)\n?```/) || [null, content];
      return schema.parse(JSON.parse(match[1] ?? content));
    },
  };
}
```

### 4.3 CoreLoop テストの重点項目（roadmap.md §5 より）

自動テストで検証可能:
- CoreLoop のステップ実行順序（モックで全ステップの呼び出し順序を確認）
- ループ間の状態引き継ぎ（StateManager に正しく永続化されるか）
- 停滞→ピボット連鎖（モックで StallDetector → StrategyManager の連動）
- SatisficingJudge 完了発火（閾値境界テスト）
- ReportingEngine 出力形式（スナップショットテスト）
- エラーハンドリング（各ステップの例外注入）

手動テストが必要:
- E2E（実LLM + 実CLIで1ループ完走）
- レポートの可読性
- 停滞→ピボット→新タスク生成の実環境連鎖

### 4.4 スナップショットテスト（ReportingEngine）

```ts
import { expect } from "vitest";
// vitest には toMatchInlineSnapshot / toMatchFileSnapshot がある
expect(markdownOutput).toMatchSnapshot();
```

---

## 5. ファイル配置

### Stage 5 で新規作成するファイル

```
src/reporting-engine.ts   — ReportingEngine MVP
src/core-loop.ts          — CoreLoop（全体オーケストレーション）
tests/reporting-engine.test.ts
tests/core-loop.test.ts
```

### State ファイルのパス（~/.motiva/ 配下）

```
reports/daily/YYYY-MM-DD.md
reports/weekly/YYYY-WNN.md
reports/notifications/YYYYMMDDHHmmss-<type>.md
reports/archive/...
tasks/<goalId>/<taskId>.json
tasks/<goalId>/task-history.json
verification/<taskId>/verification-result.json
goals/<goalId>.json
observations/<goalId>.json
gap-history/<goalId>.json
ethics/<logId>.json
events/  (ファイルキュー)
```

---

## 6. ゲート条件（Stage 5完了の定義）

1. 全ユニットテスト通過（全依存をモック）
2. `progress_ceiling` 数値不整合を解決済み（ドキュメント更新 or コメント追記）
3. 簡単なゴールで CoreLoop が observe → gap → task → verify → 完了判断まで自動で回る（手動確認）
4. `~/.motiva/reports/` にレポートファイルが正しく生成される
5. 停滞シナリオ（意図的失敗）でエスカレーションが動作する（手動確認）
6. 1ループあたりの LLM 呼び出し回数 ≤ 5 回（実測確認）

---

## 7. 信頼度ラベル

- progress_ceiling の実装値（`observation-engine.ts`, `satisficing-judge.ts`）: **Confirmed** — ソース直読み
- CoreLoop フロー（mechanism.md §2 + roadmap.md §5）: **Confirmed**
- ReportingEngine 要件（reporting.md）: **Confirmed**
- モジュール public API（各 .ts ファイルのシグネチャ抽出）: **Confirmed**
- テストパターン（task-lifecycle.test.ts 参照）: **Confirmed**
- StallDetector の `checkConsecutiveFailures` 存在: **Likely** — task-lifecycle.ts から呼ばれているが直接確認はしていない（stage4-api-summary.md で記録あり）
