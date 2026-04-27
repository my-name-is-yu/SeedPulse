---
name: Feature Request
about: Suggest a feature for PulSeed
labels: enhancement
---

## Problem
Long-running turns can feel like they progress "on their own" without enough visible checkpoints.

PulSeed does support approvals and some loop progress events, but there is no general UX pattern for small intermediate confirmations during extended work such as multi-file investigation, iterative verification, or background execution.

This weakens user trust because the system can appear to skip past decision points.

## Proposed solution
Add structured checkpoints during long or multi-step runs.

Suggested behavior:

- Emit checkpoint events at stage boundaries such as:
  - context gathered
  - target narrowed
  - edit plan chosen
  - changes applied
  - verification started
- Keep each checkpoint visible in the conversation instead of collapsing everything into one transient line.
- Optionally allow a user-configurable verbosity level so users can choose between compact and detailed progress.

These checkpoints do not need to block execution every time, but they should make the process legible.

## Alternatives considered
- Add more spinner states only. This improves perceived activity but not decision visibility.
- Require explicit approval at every checkpoint. That would increase transparency, but it would also introduce too much friction for routine work.
