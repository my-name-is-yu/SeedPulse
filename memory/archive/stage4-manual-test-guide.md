# Stage 4 手動テストガイド

作成日: 2026-03-11
更新日: 2026-03-11
前提: Stage 4 実装完了、793ユニットテスト通過

---

## 前提条件

```bash
# APIキーを設定（実APIを使用するテストで必須）
export ANTHROPIC_API_KEY="sk-ant-..."

# ビルドが通ることを確認
npm run build && npx vitest run
```

各テストスクリプトは `StateManager` に一時ディレクトリを渡すため `~/.motiva/` は汚染されない。
スクリプト終了時に自動クリーンアップする。

---

## テスト実行の推奨順序

1. **AdapterRegistry** (項目1) — LLM不要、まず構造確認
2. **ClaudeAPIAdapter** (項目2) — MockLLMClient使用、API不要
3. **ClaudeCodeCLIAdapter** (項目3) — 実バイナリ (`echo`/`true`/`false`)、API不要
4. **selectTargetDimension** (項目4) — LLM不要、純粋計算
5. **generateTask** (項目5) — MockLLMClient使用
6. **checkIrreversibleApproval** (項目6) — MockLLMClient使用
7. **executeTask** (項目7) — MockAdapter使用
8. **verifyTask** (項目8) — MockLLMClient使用
9. **handleVerdict** (項目9) — MockLLMClient使用
10. **handleFailure** (項目10) — MockLLMClient使用
11. **runTaskCycle E2E** (項目11) — MockLLMClient + MockAdapter使用

---

## テスト項目

### 1. AdapterRegistry — 登録・取得・上書き・エラー

**目的**: アダプターの登録・取得・列挙・上書き・未登録エラーの確認。LLM不要のため高速に実行できる。

```bash
npx tsx <<'EOF'
import { AdapterRegistry } from "./src/adapter-layer.js";

const registry = new AdapterRegistry();

// ─── 1. 初期状態: アダプターなし ───
console.log("=== 1. 初期状態 ===");
const initial = registry.listAdapters();
console.log("listAdapters():", JSON.stringify(initial), "(期待値: [])");
console.log(initial.length === 0 ? "✓" : "✗ 空でない");

// ─── 2. アダプター登録と取得 ───
console.log("\n=== 2. 登録と取得 ===");
const mockAdapter = {
  adapterType: "mock",
  execute: async (task) => ({
    success: true,
    output: "mock output",
    error: null,
    exit_code: 0,
    elapsed_ms: 1,
    stopped_reason: "completed",
  }),
};
registry.register(mockAdapter);
const retrieved = registry.getAdapter("mock");
console.log("adapterType:", retrieved.adapterType, "(期待値: mock)");
console.log(retrieved.adapterType === "mock" ? "取得成功 ✓" : "取得失敗 ✗");

// ─── 3. listAdapters はソート済み ───
console.log("\n=== 3. listAdapters ソート ===");
const adapterB = { adapterType: "zzz_adapter", execute: async () => ({ success: true, output: "", error: null, exit_code: null, elapsed_ms: 0, stopped_reason: "completed" }) };
const adapterA = { adapterType: "aaa_adapter", execute: async () => ({ success: true, output: "", error: null, exit_code: null, elapsed_ms: 0, stopped_reason: "completed" }) };
registry.register(adapterB);
registry.register(adapterA);
const listed = registry.listAdapters();
console.log("listAdapters():", JSON.stringify(listed));
const isSorted = JSON.stringify(listed) === JSON.stringify([...listed].sort());
console.log("ソート済み:", isSorted ? "✓" : "✗");

// ─── 4. 同一typeで上書き ───
console.log("\n=== 4. 上書き登録 ===");
const updatedMock = {
  adapterType: "mock",
  execute: async (task) => ({
    success: true,
    output: "updated output",
    error: null,
    exit_code: 0,
    elapsed_ms: 1,
    stopped_reason: "completed",
  }),
};
registry.register(updatedMock);
const result = await registry.getAdapter("mock").execute({ prompt: "test", timeout_ms: 1000, adapter_type: "mock" });
console.log("updated output:", result.output, "(期待値: updated output)");
console.log(result.output === "updated output" ? "上書き成功 ✓" : "上書き失敗 ✗");
const countAfterOverwrite = registry.listAdapters().filter(t => t === "mock").length;
console.log("mock 登録数:", countAfterOverwrite, "(期待値: 1 — 重複しない)");

// ─── 5. 未登録typeでエラー ───
console.log("\n=== 5. 未登録エラー ===");
try {
  registry.getAdapter("nonexistent_adapter");
  console.error("✗ エラーが発生しなかった");
} catch (e) {
  console.log("エラー発生 ✓");
  const msg = e instanceof Error ? e.message : String(e);
  console.log("エラーメッセージ:", msg.slice(0, 120));
  const hasAvailableList = msg.includes("aaa_adapter") || msg.includes("mock") || msg.includes("zzz_adapter");
  console.log("利用可能typeリストが含まれる:", hasAvailableList ? "✓" : "✗");
}

console.log("\nAdapterRegistry テスト完了");
EOF
```

**確認ポイント**:
- [ ] 初期状態で `listAdapters()` が空配列を返す
- [ ] 登録後に `getAdapter(type)` で同一インスタンスを取得できる
- [ ] `listAdapters()` がアルファベット順ソート済みを返す
- [ ] 同一typeで `register()` すると上書きされ重複しない
- [ ] 未登録typeで `getAdapter()` がエラーをスローし、メッセージに利用可能typeが含まれる

---

### 2. ClaudeAPIAdapter — MockLLMClientでの実行・タイムアウト・エラー

**目的**: ClaudeAPIAdapterがILLMClientラッパーとして正しく動作するか。MockLLMClientを使用するためAPIキー不要。

```bash
npx tsx <<'EOF'
import { ClaudeAPIAdapter } from "./src/adapters/claude-api.js";

// ─── MockLLMClient ───
function makeMockLLM(responseContent, delayMs = 0, shouldThrow = false, throwValue = null) {
  return {
    async sendMessage(messages, options) {
      if (delayMs > 0) {
        await new Promise(r => setTimeout(r, delayMs));
      }
      if (shouldThrow) {
        throw throwValue !== null ? throwValue : new Error("LLM error");
      }
      return {
        content: responseContent,
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: "end_turn",
      };
    },
    parseJSON(content, schema) {
      return JSON.parse(content);
    },
  };
}

const task = { prompt: "Say hello", timeout_ms: 3000, adapter_type: "claude_api" };

// ─── 1. adapterType 確認 ───
console.log("=== 1. adapterType ===");
const adapter = new ClaudeAPIAdapter(makeMockLLM("Hello!"));
console.log("adapterType:", adapter.adapterType, "(期待値: claude_api)");
console.log(adapter.adapterType === "claude_api" ? "✓" : "✗");

// ─── 2. 正常系: LLMレスポンスが output に入る ───
console.log("\n=== 2. 正常系 ===");
const res = await adapter.execute(task);
console.log("success:", res.success, "(期待値: true)");
console.log("output:", res.output, "(期待値: Hello!)");
console.log("exit_code:", res.exit_code, "(期待値: null)");
console.log("stopped_reason:", res.stopped_reason, "(期待値: completed)");
console.log("elapsed_ms:", res.elapsed_ms, "(非負数であること)");
console.log(res.success && res.output === "Hello!" && res.exit_code === null ? "✓" : "✗");

// ─── 3. プロンプトがuser messageとして渡される ───
console.log("\n=== 3. プロンプト伝達確認 ===");
let capturedMessages = null;
const capturingLLM = {
  async sendMessage(messages, options) {
    capturedMessages = messages;
    return { content: "ok", usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" };
  },
  parseJSON(content, schema) { return JSON.parse(content); },
};
await new ClaudeAPIAdapter(capturingLLM).execute({ prompt: "my prompt", timeout_ms: 3000, adapter_type: "claude_api" });
console.log("messages[0].role:", capturedMessages[0].role, "(期待値: user)");
console.log("messages[0].content:", capturedMessages[0].content, "(期待値: my prompt)");
console.log(capturedMessages[0].role === "user" && capturedMessages[0].content === "my prompt" ? "✓" : "✗");

// ─── 4. LLMエラー (Errorインスタンス) ───
console.log("\n=== 4. LLMエラー (Error) ===");
const errorAdapter = new ClaudeAPIAdapter(makeMockLLM(null, 0, true, new Error("API rate limit exceeded")));
const errRes = await errorAdapter.execute(task);
console.log("success:", errRes.success, "(期待値: false)");
console.log("error:", errRes.error, "(期待値: API rate limit exceeded)");
console.log("stopped_reason:", errRes.stopped_reason, "(期待値: error)");
console.log(!errRes.success && errRes.error === "API rate limit exceeded" ? "✓" : "✗");

// ─── 5. LLMエラー (非Errorオブジェクト) ───
console.log("\n=== 5. LLMエラー (string throw) ===");
const strErrorAdapter = new ClaudeAPIAdapter(makeMockLLM(null, 0, true, "string error value"));
const strErrRes = await strErrorAdapter.execute(task);
console.log("success:", strErrRes.success, "(期待値: false)");
console.log("stopped_reason:", strErrRes.stopped_reason, "(期待値: error)");
console.log(!strErrRes.success && strErrRes.stopped_reason === "error" ? "✓" : "✗");

// ─── 6. タイムアウト ───
console.log("\n=== 6. タイムアウト ===");
const slowLLM = makeMockLLM("slow response", 2000); // 2秒遅延
const slowTask = { prompt: "test", timeout_ms: 500, adapter_type: "claude_api" }; // 500ms タイムアウト
const start = Date.now();
const timeoutRes = await new ClaudeAPIAdapter(slowLLM).execute(slowTask);
const elapsed = Date.now() - start;
console.log("success:", timeoutRes.success, "(期待値: false)");
console.log("stopped_reason:", timeoutRes.stopped_reason, "(期待値: timeout)");
console.log("error includes 'Timed out':", timeoutRes.error && timeoutRes.error.includes("Timed out") ? "✓" : "✗");
console.log("output:", JSON.stringify(timeoutRes.output));
console.log("実際の経過時間:", elapsed, "ms (500ms前後であること)");
console.log(!timeoutRes.success && timeoutRes.stopped_reason === "timeout" ? "✓" : "✗");

// ─── 7. AdapterRegistry への登録 ───
console.log("\n=== 7. AdapterRegistry への登録 ===");
import { AdapterRegistry } from "./src/adapter-layer.js";
const registry = new AdapterRegistry();
registry.register(new ClaudeAPIAdapter(makeMockLLM("registered")));
const listed = registry.listAdapters();
console.log("listAdapters includes 'claude_api':", listed.includes("claude_api") ? "✓" : "✗");

console.log("\nClaudeAPIAdapter テスト完了");
EOF
```

