# Write-Tool Integration Plan

## 1. Overview

PulSeed's chat interface has grown organically — read tools in one file, mutation tools split across two others, and approval logic split between programmatic guards and conversational prompts. This plan unifies the tool system under a single registry, inspired by Claude Code's declarative patterns. The goal is consistency, testability, and a clean path to CoreLoop deep integration.

Problems to solve:
- Two approval mechanisms (programmatic `checkApproval` + conversational prompt) — inconsistent behavior
- Tool results use `role: "user"` instead of `role: "tool"` — breaks standard LLM tool-call protocol
- `toggle_plugin` is a stub returning an error
- `update_config` supports only `daemon_mode` key
- No unified registry — tools scattered across `self-knowledge-tools.ts`, `mutation-tool-defs.ts`, `self-knowledge-mutation-tools.ts`
- Only `delete_goal` has rich LLM-facing descriptions; others are bare

---

## 2. Unified ToolDefinition Type

New file: `src/interface/chat/tool-registry.ts`

```typescript
import { z } from "zod";
import type { StateManager } from "../../state-manager.js";
import type { LLMClient } from "../../llm-client.js";

export interface ToolDefinition {
  name: string;
  description: string;              // Rich, LLM-friendly description
  parameters: z.ZodSchema;          // Converted to JSON Schema for LLM calls
  isReadOnly: boolean;              // Default: false (safe side)
  approvalLevel: "none" | "conversational" | "required";
  execute: (params: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;                   // Errors returned as data, never thrown
}

export interface ToolContext {
  stateManager: StateManager;
  llmClient: LLMClient;
  approvalFn?: (description: string) => Promise<boolean>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  all(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  readOnly(): ToolDefinition[] {
    return this.all().filter(t => t.isReadOnly);
  }
}

export class ToolDispatcher {
  constructor(private registry: ToolRegistry) {}

  // Denial backpressure: 3 consecutive denials → step-by-step confirmation mode
  private denialCount = 0;
  private confirmationMode = false;

  async dispatch(name: string, params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.registry.get(name);
    if (!tool) {
      return { success: false, error: `Unknown tool: ${name}` };
    }

    // PreToolUse: validate params before approval or execution
    const parsed = tool.parameters.safeParse(params);
    if (!parsed.success) {
      return { success: false, error: `Invalid params: ${parsed.error.message}` };
    }

    // Approval gate (unified — no more split mechanism)
    if (tool.approvalLevel === "required" || this.confirmationMode) {
      const approved = await ctx.approvalFn?.(`Execute ${name}?`) ?? false;
      if (!approved) {
        this.denialCount++;
        if (this.denialCount >= 3) this.confirmationMode = true;
        return { success: false, error: "User denied" };
      }
      this.denialCount = 0;
    }

    try {
      return await tool.execute(parsed.data, ctx);
    } catch (err) {
      // Never let exceptions escape — return as ToolResult
      return { success: false, error: String(err) };
    }
  }
}
```

---

## 3. Three-Phase Plan

### Phase A: Tool Registry Unification

**Goal**: Single registry, fix `role: "tool"`, backward-compatible migration.

**Steps**:
1. Create `src/interface/chat/tool-registry.ts` with `ToolDefinition`, `ToolRegistry`, `ToolDispatcher` as above.
2. Move read tools from `self-knowledge-tools.ts` into registry definitions. Old file re-exports from registry for backward compat.
3. Move mutation tools from `mutation-tool-defs.ts` + `self-knowledge-mutation-tools.ts` into registry definitions.
4. In `chat-runner.ts`: replace manual tool dispatch with `ToolDispatcher.dispatch()`. Fix message role to `"tool"`.
5. Add `tool-registry.test.ts` — registration, dispatch, param validation, denial backpressure.

**Files**:
| Action | File |
|--------|------|
| Create | `src/interface/chat/tool-registry.ts` |
| Refactor | `src/interface/chat/self-knowledge-tools.ts` |
| Refactor | `src/interface/chat/mutation-tool-defs.ts` |
| Refactor | `src/interface/chat/self-knowledge-mutation-tools.ts` |
| Update | `src/interface/chat/chat-runner.ts` |
| Create | `src/interface/chat/__tests__/tool-registry.test.ts` |

