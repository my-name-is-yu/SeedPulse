# Motiva 実装ロードマップ (Stage 3-6: MVP完成)

作成日: 2026-03-10
前提: Stage 1-2 完了（405テスト通過、8モジュール実装済み）

---

## Stage 3 ✅ — Layer 3: セッション・交渉・戦略

### 実装内容

実装順序に依存関係あり。上から順に実装する。

| # | モジュール | ファイル | 依存先 | 規模感 |
|---|----------|---------|--------|--------|
| 1 | ✅ LLM抽象化レイヤー | `src/llm-client.ts` | なし（Anthropic SDK） | 小 |
| 2 | ✅ EthicsGate | `src/ethics-gate.ts` | LLMClient | 中 |
| 3 | ✅ SessionManager | `src/session-manager.ts` | StateManager | 中 |
| 4 | ✅ StrategyManager (MVP) | `src/strategy-manager.ts` | DriveScorer, StallDetector | 小 |
| 5 | ✅ GoalNegotiator | `src/goal-negotiator.ts` | ObservationEngine, StateManager, LLMClient, EthicsGate | 大 |

**詳細:**

1. **LLM抽象化レイヤー** — Anthropic SDKのラッパー。`sendMessage(prompt, options): Promise<LLMResponse>` のインターフェースを定義。テスト時にモック差し替え可能なDI構造にする。レスポンスのZodバリデーション付きパース機能を含む。
2. **EthicsGate** — 独立クラス。LLM Layer 2判定（reject/flag/pass）を実行。EthicsLogを `~/.motiva/ethics/` に永続化。GoalNegotiatorの Step 0 として呼ばれる。
3. **SessionManager** — 4種セッションコンテキスト（タスク実行/観測/タスクレビュー/ゴールレビュー）の組み立て。MVPは優先度1〜4の固定テンプレート。タスクレビューセッションには実行者の自己申告を渡さない（バイアス防止）。
4. **StrategyManager (MVP)** — 単一戦略の逐次管理。状態遷移（active/completed/abandoned）。StallDetectorと連動し、停滞検知時にピボット判断をトリガー。1〜2候補生成 → 最上位を自動選択。
5. **GoalNegotiator** — 6ステップフロー: Step 0（倫理ゲート）→ Step 1（次元分解）→ Step 2（ベースライン測定）→ Step 3（実現可能性評価）→ Step 4（閾値設定）→ Step 5（応答/カウンター提案）。`character.md` のペルソナをプロンプトに反映。`feasibility_ratio` 閾値は character.md の 2.5 を使用（デフォルト3.0からの変更）。

### 手動テスト

以下は自動テストでは品質を担保できないため、人間による確認が必要。

- [ ] LLM呼び出しが実際に動くか（APIキー設定、レスポンスのパース、エラー時のリトライ）
- [ ] EthicsGateが危険なゴール（例: 「競合のサーバーをDDoSしたい」）を適切にrejectするか — プロンプト品質の確認
- [ ] EthicsGateがグレーゾーンのゴール（例: 「競合の公開情報を収集したい」）を適切にflagするか
- [ ] GoalNegotiatorが曖昧なゴール（例: 「売上を2倍にしたい」）を適切な次元に分解できるか
- [ ] feasibility_ratio計算とカウンター提案の妥当性（非現実的なゴールに対して適切な代替案を出すか）
- [ ] character.mdのペルソナがプロンプトに適切に反映されているか（口調、判断基準）
- [ ] LLM呼び出し1回あたりのトークン消費量の計測

### ゲート条件

Stage 4に進むために、以下をすべて満たすこと。

1. ✅ 全ユニットテスト通過（LLMモック使用）
2. ✅ 実際のAnthropic APIでGoalNegotiatorの一連のフロー（ゴール入力 → 倫理チェック → 次元分解 → 実現可能性評価 → 応答）が動作する（手動確認）
3. ✅ EthicsGateが明らかに不適切なゴールをrejectする（3種以上のケースで手動確認）
4. ✅ 交渉ログが `~/.motiva/goals/<goal_id>/` に正しく永続化される
5. ✅ SessionManagerの4種コンテキストが正しい情報のみを含む（特にレビューセッションにバイアス情報が混入しない）

### 自動テスト vs 手動テスト

