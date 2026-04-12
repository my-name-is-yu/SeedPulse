# Runtime

This document describes how PulSeed runs today.
The key runtime idea is:

- the same orchestration stack is reused by CLI, TUI, chat, and daemon flows
- `CoreLoop` remains the long-lived controller
- `AgentLoop` is the bounded executor used inside task, chat, and selected core-phase flows

## 1. Runtime surfaces

PulSeed currently exposes four main ways to run:

- CLI commands
- chat mode
- TUI
- daemon / cron

All of them share the same underlying state and orchestration modules.

## 2. CLI

The CLI entry point is `pulseed`.

Common commands:

```bash
pulseed setup
pulseed goal add "<description>"
pulseed run --goal <id>
pulseed status --goal <id>
pulseed report --goal <id>
pulseed chatpulseed tui
pulseed start --goal <id>
pulseed stop
```

`pulseed run --goal <id>` is the direct way to execute one CoreLoop run.

## 3. Chat mode

`pulseed chat` is now a real bounded agent runtime, not just a command router.

When the configured provider supports native tool calling, chat uses the native AgentLoop path.

Important runtime behavior:

- persistent chat session history
- streaming tool events
- approvals for restricted actions
- context compaction
- ability to operate CoreLoop through tools rather than direct internal calls

The design rule is explicit in the implementation: chat should manipulate long-lived control through tools, not by bypassing runtime boundaries.

## 4. TUI

The TUI is the interactive terminal shell around the same runtime.

It combines:

- goal progress
- reports
- approvals
- chat
- loop control

The TUI can also wire native chat and task AgentLoop runners when the active provider config enables `agent_loop`.

## 5. Daemon and cron

Daemon mode is the resident host for continuous operation.

```bash
pulseed start --goal <id>
pulseed stop
```

Cron is still available for users who do not want a resident daemon:

```bash
pulseed cron --goal <id>
```

Both paths ultimately drive the same CoreLoop and TaskLifecycle.

## 6. Native AgentLoop runtime

PulSeed has a first-class native `agent_loop` adapter.

This adapter is not a separate external executable. It is a selection marker that routes task execution through PulSeed's internal AgentLoop runtime.

Current AgentLoop runtime properties:

- bounded turns
- bounded tool calls
- bounded wall-clock time
- repeated tool-loop detection
- schema-validated completion
- context compaction
- trace and session state capture
- optional worktree preparation for task execution

This is the path intended to close the gap with Codex-style tool-using execution while keeping PulSeed's persistent architecture.

## 7. CoreLoop inside the runtime

Runtime surfaces do not replace CoreLoop. They host it.

CoreLoop currently coordinates:

- observation
- gap calculation
- drive scoring
- task lifecycle execution
- tree mode
- multi-goal mode
- stall handling
- completion
- agentic core phases

Agentic core phases currently include:

- `observe_evidence`
- `knowledge_refresh`
- `replanning_options`
- `stall_investigation`
- `verification_evidence`

These are bounded sub-runs, not unbounded inner loops.

## 8. Scheduling and directives

CoreLoop can emit next-iteration directives from bounded agentic phases.

Those directives are now consumed by runtime scheduling:

- tree mode can prioritize a child node with a pending directive
- multi-goal mode can prioritize a goal with a pending directive

This is the current bridge between local bounded agent reasoning and long-lived control.

## 9. Tools in the runtime

Tools are part of the runtime substrate.

Important examples:

- filesystem and git inspection
- shell command execution
- test execution
- task and goal state queries
- knowledge and memory recall
- Soil query and maintenance tools
- schedule management tools

Both CoreLoop phases and AgentLoop sessions run on top of this tool layer with explicit policy.

## 10. Soil and memory in runtime behavior

The runtime exposes long-lived knowledge to bounded runs through:

- state manager data
- task and session history
- knowledge manager
- memory recall
- `soil_query`

This matters because PulSeed is designed to survive beyond one prompt window.

## 11. Persistence

PulSeed persists local runtime state under `~/.pulseed/`.

Important runtime areas include:

- goals
- tasks
- reports
- schedules
- runtime health and queue state
- approvals
- checkpoints
- memory
- Soil projections

The runtime also uses write-ahead-log style durability for parts of state management and health tracking.

## 12. Provider and adapter defaults

The public default direction is now:

- provider selected through `pulseed setup`
- adapter set to `agent_loop` when the chosen model supports native tool calling

External adapters still matter, but they are no longer the only story for execution.

## 13. Reading order

For the public runtime picture:

1. [README](../README.md)
2. [Getting Started](getting-started.md)
3. [Mechanism](mechanism.md)
4. [Configuration](configuration.md)
5. [Architecture Map](architecture-map.md)
