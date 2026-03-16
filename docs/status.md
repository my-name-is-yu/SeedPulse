# Implementation Status

Implementation Phase — Stage 1-14 complete (2844 tests, 65 files).

## Stage 1 (complete)
- Type definitions: 14 Zod schema files in `src/types/`
- `src/state-manager.ts` — file-based JSON persistence (~/.motiva/, atomic writes)
- `src/gap-calculator.ts` — 5-threshold-type pipeline (raw→normalized→weighted)

## Stage 2 (complete)
- Layer 1: `src/drive-system.ts` (event queue, scheduling, activation checks), `src/trust-manager.ts` (trust balance, 4-quadrant action matrix, permanent gates)
- Layer 2: `src/observation-engine.ts` (3-layer observation, progress ceiling, contradiction resolution), `src/drive-scorer.ts` (3 drive scores: dissatisfaction/deadline/opportunity), `src/satisficing-judge.ts` (completion judgment, dimension satisfaction, threshold adjustment), `src/stall-detector.ts` (4 stall types, cause classification, escalation, decay factor)

## Stage 3 (complete)
- Layer 3: `src/llm-client.ts`, `src/ethics-gate.ts`, `src/session-manager.ts`, `src/strategy-manager.ts`, `src/goal-negotiator.ts`

## Stage 4 (complete)
- Layer 0+4: `src/adapter-layer.ts`, `src/adapters/claude-code-cli.ts`, `src/adapters/claude-api.ts`, `src/task-lifecycle.ts`

## Stage 5 (complete)
- Layer 5: `src/reporting-engine.ts` (3 report types, Markdown output, CLI display, 5 notification types), `src/core-loop.ts` (observe→gap→score→completion→stall→task→report loop)

## Stage 6 (complete)
- Layer 6: `src/cli-runner.ts` (5 subcommands: run, goal add, goal list, status, report), `src/index.ts` (full module exports)
- 983 tests passing across 18 test files

## Stage 7 (complete)
- TUI UX: sidebar layout (Dashboard left/Chat right), ReportView component, useLoop hook化, message 200-cap
- Task verification: `verifyTask()` dimension_updates now applied to goal state
- npm publish prep: package.json fields, LICENSE (MIT), .npmignore

## Stage 8 (complete)
- `src/knowledge-manager.ts` — knowledge gap detection (interpretation_difficulty, strategy_deadlock), acquisition task generation, knowledge CRUD, contradiction detection
- `src/capability-detector.ts` — capability deficiency detection, registry management, user escalation
- `src/types/knowledge.ts`, `src/types/capability.ts` — 2 new Zod schema files (total: 16)
- Integration: ObservationEngine + StrategyManager emit knowledge gap signals, SessionManager injects knowledge context, TaskLifecycle wires EthicsGate.checkMeans() + CapabilityDetector
- 1191 tests passing across 23 test files

## Stage 9 (complete)
- `src/portfolio-manager.ts` — portfolio-level orchestration: deterministic task selection (wait-time/allocation ratio), effectiveness measurement (dimension-target matching), auto-rebalancing (score-ratio threshold), termination conditions (3 criteria)
- `src/types/portfolio.ts` — EffectivenessRecord, RebalanceResult, TaskSelectionResult, PortfolioConfig, AllocationAdjustment (total: 17 Zod schema files)
- StrategyManager extensions: activateMultiple, terminateStrategy, createWaitStrategy, suspendStrategy, resumeStrategy, getAllActiveStrategies, updateAllocation
- WaitStrategy support: intentional inaction with measurement plan, expiry handling, fallback activation
- Integration: CoreLoop + TaskLifecycle wire PortfolioManager (backward compatible, optional dependency)
- 1266 tests passing across 24 test files

