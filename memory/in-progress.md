# In-Progress

## 現在: Dogfoodingフェーズ — 継続的な課題発見・修正サイクル

### 手順
1. `npm run build`
2. ゴール設定: `MOTIVA_LLM_PROVIDER=openai node dist/cli-runner.js goal add "..." --yes`
3. ループ実行: `MOTIVA_LLM_PROVIDER=openai node dist/cli-runner.js run --goal <id> --max-iterations N --yes`
4. 問題発見 → 原因調査 → 修正 → 再実行

### 修正済み（8件）
1. negotiate()コンテキスト不足 → gatherNegotiationContext()（67be750）
2. ShellDataSource未登録 → autoRegisterShellDataSources()（9620877）
3. Codex --pathフラグ未対応 → spawn cwdに変更（7304d61）
4. ノイズ次元がタスク支配 → confidence重み付き次元選択（4a1e311）
5. monotonic clampバグ → max次元のclamp削除（observation-engine.ts）— 回帰が正しく記録されるように
6. negotiate次元膨張 → プロンプト改善: Rule3削除、上限5-7次元、測定可能性要求、DataSource節引き締め（goal-negotiator.ts）
7. ShellDataSource grepパターン → `grep -rc "TODO"` が文字列リテラル内もカウント → コメント行のみ対象に修正（goal.ts）
8. GoalTreeManager hypothesisパースエラー → SubgoalItemSchemaにdefault("")追加 + サニタイズ拡張（title/description/goal等8キー対応）+ post-parseフォールバック（goal-tree-manager.ts）

### Dogfooding検証結果（2026-03-17）
- TODOゴール: Codexがファイル変更に成功（context-provider.ts等のTODO除去）
- 観測: mechanical層（confidence 0.9）で正常動作
- 次元数: 5次元に収まった（以前は8-10）
- **tree mode**: サブゴール分解 → 実行 → completed到達まで動作確認済み
- **注意**: Codexが行き過ぎた変更をする傾向あり（TODO文字列リテラルまで除去、suggest.tsのexport化等）→ 実行後のレビューが重要

### 未解決・要観察
- サブゴール品質: LLMが無関係な次元を生成する（"Total Source Files"等）→ サブゴール生成プロンプト改善余地
- Codexの行き過ぎた変更 → タスク指示の精度改善余地
- executeTask時にworkspaceContextが渡されていない → 改善すればCodexの精度向上（researcher-codex2調査済み）
- gapが減少するがゼロにならない → gap=0は不要（satisficingはboolean判定）。mechanical観測なら問題なし

### 試すべきゴール例
- `"TypeScriptビルドエラーをゼロにする"` — tsc --noEmit観測
- `"テストカバレッジを向上する"` — vitest観測
- GitHub Issueゴール — GitHubIssueAdapter検証
