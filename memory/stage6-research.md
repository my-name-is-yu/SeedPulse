# Stage 6 — CLIRunner Research Summary

作成日: 2026-03-11
対象ファイル: `src/cli-runner.ts`, `src/index.ts` (エントリーポイント追記)

---

## 1. 実装するファイルと依存関係

```
src/cli-runner.ts   — サブコマンド実装本体
src/index.ts        — 既存のexport群に CLIRunner を追加
```

CLIRunner の依存モジュール:
- `StateManager` (src/state-manager.ts)
- `CoreLoop` + `CoreLoopDeps` (src/core-loop.ts)
- `GoalNegotiator` + `EthicsRejectedError` (src/goal-negotiator.ts)
- `ReportingEngine` (src/reporting-engine.ts)
- `DriveSystem` (src/drive-system.ts)
- `LLMClient` (src/llm-client.ts)
- `EthicsGate` (src/ethics-gate.ts)
- `ObservationEngine` (src/observation-engine.ts)
- `TrustManager` (src/trust-manager.ts)
- `DriveSystem` (src/drive-system.ts)
- `AdapterRegistry` (src/adapter-layer.ts)
- `ClaudeCodeCliAdapter` (src/adapters/claude-code-cli.ts)
- `ClaudeApiAdapter` (src/adapters/claude-api.ts)
- `TaskLifecycle` (src/task-lifecycle.ts)
- `SatisficingJudge` (src/satisficing-judge.ts)
- `StallDetector` (src/stall-detector.ts)
- `StrategyManager` (src/strategy-manager.ts)
- Pure functions: `calculateGapVector`, `aggregateGaps`, `scoreAllDimensions`, `rankDimensions` (gap-calculator.ts / drive-scorer.ts)

---

## 2. 各モジュールのコンストラクタと主要メソッド

### StateManager
```typescript
constructor(baseDir?: string)
// デフォルト: ~/.motiva/  (process.env.HOME + "/.motiva")

getBaseDir(): string
saveGoal(goal: Goal): void
loadGoal(goalId: string): Goal | null
listGoalIds(): string[]          // ← goal list コマンドで使用
deleteGoal(goalId: string): boolean
```

### CoreLoop
```typescript
constructor(deps: CoreLoopDeps, config?: LoopConfig)

// LoopConfig
interface LoopConfig {
  maxIterations?: number;          // default 100
  maxConsecutiveErrors?: number;   // default 3
  delayBetweenLoopsMs?: number;    // default 1000
  adapterType?: string;            // default "claude_api"
}

// CoreLoopDeps
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

async run(goalId: string): Promise<LoopResult>
// LoopResult.finalStatus: "completed" | "stalled" | "max_iterations" | "error" | "stopped"

stop(): void   // Ctrl+C グレースフルシャットダウン用
isStopped(): boolean
```

### GoalNegotiator
```typescript
constructor(
  stateManager: StateManager,
  llmClient: ILLMClient,
  ethicsGate: EthicsGate,
  observationEngine: ObservationEngine
)

async negotiate(
  rawGoalDescription: string,
  options?: {
    deadline?: string;
    constraints?: string[];
    timeHorizonDays?: number;
  }
): Promise<{ goal: Goal; response: NegotiationResponse; log: NegotiationLog }>
// throws EthicsRejectedError if rejected

async decompose(goalId: string, parentGoal: Goal): Promise<{ subgoals, rejectedSubgoals }>
async renegotiate(goalId, trigger, context?): Promise<{ goal, response, log }>
```

NegotiationResponse.type: `"accept" | "counter_propose" | "flag_as_ambitious"`
NegotiationResponse.message: ユーザーに表示するテキスト

### ReportingEngine
```typescript
constructor(stateManager: StateManager)

generateExecutionSummary(params: ExecutionSummaryParams): Report
generateDailySummary(goalId: string): Report
generateWeeklyReport(goalId: string): Report
saveReport(report: Report): void
getReport(reportId: string): Report | null
listReports(goalId?: string): Report[]       // ← status/report コマンドで使用
formatForCLI(report: Report): string         // ← CLIへの1行表示形式
generateNotification(type, context): Report
```