## Stage 10 (complete)
- 10.1 Daemon Mode: `src/daemon-runner.ts` (CoreLoop wrapper, PID management, crash recovery, graceful shutdown), `src/pid-manager.ts` (atomic PID file, process detection), `src/logger.ts` (rotating file logger)
- 10.2 Event-Driven System: `src/event-server.ts` (localhost HTTP endpoint on 127.0.0.1:41700), `src/drive-system.ts` extensions (writeEvent, file watcher, in-memory queue)
- 10.3 Push Reporting: `src/notification-dispatcher.ts` (Slack webhook, Email stub, generic Webhook, DND, cooldown), `src/reporting-engine.ts` extensions (optional push dispatch)
- 10.4 CI/CD: `.github/workflows/ci.yml` (Node 18/20/22 matrix, npm publish on tag)
- 10.5 Memory Lifecycle MVP: `src/memory-lifecycle.ts` (3-tier memory model, Short→Long LLM compression, tag-based Working Memory selection, retention policy, goal close archival, garbage collection)
- `src/types/daemon.ts`, `src/types/notification.ts`, `src/types/memory-lifecycle.ts` — 3 new Zod schema files (total: 20)
- CLI: 3 new subcommands (start, stop, cron) added to `src/cli-runner.ts`
- 1439 tests passing across 30 test files

## Stage 11 (complete)

### Phase 11A: 倫理ゲート Layer 1 + タスク手段チェック
- `src/ethics-gate.ts` extensions — Layer 1 category-based blocklist (6 categories: 違法行為、加害、プライバシー侵害、欺瞞、セキュリティ侵害、差別自動化); fast pre-filter before Layer 2 LLM judgment
- `src/types/ethics.ts` — ethics_constraints schema for user-customizable additional restrictions
- `src/task-lifecycle.ts` integration — `checkMeans()` wired into task approval flow

### Phase 11B: キャラクターカスタマイズ + 満足化 Phase 2
- `src/types/character.ts` — CharacterConfig schema (4-axis: caution_level, stall_flexibility, communication_directness, proactivity_level)
- `src/character-config.ts` — CharacterConfigManager: load/save/validate character profiles
- `src/goal-negotiator.ts`, `src/stall-detector.ts`, `src/reporting-engine.ts` — character parameter reflection
- `tests/character-separation.test.ts` — separation guarantee: character changes do not affect structural constraints
- `src/satisficing-judge.ts` extensions — full aggregation mapping coverage (min/avg/max/all_required)
- `src/types/goal.ts` extensions — aggregation_mode field additions

### Phase 11C: 好奇心メカニズム MVP
- `src/types/curiosity.ts` — CuriosityConfig, CuriosityGoal, LearningFeedback Zod schemas
- `src/curiosity-engine.ts` — 5 trigger conditions (task queue empty, unexpected observation, repeated failure, undefined problem, periodic exploration); LLM-based curiosity goal generation with approval flow; 4 learning feedback patterns (high-impact priority, failure reframing, cross-goal transfer, blind-spot detection); resource budget constraints (20%/50%/100%)
- `src/core-loop.ts` extensions — optional CuriosityEngine integration
- `src/cli-runner.ts`, `src/index.ts` — CuriosityEngine exports and CLI wiring
- New test files: `tests/curiosity-engine.test.ts`, `tests/character-config.test.ts`, `tests/character-separation.test.ts`
- Updates to: `tests/core-loop.test.ts`, `tests/ethics-gate.test.ts`, `tests/event-server.test.ts`, `tests/goal-negotiator.test.ts`, `tests/reporting-engine.test.ts`, `tests/satisficing-judge.test.ts`, `tests/stall-detector.test.ts`, `tests/task-lifecycle.test.ts`
- 1749 tests passing across 35 test files

## Stage 12 (complete)

**Status**: 完了（1919テスト、40テストファイル）

### 12.1 埋め込み基盤 (Part C)
- `src/types/embedding.ts` — EmbeddingConfig, EmbeddingEntry, VectorSearchResult Zodスキーマ
- `src/embedding-client.ts` — IEmbeddingClient インターフェース、MockEmbeddingClient（テスト用）、OllamaEmbeddingClient、OpenAIEmbeddingClient、cosineSimilarity
- `src/vector-index.ts` — VectorIndex（インメモリMap + JSONファイル永続化、atomic write、cosine similarity検索）