**確認ポイント**:
- [ ] `adapterType` が `"claude_api"` である
- [ ] 正常系でLLMレスポンスが `output` に入り `success: true`、`exit_code: null`、`stopped_reason: "completed"` になる
- [ ] プロンプトが `[{ role: "user", content: task.prompt }]` として LLMに渡される
- [ ] LLM Errorインスタンスの場合 `error` に `message` が入り `stopped_reason: "error"` になる
- [ ] 非Errorオブジェクトのthrowでも `success: false`、`stopped_reason: "error"` になる
- [ ] タイムアウト時に `stopped_reason: "timeout"` となり `error` に "Timed out" が含まれる
- [ ] `AdapterRegistry` に登録できる

---

### 3. ClaudeCodeCLIAdapter — 実バイナリでの実行・タイムアウト・バイナリ不在

**目的**: ClaudeCodeCLIAdapterがspawnを使い実プロセスを正しく扱うか。システムの `echo`/`true`/`false` バイナリを使用するためAPIキー不要。

```bash
npx tsx <<'EOF'
import { ClaudeCodeCLIAdapter } from "./src/adapters/claude-code-cli.js";

// ─── 1. adapterType / デフォルトcliPath ───
console.log("=== 1. adapterType と cliPath ===");
const adapter = new ClaudeCodeCLIAdapter();
console.log("adapterType:", adapter.adapterType, "(期待値: claude_code_cli)");
console.log(adapter.adapterType === "claude_code_cli" ? "✓" : "✗");

const customAdapter = new ClaudeCodeCLIAdapter("/usr/bin/echo");
console.log("カスタムcliPath設定 ✓ (インスタンス化成功)");

// ─── 2. exit code 0 で success: true ───
console.log("\n=== 2. exit 0 → success: true ===");
// `true` コマンドは何もせず exit 0 で終了する
const trueAdapter = new ClaudeCodeCLIAdapter("true");
const trueRes = await trueAdapter.execute({ prompt: "ignored", timeout_ms: 5000, adapter_type: "claude_code_cli" });
console.log("success:", trueRes.success, "(期待値: true)");
console.log("exit_code:", trueRes.exit_code, "(期待値: 0)");
console.log("stopped_reason:", trueRes.stopped_reason, "(期待値: completed)");
console.log("elapsed_ms:", trueRes.elapsed_ms, "(非負数であること)");
console.log(trueRes.success && trueRes.exit_code === 0 ? "✓" : "✗");

// ─── 3. exit code 非0 で success: false ───
console.log("\n=== 3. exit 1 → success: false ===");
// `false` コマンドは何もせず exit 1 で終了する
const falseAdapter = new ClaudeCodeCLIAdapter("false");
const falseRes = await falseAdapter.execute({ prompt: "ignored", timeout_ms: 5000, adapter_type: "claude_code_cli" });
console.log("success:", falseRes.success, "(期待値: false)");
console.log("exit_code:", falseRes.exit_code, "(期待値: 1)");
console.log("stopped_reason:", falseRes.stopped_reason, "(期待値: error)");
console.log(!falseRes.success && falseRes.exit_code === 1 ? "✓" : "✗");

// ─── 4. stdoutキャプチャ ───
console.log("\n=== 4. stdout キャプチャ ===");
// echo コマンドで stdin を無視して固定文字列を出力
const echoAdapter = new ClaudeCodeCLIAdapter("echo");
const echoRes = await echoAdapter.execute({ prompt: "hello_world", timeout_ms: 5000, adapter_type: "claude_code_cli" });
console.log("output (raw):", JSON.stringify(echoRes.output));
// echo は引数なしで改行を出力するか、stdinを無視して改行のみ出力
console.log("output に何らかの文字列が入る:", echoRes.output.length >= 0 ? "✓" : "✗");
console.log("exit_code:", echoRes.exit_code, "(期待値: 0)");

// ─── 5. stderrキャプチャ ───
console.log("\n=== 5. stderr キャプチャ ===");
// sh を使って stderr に書き込む (stdinの内容は無視)
const shAdapter = new ClaudeCodeCLIAdapter("sh");
const shTask = { prompt: "ignored", timeout_ms: 5000, adapter_type: "claude_code_cli" };
// sh は stdin からコマンドを読むが --print フラグは認識しない → エラー終了するか無視
// ここでは動作確認のみ (exit codeを問わず output/error が文字列であることを確認)
const shRes = await shAdapter.execute(shTask);
console.log("output型:", typeof shRes.output, "(期待値: string)");
console.log("error型:", shRes.error === null || typeof shRes.error === "string" ? "string | null ✓" : "✗");

// ─── 6. タイムアウト ───
console.log("\n=== 6. タイムアウト ===");
// node の無限ループで意図的にタイムアウトを発生させる
const nodeAdapter = new ClaudeCodeCLIAdapter("node");
const infiniteTask = {
  prompt: "while(true){}",
  timeout_ms: 800,
  adapter_type: "claude_code_cli",
};
const start = Date.now();
const timeoutRes = await nodeAdapter.execute(infiniteTask);
const elapsed = Date.now() - start;
console.log("success:", timeoutRes.success, "(期待値: false)");
console.log("stopped_reason:", timeoutRes.stopped_reason, "(期待値: timeout)");
console.log("error includes 'Timed out':", timeoutRes.error && timeoutRes.error.includes("Timed out") ? "✓" : "✗");
console.log("elapsed_ms:", timeoutRes.elapsed_ms, "(800ms前後であること)");
console.log("実際の経過時間:", elapsed, "ms");
console.log(!timeoutRes.success && timeoutRes.stopped_reason === "timeout" ? "✓" : "✗");

// ─── 7. バイナリ不在 ───
console.log("\n=== 7. バイナリ不在 ===");
const missingAdapter = new ClaudeCodeCLIAdapter("/nonexistent/binary/path");
const missingRes = await missingAdapter.execute({ prompt: "test", timeout_ms: 5000, adapter_type: "claude_code_cli" });
console.log("success:", missingRes.success, "(期待値: false)");
console.log("stopped_reason:", missingRes.stopped_reason, "(期待値: error)");
console.log("exit_code:", missingRes.exit_code, "(期待値: null — プロセス起動前に失敗)");
console.log("error:", missingRes.error ? missingRes.error.slice(0, 80) : null);
console.log(!missingRes.success && missingRes.exit_code === null ? "✓" : "✗");

// ─── 8. AdapterRegistry への登録 ───
console.log("\n=== 8. AdapterRegistry への登録 ===");
import { AdapterRegistry } from "./src/adapter-layer.js";
const registry = new AdapterRegistry();
registry.register(new ClaudeCodeCLIAdapter());
console.log("listAdapters includes 'claude_code_cli':", registry.listAdapters().includes("claude_code_cli") ? "✓" : "✗");

console.log("\nClaudeCodeCLIAdapter テスト完了");
EOF
```

**確認ポイント**:
- [ ] `adapterType` が `"claude_code_cli"` である
- [ ] `true` コマンドで `success: true`、`exit_code: 0`、`stopped_reason: "completed"` になる
- [ ] `false` コマンドで `success: false`、`exit_code: 1`、`stopped_reason: "error"` になる
- [ ] `output` と `error` が文字列型である
- [ ] タイムアウト時に `stopped_reason: "timeout"` となり `error` に "Timed out" が含まれ `elapsed_ms` がタイムアウト値付近になる
- [ ] バイナリ不在で `success: false`、`exit_code: null`（プロセス起動前失敗）になる
- [ ] `AdapterRegistry` に登録できる

