# Getting Started

This is the shortest path from install to a first goal run.

## 1. Install

PulSeed requires Node.js 22 or 24.

```bash
npm install -g pulseed
```

## 2. Start PulSeed

Run:

```bash
pulseed
```

PulSeed will guide setup when needed. It writes local state under `~/.pulseed/`, including provider selection, goals, tasks, reports, runtime data, schedules, memory, and Soil projections.

## 3. Work in natural language

Describe what you want PulSeed to do:

- "Increase test coverage to 90%."
- "Show me the current progress."
- "Run the next useful step."
- "Keep this goal moving in the background."

The default public path is `pulseed` plus natural language. Lower-level subcommands exist for automation, debugging, and compatibility, but they are not the main getting-started flow.

## 4. What runs where

- `CoreLoop` handles goal-level control, including continuation, refinement, verification, and completion checks
- `AgentLoop` handles bounded tool use for tasks, chat, and runtime phases that need a short-lived executor
- Local state lives under `~/.pulseed/`

## Next Docs

- [Docs Index](index.md)
- [Mechanism](mechanism.md)
- [Runtime](runtime.md)
- [Configuration](configuration.md)
- [Architecture Map](architecture-map.md)