### 12.2 知識獲得 Phase 2 (Part D)
- `src/knowledge-graph.ts` — KnowledgeGraph（概念ノード・関係エッジCRUD、循環検出、JSON永続化）
- `src/types/knowledge.ts` — embedding_id フィールド追加、KnowledgeEdge/KnowledgeRelationType 型追加
- `src/knowledge-manager.ts` — VectorIndex DI追加、searchKnowledge()/searchAcrossGoals() ベクトル検索メソッド

### 12.3 好奇心 Phase 2 (Part E)
- `src/curiosity-engine.ts` — VectorIndex DI追加、detectSemanticTransfer()、checkUndefinedProblems() 埋め込みベース強化
- `src/types/curiosity.ts` — detection_method に "embedding_similarity" 追加

### 12.4 満足化マッピング (Part D/F)
- `src/types/satisficing.ts` — MappingProposal 型追加
- `src/satisficing-judge.ts` — proposeDimensionMapping()（埋め込み類似度による自動マッピング提案）、onSatisficingJudgment コールバック

### 12.5 状態ベクトル Phase 2 (Part A)
- `src/types/state.ts` — RescheduleOptions 型追加
- `src/state-manager.ts` — getMilestones(), evaluatePace(), generateRescheduleOptions(), getOverdueMilestones(), savePaceSnapshot()
- `src/core-loop.ts` — マイルストーン期限チェック、LoopIterationResult に milestoneAlerts 追加

### 12.6 セッション・コンテキスト Phase 2 (Part B/F)
- `src/types/dependency.ts` — DependencyEdge, DependencyGraph, DependencyType Zodスキーマ
- `src/goal-dependency-graph.ts` — GoalDependencyGraph（DAG管理、循環検出、LLM自動検出、スケジューリング影響計算）
- `src/types/session.ts` — コンテキストバジェット設定型追加
- `src/session-manager.ts` — 動的バジェット選択、injectSemanticKnowledgeContext()
- `src/goal-negotiator.ts` — SatisficingJudge DI追加、decompose() 内で自動マッピング提案活用

### 12.7 記憶ライフサイクル Phase 2 (Part E)
- `src/types/memory-lifecycle.ts` — RelevanceScore, CompressionPolicy 型追加、embedding_id フィールド
- `src/memory-lifecycle.ts` — Drive-based管理（getCompressionDelay, getDeadlineBonus, markForEarlyCompression）、selectForWorkingMemorySemantic()

## Stage 13 (complete)

**Status**: 完了（2 new test files: `tests/capability-detector.test.ts`, `tests/data-source-adapter.test.ts`）

### 13A: CapabilityDetector 拡張（自律能力調達）
- `src/capability-detector.ts` extensions — 能動的欠如検知・自律調達フロー
  - `detectDeficiency(task)` — タスク実行に必要な能力欠如をLLMで検出し `CapabilityGap` を返す
  - `planAcquisition(gap)` — 欠如ギャップから `CapabilityAcquisitionTask`（取得方法・成功基準）を生成
  - `verifyAcquiredCapability(task)` — 取得後の能力をLLM+実行で検証（pass/fail/escalate）
  - `registerCapability(cap, context?)` — 能力をレジストリに登録、取得コンテキスト付与
  - `getAcquisitionHistory(goalId)` — ゴール単位の取得履歴を返す
  - `removeCapability(id)`, `findCapabilityByName(name)`, `setCapabilityStatus(id, status)` — CRUD補完メソッド
  - `escalateToUser(gap, goalId)` — 自動取得不可時にユーザーへエスカレーション通知
- `src/types/capability.ts` 拡張 — `CapabilityAcquisitionTask`（取得タスク + 検証試行カウンタ）、`CapabilityDependency`（依存グラフ）、`CapabilityVerificationResult`（pass/fail/escalate）、`AcquisitionMethod`（tool_creation/permission_request/service_setup）型追加

