# Codex CLI as ILLMClient Backend — Research

Date: 2026-03-15

## Summary

Using `codex exec` as an ILLMClient backend is **technically possible but has serious caveats**.
The better approach is `@openai/codex-sdk` (TypeScript library) which avoids raw process management.
For the specific use-case of structured JSON LLM calls in Motiva (5-10+ per loop iteration),
spawning `codex exec` per call has too much overhead. The SDK mitigates this with thread reuse.

---

## A. Can `codex exec "Return only JSON: ..."` reliably return just JSON text on stdout?

**Answer: Mostly yes, but not perfectly.** [Confirmed]

- Default behavior (no flags): progress information goes to **stderr**, final agent message goes to **stdout** only.
  Source: https://developers.openai.com/codex/noninteractive/
- This means `stdout` capture is relatively clean by default.
- However, "final agent message" is whatever the agent decided to say — it can include reasoning text,
  preamble, or markdown formatting before/after the JSON object.
- The existing `extractJSON()` in `llm-client.ts` already handles markdown code blocks (`\`\`\`json ... \`\`\``),
  so the contamination problem is partially pre-solved.
- **Risk**: The agent may add conversational text around the JSON even when prompted to return only JSON.
  This is model-dependent and not guaranteed to be clean.

---

## B. Does `codex exec` add extra output (status messages, thinking, etc.) that pollutes JSON parsing?

**Answer: Status messages go to stderr (clean). Reasoning/thinking in the final message is a risk.** [Confirmed]

- All progress events, tool call logs, and status messages → **stderr** (not stdout).
- Only the final assistant turn message → **stdout**.
- BUT: codex uses reasoning models (o4-mini, o3). These models may include explicit `<thinking>` blocks
  or verbose preamble in the final message text itself.
- The `--json` / `--experimental-json` flag makes stdout a JSONL event stream (one JSON object per line),
  which is parsable but requires filtering for the `turn.completed` event to extract the final message.
- With `--json`, you cannot simply `JSON.parse(stdout)` — you must parse each line and find the right event.

---

## C. Is there a `--quiet` or `--output-last-message` flag to get clean output?

**Answer: Yes — `--output-last-message` / `-o` is merged and available.** [Confirmed]

- `--output-last-message <path>` / `-o <path>`: writes the final assistant message to a file.
  PR #4644 merged 2025-10-03. Source: https://github.com/openai/codex/issues/1670
- This is for file output. Combined with stdout capture, stdout still gets the final message too.
- There is **no `--quiet` flag** listed in the CLI reference.
- **For Motiva's use case**, `-o /tmp/codex-response.json` + reading the file would give the cleanest
  output, bypassing any stdout contamination from terminal control codes.

---

## D. What about `--json` flag — does it output structured events we could parse?

**Answer: Yes, but it is a JSONL event stream, not a single JSON object.** [Confirmed]

Flag: `--json` (stable) or `--experimental-json` (older name, being renamed).
Source: https://developers.openai.com/codex/cli/reference, issue #2288

Event types emitted on stdout as JSONL:
- `thread.started`
- `turn.started`
- `turn.completed` ← this contains the final response
- `turn.failed`
- `item.*` (agent messages, reasoning, command executions, file changes, MCP tool calls)
- `error`

To use `--json` for ILLMClient:
1. Capture stdout line by line
2. JSON.parse each line
3. Filter for `turn.completed` event
4. Extract the message content from that event

This is **parseable but requires a small parser**. It does have the advantage of giving token counts
and structured metadata if needed.

**There is also `--output-schema <path>`**: accepts a JSON Schema file describing the expected
final response shape. This is the cleanest approach for structured output — it instructs the model
to conform to a schema. Equivalent to OpenAI's structured outputs / response_format.

---

## E. Performance: overhead of spawning `codex exec` per internal LLM call

**Answer: Prohibitively expensive for Motiva's use case.** [Confirmed with high confidence]

