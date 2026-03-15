# OpenAI / Codex テストガイド

MotivaをOpenAI APIおよびOpenAI Codex CLIで動かすためのガイドです。

## 前提条件

- ChatGPT有料プラン（API利用可能なプラン）または OpenAI API 別途契約
- Node.js 18+
- Motivaビルド済み（`npm run build`）
- OpenAI Codex CLI インストール済み（タスクをCodexで実行する場合のみ）

### OpenAI API Key の取得

1. [https://platform.openai.com](https://platform.openai.com) にアクセス
2. 「API Keys」→「Create new secret key」
3. 生成されたキー（`sk-...`）を安全な場所に保管

### Codex CLI のインストール

```bash
npm install -g @openai/codex

# インストール確認
codex --version
```

---

## 1. 環境変数の設定

### 必須

```bash
export MOTIVA_LLM_PROVIDER=openai
export OPENAI_API_KEY=sk-...
```

### オプション

```bash
# 使用モデル（デフォルト: gpt-4o）
export OPENAI_MODEL=gpt-4o          # デフォルト
export OPENAI_MODEL=gpt-4o-mini     # コスト削減
export OPENAI_MODEL=o3              # 高性能reasoning model
export OPENAI_MODEL=o4-mini         # reasoning model（軽量）

# Azure OpenAI やプロキシ経由の場合
export OPENAI_BASE_URL=https://<your-endpoint>.openai.azure.com/
```

> **注意**: `o1` / `o3` / `o4` 系のreasoningモデルは `temperature` パラメータ非対応です。Motivaは自動的にtemperatureを省略して送信します。

### .envファイルを使う場合

プロジェクトルートに `.env` を作成（**gitignoreに追加済みか確認**）：

```bash
# .env
MOTIVA_LLM_PROVIDER=openai
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxx
OPENAI_MODEL=gpt-4o

# Anthropicとの切り替え用（後述）
# ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
```

読み込み：

```bash
source .env  # または set -a; source .env; set +a
```

---

## 2. Motivaのエントリポイント

```bash
# ビルド済みバイナリを直接実行
node dist/cli-runner.js <サブコマンド>

# またはnpx経由
npx motiva <サブコマンド>
```

---

## 3. 段階的テスト手順

### Step 1: 接続確認

```bash
MOTIVA_LLM_PROVIDER=openai \
OPENAI_API_KEY=sk-... \
node dist/cli-runner.js status
```

エラーなく起動し、ゴール一覧（空でも可）が表示されれば接続OK。

### Step 2: ゴールを追加する

```bash
MOTIVA_LLM_PROVIDER=openai \
OPENAI_API_KEY=sk-... \
node dist/cli-runner.js goal add "ファイルhello.txtを作成して'Hello, Motiva!'と書く"
```

GoalNegotiatorがLLMを呼び出し、ゴールの次元・閾値・実現可能性を評価します。
登録確認：

```bash
node dist/cli-runner.js goal list
```

### Step 3: コアループを1回実行

```bash
MOTIVA_LLM_PROVIDER=openai \
OPENAI_API_KEY=sk-... \
node dist/cli-runner.js run
```

observe → gap → score → task → verify の1サイクルが実行されます。

### Step 4: Codexアダプターでタスク実行

ゴールの `adapter_type` を `openai_codex_cli` に設定してCodexにタスクを委譲します。

ゴールJSON例（`goal-codex-test.json`）：

```json
{
  "description": "hello.txtを作成して'Hello, Motiva!'と書く",
  "adapter_type": "openai_codex_cli",
  "dimensions": [
    {
      "name": "file_created",
      "threshold": { "type": "present", "value": true }
    }
  ]
}
```

実行：

```bash
MOTIVA_LLM_PROVIDER=openai \
OPENAI_API_KEY=sk-... \
node dist/cli-runner.js run
```

Codexアダプターは内部で以下のコマンドを実行します：

```bash
codex exec --full-auto "PROMPT"
```

`--model` を指定したい場合は `OpenAICodexCLIAdapter` のコンストラクタに渡す（コード変更が必要）。

---

## 4. テスト用ゴール例

### A. シンプルなファイル作成タスク（Codexで実行しやすい）

```bash
node dist/cli-runner.js goal add "カレントディレクトリにhello.txtを作成し'Hello from Motiva!'と書く"
```

### B. テスト実行タスク

```bash
node dist/cli-runner.js goal add "npx vitest run を実行してテストがすべてpassすることを確認する"
```

### C. ドキュメント生成タスク

```bash
node dist/cli-runner.js goal add "README.mdを作成してプロジェクトの概要を3行で説明する"
```

---

## 5. トラブルシューティング

### API Keyが未設定のとき

```
OpenAILLMClient: no API key provided. Pass apiKey to constructor or set OPENAI_API_KEY env var.
```

→ `export OPENAI_API_KEY=sk-...` を実行してから再試行。

### Codex CLIが未インストールのとき

```
Error: spawn codex ENOENT
```

→ `npm install -g @openai/codex` を実行。インストール後 `codex --version` で確認。

### レート制限（429エラー）

```
OpenAILLMClient: HTTP 429 Too Many Requests
```

OpenAILLMClientは最大3回（1s → 2s → 4sの指数バックオフ）自動リトライします。
それでも失敗する場合はしばらく待ってから再実行、またはTier上位のAPIプランに切り替え。

### reasoning modelでtemperatureエラー

`o1` / `o3` / `o4` 系モデルはtemperatureを受け付けません。
Motivaは自動的にtemperatureを省略するため、通常は問題ありません。
もし外部から直接パラメータを渡す場合は注意してください。

### モデル名が間違っている

```
OpenAILLMClient: HTTP 404 ...
```

→ `OPENAI_MODEL` の値を確認。利用可能なモデル名は [https://platform.openai.com/docs/models](https://platform.openai.com/docs/models) を参照。

---

## 6. AnthropicとOpenAIの切り替え

環境変数を変えるだけで切り替えできます。

### OpenAI を使う

```bash
export MOTIVA_LLM_PROVIDER=openai
export OPENAI_API_KEY=sk-...
# OPENAI_MODEL=gpt-4o  # 省略時デフォルト
```

### Anthropic（デフォルト）に戻す

```bash
unset MOTIVA_LLM_PROVIDER
export ANTHROPIC_API_KEY=sk-ant-...
```

### .envで両方を用意しておく例

```bash
# .env — 使いたいプロバイダーのコメントを外して source .env

# --- OpenAI ---
MOTIVA_LLM_PROVIDER=openai
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxx
OPENAI_MODEL=gpt-4o

# --- Anthropic (default) ---
# MOTIVA_LLM_PROVIDER=
# ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
```

---

## 7. 状態リセット

テストデータをクリアして最初からやり直す場合：

```bash
rm -rf ~/.motiva
```
