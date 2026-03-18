# ロードマップ: Milestone 8 以降

## 現在地

Stage 1-14 + Milestone 1-12 完了（3461テスト、109ファイル）。Phase 3（開発基盤整備）完了済み。
プラグインアーキテクチャ基盤が整い、Slack通知サンプルプラグインがロード・動作確認済み。
次: Milestone 13（プラグイン自律選択 + セマンティック知識共有）。

**M8 dogfooding（TODO/FIXME解消ゴール）で3つの問題が発覚**:
- LLM観測がtodo_count=0, fixme_count=0と報告したが、実際には3件残存（hallucination）
- Codexがコメント1行しか変更しなかった（保守的すぎる実行）
- ゴールを手動定義する必要があった（「改善して」でMotivaが自分でゴールを作れない）

この結果を受けてロードマップを再優先化した。観測が嘘をつき、ゴールを手動で書かなければならない限り、コアループは機能不全である。プラグイン拡張よりも先にコアを修復する。

新しい優先順位: **安全性 → 観測精度 → ゴール自動生成 → 戦略自律選択 → プラグイン**

---

## ロードマップ概要

| Milestone | テーマ | 規模 | 検証方法 |
|-----------|--------|------|----------|
| **8** | 安全性強化 + npm公開 | Medium | npm publishを実行、EthicsGate Layer 1でブロック確認 |
| **9** | 観測精度強化 | Medium | TODO/FIXMEゴール再実行で観測一致率90%以上 |
| **10** | ゴール自動生成 | Medium | `motiva improve src/` で自律改善ループ完走 |
| **11** | 戦略自律選択 + 実行品質 | Medium | TODO/FIXME解消が1イテレーション完了 |
| **12** | プラグインアーキテクチャ | Large | サンプルプラグインロード + デーモン24時間動作 |
| **13** | プラグイン自律選択 + セマンティック知識共有 | Large | プラグイン自動選択 + 知識転移 |
| **14** | 仮説検証メカニズム（PIVOT/REFINE + 学習） | Medium-Large | stall時の自律回復 + 判断履歴学習 |

---

## Milestone 8: 安全性強化 + npm公開

**テーマ**: EthicsGate Layer 1を実装し、コアを薄く保ったまま安全に外部公開できる状態にする。

### 8.1: EthicsGate Layer 1（カテゴリベースブロックリスト）
- `src/ethics-gate.ts` 拡張 — カテゴリベースブロックリスト（destructive_action, credential_access等）
- TaskLifecycle generateTask()後の手段チェック統合（既存FIXMEコメント解消）
- 設計: `docs/design/goal-ethics.md` §9

### 8.2: TaskLifecycle L1検証の実アダプター呼び出し
- `src/task-lifecycle.ts` — L1機械的検証でアダプター経由のコマンド実行
- 既存FIXMEコメント解消

### 8.3: ClaudeCodeCLI flags検証・修正
- `src/adapters/claude-code-cli.ts` — `--print`フラグ等の動作検証
- 既存TODOコメント解消

### 8.4: パッケージ整備 + npm publish
- README.md更新（テスト数983→3282、Project Status更新、機能リスト最新化）
- .npmignore確認（コアのみ含める、プラグインサンプルは別途）
- GitHub Actions: npm publish自動化（タグトリガー）
- `npm publish` 実行

**成功基準**:
- [x] EthicsGate Layer 1がdestructive_actionカテゴリをブロック
- [x] TaskLifecycleがgenerateTask()後に手段チェックを実行
- [x] npm publishが成功し、`npm install motiva` で動作確認

**Status**: complete（2026-03-16）

---

## Milestone 9: 観測精度強化

**テーマ**: LLM観測のhallucination問題を解決し、正しく現状を把握できるようにする。M8 dogfoodingで観測がtodo_count=0と嘘をついたことがこのMilestoneの直接の動機。

### 9.1: 機械的観測の自動併用
- ObservationEngineに汎用シェルコマンド観測を追加（grep, wc, test runner等）
- 次元タイプに応じた自動観測手段選択: count系→grep/wc、existence系→stat、test系→vitest --reporter=json
- 設計: `docs/design/observation.md` 拡張

