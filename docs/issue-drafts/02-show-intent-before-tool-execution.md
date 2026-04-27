---
name: Feature Request
about: Suggest a feature for PulSeed
labels: enhancement
---

## Problem
PulSeed can emit commentary-style activity events, but the user experience still tends to jump straight into tool execution without making the immediate intent explicit.

Even when the system has a clear reason for the next action, the TUI compresses per-turn activity into a single updatable row. This means the rationale is often overwritten by the latest status line before the user can understand the decision path.

The result is that tool execution feels abrupt and under-explained.

## Proposed solution
Introduce a lightweight "intent first" step before the first material tool call in a turn.

Suggested behavior:

- Emit a stable, non-transient intent message before execution starts.
- Format it as a short statement such as:
  - what PulSeed is trying to confirm
  - what it plans to inspect or change
  - why that step is the next best move
- Preserve that message after the turn ends so the user can understand the basis for the result.

This should be especially important for turns that will read multiple files, mutate code, or trigger approvals.

## Alternatives considered
- Rely on final assistant output to explain the reasoning after the fact. This is better than nothing, but it does not solve the "black box while working" problem.
- Show full chain-of-thought-like traces. That is unnecessary; the goal is visible intent, not exhaustive internal reasoning.