**Approval mapping** (carry forward from current state):
| Tool | approvalLevel |
|------|--------------|
| get_goals, get_sessions, get_trust_state, get_config, get_plugins | none (read-only) |
| set_goal, update_goal, delete_goal, update_config | none (conversational) |
| archive_goal, reset_trust, toggle_plugin | required |

---

### Phase B: Mutation Tool Expansion

**Goal**: Complete stubs, expand config coverage, rich descriptions for all tools.

**Steps**:
1. **Complete `toggle_plugin`**: implement actual plugin enable/disable via `PluginLoader`. Return structured result with plugin name and new state.
2. **Expand `update_config`**: read all supported keys from `CONFIG_METADATA` (already in `tool-metadata.ts`). Validate value type per key before writing. Return previous + new value.
3. **Rich descriptions for all mutation tools**: expand `tool-metadata.ts` so every tool has the same quality description as `delete_goal` currently has. Include: what it does, when to use, what NOT to do, parameter semantics.
4. **Unify approval**: remove old `checkApproval` calls inside individual handlers. All approval is now handled by `ToolDispatcher` based on `approvalLevel`.
5. **PreToolUse semantic hook**: Phase A validates params structurally. Phase B adds semantic validation (e.g., reject `archive_goal` if goal is currently running).

**Files**:
| Action | File |
|--------|------|
| Expand | `src/interface/chat/tool-metadata.ts` |
| Implement | toggle_plugin handler (inside tool-registry or dedicated handler file) |
| Expand | update_config handler |
| Update | mutation tool tests |

---

### Phase C: CoreLoop Deep Integration

**Goal**: ObservationEngine and StrategyManager can use tools; results flow back into state.

This phase is **additive** — no breaking changes. Reference existing draft: `docs/design/core/tool-system.md`.

**Steps**:
1. **ObservationEngine**: inject `ToolRegistry` (read-only tools only). During observation, call available read tools to gather state snapshots. Merge tool results with LLM observation output.
2. **GapCalculator**: optionally call a `verify` tool to cross-check gap measurements (e.g., shell command that confirms metric value).
3. **StrategyManager**: when selecting a strategy, include available tool names in LLM context so strategy can reference specific tools.
4. **CoreLoop**: wire `ToolResult` objects into session state so they appear in the next observation context.

```typescript
// Injection pattern — no global registry
class ObservationEngine {
  constructor(
    private llmClient: LLMClient,
    private readOnlyTools: ToolDefinition[],  // injected by CoreLoop
  ) {}
}
```

**Files**:
| Action | File |
|--------|------|
| Update | `src/observation-engine.ts` |
| Update | `src/gap-calculator.ts` |
| Update | `src/strategy/strategy-manager.ts` |
| Update | `src/core-loop.ts` |
| Create | `src/__tests__/integration/tool-coreloop.test.ts` |

---

## 4. Migration Strategy

| Phase | Breaking? | Backward Compat Mechanism |
|-------|-----------|--------------------------|
| A | No | Old files re-export from registry; callers unchanged |
| B | Minimal | `checkApproval` callers need one-line update to use dispatcher |
| C | No | Additive injection — existing CoreLoop callers unchanged |

Recommended order: A → B → C. Each phase is independently shippable.

---

## 5. File Impact Summary

| File | Phase | Action |
|------|-------|--------|
| `src/interface/chat/tool-registry.ts` | A | Create |
| `src/interface/chat/self-knowledge-tools.ts` | A | Refactor (re-export) |
| `src/interface/chat/mutation-tool-defs.ts` | A | Refactor (re-export) |
| `src/interface/chat/self-knowledge-mutation-tools.ts` | A | Refactor (re-export) |
| `src/interface/chat/chat-runner.ts` | A | Fix role + use dispatcher; pass onStatus callback |
| `src/interface/chat/__tests__/tool-registry.test.ts` | A | Create |
| `src/interface/tui/tool-status.tsx` | A | Create — status display component |
| `src/interface/chat/tool-metadata.ts` | B | Expand all tool descriptions |
| toggle_plugin handler | B | Implement |
| update_config handler | B | Expand keys |
| `src/observation-engine.ts` | C | Inject read-only tools |
| `src/gap-calculator.ts` | C | Optional verify hook |
| `src/strategy/strategy-manager.ts` | C | Tool-aware context |
| `src/core-loop.ts` | C | Wire tool results to state |
| `src/__tests__/integration/tool-coreloop.test.ts` | C | Create |