### 9.2: LLM観測のクロス検証
- 機械的観測とLLM観測の結果を比較、乖離時は機械的結果を優先
- 乖離ログ出力（将来のプロンプト改善に活用）
- confidence_tierを動的に下げる（LLM結果が機械的検証と矛盾→self_reportレベルに格下げ）

### 9.3: LLM観測プロンプト改善
- Few-shot例の追加
- 定性評価のスコアキャリブレーション
- 「実際にファイルを読んで回答せよ」の明示的指示

### 9.4: 次元キー `_2` サフィックス問題修正
- ObservationEngineの重複キー正規化ロジック追加

**成功基準**:
- [x] grep結果とLLM観測結果の一致率が90%以上
- [x] TODO/FIXME count系の機械的観測が自動選択される
- [x] 乖離ログが出力され、confidence_tierが動的調整される

**Status**: complete（2026-03-16）

**検証方法**: 同じTODO/FIXMEゴールを再実行し、正確な観測ができることを確認

---

## Milestone 10: ゴール自動生成

**テーマ**: 「改善して」でMotivaが自分でゴールを提案できるようにする。現状は全ゴールを手動定義する必要があり、エージェント自律性の根幹が欠けている。

### 10.1: コードベース分析 → ゴール候補提案
- GoalNegotiatorに `suggestGoals(repoPath)` メソッド追加
- LLMにリポジトリ構造・コード品質・テストカバレッジ等を分析させ、改善ゴール候補を生成
- 各候補に次元・閾値・優先度を含める
- CLI: `motiva suggest` コマンド（候補一覧表示→ユーザーが選択→goal add）

### 10.2: ゴール候補の品質フィルタリング
- 実現可能性チェック（CapabilityDetector連携）
- 既存ゴールとの重複排除
- 費用対効果の推定（小さい変更で大きな改善 > 大きい変更で小さい改善）

### 10.3: `motiva improve` コマンド
- `motiva improve [path]` — 指定パスを分析→ゴール提案→承認→ループ実行をワンコマンドで
- `--auto` フラグで全自動（提案の中からスコア最高のゴールを自動選択）

**成功基準**:
- [x] `motiva suggest` がMotiva自身のリポジトリに対して3つ以上の改善ゴールを提案
- [x] 提案されたゴールの次元・閾値が妥当（機械的観測で検証可能な次元を含む）
- [x] `motiva improve src/` で自律的に改善ループが回る

**Status**: complete（2026-03-16）

**検証方法**: Motiva自身に対して `motiva improve` を実行し、意味のある改善が得られることを確認

---

## Milestone 11: 戦略自律選択 + 実行品質

**テーマ**: タスク生成とCodex実行の質を上げる。M8 dogfoodingでCodexがコメント1行しか変更しなかった原因はタスク指示の粒度不足にある。

### 11.1: タスク生成のコンテキスト強化
- generateTask()時に、実際のファイル内容・grep結果をコンテキストに含める
- 「コメント1行変更」ではなく具体的な修正指示を生成
- StrategyManager連携: 過去の成功戦略パターンを参照

### 11.2: 実行スコープ制御
- Codex実行時の作業ディレクトリ・対象ファイル制限
- 変更差分の事前推定と承認
- 実行後のビルド・テスト自動確認

### 11.3: Drive-based Memory Management
- `src/memory-lifecycle.ts` — DriveScorer連携の配線完成
- 意味的検索によるWorking Memory選択

### 11.4: SatisficingJudge resource undershoot条件
- タスクコスト履歴の追加
- condition 3（resource undershoot）判定ロジック実装

**成功基準**:
- [x] タスク指示に具体的なファイルパスと修正内容が含まれる
- [x] Codex実行後にテストが通ることを自動確認
- [x] 前回のTODO/FIXME解消が1イテレーションで完了する

**Status**: complete（2026-03-16）

---

## Milestone 12: プラグインアーキテクチャ

