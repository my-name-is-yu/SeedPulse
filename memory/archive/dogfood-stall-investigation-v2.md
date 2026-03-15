# Dogfooding Stall Investigation v2

## 調査対象
- ゴールID: `e0b3a12f-f8c1-4a54-92e1-01ea508c1a53`
- コマンド: `MOTIVA_LLM_PROVIDER=openai npx tsx src/cli-runner.ts run --goal e0b3a12f-f8c1-4a54-92e1-01ea508c1a53 --adapter github_issue`
- 症状: 9イテレーションで "Goal stalled — escalation level reached maximum" で停止

---

## 1. StallDetector のパラメータ

**`src/stall-detector.ts` より確認済み。**

| パラメータ | 値 | 意味 |
|---|---|---|
| `BASE_FEEDBACK_CATEGORY_N["immediate"]` | 3 | フィードバックカテゴリ "immediate" のウィンドウN |
| `BASE_FEEDBACK_CATEGORY_N["medium_term"]` | 5 | フィードバックカテゴリ "medium_term" のウィンドウN |
| `BASE_FEEDBACK_CATEGORY_N["long_term"]` | 10 | フィードバックカテゴリ "long_term" のウィンドウN |
| `BASE_DEFAULT_N` | 5 | カテゴリ指定なしのデフォルトN |
| `ESCALATION_CAP` | 3 | エスカレーションレベルの上限 |
| `CONSECUTIVE_FAILURE_THRESHOLD` | 3 | 連続失敗stall閾値 |
| `stall_flexibility` (DEFAULT_CHARACTER_CONFIG) | 1 | デフォルト値（最も速くピボット） |

**N値の計算式:**
```
multiplier = 0.75 + stall_flexibility * 0.25 = 0.75 + 1 * 0.25 = 1.0
N = round(BASE_DEFAULT_N * multiplier) = round(5 * 1.0) = 5
```

**checkDimensionStall の判定条件（`src/stall-detector.ts` L82-108）:**
```
gapHistory.length < N + 1  → null（履歴不足）
recent = gapHistory.slice(-(N+1))    // 最新6件を取得
oldest = recent[0].normalized_gap
latest = recent[recent.length-1].normalized_gap
latest < oldest → null（改善あり、stall検出せず）
latest >= oldest → StallReport生成（stall確定）
```

つまり、**N=5 のとき、6件以上の gap_history が蓄積された時点で判定開始**。
oldest（6件前）と latest（最新）を比較し、改善なければ stall。

---

## 2. 9イテレーションでstallするシナリオの完全再構成

### ゴールの dimension 構成（`goal.json` より）

| dimension | threshold_type | threshold_value | 初期 current_value |
|---|---|---|---|
| readme_completion | min | 100 | null |
| getting_started_guide_completion | min | 100 | null |
| user_feedback | min | 10 | null |
| update_frequency | min | 6 | null |
| link_validity | present | — | null |

**重要: すべての dimension で current_value = null**

### null current_value の gap 計算（`src/gap-calculator.ts` より確認）

`current_value = null` の場合:
- `computeRawGap`: threshold型に関わらず sentinel 値を返す（min → threshold.value）
- `normalizeGap`: `current_value === null` のガードで常に **1.0** を返す
- `applyConfidenceWeight`: `currentValueIsNull=true` のため confidence weighting をスキップ
- 結果: すべての dimension で `normalized_weighted_gap = 1.0`（固定）

### イテレーション別の gap_history 実績（`gap-history.json` より確認）

実際の記録データを見ると、全9イテレーション（iteration 0-8）にわたり、**すべての dimension の normalized_weighted_gap が 1.0 のまま不変**。

これは current_value が null のままであることを直接証明している。

### エスカレーションの推移（`src/core-loop.ts` L692-740 + `src/stall-detector.ts` L80-108 より）

CoreLoop の stall 検出ロジック:

1. 各 dimension について `checkDimensionStall` を呼ぶ
2. stall 検出時: `getEscalationLevel` で現在レベルを取得し StallReport に記録
3. stall 検出後: `incrementEscalation` でレベルを +1
4. CoreLoop の終了判定: `stallReport.escalation_level >= 3` なら `finalStatus = "stalled"`

**重要な発見: エスカレーションレベルの記録タイミングのずれ**

```typescript
// L728-738 (core-loop.ts)
const escalationLevel = this.deps.stallDetector.getEscalationLevel(goalId, dim.name);
const newStrategy = await this.deps.strategyManager.onStallDetected(goalId, escalationLevel + 1);
...
this.deps.stallDetector.incrementEscalation(goalId, dim.name);
```