### DriveSystem
```typescript
constructor(stateManager: StateManager, options?: { baseDir?: string })

shouldActivate(goalId: string): boolean       // アクティブチェック
readEventQueue(): MotivaEvent[]
processEvents(): MotivaEvent[]
getSchedule(goalId: string): GoalSchedule | null
updateSchedule(goalId: string, schedule: GoalSchedule): void
createDefaultSchedule(goalId: string, intervalHours: number): GoalSchedule
prioritizeGoals(goalIds: string[], scores: Map<string, number>): string[]
```

### LLMClient
```typescript
constructor(apiKey?: string, options?: { model?: string; maxTokens?: number })
// API KEY: コンストラクタ引数 > process.env.ANTHROPIC_API_KEY
// キーなしでコンストラクタを呼ぶと throw

sendMessage(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse>
parseJSON<T>(content: string, schema: ZodSchema<T>): T
```

---

## 3. サブコマンド仕様

```
motiva run                     — CoreLoop を 1 回実行（アクティブなゴールを処理）
motiva goal add "<description>" — GoalNegotiator を起動してゴールを登録
motiva goal list               — 登録済みゴール一覧表示
motiva status                  — 現在の進捗レポート表示
motiva report                  — 最新レポートの表示
```

終了コード:
- `0` — 正常完了 / ゴール達成 (`finalStatus === "completed"` or 通常終了)
- `1` — エラー (`finalStatus === "error"` or 例外)
- `2` — 停滞エスカレーション (`finalStatus === "stalled"`)

---

## 4. CLI引数パース方針

Node.js 18+ 組み込みの `parseArgs` (`node:util`) を使用。外部ライブラリ不要。

```typescript
import { parseArgs } from "node:util";

// 例
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { /* flags */ },
  allowPositionals: true,
  strict: false, // サブコマンドは positionals で処理
});
```

---

## 5. `motiva run` の処理フロー

```
1. StateManager 初期化 (~/.motiva/ の作成)
2. アクティブゴール取得: stateManager.listGoalIds() でID列挙
   → 各IDを loadGoal() して status === "active" | "waiting" をフィルタ
3. DriveSystem.shouldActivate(goalId) でフィルタ
4. 依存モジュールを全部インスタンス化して CoreLoopDeps を組み立て
5. CoreLoop.run(goalId) を実行
6. SIGINT/SIGTERM で coreLoop.stop() を呼んでグレースフルシャットダウン
7. LoopResult.finalStatus に応じて終了コードを決定
```

---

## 6. `motiva goal add` の処理フロー

```
1. rawGoalDescription を positionals[1] から取得
2. GoalNegotiator を初期化
3. negotiate(rawGoalDescription) を呼び出し
4. response.type が "counter_propose" の場合は counterProposal を表示して確認を求める
5. response.message を表示
6. goal.id を表示（「ゴールが登録されました: <id>」）
7. EthicsRejectedError がスローされた場合はエラーメッセージを表示して exit(1)
```

---

## 7. `motiva goal list` の処理フロー

```
1. stateManager.listGoalIds() で ID 列挙
2. 各IDで loadGoal() → status, title, created_at を取得
3. テーブル形式で表示: ID | Status | Title | Created
```

---

## 8. `motiva status` / `motiva report` の処理フロー

```
status:
  1. stateManager.listGoalIds() でゴール一覧
  2. 各ゴールの最新の execution_summary を reportingEngine.listReports(goalId) から取得
  3. formatForCLI() で表示

report:
  1. 直近の全レポートを reportingEngine.listReports() で取得
  2. 最新N件を formatForCLI() で表示
  または report.content (Markdown) をそのまま表示
```

---

## 9. 初期化処理 (~/.motiva/)

StateManager のコンストラクタが自動で以下を作成する:
```
~/.motiva/
├── goals/
├── goal-trees/
├── events/
│   └── archive/
├── reports/
│   ├── daily/
│   ├── weekly/
│   └── notifications/
└── schedule/   ← DriveSystem が作成
```

CLIRunner での追加初期化は不要（StateManager + DriveSystem コンストラクタで完結）。

---

## 10. APIキー管理

LLMClient コンストラクタが `process.env.ANTHROPIC_API_KEY` を自動参照する。
CLIRunner での処理:
- LLMClient インスタンス化 → APIキーなしなら throw → catch して適切なエラーメッセージ表示