Motiva makes 5-10+ LLM calls per loop iteration (goal decomposition, gap analysis, task generation,
L1/L2 verification, satisficing judgement, stall detection, etc.).

Overhead per `codex exec` spawn:
- Process startup: ~200-500ms (Node.js/Rust binary startup)
- Session initialization: Codex scans git history/metadata on startup (expensive operation)
  Note: a recent update "reduced sub-agent startup overhead by skipping expensive history metadata
  scans for subagent spawns" — so this may be partially mitigated in latest versions.
- Network round-trip to OpenAI API: ~500ms-2s (same as direct API call)
- Total per call: estimated **1-3 seconds overhead** on top of the LLM response time

At 5-10 calls per loop with 1-3s overhead each = **5-30 seconds of pure overhead per loop iteration**.
This is unacceptable for an orchestration loop that aims to be responsive.

**Contrast with direct API client (OpenAILLMClient / LLMClient)**:
- Single persistent HTTP client, no process spawn
- Only the API network latency (500ms-2s)
- 5-10 calls = 2.5-20s of API time (no extra overhead)

---

## F. Is there a better approach? Codex SDK / library mode?

**Answer: Yes — `@openai/codex-sdk` is the right approach if Codex must be used.** [Confirmed]

Package: `@openai/codex-sdk` (npm), latest ~0.112.0
TypeScript/Node.js 18+ native.
Source: https://developers.openai.com/codex/sdk/, https://dev.to/kachurun/openai-codex-as-a-native-agent-in-your-typescript-nodejs-app-kii

### How it works

The SDK wraps the Codex CLI binary internally — it spawns the process once and communicates via
JSONL over stdin/stdout pipes (pipe mode). You do not manage stdin/stdout yourself.

```typescript
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread(); // spawns once

// Reuse the thread for multiple prompts:
const result = await thread.run("Return only JSON: { ... }");
// result.finalResponse = the assistant's final message string
// result.items = array of events (messages, reasoning, commands, etc.)
```

Key properties:
- `thread.run(prompt)` → returns `{ finalResponse: string, items: [...] }`
- `thread.runStreamed(prompt)` → async generator of structured events
- Threads are persisted in `~/.codex/sessions` (or use `--ephemeral` equiv)

### Performance with SDK thread reuse

- **Spawn once per thread**: no per-call process startup overhead
- **Call `thread.run()` repeatedly**: subsequent calls are just message passing over the open pipe
- Still has the API network round-trip per call (unavoidable)
- **Estimated per-call overhead with thread reuse**: ~50-100ms (pipe message, no spawn)

### Caveats

1. The SDK wraps the CLI binary — it still requires `codex` CLI to be installed.
2. Internal protocol (JSONL pipe format) may change frequently (unstable as of 2025).
3. The DEV article notes: "only works with the Native (Rust) version" of Codex.
4. No direct equivalent to `system` prompt or `max_tokens` / `temperature` parameters
   (these are configured via Codex profiles/config, not per-call parameters).
5. The `ILLMClient` interface uses `LLMRequestOptions` with `model`, `max_tokens`, `system`,
   `temperature` — these would not map cleanly to the SDK's thread model.
6. `result.items` may include reasoning blocks; extracting just the text requires filtering.

---

## Recommendation for Motiva

### Option 1: Do NOT use `codex exec` as ILLMClient (Recommended for internal calls)

For Motiva's internal LLM calls (goal decomposition, scoring, verification), use:
- `LLMClient` (Anthropic) — existing, production-ready
- `OpenAILLMClient` — existing, direct API, no overhead
- `OllamaLLMClient` — existing, local, no overhead

These are all real HTTP API clients. They have zero process-spawn overhead and map cleanly to
the `ILLMClient` interface with full control over `model`, `max_tokens`, `temperature`, `system`.