**テーマ**: コアが安定したので拡張基盤を整える。「Goal-and-forget」ビジョンの実現。コアを薄く保ちながら、拡張機能をプラグインとして分離する。Slack/メール等の特定サービス依存はコアに含めず、プラグインとして提供する。

設計: `docs/design/plugin-architecture.md`

### 12.1: プラグインローダー + 能力記述スキーマ
- `src/plugin-loader.ts` 新規実装 — `~/.motiva/plugins/` からの動的読み込み
- Plugin Manifest（name, type, capabilities, dimensions, description）
- AdapterRegistry / DataSourceRegistry への自動登録
- 設計: `docs/design/plugin-architecture.md` §2

### 12.2: INotifier インターフェース
- `src/types/plugin.ts` に追加 — 通知プラグインの抽象インターフェースをコアに定義
  - `notify(event: NotificationEvent): Promise<void>`
  - `supports(eventType: NotificationEventType): boolean`
- NotificationDispatcher → INotifierプラグインへのルーティング
- サンプルプラグイン `plugins/slack-notify/` — Slack Webhook送信実装（コア外）
- 設計: `docs/design/plugin-architecture.md` §3

### 12.3: グレースフルシャットダウン + クラッシュリカバリ
- `src/daemon-runner.ts` 拡張 — SIGTERM/SIGINTハンドリング改善、再起動後の状態復元
- ログローテーション
- 設計: `docs/runtime.md` Phase 2b

### 12.4: イベントファイルウォッチャー
- `src/event-server.ts` 拡張 — `~/.motiva/events/` のリアルタイムファイル監視
- `motiva cron` コマンド（cronユーザー向けエントリ生成）

**成功基準**:
- [x] サンプルプラグイン（slack-notifier）がロード・動作する
- [x] プラグインのマニフェスト検証が機能する
- [x] グレースフルシャットダウン（SIGTERM/SIGINT）実装済み
- [x] プロセスkill後の状態復元・クラッシュリカバリ実装済み
- [x] イベントファイルウォッチャー（fs.watch）実装済み

**Status**: complete（2026-03-17）

---

## Milestone 13: プラグイン自律選択 + セマンティック知識共有

**テーマ**: CapabilityDetectorがプラグインメタデータを読み込み、ゴール要件に応じて自律的にプラグインを選択・活用する（プラグインアーキテクチャ Phase 2）。複数ゴール間での暗黙的知識共有を実用レベルにする。

### 13.1: CapabilityDetector拡張（プラグイン自動マッチング）
- `src/capability-detector.ts` 拡張 — プラグインメタデータ読み込みと能力インデックス構築
- ゴール要件との自動マッチング（LLMで「このゴールにこのプラグインが適切か？」を判断）
- `detectGoalCapabilityGap()` にプラグイン候補返却を追加
- 設計: `docs/design/plugin-architecture.md` §4

### 13.2: プラグイン信頼スコア学習
- `src/trust-manager.ts` 拡張 — プラグイン別信頼スコアの読み書き
- プラグイン使用結果（成功/失敗）をTrustManagerに記録
- `selectPlugin()` — 信頼スコアと能力マッチングを組み合わせたプラグイン選択
- 設計: `docs/design/plugin-architecture.md` §5

### 13.3: ゴール横断共有ナレッジベース
- `src/knowledge-manager.ts` 拡張 — ゴール別JSON → 共有ベクトルKBへ移行
- `searchKnowledge()` / `searchAcrossGoals()` の実装（Phase 2スタブ解消）
- VectorIndex活用による意味的検索

### 13.4: コンテキスト選択の動的バジェット化
- `src/session-manager.ts` 拡張 — 固定top-4 → バジェットベース動的選択
- GoalDependencyGraph活用（resource_conflict排他制御）

### 13.5: CuriosityEngine埋め込みベース検出
- `src/curiosity-engine.ts` 拡張 — dimension_name完全一致 → embedding_similarity
- VectorIndex活用

**成功基準**:
- [x] ゴールAの学びがゴールBの戦略選択に自動反映される
- [x] プラグインの自動選択が機能する
- [x] セマンティック検索で関連知識がtop-3に出現

