# Motiva — アーキテクチャ仕様書

## 1. 概要と設計原則

Motivaは既存のAIエージェント（Claude Code等）に「動機」を与えるフレームワークである。エージェント自体を改変せず、Claude Code Hooksを通じてライフサイクルイベントをインターセプトし、ゴール・観測・ギャップ・制約を管理してセッション内の自律的タスク選択と完了判断を実現する。

### 三原則

**1. 観測ベース（Observation over estimation）**
進捗は成果物の観測から機械的に導出する。自己申告・推定・盲目カウンタは使わない。Write/Editを20回すれば100%になるシステムは動機層として失格。

**2. 多次元デフォルト（Multi-dimensional by default）**
すべてのゴールは複数の閾値次元（`achievement_thresholds`）を持つ。単一の`progress: 0.9`という旧実装は廃止。次元が定義されていないゴールは`needs_refinement`状態とし、自動完了させない。

**3. 検証なき完了なし（Verification before completion）**
ゴールの完了判断には証拠ベースの観測（テスト通過、ファイル存在、ビルド成功）が必要。確信度が低い次元が残る場合、完了前に検証タスクを生成して実行を要求する。

---

## 2. コアループ

```
Goal → Observe → Gap → Task → Verify → Complete
```

| ステップ | 内容 |
|----------|------|
| **Goal** | ゴールは永続状態（`.motive/goals/<id>.json`）に保持。タイプ（deadline/dissatisfaction/opportunity）と多次元閾値を持つ |
| **Observe** | フックがツール出力を受け取り、観測ルールを実行して状態ベクトルを更新する |
| **Gap** | `achievement_thresholds`の各次元について`(target - current) / target`を計算。確信度ペナルティを加味する |
| **Task** | ギャップが最も大きく、かつ観測ルールが明確な次元を優先してタスクを生成 |
| **Verify** | 確信度が低い次元には検証タスクを生成。手動確認または再観測で確信度を引き上げる |
| **Complete** | 全次元がtarget以上、かつ平均確信度 >= 0.7 で完了 |

**ループの性質**: 各フック呼び出しはステートレス。`.motive/state.json`を読み込み、計算し、書き戻す。デーモンなし、HTTP不要。

---

## 3. 進捗観測メカニズム（最重要）

### 3.1 盲目カウンタの問題

旧PoC実装では`post-tool-use.ts`の`deriveStateUpdates()`がWrite/Editごとに`progress += 0.05`（確信度0.6）を加算していた。20回のWrite/Editでprogress = 1.0。TODOアプリを作るゴールでREADMEを書いてもコア機能を実装しても同じ+0.05が加算される。ゴールとの関連性チェックなし、完了条件との照合なし。

さらに`achievement_thresholds`がデフォルト`{ progress: 0.9 }`の単一次元で、ギャップ0件のゴールが即座に`completed`とマークされるバグも存在した。

### 3.2 チェックリストベース観測モデル

各ゴールの`achievement_thresholds`は、named dimensionの集合として定義される。各次元は観測ルール（`ObservationRule`）を持ち、フックが実際にルールを実行して値を更新する。

| Dimension type | 観測ルール | 例 | 証拠ソース |
|---|---|---|---|
| `file_exists` | 指定ファイルの存在確認 | `src/auth.ts` exists | `fs.existsSync()` |
| `test_pass` | テストランナー出力のパース | all tests pass | Bash stdout の正規表現 |
| `file_count` | glob一致ファイル数のカウント | `src/components/`に5件以上 | `glob.sync()` |
| `pattern_match` | ファイル内パターン確認 | `src/index.ts`に`export default`が含まれる | `readFileSync` + regex |
| `build_success` | ビルド出力のパース | `npm run build`が成功 | Bash exit code |
| `manual` | ユーザー確認 | UIが正しく表示される | `motive verify` CLI |

**次元の生成経路**:
1. `add-goal`時: `completion_criteria`テキストをヒューリスティックにパース → 次元候補を生成
2. `refine-goal`時: ユーザーの回答を次元に変換して`achievement_thresholds`に書き込む
3. フォールバック: 条件が不明な場合 → `{ build_success: { target: 1.0 }, test_pass: { target: 0.8 } }`