| 項目 | 自動テスト | 手動テスト |
|------|----------|----------|
| LLMClient のインターフェース準拠 | モックで検証可 | APIキー・ネットワーク・レスポンス形式は手動 |
| EthicsGate の判定ロジック | モックLLMで3分岐（reject/flag/pass）を検証可 | プロンプト品質・判定精度は手動 |
| SessionManager のコンテキスト組み立て | 全4種のコンテキスト内容を自動検証可 | — |
| StrategyManager の状態遷移 | 全遷移パスを自動検証可 | — |
| GoalNegotiator の6ステップフロー | モックLLMでフロー制御・エラーハンドリングを検証可 | 次元分解の品質・カウンター提案の妥当性は手動 |
| 永続化 | ファイル書き込み・読み込みの正確性は自動検証可 | — |

---

## Stage 4 ✅ — Layer 0 + Layer 4: アダプター + タスクライフサイクル

### 実装内容

| # | モジュール | ファイル | 依存先 | 規模感 |
|---|----------|---------|--------|--------|
| 1 | ✅ AdapterLayer | `src/adapter-layer.ts`, `src/adapters/claude-code-cli.ts`, `src/adapters/claude-api.ts` | なし | 中 |
| 2 | ✅ TaskLifecycle | `src/task-lifecycle.ts` | DriveScorer, SessionManager, TrustManager, StrategyManager, AdapterLayer | 大 |

**詳細:**

1. **AdapterLayer** — エージェント委譲の抽象化インターフェース。MVP実装は2つ: Claude Code CLIアダプター（`claude` コマンドのspawn）とClaude APIアダプター（Anthropic SDK直接呼び出し）。既存PoCの `src/adapters/claude-code.ts` のパターンを参考にしつつ再実装。入出力の型定義、タイムアウト制御、プロセス管理を含む。
2. **TaskLifecycle** — タスクの全ライフサイクルを管理。タスク選択（DriveScorer優先度）→ タスク生成（LLMによるプロンプト構築）→ 実行（AdapterLayer経由）→ 3層検証（L0機械的/L1独立レビュー/L2自己申告）→ 失敗対応（keep/discard/escalate）。可逆性タグ（reversible/irreversible/unknown）判定と不可逆アクション時の人間承認フロー。`consecutive_failure_count` 管理（task-lifecycle.md 2.8 に準拠）。

### 手動テスト

- [ ] Claude Code CLIアダプターが実際にClaude Codeプロセスを起動してタスクを実行できるか
- [ ] Claude Code CLIのstdout/stderrパースが正しく動作するか
- [ ] タスク生成のプロンプト品質（成功基準が具体的か、スコープ境界が明確か）
- [ ] 3層検証の動作確認（特にL0 vs L1で矛盾が発生した場合の解消ロジック）
- [ ] 不可逆アクション検出と人間承認フロー（CLI上でのプロンプト表示と入力待ち）
- [ ] 失敗時のkeep/discard/escalate判定の妥当性
- [ ] タスク実行のタイムアウト制御が動作するか

### ゲート条件

1. ✅ 全ユニットテスト通過（AdapterLayerはモック、TaskLifecycleはモックAdapter使用）
2. ✅ 実際のClaude Code CLIで簡単なタスク（例: 指定ディレクトリにテストファイルを作成）の生成 → 実行 → 検証の一連フローが完走する（手動確認）
3. ✅ 不可逆アクション検出時に承認要求が表示される（手動確認）
4. ✅ タスク失敗時のエスカレーション（StallDetectorへの通知）が動作する（手動確認）
5. ✅ `consecutive_failure_count` が正しくインクリメント・リセットされる

### 自動テスト vs 手動テスト

| 項目 | 自動テスト | 手動テスト |
|------|----------|----------|
| AdapterLayer インターフェース準拠 | モックで検証可 | — |
| Claude Code CLI プロセス起動・制御 | — | 実プロセスのspawn/kill/timeoutは手動 |
| Claude API 呼び出し | モックで検証可 | 実APIでのレスポンス形式は手動 |
| タスク生成ロジック | モックLLMでフロー検証可 | プロンプト品質は手動 |
| 3層検証フロー | モックで全パターン（一致/矛盾/部分一致）検証可 | — |
| 可逆性判定 | 既知パターンのテストケースで検証可 | LLM判定の精度は手動 |
| 人間承認フロー | — | CLI上のインタラクションは手動 |
| keep/discard/escalate 分岐 | 全分岐を自動検証可 | 判定の妥当性は手動 |
| failure_count 管理 | 自動検証可 | — |