### 13B: DataSourceAdapter（外部世界接続）
- `src/data-source-adapter.ts` — 外部データソース接続基盤
  - `IDataSourceAdapter` interface — `connect()`, `query(params)`, `disconnect()`, `healthCheck()` 4メソッド規約
  - `FileDataSourceAdapter` — JSONファイル読み込み、dimension_mappingによるフィールド抽出
  - `HttpApiDataSourceAdapter` — GET/POSTリクエスト、Bearer/API Key/Basic認証、タイムアウト、レスポンスパス抽出
  - `DataSourceRegistry` — 複数ソース管理、型別ファクトリ生成（file/http_api/database/custom）
- `src/types/data-source.ts` — `DataSourceConfig`（4種: file/http_api/database/custom、認証・ポーリング設定）、`DataSourceQuery`（次元名・式・タイムアウト）、`DataSourceResult`（値・生データ・タイムスタンプ）、`DataSourceRegistry` Zodスキーマ

### 13C: CLI サブコマンド（datasource）
- `src/cli-runner.ts` 拡張 — 3サブコマンド追加
  - `motiva datasource add <type>` — ファイル（`--path`）またはHTTP API（`--url`）データソース登録、`~/.motiva/datasources/<id>.json` に永続化
  - `motiva datasource list` — 登録済みデータソース一覧表示
  - `motiva datasource remove <id>` — データソース設定削除

### 設計ドキュメント
- `docs/design/data-source.md` — DataSourceAdapter設計（接続モデル、ポーリング、認証、次元マッピング）

## Stage 14 (complete)

**Status**: 完了（2663テスト、53テストファイル、+744テスト、+13テストファイル）

## Dogfooding Phase A/B (complete)

### Phase A: GitHub Issueアダプタ実装

- `src/adapters/github-issue.ts` — GitHubIssueAdapter（IAdapter実装、`gh` CLI経由でissue作成）
- `src/adapters/github-issue-datasource.ts` — GitHubIssueDataSourceAdapter（IDataSourceAdapter実装、issue状態観測）
- プロンプト解析: ` ```github-issue JSON``` ` ブロック or フォールバック（1行目=タイトル）
- 観測次元: open_issue_count, closed_issue_count, completion_ratio, total_issue_count
- 設定: `MOTIVA_GITHUB_REPO` 環境変数 or コンフィグ、デフォルトラベル `motiva`

成功基準:
- [x] `motiva run --adapter github_issue` でissueが作成される
- [x] 作成されたissueが具体的で実行可能
- [x] 次のループでissue状態を観測できる

### Phase B: 小さいゴールでdogfood開始

ゴール「MotivaのREADMEとGetting Startedガイドを整備する」を1イテレーションで達成。

- アダプタ: OpenAI Codex CLI adapter（`src/adapters/openai-codex.ts`）を使用
- データソース: FileExistenceDataSourceAdapter（`src/adapters/file-existence-datasource.ts`）でファイル存在を観測
- 成果物: `README.md`, `docs/getting-started.md`
- データソース設定修正: 当初 `GETTING_STARTED.md` → `docs/getting-started.md` に変更（実際のファイルパスに合わせる）

成功基準:
- [x] Motivaが3つ以上の有用なissueを自動起票
- [x] issueを解決したらMotivaが進捗を正しく認識
- [x] ループが自然に収束（ゴール達成 or satisficing判定）

### 技術メモ

- `gh` CLI を使用（GitHub API直接呼び出しより簡単、認証も`gh auth`で管理済み）
- issue本文にMotiva metadata（goal_id, task_id, dimension）を埋め込む（観測時の紐付け用）
- ラベル `motiva` でフィルタリング、追加ラベルで分類（`docs`, `test`, `bug`等）

## Post-Stage-14 追加実装 (complete)

**Status**: 完了（2809テスト、61テストファイル）

