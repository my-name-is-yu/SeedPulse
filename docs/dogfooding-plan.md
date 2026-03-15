# Motiva Dogfooding Plan

Motivaを使ってMotiva自身を改善する — セルフドッグフーディング計画。

## コンセプト

Motivaにゴールを設定し、Motivaが自分のリポジトリを分析してGitHub Issueを起票する。
人間 + Claude Code がissueを解決し、Motivaが次のループで進捗を観測する。

```
Motiva (ゴール設定)
  │
  ├── 観測: リポジトリ状態を読む（docs, tests, code quality）
  ├── ギャップ検出: 不足・改善点を発見
  ├── タスク生成: GitHub Issue として起票（--label motiva）
  │
  └── 人間 + Claude Code が issue を解決
        └── Motivaが次ループで closed/open を観測 → 進捗更新
```

## 安全設計

- Motivaは直接コードを触らない — 出力はGitHub Issueのみ
- issueにはすべて `motiva` ラベルを付与（トラッキング用）
- 人間がissueをレビューしてから着手（不適切なissueはcloseで却下）

## 実装フェーズ

### Phase A: GitHub Issue アダプタ実装

**目的**: Motivaのタスク実行出力をGitHub Issueに変換するアダプタ

実装内容:
1. `src/adapters/github-issue.ts` — IAdapter実装
   - execute: `gh issue create --title "..." --body "..." --label motiva`
   - AgentTask.promptからタイトル・本文・ラベルを抽出
   - AgentResultにissue URLを返す
2. `src/provider-factory.ts` — `github_issue` アダプタ登録
3. 観測: `gh issue list --label motiva --json number,title,state` で状態取得
   - 既存 DataSourceAdapter (http_api) または gh CLI 経由
4. テスト: `tests/github-issue-adapter.test.ts`

### Phase B: 小さいゴールでdogfood開始

**最初のゴール**: "MotivaのREADMEとGetting Startedガイドを整備する"

次元例:
- `readme_completeness`: 0→1 (README.mdの存在と品質)
- `getting_started_exists`: 0→1 (Getting Startedガイドの有無)
- `api_doc_coverage`: 0→1 (主要APIのドキュメント率)

観測方法:
- ファイル存在チェック（mechanical）
- LLMによる品質レビュー（independent_review）
- issue open/closed 比率（mechanical）

### Phase C: 観測強化

**目的**: 複雑なゴールに対応できる観測基盤を作る。現状の `self_report` は `current_value` を再記録するだけで実質何もしない。LLM-powered観測が必須。

#### C-1: LLM-powered observation実装

実装内容:
- `ObservationEngine.observe()` にLLM呼び出しを追加
  - DataSourceで値が取れない次元に対してLLM評価を実行
  - ワークスペースのファイル内容をアダプタ経由で取得 → LLMに渡して0-1スコアを返させる
  - 信頼度: `independent_review` tier (0.50–0.84)
- LLM観測プロンプト（例）:
  ```
  以下のファイル内容を読み、「{次元ラベル}」を0.0〜1.0で評価してください。
  ゴール: {goal.description}
  閾値（目標値）: {threshold}
  ファイル: {content}
  回答: {"score": 0.0〜1.0, "reason": "..."}
  ```
- 既存 DataSource（FileExistence 等）で取得可能な次元はDataSource優先

成功基準:
- [ ] `observe()` がLLM観測を実行し `independent_review` 信頼度でスコアを返す
- [ ] DataSource未設定の次元でもLLM観測でギャップ計算が進む

#### C-2: 観測プロンプト改善

実装内容:
- 次元ごとにプロンプトを最適化（ゴールの `description` + 次元の `label` + `threshold` を含める）
- DataSource観測とLLM観測の結果をマージするロジック
  - DataSourceが取得できた場合 → DataSource優先（信頼度: `mechanical`）
  - 取得できない場合 → LLM観測にフォールバック（信頼度: `independent_review`）
- 次元名の不一致検出: DataSourceの次元名とゴール次元名が一致しない場合に警告ログ出力

成功基準:
- [ ] 次元ごとに適切な信頼度でスコアが返る
- [ ] 不一致次元名に対して警告が出る

#### C-3: 観測精度テスト

実装内容:
- モック環境でLLM観測が正しいスコアを返すか確認するテスト
- `FileExistenceDataSource` + LLM観測の併用テスト
- 観測結果がギャップ計算→タスク生成の正しいインプットになるかE2E確認

成功基準:
- [ ] LLM観測テストがvitestで通過
- [ ] FileExistence + LLM観測の併用でループ1周が完走する

---

### Phase D: 中規模dogfooding

**目的**: 観測基盤が整った前提で、より複雑なゴールを試す。各ゴールでMotiva自身の機能の異なる側面を検証する。

#### D-1: "MotivaのREADME品質を改善する"

- **次元**:
  - `readme_quality`: 0→1（LLMがREADME.mdの内容を評価）
  - `installation_guide_present`: 0→1（インストール手順の有無）
  - `usage_example_present`: 0→1（使用例の有無）
- **観測方法**: LLM観測（独立レビュー）
- **検証ポイント**: LLM観測の精度、タスク生成品質