---

## Stage 5 ✅ — Layer 5: コアループ + レポーティング

### 実装内容

| # | モジュール | ファイル | 依存先 | 規模感 |
|---|----------|---------|--------|--------|
| 1 | ✅ ReportingEngine (MVP) | `src/reporting-engine.ts` | StateManager | 小 |
| 2 | ✅ CoreLoop | `src/core-loop.ts` | ObservationEngine, GapCalculator, DriveScorer, TaskLifecycle, SatisficingJudge, StallDetector, ReportingEngine | 大 |

**詳細:**

1. **ReportingEngine (MVP)** — 3種レポート生成: 実行サマリー（毎ループ）、日次サマリー、週次レポート。Markdown出力を `~/.motiva/reports/` に保存。CLIログ表示（進捗バー的なフォーマット）。通知種別: 緊急/承認要求/停滞エスカレーション/完了/能力不足。
2. **CoreLoop** — Motivaの心臓部。1ループ = observe → gap → score → task → execute → verify → report。SatisficingJudgeの完了判断で停止。StallDetector連動でStrategyManagerピボット。ループ間の状態引き継ぎ（前ループの観測結果を次ループの入力に）。エラーハンドリング（任意のステップでの失敗からの復旧）。

**注意: Stage 5開始前に解決必須の数値不整合:**
- `progress_ceiling` の値: observation.md では 0.70/0.90、satisficing.md では 0.60/0.85 と記載が異なる。CoreLoopが両モジュールを接続するため、この不整合を解消してから実装に入ること。

### 手動テスト

- [ ] CoreLoopの1周が正しい順序で全モジュールを呼び出すか（ログで確認）
- [ ] レポートの可読性（Markdown出力の品質、情報の過不足）
- [ ] 停滞検知 → StrategyManagerピボット → 新タスク生成の連鎖が動くか
- [ ] SatisficingJudgeの完了判断が適切なタイミングで発火するか（早すぎず遅すぎず）
- [ ] 複数ループにわたるゴール進捗の蓄積が正しいか（5ループ以上の連続実行）
- [ ] エラー発生時（LLMタイムアウト、ファイルI/Oエラー等）にループが安全に停止するか
- [ ] LLM呼び出し回数の計測（1ループあたりの呼び出し数とコスト）

### ゲート条件

1. ✅ 全ユニットテスト通過（全依存モジュールをモック）
2. ✅ 簡単なゴール（例: 「このディレクトリにREADME.mdを作成する」）で、CoreLoopが観測 → ギャップ計算 → タスク生成 → 実行 → 検証 → 完了判断まで自動で回る（手動確認）
3. ✅ レポートファイルが `~/.motiva/reports/` に正しく生成される
4. ✅ 停滞シナリオ（意図的に失敗させる）でエスカレーションが動作する（手動確認）
5. ✅ `progress_ceiling` の数値不整合が解消されている
6. ✅ 1ループあたりのLLM呼び出し回数が想定範囲内（最大5回）であることを確認

### 自動テスト vs 手動テスト

| 項目 | 自動テスト | 手動テスト |
|------|----------|----------|
| CoreLoop のステップ実行順序 | モックで全ステップの呼び出し順序を検証可 | — |
| ループ間の状態引き継ぎ | モックで検証可 | — |
| 停滞→ピボット連鎖 | モックで検証可 | 実環境での判断品質は手動 |
| SatisficingJudge 完了発火 | モックで閾値境界テスト可 | 実ゴールでのタイミング妥当性は手動 |
| ReportingEngine 出力形式 | スナップショットテストで検証可 | 可読性は手動 |
| エラーハンドリング | 各ステップの例外注入で検証可 | — |
| E2E（ゴール → 完了） | — | 実LLM + 実CLIで手動 |

---

## Stage 6 ✅ — Layer 6: CLIランナー

### 実装内容

| # | モジュール | ファイル | 依存先 | 規模感 |
|---|----------|---------|--------|--------|
| 1 | ✅ CLIRunner | `src/cli-runner.ts`, `src/index.ts`（エントリーポイント） | CoreLoop, DriveSystem, ReportingEngine, GoalNegotiator | 小 |

**詳細:**