### OpenAI/Codex対応
- `src/openai-client.ts` — OpenAILLMClient（ILLMClient実装、openai SDK、gpt-4oデフォルト）
- `src/adapters/openai-codex.ts` — OpenAICodexCLIAdapter（IAdapter実装、`codex exec --full-auto`）
- `src/provider-factory.ts` — 共有ファクトリ（buildLLMClient + buildAdapterRegistry）
- 環境変数: `MOTIVA_LLM_PROVIDER=openai|ollama|anthropic`、`OPENAI_API_KEY`、`OPENAI_MODEL`
- デフォルトプロバイダーをOpenAIに変更

### GitHub Issueアダプタ（dogfooding用）
- `src/adapters/github-issue.ts` — GitHubIssueAdapter（IAdapter実装、`gh` CLI経由でissue作成）
- `src/adapters/github-issue-datasource.ts` — GitHubIssueDataSourceAdapter（IDataSourceAdapter実装、issue状態観測）
- プロンプト解析: ` ```github-issue JSON``` ` ブロック or フォールバック（1行目=タイトル）
- 観測次元: open_issue_count, closed_issue_count, completion_ratio, total_issue_count
- 設定: `MOTIVA_GITHUB_REPO` 環境変数 or コンフィグ、デフォルトラベル `motiva`

### FileExistenceDataSourceAdapter
- `src/adapters/file-existence-datasource.ts` — ファイル存在チェックによる進捗観測
- ObservationEngine経由でのパススルー式サポート

### CapabilityDetector: ゴール能力ギャップ検出
- `src/capability-detector.ts` 拡張 — `detectGoalCapabilityGap(goal)` メソッド追加
- ゴール実行に必要な能力の欠如をゴール単位で事前検出

### Auto-archive
- `src/state-manager.ts` 拡張 — `archiveGoal(goalId)` メソッド追加
- `src/core-loop.ts` 統合 — satisficing完了時に自動アーカイブ

Goal横断ポートフォリオと学習 — 再帰的ゴールツリー、ノード独立ループ、クロスゴールポートフォリオ、学習パイプライン Phase 2、ゴール間知識転移。

### 14A: 型定義・設計ドキュメント基盤
- `src/types/goal-tree.ts` — GoalTree, GoalTreeNode, TreeNodeStatus Zodスキーマ
- `src/types/cross-portfolio.ts` — CrossGoalPortfolio, PortfolioPriority, ResourceAllocation Zodスキーマ
- `src/types/learning.ts` — LearningLog, LearningFeedback, CrossGoalPattern Zodスキーマ
- `src/types/goal.ts` 拡張 — decomposition_depth, specificity_score, loop_status, "leaf" ノード型追加
- `src/types/strategy.ts` 拡張 — source_template_id, cross_goal_context フィールド追加
- 設計ドキュメント: `docs/design/goal-tree.md`, `docs/design/learning-pipeline.md`, `docs/design/knowledge-transfer.md`, `docs/design/portfolio-management.md` Phase 3

### 14B: 再帰的Goal Tree（分解・集約・剪定）
- `src/goal-tree-manager.ts` (~400行) — GoalTreeManager: N層分解、バリデーション、剪定、再構成
- `src/state-aggregator.ts` (~200行) — StateAggregator: 子ノード状態集約、伝播、完了カスケード
- 変更: goal-negotiator.ts, satisficing-judge.ts, state-manager.ts, core-loop.ts

### 14C: 各ノードの独立ループ実行
- `src/tree-loop-orchestrator.ts` (~300行) — TreeLoopOrchestrator: ノード選択、並列ループ制御、完了コールバック
- 変更: core-loop.ts（ツリーモード追加）、cli-runner.ts（--treeオプション追加）、reporting-engine.ts（ツリーレポート追加）

### 14D: ゴール横断ポートフォリオ
- `src/cross-goal-portfolio.ts` (~450行) — CrossGoalPortfolio: 優先度計算、リソース配分、リバランス、テンプレート推薦
- `src/strategy-template-registry.ts` (~200行) — StrategyTemplateRegistry: テンプレート登録・検索・適用
- 変更: goal-dependency-graph.ts, portfolio-manager.ts, core-loop.ts