#### D-2: "E2Eループテストを自動化する"

- **次元**:
  - `e2e_test_file_exists`: 0→1（テストファイルの存在）
  - `e2e_test_passing`: 0→1（テスト通過率）
  - `approval_loop_fixed`: 0→1（承認ループバグの修正）
- **観測方法**: FileExistenceDataSource（ファイル存在） + LLM観測（テスト内容の評価）
- **検証ポイント**: DataSource + LLM観測の併用、ループ収束

#### D-3: "npm publish可能な状態にする"

- **次元**:
  - `package_json_valid`: 0→1（package.json のbin/main/exports設定）
  - `build_succeeds`: 0→1（npm run build が通るか）
  - `version_set`: 0→1（バージョンが1.0.0以上）
- **観測方法**: LLM観測（package.json内容評価） + FileExistenceDataSource（dist/ファイル存在）
- **検証ポイント**: 重複タスク防止（dedup）、satisficing判定

---

### Phase E: 大規模ゴール（将来）

**注**: Phase C/D の観測強化・中規模dogfoodingが安定してから着手。

- "Motivaのコード品質を改善する" — 全ソースのリファクタリング提案をissue起票
- "Motivaを完成させる" — ロードマップに沿った残機能実装の自動追跡

各段階で学んだことをMotiva自身の学習パイプライン（LearningPipeline）に蓄積。

## 成功基準

Phase Aの成功:
- [x] `motiva run --adapter github_issue` でissueが作成される
- [x] 作成されたissueが具体的で実行可能
- [x] 次のループでissue状態を観測できる

Phase Bの成功:
- [x] Motivaが3つ以上の有用なissueを自動起票
- [x] issueを解決したらMotivaが進捗を正しく認識
- [x] ループが自然に収束（ゴール達成 or satisficing判定）

Phase Cの成功:
- [ ] LLM観測が `independent_review` 信頼度でスコアを返す（C-1）
- [ ] DataSource未設定の次元でもLLM観測でギャップ計算が進む（C-1）
- [ ] 次元名不一致に対して警告ログが出る（C-2）
- [ ] vitestでLLM観測テストが通過（C-3）

Phase Dの成功:
- [ ] D-1: README品質ゴールが2ループ以内に収束
- [ ] D-2: DataSource + LLM観測の併用で1ループ完走
- [ ] D-3: satisficing判定が正しく動作しループが過剰に続かない

## 実施結果メモ

### Phase A 完了
GitHub Issueアダプタ（`src/adapters/github-issue.ts`, `src/adapters/github-issue-datasource.ts`）を実装。`gh` CLI経由でissue作成・状態観測が動作確認済み。

### Phase B 完了
ゴール「MotivaのREADMEとGetting Startedガイドを整備する」を1イテレーションで達成。
- アダプタ: OpenAI Codex CLI adapter（`src/adapters/openai-codex.ts`）を使用
- データソース: FileExistenceDataSourceAdapter（`src/adapters/file-existence-datasource.ts`）でファイル存在を観測
- 成果物: `README.md`, `docs/getting-started.md`
- データソース設定修正: 当初 `GETTING_STARTED.md` → `docs/getting-started.md` に変更（実際のファイルパスに合わせる）

## 技術メモ

- `gh` CLI を使用（GitHub API直接呼び出しより簡単、認証も`gh auth`で管理済み）
- issue本文にMotiva metadata（goal_id, task_id, dimension）を埋め込む（観測時の紐付け用）
- ラベル `motiva` でフィルタリング、追加ラベルで分類（`docs`, `test`, `bug`等）

## Lessons Learned（Phase A/B から）

Phase A/Bの実施を通じて明らかになった問題と教訓:

1. **DataSource次元名とゴール次元名の不一致がスタックの最大原因**
   - DataSourceが返す次元名（例: `file_exists`）とゴール定義の次元名（例: `readme_completeness`）が一致しないと観測値が使われず、ループが前進しない
   - 対策: Phase C-2 で不一致検出の警告ログを追加する

2. **`--yes` フラグがないと承認ループで止まる**
   - インタラクティブな承認プロンプトがある限り、自動実行ができない
   - 対策: dogfoodingでは常に `--yes` を使う。承認が必要な場面では明示的に除外する

3. **ファイルパス設定ミスで観測がずれる → 設定検証の仕組みが必要**
   - Phase Bで `GETTING_STARTED.md` → `docs/getting-started.md` の修正が必要だった
   - DataSource設定時にファイルパスの存在チェックや正規化を行う仕組みが将来的に必要

4. **`self_report` 観測は実質何もしない → LLM-powered観測が必須**
   - `self_report` はエージェントが自己申告した値をそのまま記録するだけ
   - 複雑なゴール（品質改善など）ではLLMが独立してワークスペースを評価する必要がある

5. **単純なゴールでも多くのバグが見つかる → dogfoodingの価値は高い**
   - Phase Bの1ゴールだけで、次元名不一致・ファイルパスミス・`--yes`フラグ不足など複数の問題が露見した
   - 実際のゴールを動かすことでユニットテストでは発見できない結合バグが見つかる
