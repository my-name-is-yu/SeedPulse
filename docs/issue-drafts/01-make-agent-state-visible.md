---
name: Feature Request
about: Suggest a feature for PulSeed
labels: enhancement
---

## Problem
PulSeed exposes high-level loop status, but it does not clearly show what the agent is currently reading, what files or resources are in scope, or what it considers the current change target.

In the current TUI flow, `tool_start`, `tool_update`, and `tool_end` events are emitted, but the chat state reducer does not render them as visible chat rows. As a result, users can see that "something is happening" without seeing what the system is operating on.

This makes the runtime feel opaque during active work, especially for code-reading and code-editing sessions.

## Proposed solution
Add a first-class "current activity" surface in the TUI and chat runtime that stays visible while a turn is running.

Suggested behavior:

- Show the current file, command, tool, or target resource being read or modified.
- Preserve the latest few tool-level events instead of dropping them.
- Distinguish between "reading", "planning", "editing", "verifying", and "waiting for approval".
- Allow the user to expand the current activity into a short event log.

This should be driven by existing chat events rather than introducing a separate tracing system.

## Alternatives considered
- Keep the current single-line activity model and only improve message wording. This would help slightly, but it would still hide the actual working set.
- Expose the information only in debug mode. This would reduce noise, but the visibility gap is a default UX problem, not just a debugging problem.