**Status**: complete（2026-03-17）

---

## Milestone 14: 仮説検証メカニズム（PIVOT/REFINE + 学習ループ）

**テーマ**: AutoResearchClawの仮説検証パターンをMotivaに導入し、戦略停滞時の自律判断力を強化する。設計: `docs/design/hypothesis-verification.md`

### 14.1: 構造化PIVOT/REFINE判断（StallDetector + StrategyManager統合）
- StallDetectorに `analyzeStallCause()` 追加 — gap推移パターンから原因を推定
  - oscillating（振動）→ REFINE（パラメータ調整して再実行）
  - flat（横ばい）→ PIVOT（戦略変更、ゴールは維持）
  - diverging（悪化）→ ESCALATE（ゴール再交渉）
- StrategyManagerに各戦略のrollback target定義
- CoreLoopのstall分岐を3方向に拡張
- 最大pivot回数: 2
- 影響: stall-detector.ts, strategy-manager.ts, core-loop.ts, types/
- 規模: Medium（2-3日）

### 14.2: 判断履歴の学習ループ（KnowledgeManager拡張）
- DecisionRecordスキーマ — PIVOT/REFINE判断時のコンテキスト（gap値、戦略種別、stall回数、trust）を記録
- KnowledgeManagerにdecision記録・検索API追加
- StrategyManager.selectStrategy()で過去の判断履歴を参照（失敗戦略回避、成功戦略優先）
- 30日time-decay
- M13のセマンティック知識共有と統合
- 影響: knowledge-manager.ts, strategy-manager.ts, types/
- 規模: Medium-Large（3-5日）

**成功基準**:
- [ ] stall検出時にPIVOT/REFINE/ESCALATEが原因に応じて自動選択される
- [ ] 過去にPIVOTされた戦略が同種ゴールで自動的に低優先になる
- [ ] dogfooding: 2回以上のstallが発生するゴールで自律回復を確認

**Status**: planned

---

## 将来（M15以降）

- DatabaseDataSourceAdapter（PostgreSQL/MySQL/SQLite）
- WebSocket/SSEリアルタイムDataSource
- DimensionMapping意味的自動提案
- KnowledgeTransfer Phase 2（転移信頼スコア学習）
- マルチユーザー対応
- Web UI（TUIの代替/補完）
- プラグインマーケットプレイス / レジストリ（npmスコープ: `@motiva-plugins/`）
- コミュニティプラグイン（GitHub DataSource, Jira DataSource, PagerDuty Notifier等）
- プラグインバージョン管理 + 互換性チェック

---

## 設計原則（M1-M7で学んだこと + M8 dogfooding教訓）

1. **各Milestoneの最後にDogfooding検証を必ず行う** — 実ゴール実行で予期しない結合バグが必ず出る
2. **LLM応答はZodパース前にサニタイズ** — enum外の値が来る前提で設計
3. **catchブロックでエラーを握りつぶさない** — 必ずログ出力
4. **gpt-5.3-codexを推奨モデルとして使う** — 観測精度・収束速度が大幅に優れる
5. **サブステージ単位で一つずつ実装** — 大きなステージは分割する
6. **コアは薄く、拡張はプラグインで** — 特定サービス依存（Slack, メール, GitHub等）はプラグインに分離し、コアの依存を最小に保つ
7. **プラグインの判断基準**: (1) ループに必須 → コア、(2) 依存ゼロ → コア同梱可、(3) 特定サービス依存 → プラグイン
8. **MotivаはプラグインをMasterする** — Claude Codeではユーザーがツールを呼ぶが、Motivaは能力メタデータとマッチングにより自律的にプラグインを選択・活用する
9. **観測の正確性がすべての基盤** — LLM観測を盲信しない。機械的検証とのクロスチェック必須。M8 dogfoodingでLLMがtodo_count=0と報告したが実際には3件残存していた事実を忘れない
10. **自律能力はコア→拡張の順** — 正しく見る（M9）→ 自分で考える（M10）→ 自分で決める（M11）→ 拡張する（M12+）。コアループが機能不全のまま外形を広げても意味がない