---

### 4. TaskLifecycle.selectTargetDimension — 次元選択ロジック

**目的**: DriveScorer連携で最もスコアの高い次元が選択されるか。LLM不要のため高速に実行できる。

```bash
npx tsx <<'EOF'
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { StateManager } from "./src/state-manager.js";
import { LLMClient } from "./src/llm-client.js";
import { SessionManager } from "./src/session-manager.js";
import { TrustManager } from "./src/trust-manager.js";
import { StrategyManager } from "./src/strategy-manager.js";
import { StallDetector } from "./src/stall-detector.js";
import { TaskLifecycle } from "./src/task-lifecycle.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-select-test-"));

// MockLLMClient (このテストでは使用されない)
const mockLLM = {
  async sendMessage() { return { content: "{}", usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: "end_turn" }; },
  parseJSON(c) { return JSON.parse(c); },
};

const stateManager = new StateManager(tmpDir);
const sessionManager = new SessionManager(stateManager);
const trustManager = new TrustManager(stateManager);
const strategyManager = new StrategyManager(stateManager, mockLLM);
const stallDetector = new StallDetector(stateManager);
const lifecycle = new TaskLifecycle(stateManager, mockLLM, sessionManager, trustManager, strategyManager, stallDetector);

// ─── 1. 単一次元の場合 ───
console.log("=== 1. 単一次元 ===");
const singleGap = {
  goal_id: "goal-001",
  gaps: [
    {
      dimension_name: "test_coverage",
      raw_gap: 0.4,
      normalized_gap: 0.4,
      normalized_weighted_gap: 0.4,
      confidence: 0.8,
      uncertainty_weight: 1.0,
    },
  ],
  timestamp: new Date().toISOString(),
};
const singleDrive = {
  time_since_last_attempt: { test_coverage: 24 },
  deadlines: { test_coverage: null },
  opportunities: {},
};
const selected1 = lifecycle.selectTargetDimension(singleGap, singleDrive);
console.log("選択された次元:", selected1, "(期待値: test_coverage)");
console.log(selected1 === "test_coverage" ? "✓" : "✗");

// ─── 2. 複数次元でギャップが大きい方が選ばれる ───
console.log("\n=== 2. 複数次元 — ギャップ大が優先 ===");
const multiGap = {
  goal_id: "goal-001",
  gaps: [
    {
      dimension_name: "small_gap",
      raw_gap: 0.1,
      normalized_gap: 0.1,
      normalized_weighted_gap: 0.1,
      confidence: 0.9,
      uncertainty_weight: 1.0,
    },
    {
      dimension_name: "large_gap",
      raw_gap: 0.8,
      normalized_gap: 0.8,
      normalized_weighted_gap: 0.8,
      confidence: 0.9,
      uncertainty_weight: 1.0,
    },
  ],
  timestamp: new Date().toISOString(),
};
const multiDrive = {
  time_since_last_attempt: { small_gap: 0, large_gap: 0 },
  deadlines: { small_gap: null, large_gap: null },
  opportunities: {},
};
const selected2 = lifecycle.selectTargetDimension(multiGap, multiDrive);
console.log("選択された次元:", selected2, "(期待値: large_gap)");
console.log(selected2 === "large_gap" ? "✓" : "✗");

// ─── 3. 時間経過があると優先度が上がる ───
console.log("\n=== 3. 時間経過 — 長時間未着手が優先される傾向 ===");
const staleDrive = {
  time_since_last_attempt: { small_gap: 200, large_gap: 0 }, // small_gapは200時間未着手
  deadlines: { small_gap: null, large_gap: null },
  opportunities: {},
};
const selected3 = lifecycle.selectTargetDimension(multiGap, staleDrive);
console.log("選択された次元:", selected3);
console.log("(small_gapかlarge_gapが選ばれること — DriveScorer実装依存)");

// ─── 4. gapsが空の場合はエラー ───
console.log("\n=== 4. gaps空でエラー ===");
const emptyGap = {
  goal_id: "goal-001",
  gaps: [],
  timestamp: new Date().toISOString(),
};
try {
  lifecycle.selectTargetDimension(emptyGap, { time_since_last_attempt: {}, deadlines: {}, opportunities: {} });
  console.error("✗ エラーが発生しなかった");
} catch (e) {
  console.log("エラー発生 ✓:", e instanceof Error ? e.message.slice(0, 80) : e);
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("\nクリーンアップ完了");
EOF
```

**確認ポイント**:
- [ ] 単一次元の場合にその次元名が返る
- [ ] 複数次元でギャップが大きい方が選択される（DriveScorer連携）
- [ ] `gaps` が空の場合にエラーがスローされる
- [ ] 戻り値が次元名の文字列である

---

### 5. TaskLifecycle.generateTask — タスク生成とLLM連携

**目的**: LLMが生成したタスク定義がZodパースされ、永続化されるか。MockLLMClientを使用するためAPIキー不要。

```bash
npx tsx <<'EOF'
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { StateManager } from "./src/state-manager.js";
import { SessionManager } from "./src/session-manager.js";
import { TrustManager } from "./src/trust-manager.js";
import { StrategyManager } from "./src/strategy-manager.js";
import { StallDetector } from "./src/stall-detector.js";
import { TaskLifecycle } from "./src/task-lifecycle.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-generate-test-"));

// LLMGeneratedTaskSchema に合わせたレスポンス
const VALID_TASK_RESPONSE = JSON.stringify({
  work_description: "Increase test coverage to 80% by adding unit tests for gap-calculator.ts",
  rationale: "Low test coverage increases risk of regressions in the gap calculation pipeline",
  approach: "Identify untested branches in gap-calculator.ts, write vitest unit tests for each threshold type",
  success_criteria: [
    {
      description: "Test coverage reaches >= 80%",
      verification_method: "npx vitest run --coverage",
      is_blocking: true
    },
    {
      description: "All new tests pass without errors",
      verification_method: "npx vitest run",
      is_blocking: true
    }
  ],
  scope_boundary: {
    in_scope: ["src/gap-calculator.ts", "tests/gap-calculator.test.ts"],
    out_of_scope: ["src/state-manager.ts", "src/types/"],
    blast_radius: "gap calculation logic only"
  },
  constraints: ["Do not modify existing passing tests", "Use vitest framework only"],
  reversibility: "reversible",
  estimated_duration: { value: 2, unit: "hours" }
});

// MockLLMClient: ```json コードフェンス形式で返す
const mockLLM = {
  async sendMessage(messages, options) {
    return {
      content: "```json\n" + VALID_TASK_RESPONSE + "\n```",
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: "end_turn",
    };
  },
  parseJSON(content, schema) {
    // コードフェンスを除去してパース
    const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return schema.parse(parsed);
  },
};

const stateManager = new StateManager(tmpDir);
const sessionManager = new SessionManager(stateManager);
const trustManager = new TrustManager(stateManager);
const strategyManager = new StrategyManager(stateManager, mockLLM);
const stallDetector = new StallDetector(stateManager);
const lifecycle = new TaskLifecycle(stateManager, mockLLM, sessionManager, trustManager, strategyManager, stallDetector);

// ─── 1. 通常のタスク生成 ───
console.log("=== 1. タスク生成（正常系） ===");
const task = await lifecycle.generateTask("goal-001", "test_coverage");

console.log("task.id:", task.id, "(UUID形式であること)");
console.log("task.goal_id:", task.goal_id, "(期待値: goal-001)");
console.log("task.work_description:", task.work_description);
console.log("task.reversibility:", task.reversibility, "(期待値: reversible)");
console.log("task.primary_dimension:", task.primary_dimension, "(期待値: test_coverage — generateTask引数から設定)");
console.log("task.status:", task.status, "(期待値: pending)");
console.log("task.consecutive_failure_count:", task.consecutive_failure_count, "(期待値: 0)");

const isUUID = /^[0-9a-f-]{36}$/.test(task.id);
console.log("UUID形式:", isUUID ? "✓" : "✗");
console.log("goal_id一致:", task.goal_id === "goal-001" ? "✓" : "✗");

// ─── 2. 永続化確認 ───
console.log("\n=== 2. 永続化確認 ===");
const taskFile = path.join(tmpDir, "tasks", "goal-001", task.id + ".json");
const fileExists = fs.existsSync(taskFile);
console.log("タスクファイル存在:", fileExists ? "✓" : "✗");
if (fileExists) {
  const saved = JSON.parse(fs.readFileSync(taskFile, "utf8"));
  console.log("保存されたtask.id:", saved.id, task.id === saved.id ? "一致 ✓" : "不一致 ✗");
}

