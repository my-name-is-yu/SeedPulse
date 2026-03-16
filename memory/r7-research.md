# R7 Research: 反復改善の検証設計

調査日: 2026-03-16
ソース: tests/e2e/ 全8ファイル + src/stall-detector.ts + src/satisficing-judge.ts + src/core-loop.ts

---

## 1. E2Eテストの共通パターン

### セットアップの基本構造

全テストで一貫して使われているパターン:

```typescript
// 1. 一時ディレクトリ作成 (beforeEach/afterEach で管理)
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-XXXX-"));

// 2. StateManager を tempDir で初期化
const stateManager = new StateManager(tempDir);

// 3. シーケンシャルMockLLMClient (milestone2-d1パターン)
const llmClient = createSequentialMockLLMClient([
  response0,  // イテレーション1 観測
  response1,  // イテレーション1 タスク生成
  response2,  // イテレーション1 LLMレビュー
  response3,  // イテレーション2 観測
  ...
]);

// 4. CoreLoop 構築 (buildCoreLoop ヘルパー)
function buildCoreLoop(stateManager, llmClient, maxIterations, observationEngine?) {
  const obsEngine = observationEngine ?? new ObservationEngine(stateManager, [], llmClient);
  const sessionManager = new SessionManager(stateManager);
  const trustManager = new TrustManager(stateManager);
  const stallDetector = new StallDetector(stateManager);
  const satisficingJudge = new SatisficingJudge(stateManager);
  const reportingEngine = new ReportingEngine(stateManager);
  const driveSystem = new DriveSystem(stateManager);
  const strategyManager = new StrategyManager(stateManager, llmClient);

  const taskLifecycle = new TaskLifecycle(
    stateManager, llmClient, sessionManager, trustManager,
    strategyManager, stallDetector,
    { approvalFn: async (_task) => true }  // 承認は自動
  );

  const adapterRegistry = new AdapterRegistry();
  adapterRegistry.register(new MockAdapter());  // 常に success: true を返す

  return new CoreLoop(
    { stateManager, observationEngine: obsEngine, gapCalculator: GapCalculator,
      driveScorer: DriveScorer, taskLifecycle, satisficingJudge, stallDetector,
      strategyManager, reportingEngine, driveSystem, adapterRegistry },
    { maxIterations, delayBetweenLoopsMs: 0 }
  );
}

// 5. ゴール保存 → ループ実行
stateManager.saveGoal(goal);
const result = await coreLoop.run(goalId);
```

### LLMレスポンスの形式

LLMコールの順序はイテレーション構造に依存:
- **観測フェーズ**: 次元ごとに1コール。形式: `JSON.stringify({ score: 0.6, reason: "..." })`
- **タスク生成**: ` ```json\n{...}\n``` ` ブロック形式
- **LLMレビュー**: `JSON.stringify({ verdict: "pass"|"partial"|"fail", reasoning: "...", criteria_met: N, criteria_total: N })`

タスク生成の必須フィールド:
```json
{
  "work_description": "...",
  "rationale": "...",
  "approach": "...",
  "success_criteria": [{ "description": "...", "verification_method": "...", "is_blocking": true }],
  "scope_boundary": { "in_scope": [...], "out_of_scope": [...], "blast_radius": "..." },
  "constraints": [],
  "reversibility": "reversible",
  "estimated_duration": { "value": 20, "unit": "minutes" }
}
```

### DataSource（FileExistence）の接続方法

```typescript
const feConfig: DataSourceConfig = {
  id: "fe-ds-1",
  name: "File Existence Source",
  type: "file_existence",
  connection: { path: baseDir },
  enabled: true,
  created_at: new Date().toISOString(),
  dimension_mapping: { dimension_name: "filename.ext" },
};
const fileExistenceDs = new FileExistenceDataSourceAdapter(feConfig);
const obsEngine = new ObservationEngine(stateManager, [fileExistenceDs], llmClient);
```

### モック化のスタイル

2種類のアプローチが混在:
- **実装ベース** (milestone2-d1/d2): 本物のクラスを全部 new して構成。LLMだけmock。
- **完全モック** (r1, r3-r4): CoreLoopDeps を vi.fn() で全部スタブ化。テスト対象を絞りやすい。

R7では**実装ベース**（milestone2-d1パターン）が適切。観測の実動作を検証したいため。

---

## 2. StallDetectorの仕組みと戦略転換フロー

### 4種類のStall検出