```typescript
type ObservationRuleType =
  | 'file_exists'
  | 'test_pass'
  | 'file_count'
  | 'pattern_match'
  | 'build_success'
  | 'manual';

interface ObservationRule {
  type: ObservationRuleType;
  params: Record<string, string>;
  // 例: { type: 'file_exists', params: { path: 'src/auth.ts' } }
  // 例: { type: 'test_pass', params: { command: 'npx vitest run' } }
  // 例: { type: 'file_count', params: { glob: 'src/components/**/*.ts', min: '5' } }
}
```

### 3.3 状態ベクトル更新ルール

フックごとに更新可能な次元を制限する。

| フック | 更新可能な次元 | 条件 |
|--------|---------------|------|
| PostToolUse (Write/Edit) | `file_exists`, `pattern_match` | 書き込みファイルがゴール次元のパラメータと一致する場合のみ |
| PostToolUse (Bash) | `test_pass`, `build_success`, `file_count` | コマンド出力をパースして成否を判定 |
| SessionStart | 全`file_exists`次元 | 起動時にファイル存在を再確認 |
| `motive verify` CLI | `manual` | ユーザーが明示的に確認 |

**確信度の割り当て**:
- `file_exists` / `file_count` チェック: 0.95
- テストパース: 0.9
- `manual`確認: 1.0
- ヒューリスティック推定（旧来の+0.05型）: 0.3 → 上限0.5

### 3.4 進捗キャップルール

- ヒューリスティックのみの次元: 最大0.7にキャップ
- 0.9以上に到達するには証拠ベース次元（`test_pass`, `file_exists`, `build_success`）が閾値を超えていることが必要
- `achievement_thresholds`が空の場合: `needs_refinement`を返す（`completed`は絶対にマークしない）

---

## 4. 状態スキーマ

```typescript
// src/state/models.ts

const ObservationRuleSchema = z.object({
  type: z.enum(['file_exists', 'test_pass', 'file_count', 'pattern_match', 'build_success', 'manual']),
  params: z.record(z.string(), z.string()),
});

const ThresholdDimensionSchema = z.object({
  target: z.number().min(0).max(1),
  observation_rule: ObservationRuleSchema,
  current: z.number().min(0).max(1).default(0),
  confidence: z.number().min(0).max(1).default(0),
});

const VerificationTaskSchema = z.object({
  goal_id: z.string(),
  dimension: z.string(),
  action: z.string(),          // 例: "Run: npx vitest run"
  status: z.enum(['pending', 'in_progress', 'done']),
});

const GoalSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.enum(['deadline', 'dissatisfaction', 'opportunity']),
  completion_criteria: z.string(),
  // NOTE: デフォルトなし — 空の場合は needs_refinement
  achievement_thresholds: z.record(z.string(), ThresholdDimensionSchema).default({}),
  refined: z.boolean().default(false),
  verification_tasks: z.array(VerificationTaskSchema).default([]),
  deadline: z.string().optional(),       // ISO 8601
  created_at: z.string(),
  updated_at: z.string(),
});

const StateSchema = z.object({
  session_id: z.string(),
  active_goal_ids: z.array(z.string()),
  goals: z.record(z.string(), GoalSchema),
  trust_balance: z.number().min(0).max(1).default(0.5),
  stall_counter: z.number().int().min(0).default(0),
  last_updated: z.string(),
});
```

**重要**: `achievement_thresholds`にデフォルト値（`progress: 0.9`）は設定しない。空のまま作成されたゴールは`needs_refinement`状態として処理される。

---

## 5. フック仕様

### 5.1 SessionStart（時間予算: <200ms）

| 項目 | 内容 |
|------|------|
| トリガー | Claudeセッション開始時 |
| 入力 | stdin: `{ session_id, cwd }` |
| 処理 | (1) `.motive/state.json`を読み込み (2) 各ゴールのfile_exists次元を再観測 (3) 動機スコアを再計算 (4) `motive.md`を生成 → `.claude/rules/motive.md`へ書き込み |
| 出力 | stdout: `{ continue: true }` |

### 5.2 UserPromptSubmit