1. **CLIRunner** — Motivaのエントリーポイント。サブコマンド構成:
   - `motiva run` — CoreLoopを1回実行（イベントキューのポーリング含む）
   - `motiva goal add "<description>"` — GoalNegotiatorを起動してゴールを登録
   - `motiva goal list` — 登録済みゴール一覧表示
   - `motiva status` — 現在の進捗レポート表示
   - `motiva report` — 最新レポートの表示

   引数パースはNode.js組み込みの `parseArgs` または軽量ライブラリ。終了コード: 0（正常完了/ゴール達成）、1（エラー）、2（停滞エスカレーション）。`~/.motiva/` ディレクトリの初期化処理。設定ファイル（APIキー等）の読み込み。

### 手動テスト

- [ ] `motiva run` でCoreLoopが起動し、1ループ完走するか
- [ ] `motiva goal add "READMEを作成する"` でGoalNegotiatorが起動し、対話的にゴールが登録されるか
- [ ] `motiva goal list` で登録済みゴールが表示されるか
- [ ] `motiva status` でレポートが表示されるか
- [ ] 終了コードが適切か（正常: 0、エラー: 1、エスカレーション: 2）
- [ ] 初回起動時の `~/.motiva/` ディレクトリ自動作成
- [ ] APIキー未設定時のエラーメッセージが適切か
- [ ] Ctrl+C でのグレースフルシャットダウン

### ゲート条件

1. ✅ 全サブコマンドのユニットテスト通過
2. [ ] E2Eテスト: `motiva goal add "..." && motiva run` で完結するシナリオが動作する（手動確認）
3. [ ] **MVP完成の定義**: 簡単な実世界タスク（例: 指定リポジトリにREADME.mdを作成してコミットする）をゴールとして与え、Motivaが自律的に完了まで持っていける
4. [ ] エラーケース（APIキー未設定、ネットワーク不通、不正な引数）で適切なエラーメッセージが表示される

### 自動テスト vs 手動テスト

| 項目 | 自動テスト | 手動テスト |
|------|----------|----------|
| 引数パース | 全サブコマンド・オプションを自動検証可 | — |
| 終了コード | 各シナリオの終了コードを自動検証可 | — |
| ディレクトリ初期化 | テンポラリディレクトリで自動検証可 | — |
| エラーメッセージ | スナップショットテストで検証可 | 可読性は手動 |
| E2E（goal add → run → 完了） | — | 実環境で手動（MVP完成判定） |
| グレースフルシャットダウン | — | シグナルハンドリングは手動 |

---

## 全体を通したリスクと注意点

### コスト制御

各ステージでのLLM API使用量を把握すること。特にStage 5でCoreLoopが回り始めると、1ループあたり最大5回のLLM呼び出しが発生する。開発中はモックを活用し、手動テスト時のみ実APIを使用する運用を推奨。

### 数値不整合（Stage 5前に解決必須）

`progress_ceiling` の値が設計ドキュメント間で不整合:
- `observation.md`: 検証なし 0.70 / 検証あり 0.90
- `satisficing.md`: 検証なし 0.60 / 検証あり 0.85

Stage 5（CoreLoop）で ObservationEngine と SatisficingJudge を接続する前に、どちらの値を採用するか確定すること。

→ ✅ 解決済み: ObservationEngineとSatisficingJudgeが意図的に異なるceiling値を使用。各モジュールが独立に適用し、CoreLoopでの二重適用なし。

### character.md 関連

`feasibility_ratio` 閾値が character.md では 2.5（デフォルト3.0からの変更）に設定されている。GoalNegotiator実装時にこの値を反映すること。

### テスト戦略の原則

- **ユニットテスト**: 全モジュールで必須。LLM呼び出しはすべてモック。ファイルI/Oはテンポラリディレクトリを使用。
- **統合テスト**: Stage 5以降で、モジュール間の接続を検証。モックLLMを使用。
- **E2Eテスト**: Stage 6完了時に、実LLM + 実CLIでの動作確認。手動実施。
- **スナップショットテスト**: レポート出力、エラーメッセージなどの形式検証に使用。

### 実装の累積テスト数の目安

| ステージ | 新規テスト数（目安） | 累積テスト数（目安） |
|---------|-------------------|-------------------|
| Stage 1-2（完了） | 405 | 405 |
| Stage 3 | 実績 258 | 累積 663 |
| Stage 4 | 実績 139 | 累積 802 |
| Stage 5 | 実績 120 | 累積 922（17ファイル）|
| Stage 6 | 実績 61 | 累積 983（18ファイル）|
