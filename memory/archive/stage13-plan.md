# Stage 13 実装計画: 能力自律調達と外部世界接続

**ステータス**: 計画策定済み、未着手
**前提**: Stage 1-12 完了（1919テスト、40テストファイル）
**詳細リサーチ**: `memory/stage13-research.md`

---

## パート構成（2パート、順次実装）

13.1（能力自律調達）と13.3（Registry動的管理）は同一ファイル群を共有するため統合。
13.2（外部データソース）は設計ドキュメントが未存在のため、設計を含めて後半で実施。

```
Part A: 13.1 + 13.3 能力自律調達 & Registry動的管理  ← 即着手可、CapabilityDetector拡張
Part B: 13.2 外部データソース連携                     ← Part A完了後、設計ドキュメント作成含む
```

---

## Part A: 能力自律調達 + Registry動的管理

**スコープ**: 能力不足→調達タスク委譲→検証→自動登録の全フロー実装
**サイズ**: Multi-file（4ファイル変更、テスト1-2ファイル）
**設計出典**: `docs/design/execution-boundary.md` §5.2〜5.5

### 背景

Stage 8のCapabilityDetectorは能力不足を「検知→人間エスカレーション」するだけだった。
Part Aでは検知後にエージェントへ調達タスクを委譲し、検証・登録まで自動化する。

### 実装内容

1. **`src/types/capability.ts`** — 型拡張
   - `CapabilityType` に `"data_source"` 追加
   - `CapabilityAcquisitionTask` 型（調達方法: tool_creation / permission_request / service_setup）
   - `AcquisitionContext` 型（調達経緯: どのゴール/タスクから発生したか）
   - `CapabilityDependency` 型（能力間の依存関係）
   - `CapabilityStatus` に `"acquiring"` | `"verification_failed"` 追加

2. **`src/capability-detector.ts`** — 調達ロジック追加
   - `planAcquisition(gap: CapabilityGap): CapabilityAcquisitionTask` — 調達方法の選択（ツール作成委譲 / 権限要求 / 外部連携提案）
   - `verifyAcquiredCapability(capability, task_result): VerificationResult` — 3段階検証（基本動作 / エラーハンドリング / スコープ境界）
   - `registerCapability(capability, context): void` — Registry登録 + KnowledgeManager保存
   - 検証3回失敗 → ユーザーエスカレーション
   - Registry動的管理: ホットプラグ登録・削除、能力依存関係管理、再利用可能な形でのコンテキスト記録

3. **`src/task-lifecycle.ts`** — 調達タスクハンドリング
   - `task_category: "capability_acquisition"` の識別と専用フロー
   - 調達タスクの生成（CapabilityDetector→TaskLifecycle連携）
   - 検証結果に応じた後続アクション（登録 / リトライ / エスカレーション）

4. **`src/index.ts`** — 新規エクスポート追加

### テスト

- `tests/capability-detector.test.ts` — 既存テストに追加
  - 調達方法選択（ツール作成 / 権限要求 / 外部連携の各ケース）
  - 3段階検証（成功 / 部分失敗 / 全失敗→エスカレーション）
  - Registry登録・削除・依存関係管理
  - ホットプラグ（実行時追加・削除）
  - 調達コンテキストの記録と再利用検索
- `tests/task-lifecycle.test.ts` — 既存テストに追加
  - capability_acquisition カテゴリのタスク実行フロー

### 安全性の注意点

- **EthicsGate.checkMeans()**: 調達されたツールは必ず手段チェックを通す
- **不可逆アクション**: 外部サービス設定等はユーザー承認必須（execution-boundary §7準拠）
- 検証不合格の能力は `verification_failed` ステータスで登録し、自動使用しない

### 完了条件

- [ ] 能力不足検知→調達タスク生成→実行→検証→登録の一連フローが動作
- [ ] 検証3回失敗でエスカレーション
- [ ] Registry動的管理（登録・削除・依存関係・コンテキスト記録）
- [ ] EthicsGate統合（調達ツールの手段チェック）
- [ ] 全テスト通過

---

## Part B: 外部データソース連携

**スコープ**: データソースアダプタの抽象化、ObservationEngineの拡張、CLIサブコマンド追加
**サイズ**: Multi-file（新規2ファイル + 変更3ファイル、テスト2ファイル）
**設計出典**: `docs/vision.md` §5.7（詳細設計なし → 実装前に設計ドキュメント作成）
**前提**: Part A完了（Registry管理が整っていること）

### 背景

