# Motiva 実装ロードマップ調査

調査日: 2026-03-10
対象: docs/mechanism.md, docs/runtime.md, docs/architecture-map.md, docs/design/* (全14ファイル)
既存PoCコード: src/ 配下4ファイル（state.ts, index.ts, adapters/claude-code.ts, motiva.ts）

---

## A. コアモジュール一覧

### コアループ（MVP必須）

| モジュール | 責務（1行） | 依存 | 規模感 | フェーズ |
|-----------|-----------|------|--------|---------|
| **CoreLoop** | observe→gap→score→task→execute→verify の1ループを実行する | 全モジュール | 大 | MVP |
| **StateManager** | ゴールツリー・状態ベクトル・観測ログをJSONファイルで永続化/読み込み | なし | 中 | MVP |
| **ObservationEngine** | 3層観測（機械的/独立レビュー/自己申告）を実行し current_value と confidence を更新 | StateManager | 中 | MVP |
| **GapCalculator** | raw_gap → normalized_gap → normalized_weighted_gap のパイプラインを実行 | StateManager | 小 | MVP |
| **DriveScorer** | 不満・締切・機会の3駆動力スコアを計算し優先次元を確定（LLM不使用） | GapCalculator | 小 | MVP |
| **TaskLifecycle** | タスクの生成・実行・検証（3層）・失敗対応（keep/discard/escalate）を管理 | DriveScorer, SessionManager, TrustManager | 大 | MVP |
| **SessionManager** | セッションの起動・コンテキスト組み立て・終了を制御（MVPは優先度1〜4固定） | StateManager | 中 | MVP |
| **AdapterLayer** | Claude Code CLI / Claude API へのエージェント委譲を抽象化 | なし | 中 | MVP |

### 判断システム（MVP必須）

| モジュール | 責務（1行） | 依存 | 規模感 | フェーズ |
|-----------|-----------|------|--------|---------|
| **TrustManager** | トラストバランス([-100,+100])と確信度を管理し4象限行動マトリクスで自律度を決定 | StateManager | 小 | MVP |
| **SatisficingJudge** | 全次元閾値超過 + 信頼度チェック + 証拠ゲートで完了を判定 | StateManager | 小 | MVP |
| **StallDetector** | 4種停滞指標（次元/時間超過/連続失敗/全体）を検知し段階対応をトリガー | StateManager | 中 | MVP |
| **GoalNegotiator** | ゴール受取→次元分解→ベースライン→実現可能性評価→応答の5ステップを実行（LLM使用） | ObservationEngine, StateManager | 大 | MVP |
| **StrategyManager (MVP版)** | 単一戦略の逐次管理、停滞時のピボット判断 | DriveScorer, StallDetector | 小 | MVP |

### プロセス基盤（MVP必須）

| モジュール | 責務（1行） | 依存 | 規模感 | フェーズ |
|-----------|-----------|------|--------|---------|
| **CLIRunner** | `motiva run` コマンドで1コアループを実行するエントリーポイント | CoreLoop | 小 | MVP |
| **DriveSystem** | 軽量起動チェック（LLM不要）とイベントキュー（~/.motiva/events/）処理 | StateManager | 小 | MVP |
| **ReportingEngine (MVP版)** | 実行結果のMarkdown出力とCLIログ表示 | StateManager | 小 | MVP |

### Phase 2以降

| モジュール | 責務（1行） | フェーズ |
|-----------|-----------|---------|
| **PortfolioManager** | 複数戦略の並列実行・効果計測・自動リバランス | Phase 2 |
| **CuriosityEngine** | メタ動機による新ゴール提案・既存ゴール再定義 | Phase 2 |
| **KnowledgeAcquirer** | 知識不足検知・調査タスク生成・DomainKnowledge保存 | Phase 2 |
| **DaemonRunner** | 内蔵スケジューラーによる自動ループ実行 | Phase 2a |
| **HTTPEventReceiver** | ローカルHTTPエンドポイント(127.0.0.1:41700)でのイベント受信 | Phase 2 |
| **ExternalNotifier** | Slack/メール/Webhookへのレポート配信 | Phase 2 |
| **GoalDependencyGraph** | ゴール間の依存グラフ管理（prerequisite/synergy/conflict） | Phase 2 |

---

## B. 依存関係グラフ（実装順序）

```
LAYER 0（独立、先行実装必須）
  StateManager
  AdapterLayer

LAYER 1（Layer 0に依存）
  GapCalculator ← StateManager
  DriveSystem   ← StateManager
  TrustManager  ← StateManager

LAYER 2（Layer 1に依存）
  ObservationEngine ← StateManager, AdapterLayer
  DriveScorer       ← GapCalculator
  SatisficingJudge  ← StateManager
  StallDetector     ← StateManager

LAYER 3（Layer 2に依存）
  SessionManager     ← StateManager
  GoalNegotiator     ← ObservationEngine, StateManager, AdapterLayer
  StrategyManager    ← DriveScorer, StallDetector

LAYER 4（Layer 3に依存）
  TaskLifecycle ← DriveScorer, SessionManager, TrustManager, StrategyManager

LAYER 5（Layer 4に依存）
  CoreLoop          ← ObservationEngine, GapCalculator, DriveScorer, TaskLifecycle, SatisficingJudge, StallDetector
  ReportingEngine   ← StateManager

LAYER 6（Layer 5に依存）
  CLIRunner ← CoreLoop, DriveSystem, ReportingEngine
```

横断的（どのLayerからも呼ばれる）:
- StateManager（全モジュール共通のI/O）
- TrustManager（TaskLifecycleの実行許可判定で参照）

---

## C. MVPスコープの定義

設計ドキュメントから読み取れるMVP要件（"MVP" キーワードと "Phase 1" 記述から抽出）:

### プロセスモデル
- `motiva run` コマンドで1ループ実行 → 終了
- スケジューリングはユーザー/外部cron任せ
- 状態はファイル永続化（~/.motiva/）

### コアループ
- 観測: Layer 1（機械的）+ Layer 3（自己申告）のみ。独立レビューセッション（Layer 2）は含めてよいが軽量化可
- ギャップ計算: 5閾値型すべて対応（min/max/range/present/match）
- 駆動スコア: 3駆動力すべて計算（不満・締切・機会）。機会駆動の `timing_bonus` はLLM評価不要（0.0デフォルト可）
- タスク選択: 優先度1〜4の固定コンテキストテンプレート（動的選択は不要）
- 検証: 3層すべて実装（機械的検証はエージェントセッション経由）

### ゴール管理
- ゴール交渉: 5ステップ実装（LLMによる実現可能性評価含む）
- 満足化: 完了判断フロー実装（検証タスク自動生成含む）
- 停滞検知: 4指標 + 段階対応（第1〜3検知）
- ゴールツリー: 再帰構造 + 最小値集約（デフォルト）

### 戦略管理（MVP版）
- 単一戦略の逐次実行
- 1〜2候補生成 → 最上位を自動選択
- リバランスは手動（ユーザーが切り替え）
- 戦略履歴は記録（`current_strategy` + `strategy_history`）

### 信頼と安全
- トラストバランス: [-100,+100]整数、Δs=+3, Δf=-10、高信頼境界=+20
- 確信度境界: >=0.50（検証あり）vs <0.50（自己申告）
- 不可逆アクションは常に人間承認（trust/confidence無関係）

### イベント受信
- ファイルキュー（~/.motiva/events/）のみ
- `motiva run` 起動時にポーリング処理

### レポーティング
- ファイル出力（Markdown）+ CLIログ
- 日次サマリー + 週次レポート（`motiva run` 実行時に評価）
- 全通知種別実装（緊急/承認要求/停滞エスカレーション/完了/能力不足）

### MVP除外（Phase 2以降）
- 好奇心エンジン（CuriosityEngine）
- 知識獲得機能（KnowledgeAcquirer）
- ポートフォリオ並列管理
- ゴール間依存グラフ
- 外部通知チャネル（Slack/メール）
- デーモンモード / HTTP受信
- 学習パイプライン（ゴール完了時のみ手動トリガーで可）

---

## D. 既存PoCとの関係

### 既存ファイル構成
```
src/
├── state.ts              — 状態管理（ゴール・タスクのCRUD）
├── motiva.ts             — オーケストレーターメインループ
├── index.ts              — CLIエントリーポイント
└── adapters/
    └── claude-code.ts    — Claude Code CLIアダプター
```

### 評価

**活用可能な設計思想（ただし再実装推奨）:**
- `AdapterLayer` の抽象化パターン（claude-code.ts）
- CLIエントリーポイントの構造（index.ts）

**設計との乖離が大きく流用困難:**
- `state.ts`: 既存のゴール/タスク構造が設計の5閾値型・状態ベクトル・gap_vector・信頼度モデルと異なる。スキーマ再定義が必要
- `motiva.ts`: Hooks-based Pluginアーキテクチャからオーケストレーターへのpivot済みだが、GapCalculator・DriveScorer分離がない
- 観測ログ構造、ObservationLog ↔ Dimension.history の結合キー設計が未実装

**判断: 新規実装を推奨。** 既存コードはアダプターパターンの参考程度に。スキーマを最初から設計ドキュメントに合わせて定義する方が、後の実装コストが低い。

---

## E. 技術的リスク

### リスク高

**1. LLM呼び出しの多さとコスト制御**
- コアループ1周でLLM呼び出しが最大5回（ゴール分解・観測分析・戦略選択・タスク生成・完了判断）
- 加えてゴール交渉・独立レビューセッション・停滞診断でも呼び出し発生
- 実装上の課題: 各呼び出しのプロンプト設計、レスポンスの構造化、エラーハンドリング
- 対策: 各LLM呼び出しを明確なインターフェース（入力型・出力型）で定義してからモック実装でテスト可能にする

**2. 観測システムの実装複雑度**
- observation_method スキーマ（type: mechanical/llm_review/api_query/file_check/manual）への対応
- 外部API・センサー・DBクエリを抽象化するアダプターが必要
- MVP: api_query + file_check + manual の3種に絞ると現実的

**3. ギャップ計算と信頼度パイプラインの数値正確性**
- raw_gap → normalized_gap → normalized_weighted_gap のパイプライン
- null値ガード・ゼロ除算ガード・二値型の特殊処理
- 3重適用問題（observation進捗上限・state-vector有効達成度・gap-calculation加重の役割分担）の実装での混乱リスク
- 対策: `gap-calculation.md §3` の「唯一の適用箇所」注記を厳守。ユニットテストを先に書く

### リスク中

**4. ファイルベース状態管理の設計**
- ゴールツリー・状態ベクトル・観測ログ・戦略履歴・経験ログを別々のJSONファイルとして管理
- 書き込み途中でのクラッシュ対策（アトミック書き込み）
- 参照整合性（ObservationLog ↔ Dimension.history の source_observation_id）
- ファイルレイアウト: `~/.motiva/goals/<goal_id>/` 配下に分散

**5. セッション種別ごとのコンテキスト組み立て**
- タスク実行/観測/タスクレビュー/ゴールレビュー の4種それぞれに「渡す情報」「渡さない情報」の分離
- 特にタスクレビューセッションへの「実行者自己申告を渡さない」バイアス防止
- MVPは固定テンプレート（優先度1〜4）で実装可能

**6. 可逆性タグと不可逆アクション判定**
- タスク生成時にLLMが `reversibility: reversible/irreversible/unknown` を判定
- "unknown" は "irreversible" と同等に扱う保守的原則
- 実装上: LLMへのプロンプトで確実に判定させる方法が必要

### リスク低（設計が明確）

**7. 停滞検知の閾値管理**
- 4指標の計算式は明確（gap_delta、時間超過2x、consecutive_failure_count=3）
- `plateau_until` による抑制ロジックも明確
- `consecutive_failure_count` はtask-lifecycle.md §2.8 で一元管理（重複定義なし）

**8. トラストバランスの数値計算**
- [-100,+100]整数、Δs=+3、Δf=-10、高信頼境界=+20 が確定
- 4象限マトリクスの条件式: `trust_balance >= 20 AND confidence >= 0.50` で計算可能

**9. 駆動スコアリングの数値計算**
- 3駆動力の数式は完全に定義済み
- Max + 締切オーバーライドルールも明確
- LLMは関与しない（コードのみで実装可能）

---

## 補足: 未解決事項（architecture-map.md P1リスト参照）

architecture-map.md のP1未解決として列挙されていた項目は、その後の設計ドキュメントで**すべて解決済み**:

| 項目 | 解決箇所 |
|------|---------|
| confidence調整3重問題 | gap-calculation.md §3 で「唯一の適用箇所」を明確化 |
| observation_methodスキーマ未定義 | observation.md §5 で5フィールドスキーマ定義済み |
| opportunity_valueの入力元 | drive-scoring.md §3 で3変数（downstream_impact/external_bonus/timing_bonus）定義済み |
| 信頼スコアの数値閾値 | trust-and-safety.md §2 で数値仕様（v1デフォルト）定義済み |
| プロセスモデル未決定 | runtime.md §2 でCLI/デーモン/cronを定義済み |
| コンテキスト選択アルゴリズム | session-and-context.md §4 で優先度ベースルール定義済み |
| イベント駆動トリガー受信口 | drive-system.md §3 でファイルキュー方式定義済み |
| 停滞タイプ→原因分類マッピング | stall-detection.md §3.6 でマッピング表定義済み |
| estimated_duration不在 | task-lifecycle.md §2.7 でDuration型として定義済み |
| クロスゴール類似度計算 | curiosity.md §4.3 でMVP=dimension_name完全一致方式と定義済み |

**Confirmed: 設計ドキュメントは実装可能な状態に達している。**