### 14E: 学習パイプライン Phase 2
- `src/learning-pipeline.ts` (~400行) — LearningPipeline: ログ分析、フィードバック生成、クロスゴール共有
- 4種トリガー実装済み: milestone到達時・停滞検知時・定期レビュー・goal_completed時
- クロスゴールパターン共有: VectorIndexを利用した意味的類似度マッチング
- 変更: core-loop.ts, session-manager.ts, stall-detector.ts

### 14F: ゴール間の知識・戦略転移
- `src/knowledge-transfer.ts` (~310行) — KnowledgeTransfer: 転移検出、適用、効果評価、メタパターン抽出
- 変更: core-loop.ts, curiosity-engine.ts, index.ts

## Milestone 1: 観測強化（LLM-powered観測）

**Status**: 完了 ✅

- C-1: ObservationEngineにLLM observation実装 — DataSource→LLM→self_report 3段フォールバック
- C-2: 観測プロンプト改善 + 次元名不一致警告
- C-3: 12テスト追加（observation-engine-llm.test.ts）
- Dogfooding検証: writing_quality + example_coverage の2次元でindependent_review観測動作確認（2ループ完走）

テスト: 2831テスト通過（62テストファイル）

## Milestone 2: 中規模Dogfooding検証

**Status**: 完了 ✅

- D-1: README品質ゴール — LLM観測による3次元評価（readme_quality, installation_guide_present, usage_example_present）、2ループ収束検証
- D-2: E2Eループテスト自動化 — FileExistence + LLM観測併用、1ループ完走検証
- D-3: npm publish準備 — dedup・satisficing判定の正常動作検証

テスト: 2844テスト通過（65テストファイル）

新規テストファイル:
- `tests/e2e/milestone2-d1-readme.test.ts`
- `tests/e2e/milestone2-d2-e2e-loop.test.ts`
- `tests/e2e/milestone2-d3-npm-publish.test.ts`

## Milestone 3: npm publish & パッケージ化

**Status**: 完了 ✅

## Milestone 4: 永続ランタイム Phase 2

**Status**: 完了 ✅

- 4.1: グレースフルシャットダウン、状態復元、ログローテーション
- 4.2: DaemonRunner↔EventServer統合、AbortController中断可能sleep
- 4.3: Slack Webhook、メールSMTP、DND、ゴール別設定
- 4.4: 記憶ライフサイクルMVP（Stage 10で実装済み）

テスト: 2949テスト通過（74テストファイル）

## Milestone 5: 意味的埋め込み Phase 2

**Status**: 完了 ✅

### 5.1: 知識獲得 Phase 2
- 共有ナレッジベース: `SharedKnowledgeEntrySchema`, `saveToSharedKnowledgeBase()`, `querySharedKnowledge()`
- ベクトル検索: `searchByEmbedding()` — VectorIndex連携、自動埋め込み登録
- ドメイン安定性自動再検証: `classifyDomainStability()`, `getStaleEntries()`, `generateRevalidationTasks()`
- 型拡張: `DomainStabilitySchema`, `SharedKnowledgeEntrySchema`, `RevalidationScheduleSchema`

### 5.2: 記憶ライフサイクル Phase 2
- Drive-based Memory Management: `relevanceScore()`, `compressionDelay()`, `onSatisficingJudgment()`
- DriveScorer連携: 不満スコアに応じた保持期間延長、satisficed次元の早期圧縮
- 意味的WM選択: `selectForWorkingMemory` VectorIndexフォールバック
- ゴール横断教訓検索: `searchCrossGoalLessons()`, `queryCrossGoalLessons()`
- `applyRetentionPolicy` Drive-based遅延対応

### 5.3: セッション・コンテキスト Phase 2
- 動的バジェット: `estimateTokens()`, `compressSlot()`, priority-based動的選択
- `buildContextForType` トークンバジェット対応
- 依存グラフ活用: `checkResourceConflicts()`, `buildContextWithConflictAwareness()`

テスト: 3036テスト通過（77テストファイル）

新規テストファイル:
- `tests/knowledge-manager-phase2.test.ts` (28テスト)
- `tests/memory-lifecycle-phase2.test.ts` (28テスト)
- `tests/session-manager-phase2.test.ts` (31テスト)