| 項目 | 内容 |
|------|------|
| トリガー | ユーザープロンプト送信時 |
| 入力 | stdin: `{ prompt, session_id }` |
| 処理 | (1) 未refinedゴールへの回答をプロンプトからパース (2) 回答を`achievement_thresholds`次元に変換 (3) `refined: true`をセット — **この順序必須** |
| 出力 | stdout: `{ continue: true }` |

### 5.3 PreToolUse

| 項目 | 内容 |
|------|------|
| トリガー | ツール実行前 |
| 入力 | stdin: `{ tool_name, tool_input, session_id }` |
| 処理 | 不可逆アクション検出 → 該当する場合は`block`を返す |
| 常時ブロック対象 | `git push`, `rm -rf`, `deploy`, `DROP TABLE`, 外部APIの破壊的メソッド |
| 出力 | `{ continue: true }` or `{ continue: false, reason: "..." }` |

**不可逆アクションは信頼残高・確信度に関わらず常にブロック。**

### 5.4 PostToolUse（最重要フック、時間予算: <300ms）

```
入力: { tool_name, tool_input, tool_output, session_id }

1. ツールタイプを判定（Write/Edit vs Bash vs Other）
2. 各アクティブゴールの次元ごとに観測ルールを評価:
   - Write/Edit → file_exists / pattern_match のみ
   - Bash → test_pass / build_success / file_count
3. 状態ベクトルを更新（盲目 +0.05 は使わない）
4. ギャップを再計算
5. Satisficingエンジンで完了判断:
   - completed → active_goal_ids から除去、ログに記録
   - needs_verification → verification_tasks を生成、motive.md に注入
   - needs_refinement → 何も更新しない（ユーザーに次のプロンプトで通知）
6. 状態を .motive/state.json にアトミック書き込み
```

### 5.5 PostToolFailure

| 項目 | 内容 |
|------|------|
| トリガー | ツール実行失敗時 |
| 処理 | `stall_counter`をインクリメント。3回連続失敗でリカバリー戦略を`motive.md`に注入。5回でゴールの再定義を提案 |

### 5.6 Stop

| 項目 | 内容 |
|------|------|
| トリガー | セッション終了時 |
| 処理 | (1) 最終状態を永続化 (2) `.motive/log.jsonl`に追記（`state_before → action → state_after`） (3) 信頼残高を更新（成功: +0.05, 失敗: -0.15） |

---

## 6. エンジン仕様

### 6.1 Gap Analysis（`src/engines/gap-analysis.ts`）

```typescript
interface GapResult {
  dimension: string;
  magnitude: number;    // 0.0 - 1.0
  confidence: number;
  observation_rule: ObservationRule;
}

function computeGaps(goal: Goal): GapResult[] | { status: 'needs_refinement' } {
  if (Object.keys(goal.achievement_thresholds).length === 0) {
    return { status: 'needs_refinement' };  // 空閾値を絶対に完了とみなさない
  }
  return Object.entries(goal.achievement_thresholds).map(([dim, td]) => ({
    dimension: dim,
    magnitude: Math.max(0, (td.target - td.current) / td.target),
    confidence: td.confidence,
    observation_rule: td.observation_rule,
  }));
}
```

**確信度ペナルティ**: 最終スコア = `magnitude × (1 + (1 - confidence) × 0.5)`。確信度が低い次元ほど優先度が上がる（「まだ観測できていない = 要注意」）。

### 6.2 Task Generation（`src/engines/task-generation.ts`）

- ギャップが大きい次元を優先
- `observation_rule.type`が`manual`以外の次元を優先（自動観測可能）
- タスク文言例: `"Run tests: npx vitest run (gap: test_pass 0.0 → 0.8)"`

### 6.3 Satisficing（`src/engines/satisficing.ts`）

```typescript
type CompletionStatus = 'completed' | 'needs_verification' | 'needs_refinement' | 'in_progress';

function judgeCompletion(goal: Goal, gaps: GapResult[]): CompletionStatus {
  if (!Array.isArray(gaps)) return 'needs_refinement';

  const allMet = gaps.every(g => g.magnitude <= 0.05);
  const avgConfidence = gaps.reduce((s, g) => s + g.confidence, 0) / gaps.length;
  const hasLowConfidence = gaps.some(g => g.confidence < 0.5);

  if (allMet && avgConfidence >= 0.7 && !hasLowConfidence) return 'completed';
  if (allMet && hasLowConfidence) return 'needs_verification';
  return 'in_progress';
}
```