#### (1) dimension_stall — `checkDimensionStall()`
- 入力: `gapHistory: Array<{ normalized_gap: number }>`, `feedbackCategory?`
- 検出条件: 直近N+1エントリで `latest >= oldest` (改善がない)
- N値: `feedbackCategory="immediate"` → N=3, `"medium_term"` → N=5, `"long_term"` → N=10
  - デフォルト (categoryなし) → N=5
  - stall_flexibility 係数: `multiplier = 0.75 + stall_flexibility * 0.25` (デフォルト1 → multiplier=1.0)
- **重要**: gapHistoryが `n+1` 未満ならnull返却（不十分なデータ）

#### (2) consecutive_failure — `checkConsecutiveFailures()`
- 検出条件: `consecutiveFailureCount >= 3`
- CoreLoopでの呼び出し: TaskLifecycleの `handleFailure()` が consecutive_failure_count を increment
- `handleFailure()` は3回失敗で `action: "escalate"` を返す
- CoreLoopは連続escalate=3回で `finalStatus: "stalled"` にする

#### (3) time_exceeded — `checkTimeExceeded()`
- タスクの実行時間が `estimated_duration × 2` を超えた場合
- テスト環境では実際には発火しない（taskはすぐ完了）

#### (4) global_stall — `checkGlobalStall()`
- 全次元で同時に改善がない場合

### CoreLoopでのStall処理フロー（src/core-loop.ts L740-L835）

```
各イテレーションの stall 処理 (observe後、task実行前):

for (const dim of goal.dimensions) {
  dimGapHistory = gapHistoryから当該次元を抽出
  stallReport = stallDetector.checkDimensionStall(goalId, dim.name, dimGapHistory)

  if (stallReport) {
    result.stallDetected = true
    result.stallReport = stallReport
    escalationLevel = stallDetector.getEscalationLevel(goalId, dim.name)
    newStrategy = await strategyManager.onStallDetected(goalId, escalationLevel + 1)
    if (newStrategy) result.pivotOccurred = true
    stallDetector.incrementEscalation(goalId, dim.name)  // cap at 3
    break  // 1イテレーションで1次元のstallのみ処理
  }
}

// global stall チェック (dimension_stall未検出の場合のみ)
if (!result.stallDetected) {
  globalStall = stallDetector.checkGlobalStall(goalId, allDimGaps)
  if (globalStall) { strategyManager.onStallDetected(goalId, 2) }
}
```

### Stall後の戦略転換

- `strategyManager.onStallDetected(goalId, escalationLevel)` が呼ばれる
- 戻り値が non-null なら `result.pivotOccurred = true`
- escalation_level >= 3 かつ stallDetected なら `finalStatus: "stalled"` でループ終了

### dimension_stallの発火タイミング

gapHistoryは `stateManager.saveGapHistory()` で蓄積される。
CoreLoopは `run()` 開始時に `stateManager.saveGapHistory(goalId, [])` でリセット。
つまり **同一run()内でN+1回以上のイテレーションが必要**。

- feedbackCategory未指定（デフォルト）: N=5 → 最低6イテレーション必要
- feedbackCategory="immediate": N=3 → 最低4イテレーション必要

---

## 3. CoreLoopの反復条件

### 1イテレーション内の流れ

```
runOneIteration():
  1. loadGoal()
  2. observe() — 各次元をObservationEngine経由で観測
  3. calculateGapVector() + aggregateGaps()
  4. isGoalComplete() — SatisficingJudgeで完了判定
  5. stall detection (dimension/global) + strategyManager.onStallDetected
  6. taskLifecycle.runTaskCycle() — task生成→実行→検証
  7. return LoopIterationResult
```

### 反復が続く条件（完了にならない条件）

`SatisficingJudge.isGoalComplete()` の判定:
```
isComplete = (blocking_dimensions.length === 0) AND (low_confidence_dimensions.length === 0)

blocking_dimensions: threshold未達の次元
low_confidence_dimensions: confidence < 0.50 の次元

// confidence tier:
// high: >= 0.85 → ceiling 1.0
// medium: >= 0.50 → ceiling 0.85  ← independent_reviewは0.70程度 (medium)
// low: < 0.50 → ceiling 0.60     ← 完了を妨げる
```

**重要**: `low_confidence_dimensions` が1つでもあると `is_complete = false` になる。
→ LLM観測（independent_review、confidence=0.70前後）は medium tier なので完了を妨げない。
→ 初期confidence=0.3（low tier）のまま観測されない次元は完了を妨げる。