## Milestone 6: 能力自律調達 Phase 2

**Status**: 完了 ✅

### M6.1a: CoreLoop capability_acquiring ハンドラ
- `capability_acquiring` 状態のフルサイクル処理: 検出→エージェント委譲→検証→登録
- CoreLoop統合: ループイテレーション内でCapabilityDetectorの調達タスクを自動起動

### M6.1b: CLI capability list/remove + data_source_setup タイプ
- `motiva capability list` — 登録済み能力一覧表示
- `motiva capability remove <id>` — 能力登録削除
- `data_source_setup` タスクタイプ追加（データソース設定をエージェントに委譲）

### M6.2a: DataSourceRegistry.upsert() + ObservationEngine 動的追加/削除
- `DataSourceRegistry.upsert(config)` メソッド追加 — 実行中のホットプラグを実現
- ObservationEngineへのデータソース動的追加/削除API

### M6.2b: 能力依存解決（トポロジカルソート・循環検出）
- `CapabilityDetector.resolveAcquisitionOrder(gaps)` — 依存グラフからトポロジカルソートで調達順序を決定
- 循環依存を検出してエラーとして通知

テスト: 3105テスト通過（83テストファイル、+43テスト、+6テストファイル）

## Milestone 7: 再帰的Goal Tree & 横断ポートフォリオ Phase 2

**Status**: 完了 ✅

### M7.1a: Concreteness Scoring & Auto-Stop
- `GoalTreeManager.scoreConcreteness()` — LLMベース4次元評価（具体性スコアリング）
- `decompose()` auto-stop — `concreteness >= threshold` で自動停止
- maxDepth強制（デフォルト: 5）
- 21テスト追加（`tests/goal-tree-concreteness.test.ts`）

### M7.1b: Quality Metrics & Pruning Stabilization
- `evaluateDecompositionQuality()` — coverage, overlap, actionability, depthEfficiency評価
- `pruneSubgoal()` — 理由トラッキング付き剪定 + `getPruneHistory()`
- `restructure()` — 品質評価付き再構成 + 自動リバート
- 23テスト追加（`tests/goal-tree-quality.test.ts`）

### M7.2a: Momentum Allocation & Dependency Scheduling
- `CrossGoalPortfolio.calculateMomentum()` — velocity、トレンド検出
- `buildDependencySchedule()` — トポロジカルソート、クリティカルパス
- `allocateResources()` — momentum & dependency_aware戦略
- `rebalanceOnStall()` — スタル検出とリソース再分配
- 17テスト追加（`tests/cross-goal-portfolio-phase2.test.ts`）

### M7.2b: Embedding-Based Template Recommendation
- `StrategyTemplateRegistry.indexTemplates()` — 全テンプレートをVectorIndexに埋め込み登録
- `recommendByEmbedding()` — 類似度ベース推薦
- `recommendHybrid()` — タグ + 埋め込みスコア統合推薦
- 11テスト追加（`tests/strategy-template-embedding.test.ts`）

### M7.3a: 4-Step Structural Feedback
- `LearningPipeline.recordStructuralFeedback()` — 全4タイプ対応（observation_accuracy, strategy_selection, scope_sizing, task_generation）
- `aggregateFeedback()` — 平均値・トレンド・最悪領域算出
- `autoTuneParameters()` — フィードバック駆動パラメータ提案
- 16テスト追加（`tests/learning-pipeline-phase2.test.ts`）

### M7.3b: Cross-Goal Pattern Sharing
- `LearningPipeline.extractCrossGoalPatterns()` — 複数ゴールにわたるパターン抽出
- `sharePatternsAcrossGoals()` — パターンを新規ゴールに適用
- `KnowledgeTransfer.storePattern()` / `retrievePatterns()` — パターンの永続化と検索
- 13テスト追加（`tests/learning-cross-goal.test.ts`）

テスト: 3268テスト通過（89テストファイル、+163テスト、+6テストファイル）