```typescript
// stall-detector.ts L97
const escalationLevel = this.getEscalationLevel(goalId, dimensionName);
return StallReportSchema.parse({ ..., escalation_level: escalationLevel, ... });
```

**StallReport の escalation_level は increment 前のレベルを記録する。**

イテレーションごとのエスカレーション推移:

| iteration | gapHistory長 | checkDimensionStall結果 | report.escalation_level | increment後のレベル |
|---|---|---|---|---|
| 0 | 1 | null（length < 6） | — | 0 |
| 1 | 2 | null | — | 0 |
| 2 | 3 | null | — | 0 |
| 3 | 4 | null | — | 0 |
| 4 | 5 | null | — | 0 |
| 5 | 6 | **stall（length=6, oldest=1.0, latest=1.0, latest >= oldest）** | **0** | 1 |
| 6 | 7 | stall | **1** | 2 |
| 7 | 8 | stall | **2** | 3 |
| 8 | 9 | stall | **3** | → CoreLoop終了条件成立 |

**iteration 8 で `stallReport.escalation_level = 3 >= 3` → `finalStatus = "stalled"` で停止。**

これが 9イテレーション（iteration 0-8）でstallする正確なシナリオ。

---

## 3. 根本原因の特定

### 根本原因1（主因）: ObservationEngine が current_value を null のまま保持している

`src/observation-engine.ts` の `observe()` メソッド（L290-318）:

```typescript
observe(goalId: string, methods: ObservationMethod[]): void {
  goal.dimensions.forEach((dim, idx) => {
    const entry = this.createObservationEntry({
      ...
      extractedValue: typeof dim.current_value === "number" ? dim.current_value : null,
      confidence: dim.confidence,
    });
    this.applyObservation(goalId, entry);
  });
}
```

**self_report observe は dim.current_value をそのまま読み取って再記録するだけ**。
current_value が null なら null のまま記録する。実際の進捗測定は行わない。

### 根本原因2（構造的問題）: DataSourceAdapter が該当 dimension を観測できない

`src/adapters/github-issue-datasource.ts` L78-92:

GitHubIssueDataSourceAdapter がサポートする dimension は:
- `open_issue_count`
- `closed_issue_count`
- `total_issue_count`
- `completion_ratio`

このゴールの dimension 名は:
- `readme_completion`
- `getting_started_guide_completion`
- `user_feedback`
- `update_frequency`
- `link_validity`

**完全にミスマッチ。** DataSourceAdapter はどの dimension も観測できず、null を返す。

CoreLoop（`src/core-loop.ts` L470-483）は observeFromDataSource を呼ぶが、unknown dimension の場合 DataSourceAdapter は `value: null` を返す（L86-92）。ObservationEngine はその null を `extractedValue = null` として記録する。結果として current_value は null のまま変わらない。

### 根本原因3（副因）: github_issue adapter は実際にはタスク実行も何もしていない可能性

コマンドで `--adapter github_issue` を指定しているが、GitHubIssueAdapter のタスク実行（`execute()`）が GitHub Issue を作成しても、その結果が当ゴールの dimension に反映されるフィードバックループが存在しない。Issue が作られても ObservationEngine が current_value を更新しないため、gap は永遠に 1.0 のまま。

---

## 4. 修正案

### 修正案A（推奨・即効性高）: dimension_mapping でゴールの dimension を DataSourceAdapter の次元にマッピングする

`goal.json` の各 dimension に `dimension_mapping` を追加し、GitHubIssueDataSourceAdapter が理解できる次元に変換する。

例（ゴールのネゴシエーション時またはgoal.jsonの手動修正）:

```json
{
  "name": "readme_completion",
  "dimension_mapping": "closed_issue_count"
}
```

ただし完全な解決には、Issue の closed 数で readme_completion の進捗を測るという意味論的整合が必要。このゴールでは完全には一致しない。

### 修正案B（根本解決）: このゴールには GitHub Issue DataSource は不適切。LLM による self_report 観測にフォールバックさせ、タスク実行後に current_value を更新する

**問題の本質**: このゴールは "READMEとGetting Startedガイドを整備する" というドキュメント作成タスクで、GitHubのIssue状態を観測しても進捗がわからない。

修正の方向性:
1. `--adapter github_issue` の代わりに `--adapter claude_api` または `--adapter claude_code_cli` を使う
2. タスク実行エージェントが実際にREADMEを書いた後、ObservationEngine に LLM review で current_value を更新させる
3. または、ゴール作成時に適切な dimension（`closed_issue_count` など）と適切なDataSourceを組み合わせる

### 修正案C（stall検出の感度調整・短期対処）: stall_flexibility を上げる

