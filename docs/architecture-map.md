# Architecture Map

This is the public architecture map for the current codebase.
## 1. Top-level picture

```text
user / daemon / chat / tui
          |
          v
    interface layer
          |
          v
      CoreLoop
          |
    +-----+-------------------+
    |                         |
    v                         v
agentic core phases      task lifecycle
    |                         |
    v                         v
 AgentLoop               adapter / agent_loop
    |                         |
    +-----------+-------------+
                |
                v
              tools
                |
                v
   state / memory / Soil / external world```

## 2. Directory-level map

### `src/base`

Foundation types and infrastructure:

- provider config
- LLM client abstractions
- state manager
- common types and utilities

### `src/platform`

Cross-cutting domain services:

- drive and satisficing
- observation
- knowledge and memory
- Soil
- traits such as trust and ethics
- time and tool-facing platform services

### `src/orchestrator`

Long-lived orchestration logic:

- `loop/`: CoreLoop, iteration kernel, tree/multi-goal runners
- `execution/`: task lifecycle, session management, native AgentLoop runtime
- `goal/`: goal negotiation, tree orchestration, aggregation
- `strategy/`: strategy and portfolio management
- `knowledge/`: orchestration-facing transfer helpers

### `src/tools`

Built-in tool system:

- filesystem
- system
- query
- mutation
- schedule
- network
- Soil tools

### `src/interface`

User-facing runtime surfaces:

- `cli/`
- `chat/`
- `tui/`
- `mcp-server/`

### `src/runtime`

Resident runtime support:

- daemon
- queue
- gateway
- schedule engine
- runtime health store

## 3. CoreLoop map

CoreLoop is the main long-lived controller.

Important public subparts:

- `src/orchestrator/loop/core-loop.ts`
- `src/orchestrator/loop/core-loop/iteration-kernel.ts`
- `src/orchestrator/loop/tree-loop-runner.ts`
- `src/orchestrator/goal/tree-loop-orchestrator.ts`

What CoreLoop owns:

- observation to completion flow
- tree-mode and multi-goal scheduling
- stall and refine/pivot decisions
- bounded agentic core phases
- next-iteration directives

## 4. AgentLoop map

AgentLoop is the bounded execution engine.

Important public subparts:

- `src/orchestrator/execution/agent-loop/bounded-agent-loop-runner.ts`
- `src/orchestrator/execution/agent-loop/task-agent-loop-runner.ts`
- `src/orchestrator/execution/agent-loop/chat-agent-loop-runner.ts`
- `src/orchestrator/execution/agent-loop/agent-loop-compactor.ts`
- `src/orchestrator/execution/agent-loop/task-agent-loop-worktree.ts`

What AgentLoop owns:

- tool-driven turn execution
- stop conditions
- completion schema
- context compaction
- repeated tool loop detection
- task/chat session traces

## 5. How CoreLoop and AgentLoop connect

CoreLoop uses AgentLoop in two ways.

### Task execution path

When the active adapter is `agent_loop`, `TaskLifecycle` routes execution through the native AgentLoop runtime.

### Core phase path

CoreLoop can run bounded agentic phases such as:

- `knowledge_refresh`
- `replanning_options`
- `stall_investigation`
- `verification_evidence`

These phases use strict tool policy and bounded budgets.

## 6. Tool and Soil layer

The tool layer is a shared substrate.

Important public capabilities:

- file inspection and editing
- shell command execution
- test running
- task and goal state queries
- knowledge and memory queries
- Soil read and maintenance tools

`soil_query` is especially important because it gives bounded agent runs access to PulSeed's readable long-term memory surface.

## 7. Runtime surfaces

### CLI

Good for:

- setup
- one-shot loop execution
- goal and task inspection
- daemon control

### Chat

Good for:

- bounded interactive work
- tool-driven conversations
- operating CoreLoop through tools

### TUI

Good for:

- live inspection
- approvals
- chat plus goal progress in one surface

### Daemon

Good for:

- long-lived execution
- schedules
- background runtime health and recovery

## 8. Persistence map

PulSeed persists local-first state under `~/.pulseed/`.

Publicly relevant buckets:

- goals
- tasks
- reports
- runtime state
- schedules
- checkpoints
- memory
- Soil projections

## 9. Source of truth

For the public picture:

- this file is the architectural overview
- [Module Map](module-map.md) is the code navigation companion
- `src/` is the implementation truth

Historical deep design docs remain in `docs/design/`, but some describe earlier stages or alternatives rather than the exact current runtime path.