Total: 9 files modified, 4 files created.

---

---

## 7. Real-Time Tool Status Display

Inspired by Claude Code's per-tool status labels: when a tool executes, the TUI displays a one-line status like "Deleting goal: improve-test-coverage" or "Updating config: daemon_mode".

### ToolDefinition Extension

Add to the ToolDefinition interface:
```typescript
interface ToolDefinition {
  // ... existing fields ...
  statusVerb: string;        // e.g., "Deleting", "Updating", "Archiving"
  statusArgKey?: string;     // Parameter key to show in status (e.g., "goal_id")
}
```

When the dispatcher executes a tool, it emits a status event:
```typescript
// In ToolDispatcher.dispatch()
const statusText = `${tool.statusVerb} ${tool.statusArgKey ? params[tool.statusArgKey] : tool.name}`;
ctx.onStatus?.(statusText);  // callback to TUI
```

### TUI Integration

The TUI already has:
- `shimmer-text.tsx` — wave animation component
- Plant-themed spinner verbs (100+) — shown during LLM thinking
- EventServer (SSE) — for daemon mode events

Tool status display is separate from spinner verbs:
- **Spinner verbs** = LLM is thinking (model wait)
- **Tool status** = a specific tool is executing (action in progress)

The `ToolStatusLine` component in TUI shows the current tool status:
```typescript
// src/interface/tui/tool-status.tsx (new, Phase A)
const ToolStatusLine: FC<{ status: string | null }> = ({ status }) => {
  if (!status) return null;
  return <Text dimColor>  ⚡ {status}</Text>;
};
```

Wired via ToolContext.onStatus callback from ChatRunner → TUI.

### Status for Each Tool

| Tool | statusVerb | statusArgKey |
|------|-----------|-------------|
| get_goals | Fetching goals | — |
| get_sessions | Fetching sessions | — |
| get_trust_state | Checking trust | — |
| get_config | Reading config | — |
| get_plugins | Listing plugins | — |
| set_goal | Creating goal | description |
| update_goal | Updating goal | goal_id |
| archive_goal | Archiving goal | goal_id |
| delete_goal | Deleting goal | goal_id |
| toggle_plugin | Toggling plugin | plugin_name |
| update_config | Updating config | key |
| reset_trust | Resetting trust | — |

### Phase Assignment

This feature is part of **Phase A** (Tool Registry Unification) since it requires the unified ToolDefinition type. The Phase A file impact table in section 5 includes:
- `src/interface/tui/tool-status.tsx` (new) — status display component
- `src/interface/chat/chat-runner.ts` (modify) — pass onStatus callback via ToolContext


## 8. Test Strategy

**Unit tests** (Phase A — `tool-registry.test.ts`):
- Register tool, dispatch with valid params → success
- Dispatch unknown tool → `{ success: false, error: "Unknown tool: ..." }`
- Invalid params fail at Zod parse, before approval or execution
- `approvalLevel: "required"` calls `approvalFn`; denial returns error, does not throw
- 3 consecutive denials → `confirmationMode = true`
- Exception inside `execute` is caught, returned as `ToolResult`

**Mutation tool tests** (Phase B):
- `toggle_plugin` — enable/disable round-trip; verify PluginLoader called
- `update_config` — all CONFIG_METADATA keys accepted; unknown key rejected
- Approval unification — no tool calls `checkApproval` directly

**Integration tests** (Phase C — `tool-coreloop.test.ts`):
- Chat → tool call → state mutation → next LLM turn sees updated state
- ObservationEngine with injected read-only tools produces richer observation
- CoreLoop full round-trip with tool results in session state