**`codex exec` / Codex SDK is the wrong abstraction for ILLMClient** — it is an agent execution
environment, not a simple prompt→response LLM client. It brings extra complexity (file access,
tool calls, git integration) that Motiva does not need for internal reasoning calls.

### Option 2: CodexLLMClient via SDK (if Codex models are specifically required)

If you need to call `o4-mini` / `o3` reasoning models via Codex for Motiva's internal LLM calls,
the correct path is:

**Use `OpenAILLMClient` directly** — the existing `src/openai-client.ts` already supports the
OpenAI API, which exposes `o4-mini` and `o3` directly. No Codex CLI needed at all.

```
MOTIVA_LLM_PROVIDER=openai
OPENAI_API_KEY=<key>
OPENAI_MODEL=o4-mini
```

This gives you Codex's reasoning models without any process-spawn overhead.

### Option 3: `CodexCLILLMClient` (spawn-based, only if forced)

If you must use the Codex CLI binary (e.g., for testing local codex install):

```typescript
// Rough implementation pattern:
class CodexCLILLMClient implements ILLMClient {
  async sendMessage(messages, options) {
    // 1. Build prompt string from messages array
    // 2. Write output schema to temp file (optional)
    // 3. spawn: codex exec --full-auto --ephemeral -o /tmp/out.txt "<prompt>"
    // 4. Read /tmp/out.txt for clean final message
    // 5. Parse usage from --json JSONL (no usage data in default mode)
    // 6. Return LLMResponse
  }
}
```

**Limitations of this approach**:
- No `system` prompt support (Codex ignores system instructions at exec level)
- No reliable `max_tokens` or `temperature` control
- `usage` stats not available without `--json` parsing
- Per-call spawn overhead (1-3s) — 5-10x worse than direct API
- `--ephemeral` flag needed to avoid session file accumulation

---

## Interface Mapping Analysis

The `ILLMClient` interface requires:
```typescript
sendMessage(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse>
parseJSON<T>(content: string, schema: ZodSchema<T>): T
```

`LLMRequestOptions` fields vs Codex CLI capabilities:
| Field       | Codex exec support          | Notes                              |
|-------------|-----------------------------|------------------------------------|
| `model`     | `--model <model>`           | Supported via flag                 |
| `max_tokens`| Not directly supported      | Codex manages internally           |
| `system`    | Not supported as a flag     | Would need to be prepended to prompt |
| `temperature`| Not supported              | Codex uses reasoning models (fixed)|

`LLMResponse` fields vs Codex exec output:
| Field          | Default exec           | With `--json`              |
|----------------|------------------------|----------------------------|
| `content`      | stdout (final message) | `turn.completed` event     |
| `usage.input_tokens`  | Not available   | Available in event payload |
| `usage.output_tokens` | Not available   | Available in event payload |
| `stop_reason`  | Not available          | Available in event payload |

The interface mismatch is non-trivial. `max_tokens`, `temperature`, and reliable `usage` data
are not accessible without significant workarounds.

---

## Files Inspected

- `src/llm-client.ts` — ILLMClient interface, LLMClient (Anthropic), MockLLMClient
- `src/adapters/openai-codex.ts` — existing IAdapter for task execution (NOT ILLMClient)
- `src/ollama-client.ts` — OllamaLLMClient pattern (HTTP API, OpenAI-compat)
- `src/provider-factory.ts` — buildLLMClient() factory (anthropic/openai/ollama providers)

## Sources

- https://developers.openai.com/codex/noninteractive/
- https://developers.openai.com/codex/cli/reference
- https://developers.openai.com/codex/sdk/
- https://github.com/openai/codex/issues/1670 (--output-last-message, merged PR #4644)
- https://github.com/openai/codex/issues/2288 (--json / --experimental-json status)
- https://dev.to/kachurun/openai-codex-as-a-native-agent-in-your-typescript-nodejs-app-kii
- https://www.npmjs.com/package/@openai/codex-sdk