```typescript
try {
  const llmClient = new LLMClient(); // throws if no key
} catch (e) {
  console.error("Error: ANTHROPIC_API_KEY is not set.");
  console.error("Run: export ANTHROPIC_API_KEY=sk-ant-...");
  process.exit(1);
}
```

---

## 11. package.json の bin 設定（追加が必要）

現在 `package.json` に `bin` フィールドなし。追加が必要:

```json
{
  "bin": {
    "motiva": "./dist/index.js"
  }
}
```

`dist/index.js` のシバン行も必要:
```
#!/usr/bin/env node
```

または `src/index.ts` のトップに `#!/usr/bin/env node` を追加して build 後に `chmod +x dist/index.js`。

---

## 12. 現在の src/index.ts の状態

Stage 5 完了時点で以下を export 済み（CLIRunner の追加 export のみ必要）:
```typescript
export * from "./types/index.js";
export { StateManager } from "./state-manager.js";
export { /* gap functions */ } from "./gap-calculator.js";
export { TrustManager } from "./trust-manager.js";
export { DriveSystem } from "./drive-system.js";
export { /* drive scorer functions */ } from "./drive-scorer.js";
export { ObservationEngine } from "./observation-engine.js";
export { StallDetector } from "./stall-detector.js";
export { SatisficingJudge } from "./satisficing-judge.js";
export { LLMClient, MockLLMClient } from "./llm-client.js";
export { EthicsGate } from "./ethics-gate.js";
export { SessionManager } from "./session-manager.js";
export { StrategyManager } from "./strategy-manager.js";
export { GoalNegotiator, EthicsRejectedError } from "./goal-negotiator.js";
// ← CoreLoop, ReportingEngine, TaskLifecycle, AdapterRegistry はまだ export されていない
```

NOTE: CoreLoop, ReportingEngine, TaskLifecycle, AdapterRegistry, ClaudeCodeCliAdapter, ClaudeApiAdapter の export も Stage 6 で追加すること。

---

## 13. tsconfig.json の確認

- `target: ES2022`, `module: Node16`, `moduleResolution: Node16`
- `outDir: dist`, `rootDir: src`
- ESM: `.js` 拡張子インポート必須
- `src/**/*` がコンパイル対象

---

## 14. テスト戦略（Stage 6）

目安: 30-50 テスト追加、累計 950-1000

自動テスト可能:
- 引数パース（全サブコマンド）
- 終了コード（各シナリオ）
- ディレクトリ初期化（テンポラリディレクトリ）
- エラーメッセージ（スナップショットテスト）

手動テスト必要:
- `motiva goal add "..."` の対話フロー
- `motiva run` の E2E 完走
- Ctrl+C グレースフルシャットダウン
- APIキー未設定エラー

---

## 15. 注意点・制約

1. **`motiva run` は goalId を引数で取るか自動選択するか**: 設計上はアクティブゴールを自動選択。複数ゴールがある場合は DriveSystem.prioritizeGoals() で優先順位付けして先頭を処理。または `motiva run --goal <id>` オプションを追加可能。

2. **GapCalculatorModule と DriveScorerModule の渡し方**: CoreLoop は `GapCalculatorModule` インターフェースを期待している（pure functions を object で包む）。
   ```typescript
   import { calculateGapVector, aggregateGaps } from "./gap-calculator.js";
   import { scoreAllDimensions, rankDimensions } from "./drive-scorer.js";

   const gapCalculator: GapCalculatorModule = { calculateGapVector, aggregateGaps };
   const driveScorer: DriveScorerModule = { scoreAllDimensions, rankDimensions };
   ```

3. **AdapterRegistry への登録**: `ClaudeApiAdapter` と `ClaudeCodeCliAdapter` の両方を register する。デフォルト adapterType は `"claude_api"`。

4. **readline は不要**: GoalNegotiator.negotiate() は対話なしで完結する（LLM が交渉を処理）。カウンター提案時のユーザー確認が必要なら `readline` で実装。

5. **EthicsRejectedError**: `goal-negotiator.ts` の named export `EthicsRejectedError` を catch して適切なメッセージ表示。