現在のObservationEngineはLLM経由（またはシェルコマンド）でしか外部世界を観測できない。
Part Bでは直接データソースから構造化データを取得する `IDataSourceAdapter` パターンを導入し、
DB/API/ファイル等からの観測を可能にする。

### Step 1: 設計ドキュメント作成

**`docs/design/data-source.md`（新規）** — 実装前に以下を定義:
- IDataSourceAdapter インターフェース仕様
- データソース種別（file / http_api / database / custom）
- 認証・権限管理モデル
- ポーリング設計（間隔、変化検知、閾値アラート）
- ObservationEngine統合方法（Layer 1拡張）
- MVP範囲（file + http_api のみ。DB/IoTは将来Phase）

### Step 2: 型定義 + インターフェース

1. **`src/types/data-source.ts`（新規）**
   - `DataSourceType`: `"file" | "http_api" | "database" | "custom"`
   - `DataSourceConfig`: 接続情報、認証、ポーリング設定
   - `DataSourceResult`: 取得値、タイムスタンプ、メタデータ
   - `PollingConfig`: 間隔、変化検知閾値

2. **`src/data-source-adapter.ts`（新規）**
   - `IDataSourceAdapter` インターフェース（connect / query / disconnect / healthCheck）
   - `FileDataSourceAdapter` — ファイル監視（JSON/CSV/テキスト）
   - `HttpApiDataSourceAdapter` — HTTP GET/POST、レスポンスパース
   - `DataSourceRegistry` — データソースの登録・管理（AdapterRegistryパターン流用）

### Step 3: ObservationEngine統合 + CLI

3. **`src/observation-engine.ts`** — Layer 1 拡張
   - DI: `IDataSourceAdapter[]` の注入対応
   - `observeFromDataSource(source, query): ObservationResult` メソッド追加
   - 既存のシェルコマンド実行と並列で、データソースからの直接観測をサポート

4. **`src/cli-runner.ts`** — サブコマンド追加
   - `motiva datasource add <type> <config>` — データソース登録
   - `motiva datasource list` — 登録済みデータソース一覧
   - `motiva datasource remove <id>` — データソース削除

5. **`src/index.ts`** — エクスポート追加

### テスト

- `tests/data-source-adapter.test.ts`（新規）
  - IDataSourceAdapter契約テスト
  - FileDataSourceAdapter（ファイル読み取り、変化検知）
  - HttpApiDataSourceAdapter（モックHTTP、エラーハンドリング）
  - DataSourceRegistry（登録・削除・検索）
- `tests/observation-engine.test.ts` — 既存テストに追加
  - データソース経由の観測フロー
  - データソース障害時のフォールバック

### 安全性の注意点

- **認証情報**: APIキー・DB接続文字列は `~/.motiva/secrets/` に保存、コード内にハードコードしない
- **書き込み操作禁止**: MVPではデータソースは読み取り専用。書き込みは将来Phaseで人間承認付きで実装
- **ポーリング制限**: DoS防止のため最小間隔を設定（デフォルト: 30秒）

### 完了条件

- [ ] `docs/design/data-source.md` 設計ドキュメント完成
- [ ] IDataSourceAdapter + File/HTTP実装
- [ ] ObservationEngine Layer 1 拡張（データソース直接観測）
- [ ] CLIサブコマンド（datasource add/list/remove）
- [ ] 全テスト通過

---

## 全体見積もり

| パート | 新規ファイル | 変更ファイル | テスト | 主要モジュール |
|--------|------------|------------|--------|--------------|
| Part A | 0 | 4 | 2テストファイルに追記 | CapabilityDetector, TaskLifecycle |
| Part B | 3（設計doc含む） | 3 | 2テストファイル新規 | DataSourceAdapter, ObservationEngine |
| **合計** | **3** | **7（重複除く6）** | **4** | — |

---

## リスクと対応方針

| リスク | 対応 |
|--------|------|
| 調達ツールの安全性 | EthicsGate.checkMeans()必須、検証3回失敗→エスカレーション |
| 13.2の設計ドキュメント未存在 | Part B Step 1で先に作成。設計承認後に実装着手 |
| 外部データソースの多様性 | MVP = file + http_api のみ。DB/IoTは将来Phase |
| ObservationEngine改修の影響範囲 | Layer 1の拡張に限定し、Layer 2/3は変更しない |

---

## 実装順序まとめ

```
1. Part A: 能力自律調達 + Registry動的管理
   ↓ (Part A完了後)
2. Part B Step 1: 設計ドキュメント作成
   ↓ (設計確定後)
3. Part B Step 2-3: 実装 + テスト
```