### ループ終了条件（run()レベル）

```
finalStatus = "max_iterations"  // デフォルト
for (loopIndex = 0; loopIndex < maxIterations; loopIndex++):
  iterationResult = runOneIteration()

  if (iterationResult.completionJudgment.is_complete AND loopIndex >= minIterations-1):
    finalStatus = "completed"; break

  if (連続error >= maxConsecutiveErrors):
    finalStatus = "error"; break

  if (taskAction === "escalate" AND 連続escalate >= 3):
    finalStatus = "stalled"; break

  if (stallDetected AND escalation_level >= 3):
    finalStatus = "stalled"; break
```

### 「1イテレーションでは完了しない」ゴールの作り方

方法1: **閾値を現在値より大幅に高く設定** + TaskLifecycleが dimension_updates を返さない
- current_value=0.1, threshold=min:0.9
- MockAdapterは成功するが、観測値の更新はObservationEngineに依存
- LLMMockで1回目は低スコア、2回目以降に高スコアを返す

方法2: **複数次元で段階的改善を設定**
- 次元A: 1回目観測=0.3 (below 0.7), 2回目=0.5 (below 0.7), 3回目=0.8 (above 0.7)
- 次元B: 1回目=false, 2回目=false, 3回目=true

方法3: **DataSourceの値を段階的に変化させる**
- DataSourceAdapterに呼び出しカウンターを持つStatefulMockを作成
- query()が呼ばれるたびに次のシナリオ値を返す

---

## 4. R7テスト設計の具体的提案

### テストケース1: 3イテレーション反復改善

**目的**: 改善不十分→再タスク→再観測のパスが3+イテレーション動作することを検証

**ゴール設定**:
```typescript
// 2次元ゴール
// dim1: code_quality (min: 0.8), 初期値0.2 → LLMが段階的スコアアップ
// dim2: test_coverage (min: 0.7), 初期値0.1 → LLMが段階的スコアアップ
```

**LLMレスポンスシーケンス** (3イテレーション):
```
Iter1: obs(dim1)=0.3, obs(dim2)=0.2 → task_gen → review(pass)
Iter2: obs(dim1)=0.5, obs(dim2)=0.4 → task_gen → review(pass)
Iter3: obs(dim1)=0.85, obs(dim2)=0.75 → (task_genは走らないかも) → completed
```

**Mock構成**:
- LLM: `createSequentialMockLLMClient` で各イテレーションの観測値を上昇させる
- Adapter: `MockAdapter` (always success)
- DataSource: なし（LLMのみ観測）

**検証ポイント**:
```typescript
expect(result.totalIterations).toBeGreaterThanOrEqual(3)
expect(result.finalStatus).toBe("completed")
// 各イテレーションのgapAggregateが単調減少していること
const gaps = result.iterations.map(i => i.gapAggregate)
for (let i = 1; i < gaps.length; i++) {
  expect(gaps[i]).toBeLessThan(gaps[i-1])
}
```

**設計上の注意**:
- LLMレスポンスが足りなくなるとエラーになるので、guard responses も追加する
- review(pass) で dimension_updates が返らないと obsEngine が更新されない
  → review の後に obsEngine.observe() が次イテレーションで呼ばれ再評価される

---

### テストケース2: StallDetectorによる戦略転換

**目的**: 同一次元で改善が止まったときに stallDetected=true + pivotOccurred=true が記録されることを検証

**アプローチ**: 完全モック（r1/r3パターン）を使用。
実際のStallDetectorを使い、gapHistoryを手動でsaveGapHistoryで仕込む。

**ゴール設定**:
```typescript
// 1次元ゴール: quality (min: 0.8)
// feedbackCategory なし → N=5 → 6エントリ必要
// run()開始時にgapHistoryがリセットされるため、
// CoreLoopの外でsaveGapHistoryに6エントリを事前注入することはできない
// → N=3 (feedbackCategory="immediate") になるよう StallDetector をカスタム初期化
//    または maxIterations=6 で実際にループさせる
```

**推奨アプローチ（モックstallDetector）**:
```typescript
// r3-r4パターンと同様にstallDetectorをmockし、
// checkDimensionStall が stallReport を返すようにする
stallDetectorMock = {
  checkDimensionStall: vi.fn()
    .mockReturnValueOnce(null)   // iter1: stall なし
    .mockReturnValueOnce(null)   // iter2: stall なし
    .mockReturnValue(stallReport),  // iter3以降: stall あり
  ...
}
// strategyManager.onStallDetected が新strategy返すように設定
strategyManagerMock = {
  onStallDetected: vi.fn().mockResolvedValue({ id: "new-strategy", ... }),
  ...
}
```