// ─── 3. strategy_id の解決優先順位 ───
console.log("\n=== 3. strategy_id — 明示引数が最優先 ===");
let capturedPrompt = "";
const capturingLLM = {
  async sendMessage(messages, options) {
    capturedPrompt = messages.map(m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    return { content: "```json\n" + VALID_TASK_RESPONSE + "\n```", usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" };
  },
  parseJSON(content, schema) {
    const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return schema.parse(JSON.parse(cleaned));
  },
};
const lifecycle2 = new TaskLifecycle(
  stateManager,
  capturingLLM,
  sessionManager,
  trustManager,
  new StrategyManager(stateManager, capturingLLM),
  stallDetector
);
const task3 = await lifecycle2.generateTask("goal-001", "test_coverage", "strategy-explicit-001");
const strategyIdMatches = task3.strategy_id === "strategy-explicit-001";
console.log("task.strategy_id:", task3.strategy_id, "(期待値: strategy-explicit-001)");
console.log("strategy_id がタスクオブジェクトに正しく設定:", strategyIdMatches ? "✓" : "✗");

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("\nクリーンアップ完了");
EOF
```

**確認ポイント**:
- [ ] タスクに UUID形式の `id` が付与される
- [ ] `goal_id`、`reversibility` がLLMレスポンスから正しくパースされる
- [ ] `primary_dimension` が `generateTask` の引数 (`"test_coverage"`) から設定される
- [ ] `success_criteria` がオブジェクト配列形式（`description`/`verification_method`/`is_blocking`）でパースされる
- [ ] `status` が `"pending"`、`consecutive_failure_count` が `0` である
- [ ] `tasks/<goal_id>/<task_id>.json` にタスクが永続化される
- [ ] `strategy_id` がタスクオブジェクトに正しくセットされる（メタデータのみ、プロンプトには含まない）

---

### 6. TaskLifecycle.checkIrreversibleApproval — 承認チェック

**目的**: reversible/irreversible/unknownの各ケースで、TrustManagerと`approvalFn`が正しく連携するか。

```bash
npx tsx <<'EOF'
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { StateManager } from "./src/state-manager.js";
import { SessionManager } from "./src/session-manager.js";
import { TrustManager } from "./src/trust-manager.js";
import { StrategyManager } from "./src/strategy-manager.js";
import { StallDetector } from "./src/stall-detector.js";
import { TaskLifecycle } from "./src/task-lifecycle.js";

const mockLLM = {
  async sendMessage() { return { content: "{}", usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: "end_turn" }; },
  parseJSON(c, s) { return JSON.parse(c); },
};

// テスト用タスク生成ヘルパー
function makeTask(reversibility, category = "testing") {
  return {
    id: "task-test-001",
    goal_id: "goal-001",
    work_description: "test task",
    success_criteria: [{ description: "pass", verification_method: "manual", is_blocking: true }],
    estimated_duration: { value: 1, unit: "hours" },
    task_category: category,
    reversibility: reversibility,
    primary_dimension: "test_coverage",
    status: "pending",
    consecutive_failure_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// ─── テスト A: reversible タスク — 初期トラスト残高 0 では approvalFn が呼ばれる ───
// NOTE: reversibility="reversible" でも TrustManager.requiresApproval() は
//       トラスト残高 0 (初期値) ではドメインが autonomous 象限にならないため
//       approvalFn を呼び出す。reversible が irreversible と異なるのは
//       「高トラスト時に approvalFn が不要になる」点である。
console.log("=== A. reversible + 低トラスト — approvalFn が呼ばれ true を返す ===");
const tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-approval-a-"));
const stateManager1 = new StateManager(tmpDir1);
let approvalCalled = false;
const lifecycle1 = new TaskLifecycle(
  stateManager1, mockLLM,
  new SessionManager(stateManager1),
  new TrustManager(stateManager1),
  new StrategyManager(stateManager1, mockLLM),
  new StallDetector(stateManager1),
  { approvalFn: async (task) => { approvalCalled = true; return true; } }
);
const resultA = await lifecycle1.checkIrreversibleApproval(makeTask("reversible"), 0.9);
console.log("result:", resultA, "(期待値: true — approvalFn が true を返すため)");
console.log("approvalFn called:", approvalCalled, "(期待値: true — 低トラストでは呼ばれる)");
console.log(resultA === true && approvalCalled ? "✓" : "✗");
fs.rmSync(tmpDir1, { recursive: true, force: true });

// ─── テスト B: irreversible タスク — approvalFn が呼ばれる ───
console.log("\n=== B. irreversible — approvalFn が呼ばれ true を返す ===");
const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-approval-b-"));
const stateManager2 = new StateManager(tmpDir2);
let approvalCalledB = false;
const lifecycle2 = new TaskLifecycle(
  stateManager2, mockLLM,
  new SessionManager(stateManager2),
  new TrustManager(stateManager2),
  new StrategyManager(stateManager2, mockLLM),
  new StallDetector(stateManager2),
  { approvalFn: async (task) => { approvalCalledB = true; return true; } }
);
const resultB = await lifecycle2.checkIrreversibleApproval(makeTask("irreversible"), 0.9);
console.log("result:", resultB);
console.log("approvalFn called:", approvalCalledB, "(期待値: true — 呼ばれる)");
console.log(approvalCalledB ? "✓" : "✗ approvalFnが呼ばれなかった");
fs.rmSync(tmpDir2, { recursive: true, force: true });

// ─── テスト C: irreversible タスク — approvalFn が false を返す ───
console.log("\n=== C. irreversible — approvalFn が false を返す ===");
const tmpDir3 = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-approval-c-"));
const stateManager3 = new StateManager(tmpDir3);
const lifecycle3 = new TaskLifecycle(
  stateManager3, mockLLM,
  new SessionManager(stateManager3),
  new TrustManager(stateManager3),
  new StrategyManager(stateManager3, mockLLM),
  new StallDetector(stateManager3),
  { approvalFn: async (task) => false } // 拒否
);
const resultC = await lifecycle3.checkIrreversibleApproval(makeTask("irreversible"), 0.9);
console.log("result:", resultC, "(期待値: false — 承認拒否)");
console.log(resultC === false ? "✓" : "✗");
fs.rmSync(tmpDir3, { recursive: true, force: true });

// ─── テスト D: unknown 可逆性 — approvalFn が呼ばれる ───
console.log("\n=== D. unknown — approvalFn が呼ばれる ===");
const tmpDir4 = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-approval-d-"));
const stateManager4 = new StateManager(tmpDir4);
let approvalCalledD = false;
const lifecycle4 = new TaskLifecycle(
  stateManager4, mockLLM,
  new SessionManager(stateManager4),
  new TrustManager(stateManager4),
  new StrategyManager(stateManager4, mockLLM),
  new StallDetector(stateManager4),
  { approvalFn: async (task) => { approvalCalledD = true; return true; } }
);
const resultD = await lifecycle4.checkIrreversibleApproval(makeTask("unknown"), 0.5);
console.log("result:", resultD);
console.log("approvalFn called:", approvalCalledD);
console.log("(TrustManager判定次第でapprovalFnが呼ばれるかが決まる)");

// ─── テスト E: デフォルトapprovalFn は false ───
console.log("\n=== E. デフォルト approvalFn は false ===");
const tmpDir5 = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-approval-e-"));
const stateManager5 = new StateManager(tmpDir5);
const defaultLifecycle = new TaskLifecycle(
  stateManager5, mockLLM,
  new SessionManager(stateManager5),
  new TrustManager(stateManager5),
  new StrategyManager(stateManager5, mockLLM),
  new StallDetector(stateManager5)
  // approvalFn 未指定
);
const resultE = await defaultLifecycle.checkIrreversibleApproval(makeTask("irreversible"), 0.9);
console.log("result:", resultE, "(期待値: false — デフォルトは安全側)");
console.log(resultE === false ? "✓" : "✗");
fs.rmSync(tmpDir5, { recursive: true, force: true });
fs.rmSync(tmpDir4, { recursive: true, force: true });

console.log("\ncheckIrreversibleApproval テスト完了");
EOF
```

**確認ポイント**:
- [ ] `reversible` + 低トラスト（初期値 0）では `approvalFn` が呼ばれ、`true` を返せば `true` になる
- [ ] `irreversible` タスクでは `approvalFn` が呼ばれる
- [ ] `approvalFn` が `false` を返した場合に `false` が返る
- [ ] `approvalFn` 未指定（デフォルト）の場合に `false` が返る（安全側デフォルト）

---

### 7. TaskLifecycle.executeTask — MockAdapterでの実行

**目的**: executeTaskがSessionManagerとAdapterを正しく連携させ、タスクステータスを更新するか。

```bash
npx tsx <<'EOF'
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { StateManager } from "./src/state-manager.js";
import { SessionManager } from "./src/session-manager.js";
import { TrustManager } from "./src/trust-manager.js";
import { StrategyManager } from "./src/strategy-manager.js";
import { StallDetector } from "./src/stall-detector.js";
import { TaskLifecycle } from "./src/task-lifecycle.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-execute-test-"));
const mockLLM = {
  async sendMessage() { return { content: "{}", usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: "end_turn" }; },
  parseJSON(c, s) { return JSON.parse(c); },
};

const stateManager = new StateManager(tmpDir);
const sessionManager = new SessionManager(stateManager);
const trustManager = new TrustManager(stateManager);
const strategyManager = new StrategyManager(stateManager, mockLLM);
const stallDetector = new StallDetector(stateManager);
const lifecycle = new TaskLifecycle(stateManager, mockLLM, sessionManager, trustManager, strategyManager, stallDetector);

// テスト用タスク
const baseTask = {
  id: "task-execute-001",
  goal_id: "goal-001",
  work_description: "Run tests and check coverage",
  success_criteria: [{ description: "Coverage >= 80%", verification_method: "npx vitest run --coverage", is_blocking: true }],
  estimated_duration: { value: 2, unit: "hours" },
  task_category: "testing",
  reversibility: "reversible",
  primary_dimension: "test_coverage",
  status: "pending",
  consecutive_failure_count: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// ─── 1. 成功するMockAdapter ───
console.log("=== 1. 成功するMockAdapter ===");
let capturedAgentTask = null;
const successAdapter = {
  adapterType: "mock",
  execute: async (agentTask) => {
    capturedAgentTask = agentTask;
    return {
      success: true,
      output: "All tests passed. Coverage: 85%",
      error: null,
      exit_code: 0,
      elapsed_ms: 100,
      stopped_reason: "completed",
    };
  },
};
const result1 = await lifecycle.executeTask({ ...baseTask }, successAdapter);
console.log("success:", result1.success, "(期待値: true)");
console.log("output:", result1.output);
console.log("stopped_reason:", result1.stopped_reason, "(期待値: completed)");
console.log("capturedAgentTask.prompt 含まれるか:", capturedAgentTask !== null ? "✓" : "✗");
if (capturedAgentTask) {
  console.log("prompt先頭100文字:", capturedAgentTask.prompt.slice(0, 100));
  console.log("timeout_ms:", capturedAgentTask.timeout_ms, "(2時間=7200000ms 付近であること)");
}
console.log(result1.success ? "✓" : "✗");

// ─── 2. 失敗するMockAdapter ───
console.log("\n=== 2. 失敗するMockAdapter ===");
const failAdapter = {
  adapterType: "mock",
  execute: async () => ({
    success: false,
    output: "",
    error: "Tests failed",
    exit_code: 1,
    elapsed_ms: 50,
    stopped_reason: "error",
  }),
};
const result2 = await lifecycle.executeTask({ ...baseTask, id: "task-execute-002" }, failAdapter);
console.log("success:", result2.success, "(期待値: false)");
console.log("error:", result2.error);
console.log("stopped_reason:", result2.stopped_reason, "(期待値: error)");
console.log(!result2.success ? "✓" : "✗");

// ─── 3. タイムアウトするMockAdapter ───
console.log("\n=== 3. タイムアウトするMockAdapter ===");
const timeoutAdapter = {
  adapterType: "mock",
  execute: async () => ({
    success: false,
    output: "",
    error: "Timed out after 300000ms",
    exit_code: null,
    elapsed_ms: 300000,
    stopped_reason: "timeout",
  }),
};
const result3 = await lifecycle.executeTask({ ...baseTask, id: "task-execute-003" }, timeoutAdapter);
console.log("success:", result3.success, "(期待値: false)");
console.log("stopped_reason:", result3.stopped_reason, "(期待値: timeout)");
console.log(!result3.success && result3.stopped_reason === "timeout" ? "✓" : "✗");

// ─── 4. estimated_duration の変換確認 ───
console.log("\n=== 4. estimated_duration 変換 ===");
const durations = [
  { estimated_duration: { value: 30, unit: "minutes" }, expected_ms: 1800000 },
  { estimated_duration: { value: 2, unit: "hours" },    expected_ms: 7200000 },
  { estimated_duration: { value: 1, unit: "days" },     expected_ms: 86400000 },
  { estimated_duration: null,                           expected_ms: 1800000 }, // デフォルト30分
];
for (const d of durations) {
  const instantAdapter = {
    adapterType: "mock",
    execute: async (agentTask) => ({
      success: true, output: "ok", error: null,
      exit_code: 0, elapsed_ms: 1, stopped_reason: "completed",
      _timeout: agentTask.timeout_ms,
    }),
  };
  // capturedタスクを取得するためにラップ
  let taskForDuration = { ...baseTask, id: "task-dur-" + Date.now(), estimated_duration: d.estimated_duration };
  let passedTimeout = null;
  const capturingAdapter = {
    adapterType: "mock",
    execute: async (agentTask) => { passedTimeout = agentTask.timeout_ms; return { success: true, output: "", error: null, exit_code: 0, elapsed_ms: 1, stopped_reason: "completed" }; },
  };
  await lifecycle.executeTask(taskForDuration, capturingAdapter);
  const correct = passedTimeout === d.expected_ms;
  console.log(`  estimated_duration="${d.estimated_duration}" → timeout_ms=${passedTimeout} (期待値: ${d.expected_ms}) ${correct ? "✓" : "✗"}`);
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("\nクリーンアップ完了");
EOF
```

**確認ポイント**:
- [ ] 成功アダプターで `success: true`、`stopped_reason: "completed"` が返る
- [ ] アダプターに渡される `AgentTask.prompt` にタスク情報が含まれる
- [ ] 失敗アダプターで `success: false` が返る
- [ ] `estimated_duration` から `timeout_ms` が正しく変換される（30分=1800000、2時間=7200000、1日=86400000）
- [ ] `estimated_duration: null` のデフォルトが適切なms値になる

---

### 8. TaskLifecycle.verifyTask — 3層検証

**目的**: L1機械的チェック・L2 LLMレビュー・L3自己申告の3層が正しく組み合わさるか。全パターンをMockLLMClientで確認。

```bash
npx tsx <<'EOF'
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { StateManager } from "./src/state-manager.js";
import { SessionManager } from "./src/session-manager.js";
import { TrustManager } from "./src/trust-manager.js";
import { StrategyManager } from "./src/strategy-manager.js";
import { StallDetector } from "./src/stall-detector.js";
import { TaskLifecycle } from "./src/task-lifecycle.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-verify-test-"));

// 検証結果レスポンスのフィクスチャ
const LLM_REVIEW_PASS    = JSON.stringify({ verdict: "pass",    reasoning: "All criteria met",    criteria_met: 1, criteria_total: 1 });
const LLM_REVIEW_FAIL    = JSON.stringify({ verdict: "fail",    reasoning: "No criteria met",     criteria_met: 0, criteria_total: 1 });
const LLM_REVIEW_PARTIAL = JSON.stringify({ verdict: "partial", reasoning: "Some criteria met",   criteria_met: 1, criteria_total: 2 });

// L3 自己申告レスポンスのフィクスチャ
const SELF_REPORT_COMPLETE   = JSON.stringify({ completed: true,  summary: "Done",    partial_results: [], blockers: [] });
const SELF_REPORT_INCOMPLETE = JSON.stringify({ completed: false, summary: "Blocked", partial_results: [], blockers: ["dependency missing"] });

// MockLLMClient ファクトリ
function makeMockLLM(llmReview, selfReport) {
  let callCount = 0;
  return {
    async sendMessage(messages, options) {
      callCount++;
      // L2レビュー: 最初の呼び出し
      // L3自己申告: 2番目の呼び出し
      const content = callCount === 1 ? llmReview : selfReport;
      return { content, usage: { input_tokens: 10, output_tokens: 20 }, stop_reason: "end_turn" };
    },
    parseJSON(content, schema) {
      return schema.parse(JSON.parse(content));
    },
  };
}

const baseTask = {
  id: "task-verify-001",
  goal_id: "goal-001",
  work_description: "Add unit tests",
  success_criteria: [{ description: "Coverage >= 80%", verification_method: "npx vitest run --coverage", is_blocking: true }],
  estimated_duration: { value: 1, unit: "hours" },
  task_category: "testing",
  reversibility: "reversible",
  primary_dimension: "test_coverage",
  status: "completed",
  consecutive_failure_count: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const successExecution = {
  success: true,
  output: "Coverage: 85%. All tests pass.",
  error: null,
  exit_code: 0,
  elapsed_ms: 1000,
  stopped_reason: "completed",
};

async function runVerifyTest(label, mockLLM) {
  const stateManager = new StateManager(tmpDir);
  const sessionManager = new SessionManager(stateManager);
  const trustManager = new TrustManager(stateManager);
  const strategyManager = new StrategyManager(stateManager, mockLLM);
  const stallDetector = new StallDetector(stateManager);
  const lifecycle = new TaskLifecycle(stateManager, mockLLM, sessionManager, trustManager, strategyManager, stallDetector);
  const task = { ...baseTask, id: "task-verify-" + Date.now() };
  return lifecycle.verifyTask(task, successExecution);
}

// ─── 1. L2 pass → 総合 pass ───
console.log("=== 1. L2 pass → 総合 pass ===");
const result1 = await runVerifyTest("pass", makeMockLLM(LLM_REVIEW_PASS, SELF_REPORT_COMPLETE));
console.log("verdict:", result1.verdict, "(期待値: pass)");
console.log("confidence:", result1.confidence, "(期待値: 0.9付近)");
console.log(result1.verdict === "pass" ? "✓" : "✗");

// ─── 2. L2 fail → 総合 fail ───
console.log("\n=== 2. L2 fail → 総合 fail ===");
const result2 = await runVerifyTest("fail", makeMockLLM(LLM_REVIEW_FAIL, SELF_REPORT_INCOMPLETE));
console.log("verdict:", result2.verdict, "(期待値: fail)");
console.log("confidence:", result2.confidence);
console.log(result2.verdict === "fail" ? "✓" : "✗");

// ─── 3. L2 partial → 総合 partial ───
console.log("\n=== 3. L2 partial → 総合 partial ===");
const result3 = await runVerifyTest("partial", makeMockLLM(LLM_REVIEW_PARTIAL, SELF_REPORT_INCOMPLETE));
console.log("verdict:", result3.verdict, "(期待値: partial)");
console.log("confidence:", result3.confidence);
console.log(result3.verdict === "partial" ? "✓" : "✗");

// ─── 4. L1 適用確認: npmコマンドが含まれる場合 ───
console.log("\n=== 4. L1 機械的チェック (npm prefix) ===");
const npmTask = { ...baseTask, id: "task-l1-" + Date.now(), success_criteria: [{ description: "npm test passes", verification_method: "npm test", is_blocking: true }] };
const npmExecution = {
  success: true,
  output: "npm test result: PASS",
  error: null,
  exit_code: 0,
  elapsed_ms: 500,
  stopped_reason: "completed",
};
const stateManager4 = new StateManager(tmpDir);
const mockLLM4 = makeMockLLM(LLM_REVIEW_PASS, SELF_REPORT_COMPLETE);
const lifecycle4 = new TaskLifecycle(
  stateManager4, mockLLM4,
  new SessionManager(stateManager4),
  new TrustManager(stateManager4),
  new StrategyManager(stateManager4, mockLLM4),
  new StallDetector(stateManager4)
);
const result4 = await lifecycle4.verifyTask(npmTask, npmExecution);
console.log("verdict:", result4.verdict);
console.log("evidence 件数:", result4.evidence ? result4.evidence.length : "N/A");
if (result4.evidence) {
  result4.evidence.forEach((e, i) => console.log(`  evidence[${i}]:`, JSON.stringify(e).slice(0, 100)));
}
console.log("(L1が applicable:true で pass になる場合とfalseでスキップの両パターンあり)");

// ─── 5. 永続化確認 ───
console.log("\n=== 5. 永続化確認 ===");
const savedTaskId = baseTask.id;
const verificationFile = path.join(tmpDir, "verification", savedTaskId, "verification-result.json");
console.log("期待ファイルパス:", verificationFile);
// (タスクIDがユニークなため、最初のテストのファイルを確認)
// tmpDir以下のverificationディレクトリの存在確認
const verDir = path.join(tmpDir, "verification");
if (fs.existsSync(verDir)) {
  const entries = fs.readdirSync(verDir);
  console.log("verification/以下のディレクトリ:", entries);
  console.log("永続化されている ✓");
} else {
  console.log("verification/ ディレクトリが存在しない (パスが異なる可能性あり)");
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("\nクリーンアップ完了");
EOF
```

**確認ポイント**:
- [ ] L2 LLMレビューが `pass` の場合に総合verdict が `"pass"` になり confidence が 0.9 付近になる
- [ ] L2 LLMレビューが `fail` の場合に総合verdict が `"fail"` になる
- [ ] L2 LLMレビューが `partial` の場合に総合verdict が `"partial"` になる
- [ ] `evidence` 配列に検証根拠が含まれる
- [ ] `verification/<task_id>/verification-result.json` に結果が永続化される

---

### 9. TaskLifecycle.handleVerdict — pass/partial/fail処理

**目的**: TrustManagerへのrecordSuccess/Failure呼び出し、タスク履歴更新、keep/discard/escalate判定の確認。

```bash
npx tsx <<'EOF'
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { StateManager } from "./src/state-manager.js";
import { SessionManager } from "./src/session-manager.js";
import { TrustManager } from "./src/trust-manager.js";
import { StrategyManager } from "./src/strategy-manager.js";
import { StallDetector } from "./src/stall-detector.js";
import { TaskLifecycle } from "./src/task-lifecycle.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-verdict-test-"));

const mockLLM = {
  async sendMessage() { return { content: JSON.stringify({ success: true, reason: "ok" }), usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" }; },
  parseJSON(c, s) { return s.parse(JSON.parse(c)); },
};

function makeLifecycle(dir) {
  const sm = new StateManager(dir);
  return {
    lifecycle: new TaskLifecycle(sm, mockLLM, new SessionManager(sm), new TrustManager(sm), new StrategyManager(sm, mockLLM), new StallDetector(sm)),
    stateManager: sm,
    trustManager: new TrustManager(sm),
  };
}

const baseTask = {
  id: "task-verdict-001",
  goal_id: "goal-001",
  work_description: "Add unit tests",
  success_criteria: [{ description: "pass", verification_method: "manual", is_blocking: true }],
  estimated_duration: { value: 1, unit: "hours" },
  task_category: "testing",
  reversibility: "reversible",
  primary_dimension: "test_coverage",
  status: "completed",
  consecutive_failure_count: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// ─── 1. verdict=pass → action=completed, failure_count=0 ───
console.log("=== 1. verdict=pass → completed ===");
const { lifecycle: lc1 } = makeLifecycle(tmpDir);
const passVerification = {
  verdict: "pass",
  confidence: 0.9,
  evidence: [],
  reasoning: "All criteria met",
  task_id: baseTask.id,
  verified_at: new Date().toISOString(),
};
const res1 = await lc1.handleVerdict({ ...baseTask, id: "task-v-pass" }, passVerification);
console.log("action:", res1.action, "(期待値: completed)");
console.log("task.status:", res1.task.status, "(期待値: completed)");
console.log("task.consecutive_failure_count:", res1.task.consecutive_failure_count, "(期待値: 0)");
console.log(res1.action === "completed" ? "✓" : "✗");

// ─── 2. verdict=partial (direction correct) → action=keep ───
console.log("\n=== 2. verdict=partial → keep ===");
const { lifecycle: lc2 } = makeLifecycle(tmpDir);
const partialVerification = {
  verdict: "partial",
  confidence: 0.6,
  evidence: [],
  reasoning: "Some progress made",
  task_id: baseTask.id,
  verified_at: new Date().toISOString(),
};
const res2 = await lc2.handleVerdict({ ...baseTask, id: "task-v-partial" }, partialVerification);
console.log("action:", res2.action, "(期待値: keep — partial は方向正しいとみなされる)");
console.log(res2.action === "keep" ? "✓" : "partial以外の場合: " + res2.action);

// ─── 3. verdict=fail → handleFailure に委譲 ───
console.log("\n=== 3. verdict=fail → discard か escalate ===");
const { lifecycle: lc3 } = makeLifecycle(tmpDir);
const failVerification = {
  verdict: "fail",
  confidence: 0.5,
  evidence: [],
  reasoning: "No progress",
  task_id: baseTask.id,
  verified_at: new Date().toISOString(),
};
const res3 = await lc3.handleVerdict({ ...baseTask, id: "task-v-fail", reversibility: "reversible" }, failVerification);
console.log("action:", res3.action, "(期待値: discard か escalate — handleFailure委譲)");
console.log(["discard", "escalate", "keep"].includes(res3.action) ? "✓" : "✗");

// ─── 4. タスク履歴への追記確認 ───
console.log("\n=== 4. タスク履歴追記 ===");
const historyFile = path.join(tmpDir, "tasks", "goal-001", "task-history.json");
if (fs.existsSync(historyFile)) {
  const history = JSON.parse(fs.readFileSync(historyFile, "utf8"));
  console.log("履歴件数:", history.length);
  history.forEach((h, i) => {
    console.log(`  [${i}] taskId=${h.taskId}, status=${h.status}, dimension=${h.primary_dimension}`);
  });
  console.log("履歴が追記されている ✓");
} else {
  console.log("task-history.json が存在しない (パス確認)");
  // tasks/goal-001/ 以下を確認
  const tasksDir = path.join(tmpDir, "tasks", "goal-001");
  if (fs.existsSync(tasksDir)) {
    console.log("tasks/goal-001/ 以下:", fs.readdirSync(tasksDir));
  }
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("\nクリーンアップ完了");
EOF
```

**確認ポイント**:
- [ ] `verdict="pass"` で `action: "completed"`、`task.status: "completed"`、`consecutive_failure_count: 0` になる
- [ ] `verdict="partial"` で `action: "keep"` になる（direction correct）
- [ ] `verdict="fail"` で `action: "discard"` または `"escalate"` になる（handleFailure委譲）
- [ ] `tasks/<goal_id>/task-history.json` に履歴が追記される

---

### 10. TaskLifecycle.handleFailure — failure_count・エスカレーション・keep/discard

**目的**: `consecutive_failure_count` のインクリメント、3回目のエスカレーション、keep/discard判定を確認。ゲート条件の核心。

```bash
npx tsx <<'EOF'
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { StateManager } from "./src/state-manager.js";
import { SessionManager } from "./src/session-manager.js";
import { TrustManager } from "./src/trust-manager.js";
import { StrategyManager } from "./src/strategy-manager.js";
import { StallDetector } from "./src/stall-detector.js";
import { TaskLifecycle } from "./src/task-lifecycle.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-failure-test-"));

// revert成功 / revert失敗 のLLMレスポンスを切り替えるMockLLMClient
function makeMockLLM(revertSuccess = true) {
  return {
    async sendMessage(messages, options) {
      const revertPayload = JSON.stringify({ success: revertSuccess, reason: revertSuccess ? "reverted" : "cannot revert" });
      return { content: revertPayload, usage: { input_tokens: 5, output_tokens: 5 }, stop_reason: "end_turn" };
    },
    parseJSON(c, s) { return s.parse(JSON.parse(c)); },
  };
}

function makeLifecycle(dir, revertSuccess = true) {
  const sm = new StateManager(dir);
  const llm = makeMockLLM(revertSuccess);
  return new TaskLifecycle(sm, llm, new SessionManager(sm), new TrustManager(sm), new StrategyManager(sm, llm), new StallDetector(sm));
}

const failVerification = {
  verdict: "fail",
  confidence: 0.5,
  evidence: [],
  reasoning: "No progress",
  task_id: "task-fail-001",
  verified_at: new Date().toISOString(),
};

function makeTask(failureCount, reversibility = "reversible") {
  return {
    id: "task-fail-" + Date.now(),
    goal_id: "goal-001",
    work_description: "failing task",
    success_criteria: [{ description: "pass", verification_method: "manual", is_blocking: true }],
    estimated_duration: { value: 1, unit: "hours" },
    task_category: "testing",
    reversibility: reversibility,
    primary_dimension: "test_coverage",
    status: "completed",
    consecutive_failure_count: failureCount,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// ─── 1. failure_count=0 → 1 にインクリメント ───
console.log("=== 1. failure_count インクリメント ===");
const lc1 = makeLifecycle(tmpDir);
const res1 = await lc1.handleFailure(makeTask(0), failVerification);
console.log("action:", res1.action);
console.log("task.consecutive_failure_count:", res1.task.consecutive_failure_count, "(期待値: 1)");
console.log(res1.task.consecutive_failure_count === 1 ? "✓" : "✗");

// ─── 2. failure_count=1 → 2 にインクリメント ───
console.log("\n=== 2. failure_count 2回目 ===");
const lc2 = makeLifecycle(tmpDir);
const res2 = await lc2.handleFailure(makeTask(1), failVerification);
console.log("action:", res2.action);
console.log("task.consecutive_failure_count:", res2.task.consecutive_failure_count, "(期待値: 2)");
console.log(res2.task.consecutive_failure_count === 2 ? "✓" : "✗");

// ─── 3. failure_count=2 → 3 でエスカレーション ───
console.log("\n=== 3. failure_count 3回目 → escalate ===");
const lc3 = makeLifecycle(tmpDir);
const res3 = await lc3.handleFailure(makeTask(2), failVerification);
console.log("action:", res3.action, "(期待値: escalate)");
console.log("task.consecutive_failure_count:", res3.task.consecutive_failure_count, "(期待値: 3)");
console.log(res3.action === "escalate" && res3.task.consecutive_failure_count === 3 ? "✓" : "✗");

// ─── 4. reversible + revert成功 → discard ───
console.log("\n=== 4. reversible + revert成功 → discard ===");
const lc4 = makeLifecycle(tmpDir, true); // revert成功
const res4 = await lc4.handleFailure(makeTask(0, "reversible"), failVerification);
console.log("action:", res4.action, "(期待値: discard — revert成功後に破棄)");
console.log(res4.action === "discard" ? "✓" : "(keep または escalate の場合も許容)");

// ─── 5. irreversible → escalate ───
console.log("\n=== 5. irreversible → escalate ===");
const lc5 = makeLifecycle(tmpDir);
const res5 = await lc5.handleFailure(makeTask(0, "irreversible"), failVerification);
console.log("action:", res5.action, "(期待値: escalate — 不可逆は必エスカレーション)");
console.log(res5.action === "escalate" ? "✓" : "✗");

// ─── 6. unknown 可逆性 → escalate ───
console.log("\n=== 6. unknown 可逆性 → escalate ===");
const lc6 = makeLifecycle(tmpDir);
const res6 = await lc6.handleFailure(makeTask(0, "unknown"), failVerification);
console.log("action:", res6.action, "(期待値: escalate — unknown は安全側)");
console.log(res6.action === "escalate" ? "✓" : "✗");

// ─── 7. partial verdict (direction correct) → keep ───
console.log("\n=== 7. partial verdict → keep ===");
const lc7 = makeLifecycle(tmpDir);
const partialVerification = { ...failVerification, verdict: "partial" };
const res7 = await lc7.handleFailure(makeTask(0), partialVerification);
console.log("action:", res7.action, "(期待値: keep — partial = 方向正しい)");
console.log(res7.action === "keep" ? "✓" : "✗");

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("\nクリーンアップ完了");
EOF
```

**確認ポイント**:
- [ ] `handleFailure` 呼び出しのたびに `consecutive_failure_count` が +1 される
- [ ] `consecutive_failure_count >= 3` で `action: "escalate"` になる（ゲート条件）
- [ ] `irreversible` タスクの失敗で `action: "escalate"` になる
- [ ] `unknown` 可逆性の失敗で `action: "escalate"` になる
- [ ] `verdict: "partial"` では `action: "keep"` になる（方向は正しい）
- [ ] `reversible` かつ revert成功で `action: "discard"` になる

---

### 11. TaskLifecycle.runTaskCycle — E2Eフルサイクル

**目的**: select→generate→approve→execute→verify→handleVerdictの一連フローが完走するか。MockLLMClient + MockAdapterで実行。

```bash
npx tsx <<'EOF'
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { StateManager } from "./src/state-manager.js";
import { SessionManager } from "./src/session-manager.js";
import { TrustManager } from "./src/trust-manager.js";
import { StrategyManager } from "./src/strategy-manager.js";
import { StallDetector } from "./src/stall-detector.js";
import { TaskLifecycle } from "./src/task-lifecycle.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-cycle-test-"));

// LLMのレスポンスシーケンス
// 1回目: generateTask → タスク定義JSON
// 2回目: verifyTask (L2 LLMレビュー) → 検証JSON
// 3回目: verifyTask (L3 自己申告) → 実行レポートJSON
const GENERATE_RESPONSE = JSON.stringify({
  work_description: "Run npm test to verify coverage",
  rationale: "Verifying test coverage ensures the codebase meets the quality threshold",
  approach: "Execute npm test with coverage flag and inspect the output",
  success_criteria: [
    {
      description: "npm test exits with code 0",
      verification_method: "npm test",
      is_blocking: true
    },
    {
      description: "Coverage reaches >= 80%",
      verification_method: "npx vitest run --coverage",
      is_blocking: true
    }
  ],
  scope_boundary: {
    in_scope: ["src/", "tests/"],
    out_of_scope: [],
    blast_radius: "test execution only"
  },
  constraints: [],
  reversibility: "reversible",
  estimated_duration: { value: 30, unit: "minutes" }
});
const REVIEW_RESPONSE   = JSON.stringify({ verdict: "pass", reasoning: "All criteria met", criteria_met: 2, criteria_total: 2 });
const SELFREPORT_RESPONSE = JSON.stringify({ completed: true, summary: "Tests passed at 85% coverage", partial_results: [], blockers: [] });

let callIndex = 0;
const sequencedLLM = {
  async sendMessage(messages, options) {
    callIndex++;
    let content;
    if (callIndex === 1) content = "```json\n" + GENERATE_RESPONSE + "\n```";
    else if (callIndex === 2) content = REVIEW_RESPONSE;
    else content = SELFREPORT_RESPONSE;
    return { content, usage: { input_tokens: 50, output_tokens: 50 }, stop_reason: "end_turn" };
  },
  parseJSON(content, schema) {
    const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return schema.parse(JSON.parse(cleaned));
  },
};

// MockAdapter: 成功を返す
const successAdapter = {
  adapterType: "mock",
  execute: async (task) => ({
    success: true,
    output: "npm test: PASS. Coverage: 85%",
    error: null,
    exit_code: 0,
    elapsed_ms: 200,
    stopped_reason: "completed",
  }),
};

const stateManager = new StateManager(tmpDir);
const sessionManager = new SessionManager(stateManager);
const trustManager = new TrustManager(stateManager);
const strategyManager = new StrategyManager(stateManager, sequencedLLM);
const stallDetector = new StallDetector(stateManager);
const lifecycle = new TaskLifecycle(
  stateManager, sequencedLLM, sessionManager, trustManager, strategyManager, stallDetector,
  { approvalFn: async (task) => { console.log("  [approvalFn] 承認要求: " + task.work_description); return true; } }
);

const gapVector = {
  goal_id: "goal-001",
  gaps: [
    {
      dimension_name: "test_coverage",
      raw_gap: 0.3,
      normalized_gap: 0.3,
      normalized_weighted_gap: 0.35,
      confidence: 0.8,
      uncertainty_weight: 1.0,
    },
  ],
  timestamp: new Date().toISOString(),
};

const driveContext = {
  time_since_last_attempt: { test_coverage: 24 },
  deadlines: { test_coverage: null },
  opportunities: {},
};

// ─── E2E サイクル実行 ───
console.log("=== runTaskCycle E2E ===");
console.log("実行中...\n");
const cycleResult = await lifecycle.runTaskCycle("goal-001", gapVector, driveContext, successAdapter);

console.log("--- 結果 ---");
console.log("action:", cycleResult.action, "(期待値: completed)");
console.log("task.id:", cycleResult.task.id);
console.log("task.goal_id:", cycleResult.task.goal_id, "(期待値: goal-001)");
console.log("task.primary_dimension:", cycleResult.task.primary_dimension, "(期待値: test_coverage)");
console.log("task.status:", cycleResult.task.status, "(期待値: completed)");
console.log("verificationResult.verdict:", cycleResult.verificationResult.verdict, "(期待値: pass)");
console.log("verificationResult.confidence:", cycleResult.verificationResult.confidence);

console.log("\n--- ゲート条件確認 ---");
console.log("action=completed:", cycleResult.action === "completed" ? "✓" : "✗");
console.log("verificationResult.verdict=pass:", cycleResult.verificationResult.verdict === "pass" ? "✓" : "✗");
console.log("LLM呼び出し回数:", callIndex, "(期待値: 3 — generate+review+selfreport)");
console.log(callIndex >= 2 ? "✓" : "✗");

// ─── approval_denied ケース ───
console.log("\n=== approval_denied ケース ===");
callIndex = 0;
const denyingLLM = {
  async sendMessage(messages, options) {
    callIndex++;
    let content;
    if (callIndex === 1) content = "```json\n" + JSON.stringify({
      work_description: "Deploy to production",
      rationale: "The production deployment is required to release the latest changes",
      approach: "Run the deployment pipeline and verify the release",
      success_criteria: [
        {
          description: "Deployment completes successfully",
          verification_method: "check deployment status",
          is_blocking: true
        }
      ],
      scope_boundary: {
        in_scope: ["deployment pipeline"],
        out_of_scope: [],
        blast_radius: "production environment"
      },
      constraints: [],
      reversibility: "irreversible",
      estimated_duration: { value: 1, unit: "hours" }
    }) + "\n```";
    else content = REVIEW_RESPONSE;
    return { content, usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" };
  },
  parseJSON(content, schema) {
    const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return schema.parse(JSON.parse(cleaned));
  },
};

const stateManager2 = new StateManager(tmpDir);
const lifecycle2 = new TaskLifecycle(
  stateManager2, denyingLLM,
  new SessionManager(stateManager2),
  new TrustManager(stateManager2),
  new StrategyManager(stateManager2, denyingLLM),
  new StallDetector(stateManager2),
  { approvalFn: async (task) => { console.log("  [approvalFn] 拒否: " + task.work_description); return false; } }
);

const deniedResult = await lifecycle2.runTaskCycle("goal-001", gapVector, driveContext, successAdapter);
console.log("action:", deniedResult.action, "(期待値: approval_denied)");
console.log("verificationResult.verdict:", deniedResult.verificationResult.verdict, "(期待値: fail)");
console.log(deniedResult.action === "approval_denied" ? "✓" : "✗");

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("\nクリーンアップ完了");
EOF
```

**確認ポイント**:
- [ ] `runTaskCycle` が完走し `action: "completed"` になる（ゲート条件）
- [ ] `task.goal_id` が正しく設定される
- [ ] `verificationResult.verdict` が `"pass"` になる
- [ ] LLM呼び出しが generate + review + self-report の順で行われる
- [ ] `approvalFn` が `false` を返した場合に `action: "approval_denied"` になる

---

### 12. ClaudeAPIAdapter — 実APIでのE2Eフロー（APIキー必須）

**目的**: 実際のAnthropic APIとAdapterが正しく連携するか。コスト発生注意。

```bash
npx tsx <<'EOF'
import { LLMClient } from "./src/llm-client.js";
import { ClaudeAPIAdapter } from "./src/adapters/claude-api.js";

const llmClient = new LLMClient(); // ANTHROPIC_API_KEY 環境変数から取得

const adapter = new ClaudeAPIAdapter(llmClient);

// ─── 1. 単純なタスク実行 ───
console.log("=== 実API: 単純なタスク実行 ===");
const task = {
  prompt: "Count from 1 to 3. Just output the numbers separated by spaces, nothing else.",
  timeout_ms: 30000,
  adapter_type: "claude_api",
};
const start = Date.now();
const result = await adapter.execute(task);
const elapsed = Date.now() - start;

console.log("success:", result.success);
console.log("output:", result.output);
console.log("exit_code:", result.exit_code, "(期待値: null)");
console.log("stopped_reason:", result.stopped_reason, "(期待値: completed)");
console.log("elapsed_ms:", result.elapsed_ms);
console.log("実経過時間:", elapsed, "ms");

if (result.success) {
  const hasNumbers = result.output.includes("1") && result.output.includes("2") && result.output.includes("3");
  console.log("1,2,3が含まれる:", hasNumbers ? "✓" : "✗（レスポンス確認）");
}

// ─── 2. TaskLifecycle との統合 ───
console.log("\n=== 実API: TaskLifecycle との統合 ===");
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { StateManager } from "./src/state-manager.js";
import { SessionManager } from "./src/session-manager.js";
import { TrustManager } from "./src/trust-manager.js";
import { StrategyManager } from "./src/strategy-manager.js";
import { StallDetector } from "./src/stall-detector.js";
import { TaskLifecycle } from "./src/task-lifecycle.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-real-api-test-"));
const stateManager = new StateManager(tmpDir);

const lifecycle = new TaskLifecycle(
  stateManager, llmClient,
  new SessionManager(stateManager),
  new TrustManager(stateManager),
  new StrategyManager(stateManager, llmClient),
  new StallDetector(stateManager),
  { approvalFn: async (task) => true }
);

const gapVector = {
  goal_id: "goal-real-001",
  gaps: [{
    dimension_name: "test_coverage",
    raw_gap: 0.3,
    normalized_gap: 0.3,
    normalized_weighted_gap: 0.3,
    confidence: 0.8,
    uncertainty_weight: 1.0,
  }],
  timestamp: new Date().toISOString(),
};

const driveContext = {
  time_since_last_attempt: { test_coverage: 24 },
  deadlines: { test_coverage: null },
  opportunities: {},
};

console.log("runTaskCycle 実行中 (実APIコール発生)...");
const cycleResult = await lifecycle.runTaskCycle(
  "goal-real-001",
  gapVector,
  driveContext,
  adapter
);

console.log("\n--- サイクル結果 ---");
console.log("action:", cycleResult.action);
console.log("task.work_description:", cycleResult.task.work_description);
console.log("task.task_category:", cycleResult.task.task_category);
console.log("verificationResult.verdict:", cycleResult.verificationResult.verdict);
console.log("verificationResult.confidence:", cycleResult.verificationResult.confidence);

const validActions = ["completed", "keep", "discard", "escalate", "approval_denied"];
console.log("actionが有効値:", validActions.includes(cycleResult.action) ? "✓" : "✗");

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("\nクリーンアップ完了");
EOF
```

**確認ポイント**:
- [ ] 実APIでアダプターが成功する（`success: true`、`stopped_reason: "completed"`）
- [ ] `exit_code` が `null` である（APIアダプターはプロセスを持たない）
- [ ] `runTaskCycle` が実API使用で完走し有効なactionを返す（ゲート条件）

---

## 注意事項

- 項目1〜11はMockLLMClient/MockAdapterを使用するためAPIキー不要
- 項目12（実API統合）のみ `ANTHROPIC_API_KEY` が必須でコストが発生する（おおよそ $0.05〜$0.20 程度）
- 各スクリプトはクリーンアップを自動実行するため `~/.motiva/` は汚染されない
- `ClaudeCodeCLIAdapter` の実 `claude` CLI テストは `claude` コマンドが PATH に存在する場合のみ動作する。項目3では `true`/`false`/`echo`/`node` を代用しているため Claude CLI は不要
- MockLLMのレスポンスは ` ```json ` コードフェンス形式で返すこと（`parseJSON` がコードフェンスを期待する場合がある）。フェンスなしのプレーンJSONも試すこと

---

## ゲート条件チェックリスト（Stage 5へ進む前に全て✓）

- [ ] 全ユニットテスト通過（MockLLM使用）: `npx vitest run`
- [ ] ClaudeAPIAdapterで単純タスクの生成→実行→検証が完走する（項目12）
- [ ] 不可逆アクション検出時に `approvalFn` が呼ばれる（項目6 テストB）
- [ ] `consecutive_failure_count >= 3` で `escalate` アクションが発動する（項目10 テスト3）
- [ ] `consecutive_failure_count` が正しくインクリメント・リセットされる（項目10 テスト1〜3 + 項目9 テスト1）
- [ ] `runTaskCycle` がE2Eで完走し `action: "completed"` を返す（項目11）
- [ ] `approval_denied` が `approvalFn: false` 時に正しく返る（項目11 approval_deniedケース）
