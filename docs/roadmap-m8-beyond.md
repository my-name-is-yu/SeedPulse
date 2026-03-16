# ロードマップ: Milestone 8 以降

## 現在地

Stage 1-14 + Milestone 1-7 完了（3282テスト、90ファイル）。
Goal Tree自動分解・LLM観測・Dogfooding検証基盤が整った。
次は「外向きの成熟」と「永続自律運用」の2軸で進める。

---

## ロードマップ概要

| Milestone | テーマ | 規模 | 検証方法 |
|-----------|--------|------|----------|
| **8** | 安全性強化 + npm公開 | Medium | npm publishを実行、EthicsGate Layer 1でブロック確認 |
| **9** | 永続ランタイム完成 + プッシュ通知 | Large | 24時間デーモン自律動作 + Slack通知 |
| **10** | セマンティック知識共有 | Medium | 複数ゴール横断の知識転移を検証 |
| **11** | LLM観測精度 + コンテキスト最適化 | Medium | Dogfooding観測精度の定量改善 |

---

## Milestone 8: 安全性強化 + npm公開

**テーマ**: EthicsGate Layer 1を実装し、安全に外部公開できる状態にする。

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
- .npmignore確認
- GitHub Actions: npm publish自動化（タグトリガー）
- `npm publish` 実行

**成功基準**:
- [ ] EthicsGate Layer 1がdestructive_actionカテゴリをブロック
- [ ] TaskLifecycleがgenerateTask()後に手段チェックを実行
- [ ] npm publishが成功し、`npm install motiva` で動作確認

---

## Milestone 9: 永続ランタイム完成 + プッシュ通知

**テーマ**: 「Goal-and-forget」ビジョンの実現。ユーザーが何もしなくてもMotiva側から報告する。

### 9.1: グレースフルシャットダウン + クラッシュリカバリ
- `src/daemon-runner.ts` 拡張 — SIGTERM/SIGINTハンドリング改善、再起動後の状態復元
- ログローテーション
- 設計: `docs/runtime.md` Phase 2b

### 9.2: プッシュ通知（Slack + メール）
- `src/notification-dispatcher.ts` 拡張 — Slack Webhook送信、nodemailer SMTP（依存追加済み）
- Do Not Disturb（時間帯指定、通知頻度制限）
- Slackインタラクティブ承認（ボタン経由でタスク承認）
- 設計: `docs/design/reporting.md` Phase 2

### 9.3: イベントファイルウォッチャー
- `src/event-server.ts` 拡張 — `~/.motiva/events/` のリアルタイムファイル監視
- `motiva cron` コマンド（cronユーザー向けエントリ生成）

### 9.4: 次元キー `_2` サフィックス問題修正
- ObservationEngineの重複キー正規化ロジック追加

**成功基準**:
- [ ] `motiva start --goal <id>` で24時間自律動作
- [ ] ゴール進捗がSlack通知される
- [ ] プロセスkill後に `motiva start` で状態復元して再開

---

## Milestone 10: セマンティック知識共有

**テーマ**: 複数ゴール間での暗黙的知識共有を実用レベルにする。

### 10.1: ゴール横断共有ナレッジベース
- `src/knowledge-manager.ts` 拡張 — ゴール別JSON → 共有ベクトルKBへ移行
- `searchKnowledge()` / `searchAcrossGoals()` の実装（Phase 2スタブ解消）
- VectorIndex活用による意味的検索

### 10.2: コンテキスト選択の動的バジェット化
- `src/session-manager.ts` 拡張 — 固定top-4 → バジェットベース動的選択
- GoalDependencyGraph活用（resource_conflict排他制御）

### 10.3: CuriosityEngine埋め込みベース検出
- `src/curiosity-engine.ts` 拡張 — dimension_name完全一致 → embedding_similarity
- VectorIndex活用

**成功基準**:
- [ ] ゴールAの学びがゴールBの戦略選択に自動反映される
- [ ] セマンティック検索で関連知識がtop-3に出現

---

## Milestone 11: LLM観測精度 + コンテキスト最適化

**テーマ**: Dogfoodingで発見された観測精度問題の改善。

### 11.1: LLM観測プロンプト改善
- Few-shot例の追加
- 定性評価のスコアキャリブレーション
- 虚偽情報検出（Codex出力の独立検証）

### 11.2: Drive-based Memory Management
- `src/memory-lifecycle.ts` — DriveScorer連携の配線完成
- 意味的検索によるWorking Memory選択

### 11.3: SatisficingJudge resource undershoot条件
- タスクコスト履歴の追加
- condition 3（resource undershoot）判定ロジック実装

**成功基準**:
- [ ] LLM観測の虚偽情報率が改善（定量測定）
- [ ] DriveScore連動のメモリ管理が動作

---

## 将来（M12以降、未設計）

- DatabaseDataSourceAdapter（PostgreSQL/MySQL/SQLite）
- WebSocket/SSEリアルタイムDataSource
- DimensionMapping意味的自動提案
- KnowledgeTransfer Phase 2（転移信頼スコア学習）
- マルチユーザー対応
- Web UI（TUIの代替/補完）

---

## 設計原則（M1-M7で学んだこと）

1. **各Milestoneの最後にDogfooding検証を必ず行う** — 実ゴール実行で予期しない結合バグが必ず出る
2. **LLM応答はZodパース前にサニタイズ** — enum外の値が来る前提で設計
3. **catchブロックでエラーを握りつぶさない** — 必ずログ出力
4. **gpt-5.3-codexを推奨モデルとして使う** — 観測精度・収束速度が大幅に優れる
5. **サブステージ単位で一つずつ実装** — 大きなステージは分割する
