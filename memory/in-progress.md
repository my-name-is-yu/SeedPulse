# In-Progress

## 現在の作業: src/ リストラクチャリング

設計ドキュメント: `docs/design/src-restructure.md`

### 完了済みバッチ（未コミット）
- **Batch 1**: `src/llm/` (6ファイル) + `src/runtime/` (5ファイル)
- **Batch 2**: `src/drive/` (5ファイル) + `src/traits/` (4ファイル)
- **Batch 3**: `src/observation/` (5ファイル) + `src/execution/` (3ファイル)
  - `src/context-providers/` 廃止済み（workspace-context.ts → observation/）
- **Batch 4**: `src/strategy/` (3ファイル) + `src/goal/` (5ファイル) + `src/knowledge/` (7ファイル)

合計45ファイル移動完了。ビルド成功、3431テスト全パス。未コミット。

### src/ルートに残るファイル（設計通り）
- core-loop.ts, cli-runner.ts, reporting-engine.ts, state-manager.ts, index.ts

### 次のステップ
- 全バッチまとめてコミット
- Phase 2（大ファイル分割）は別タスク — cli-runner.ts (2652行), memory-lifecycle.ts (1954行) 等

### 学んだこと
- workerがimport書き換えを漏らす傾向 → fixup workerを毎回投入
- sed一括置換が最も効率的（Batch 3で実証）
- vi.mock() と dynamic import() のパスも要更新
- 並列workerは3グループまで効率的（Batch 4で3並列 → fixup 2回で収束）