`needs_verification`時は検証タスクを生成し、`goal.verification_tasks`に書き込む。次回の`motive.md`で検証を促す。

### 6.4 Stall Detection（`src/engines/stall-detection.ts`）

| トリガー | 閾値 |
|----------|------|
| 時間超過 | 見積もり時間の2倍 |
| 連続失敗 | 3回 |
| 状態変化なし | N回のフック呼び出し（Nは`.motive/config.yaml`で設定） |

**エスカレーション分岐**:
- 情報不足 → 調査タスクを自己生成
- 権限不足 → 人間にエスカレーション
- 能力不足 → ゴールの再定義を要請
- 外部依存 → 待機 + 別ゴールに切り替え

### 6.5 Priority Scoring（`src/engines/priority-scoring.ts`）

```typescript
// deadline: 締切が近づくと指数的に上昇
const hoursRemaining = (new Date(deadline).getTime() - Date.now()) / (3600 * 1000);
const deadlineScore = deadline
  ? Math.exp(-hoursRemaining / 24)  // 締切が近づくほど急上昇
  : 0;

// dissatisfaction: 放置・慣れで30%減衰
const dissatisfactionScore = baseDissatisfaction * Math.exp(-staleness * 0.3);

// opportunity: 12時間で期限切れ
const opportunityScore = Math.max(0, 1 - hoursElapsed / 12);
```

### 6.6 Observation Engine（`src/engines/observation.ts`）— 新規

観測ルールを実際に実行するモジュール。各ルールタイプの実装を集約。

```typescript
interface ObservationResult {
  current: number;   // 0.0 - 1.0
  confidence: number;
}

async function runObservationRule(
  rule: ObservationRule,
  toolOutput?: string
): Promise<ObservationResult>
```

- `file_exists`: `fs.existsSync(params.path)` → 存在: {1.0, 0.95}、不在: {0.0, 0.95}
- `test_pass`: `toolOutput`を正規表現でパース（vitest/jest両対応）→ 全通過: {1.0, 0.9}
- `build_success`: exit code 0 → {1.0, 0.95}
- `manual`: 呼び出し元が値をセット（CLIから）

---

## 7. 協調モデル

### 信頼残高

- グローバル値（0.0 - 1.0）、初期値0.5
- セッション成功: +0.05、セッション失敗: -0.15（非対称）
- `.motive/state.json`の`trust_balance`フィールドで永続化

### 振る舞いマトリクス

| 信頼残高 | 確信度 | 振る舞い |
|----------|--------|----------|
| 高 (≥0.7) | 高 (≥0.7) | 自律実行 |
| 高 (≥0.7) | 低 (<0.7) | タスク生成するが次ステップで確認を要求 |
| 低 (<0.7) | 高 (≥0.7) | タスク生成するが次ステップで確認を要求 |
| 低 (<0.7) | 低 (<0.7) | 現在地確認タスクを先に生成 |

### 不可逆アクション（常時ブロック）

信頼残高・確信度に無関係に常にブロックする:
- `git push`, `git push --force`
- `rm -rf`
- `deploy`, `kubectl apply --force`
- `DROP TABLE`, `TRUNCATE`
- 外部サービスへの破壊的API呼び出し

---

## 8. コンテキスト注入 (motive.md)

**制約**: ≤500トークン。`.claude/rules/motive.md`に書き込む。

```markdown
# Motiva — Current Session Context

## Active Goal
Title: <goal title>
Type: deadline | dissatisfaction | opportunity
Progress: <summary across dimensions>
Trust: <trust_balance> | Stall count: <n>

## Top Gaps (sorted by magnitude)
1. <dimension>: <current> → <target> (confidence: <n>)
   → <observation_rule.type>: <params summary>
2. ...

## Next Task
<generated task from gap engine>

## Pending Verifications
- [ ] <verification_task.action> (<dimension>)

## Needs Clarification  ← unrefined goal のみ表示
Goal "<title>" has no defined thresholds. Please answer:
- What files should exist when this is done?
- What tests should pass?
```

`motive.md`は各SessionStartで再生成。中間のフックでは状態が変化した場合のみ更新する。

