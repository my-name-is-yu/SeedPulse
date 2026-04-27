---
name: Feature Request
about: Suggest a feature for PulSeed
labels: enhancement
---

## Problem
PulSeed supports stop, approval reject, resume, and session control commands, but the system still feels weakly interruptible once a turn is underway.

In particular, there is limited support for changing course mid-run with requests like:

- stop reading and show me the diff first
- do not edit yet, summarize the target files
- switch from patching to review mode

The current model is closer to stop-or-wait than to collaborative interruption.

## Proposed solution
Add first-class mid-run interruption and redirection for interactive surfaces.

Suggested behavior:

- Allow users to interrupt an active turn with a short command or keybinding.
- Offer immediate redirect options such as:
  - stop and summarize current findings
  - pause before mutation
  - switch to review-only
  - continue in background
- Make the active turn state resumable after interruption when possible.

This should build on existing session and agent loop state rather than replacing it.

## Alternatives considered
- Rely only on `/stop`. This is simple, but it is too coarse for collaborative steering.
- Expose interruption only for daemon loops. The visibility problem exists in chat and TUI turns too, not just in background goal execution.