`character.json` または CHARACTER_CONFIG で `stall_flexibility` を 3-5 に設定すると:
- N = round(5 * (0.75 + 3*0.25)) = round(5 * 1.5) = 8
- stall 検出開始: iteration 8（N+1=9件蓄積後）
- escalation level 3 到達: iteration 8+3-1 = iteration 10

→ 停止は 11イテレーションに延びるだけで根本解決にならない。

### 修正案D（コード修正案）: DataSourceAdapter が unknown dimension を返した場合に observe を fallback させる

`src/core-loop.ts` L470-483 の DataSource 観測ループで、戻り値の `extracted_value` が `null` だった場合にその dimension を `observedDimensions` から除外しない（= self_report fallback を許可する）よう変更する。

現状のコード:
```typescript
try {
  await engine.observeFromDataSource(goalId, dim.name, ds.sourceId);
  observedDimensions.add(dim.name);  // ← 成功扱いでmarkされる（null結果でも）
  break;
} catch {
  // エラー時のみ次のsourceへ
}
```

問題: `observeFromDataSource` が null の extracted_value を記録しても例外を投げないため、その dimension は "observed" としてマークされ、self_report fallback が発生しない。

**コード修正案:**

`src/observation-engine.ts` の `observeFromDataSource` を修正し、DataSource が null を返した場合は例外を投げる:

```typescript
// observeFromDataSource L358-366 の末尾に追加
if (extractedValue === null) {
  throw new Error(
    `observeFromDataSource: data source "${sourceId}" returned null for dimension "${dimensionName}" — not supported`
  );
}
```

これにより CoreLoop の catch ブロックが機能し、self_report fallback が実行される。ただし self_report fallback も現在の current_value をそのまま再記録するだけなので、根本的な進捗更新は発生しない。

### 修正案E（推奨・根本解決）: dogfoodingゴールを GitHubIssue に適合する形に再設計する

dogfooding の目的に沿って、ゴールの dimension を GitHubIssueDataSourceAdapter が観測できる次元に変更する:

```json
{
  "dimensions": [
    {
      "name": "closed_issue_count",
      "threshold": { "type": "min", "value": 3 },
      "dimension_mapping": "closed_issue_count"
    },
    {
      "name": "completion_ratio",
      "threshold": { "type": "min", "value": 0.8 },
      "dimension_mapping": "completion_ratio"
    }
  ]
}
```

GitHubIssueAdapter が Issue を作成し、GitHubIssueDataSourceAdapter がその closed 数・completion ratio を観測することで、フィードバックループが成立する。

---

## 5. 問題のまとめ

```
ゴールのdimension名（readme_completion等）
    ↓
CoreLoop: observeFromDataSource を呼ぶ
    ↓
GitHubIssueDataSourceAdapter: 未知のdimension → value: null を返す（例外なし）
    ↓
ObservationEngine: null を extractedValue として記録 → current_value = null のまま
    ↓
CoreLoop: observedDimensions.add(dim.name) でマーク → self_report fallbackも発生しない
    ↓
GapCalculator: current_value = null → normalized_weighted_gap = 1.0（固定）
    ↓
StallDetector: 6イテレーション目から stall 検出開始
    ↓
iteration 5,6,7: escalation_level 0,1,2 で stall（CoreLoopは継続）
    ↓
iteration 8: escalation_level = 3 >= 3 → finalStatus = "stalled" で停止
```

**核心: DataSourceAdapter の「次元不一致時の null 返却」が例外なしに成功扱いされるため、
ObservationEngine も CoreLoop も問題を検知できず、current_value が null のまま固定される。**

---

## 6. 即時に取れる対処

最短経路は **修正案E**（ゴールのdimension設計変更）+ **修正案D**（コード修正）の組み合わせ。

1. コード修正（`src/observation-engine.ts`）: null返却時に例外をthrow → 1行追加
2. ゴール再設計: `closed_issue_count` / `completion_ratio` を dimension として使う新ゴールを作成
3. （任意）既存ゴール `e0b3a12f` は目的に合っていないため削除または `status: "paused"` に変更

---

*調査日時: 2026-03-15*
*調査ファイル:*
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/stall-detector.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/core-loop.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/gap-calculator.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/observation-engine.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/adapters/github-issue-datasource.ts`
- `/Users/yuyoshimuta/.motiva/goals/e0b3a12f-f8c1-4a54-92e1-01ea508c1a53/goal.json`
- `/Users/yuyoshimuta/.motiva/goals/e0b3a12f-f8c1-4a54-92e1-01ea508c1a53/gap-history.json`