---

## 9. CLI

| コマンド | 説明 |
|----------|------|
| `motive init` | `.motive/`ディレクトリと`config.yaml`を作成 |
| `motive add-goal` | ゴールを追加。`completion_criteria`をヒューリスティックにパースして`achievement_thresholds`を生成 |
| `motive refine-goal <id>` | **新規**: 対話的に`achievement_thresholds`の次元を設定・編集 |
| `motive verify <id> <dimension>` | **新規**: `manual`次元をCLIから確認済みにマーク（`current: 1.0, confidence: 1.0`） |
| `motive status` | アクティブゴール、スコア、信頼残高を表示 |
| `motive goals` | 全ゴール一覧とステータスアイコン |
| `motive log` | 最近のアクション履歴（`log.jsonl`から） |
| `motive gc` | 古いログをプルーン |
| `motive reset` | 状態をリセット |

---

## 10. ファイルレイアウト

```
src/
├── cli.ts
├── index.ts
├── hooks/
│   ├── session-start.ts
│   ├── user-prompt.ts
│   ├── pre-tool-use.ts
│   ├── post-tool-use.ts
│   ├── post-tool-failure.ts
│   └── stop.ts
├── engines/
│   ├── gap-analysis.ts
│   ├── task-generation.ts
│   ├── satisficing.ts
│   ├── stall-detection.ts
│   ├── priority-scoring.ts
│   └── observation.ts        # 新規 — ObservationRule実行エンジン
├── state/
│   ├── manager.ts            # アトミック読み書き
│   └── models.ts             # Zodスキーマ定義
├── collaboration/
│   ├── trust.ts
│   ├── behavior.ts
│   └── irreversible.ts
├── context/
│   └── injector.ts           # motive.md生成
└── learning/
    ├── logger.ts             # log.jsonl 追記
    └── pattern-analyzer.ts   # パターン分析（defer可）

.motive/                      # ホストプロジェクト内（gitignore対象）
├── state.json
├── config.yaml
├── goals/
│   └── <id>.json
└── log.jsonl
```

---

## 11. ビルドフェーズ

| Phase | スコープ | 合格基準 |
|-------|----------|----------|
| **Phase 1** | `models.ts`, `observation.ts`, `gap-analysis.ts`, `satisficing.ts`, `manager.ts` | 多次元ギャップ計算が正しい; 空の`achievement_thresholds` → `needs_refinement`; ObservationRuleが各タイプで動作する |
| **Phase 2** | 全フック + `injector.ts` | Write → `file_exists`のみ更新; Bash → `test_pass`を更新; 盲目+0.05なし; `needs_verification`で検証タスクが生成される |
| **Phase 3** | CLI (`refine-goal`, `verify`) + 残エンジン | E2E: `add-goal` → セッション起動 → 観測 → 検証 → 完了の一連が動作する |
| **Phase 4** | 協調モデル（trust, behavior, irreversible） | 振る舞いマトリクスの4象限それぞれで期待通りの出力 |
| **Phase 5** | 学習・好奇心・仕上げ | 全フック<300ms; SessionStart<200ms; motive.md≤500トークン |

---

## 12. リスクと未決事項

| リスク | 影響 | 対策 |
|--------|------|------|
| 観測ルールのカバレッジ不足 | ゴールが`needs_refinement`で止まり続ける | フォールバックとして`build_success + test_pass`のデフォルト次元を用意 |
| fs/glob実行による<300ms超過 | フックがタイムアウト | SessionStartでのみ全観測を実行。PostToolUseは変更ファイルに関連する次元のみ評価 |
| ヒューリスティックパーサーの精度（~60-70%） | 誤った次元が生成される | `refine-goal`コマンドで手動修正パスを必ず提供 |
| テストランナー出力形式の多様性 | `test_pass`パースが失敗する | vitest/jestを最優先でサポート。未知の形式は信頼度0.3で記録 |
| 高速連続フック起動による状態ファイル競合 | 書き込みが失われる | アトミック temp-file-rename 書き込みで対処（既存`manager.ts`の方針を維持） |
| `completion_criteria`の自由記述パースの限界 | 重要次元が見落とされる | パース後に未確信な次元を`motive.md`の明示的な確認ブロックに表示 |