**検証ポイント**:
```typescript
const stalledIter = result.iterations.find(i => i.stallDetected)
expect(stalledIter).toBeDefined()
expect(stalledIter!.stallReport?.stall_type).toBe("dimension_stall")
expect(stalledIter!.pivotOccurred).toBe(true)
// strategyManager.onStallDetected が呼ばれた
expect(strategyManagerMock.onStallDetected).toHaveBeenCalled()
```

---

### テストケース3: LLM観測の正確性（min型スケーリング修正後）

**目的**: R6で修正した min型スケーリングが正しく動作し、ObservationEngineが適切な値を返すことを検証

**背景**: R6修正 — LLM観測のmin/max型スケール不整合 → 閾値スケールへの変換。
LLMが0-1スコアを返すとき、min型の threshold=0.8 に対してどう正規化されるかが焦点。

**ゴール設定**:
```typescript
// 1次元ゴール: code_quality (min: 0.8), 初期値0.3
// observation_method: llm_review (independent_review)
```

**LLMレスポンスシーケンス**:
```
Iter1: LLMが score=0.75 を返す → threshold=0.8 なのでまだ未達
       → gapAggregate > 0 → task が生成される
Iter2: LLMが score=0.90 を返す → threshold=0.8 を超えた
       → gapAggregate = 0 → completed
```

**検証ポイント**:
```typescript
// Iter1後: 次元のcurrent_valueが0.75付近に更新されている
const goalAfterIter1 = stateManager.loadGoal(goalId)
const dim = goalAfterIter1.dimensions[0]
expect(dim.current_value).toBeCloseTo(0.75, 1)

// Iter2後: completed
expect(result.finalStatus).toBe("completed")
expect(result.totalIterations).toBe(2)

// ObservationLogのentryでconfidenceがmedium tier (0.5-0.84)
const log = obsEngine.getObservationLog(goalId)
const entry = log.entries.find(e => e.layer === "independent_review")
expect(entry!.confidence).toBeGreaterThanOrEqual(0.5)
expect(entry!.confidence).toBeLessThanOrEqual(0.84)
```

**Mock構成**:
```typescript
const llmClient = createSequentialMockLLMClient([
  // iter1: 観測
  JSON.stringify({ score: 0.75, reason: "Code quality is improving" }),
  // iter1: task gen
  "```json\n" + makeTaskGenerationResponse() + "\n```",
  // iter1: review
  JSON.stringify({ verdict: "pass", reasoning: "...", criteria_met: 1, criteria_total: 1 }),
  // iter2: 観測 (閾値超え)
  JSON.stringify({ score: 0.90, reason: "Code quality meets requirement" }),
  // guard
  "```json\n" + makeTaskGenerationResponse() + "\n```",
  JSON.stringify({ verdict: "pass", reasoning: "...", criteria_met: 1, criteria_total: 1 }),
])
const coreLoop = buildCoreLoop(stateManager, llmClient, 3)
```

---

## 実装上の注意事項

### iterationごとの値変化のシミュレーション

ObservationEngineは `observe()` → goal の `current_value` を直接更新して `saveGoal()` する。
LLMMockが異なる値を返すことで、各イテレーション後にgoalのstateが変わる。
次イテレーションの `isGoalComplete()` は更新後のgoal stateを読むため、
反復改善のシミュレーションはLLMレスポンスシーケンスで制御できる。

### stallDetection の N 値について

`checkDimensionStall` は `gapHistory.length < n+1` のときnullを返す。
gapHistoryは `run()` 開始時にリセットされる。
feedbackCategory省略でN=5なので、実際に6イテレーション走らせないと発火しない。
→ テストケース2では stall detector をモック化する方が現実的。

### `createSequentialMockLLMClient` の注意点

レスポンスが尽きるとエラーをthrowする。
イテレーションが早期完了したとき余分なレスポンスが残っても問題ないが、
不足するとテストが落ちる。guard responses を多めに用意すること。

### ファイル配置

新テストは `tests/e2e/r7-iterative-improvement.test.ts` に置く。
milestone2-d1 の `buildCoreLoop` ヘルパーと `createSequentialMockLLMClient` を
`tests/helpers/` に共通化することを検討（現状はテストファイル内インライン）。
