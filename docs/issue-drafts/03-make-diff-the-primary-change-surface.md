---
name: Feature Request
about: Suggest a feature for PulSeed
labels: enhancement
---

## Problem
PulSeed already has diff rendering in the TUI and can show verification diffs inside reports, but diffs are not the primary interaction surface during normal code-changing flows.

In practice, users often receive a result summary without a clear, stepwise view of what changed. `/review` helps, but it is still more of a follow-up command than the default way to understand a change.

This makes it harder to track edits with confidence.

## Proposed solution
Make diffs the default artifact of any code mutation turn.

Suggested behavior:

- After edits, show a concise changed-file summary automatically.
- Allow the user to expand into inline patches without leaving the main chat flow.
- Attach the diff view directly to the same turn that produced the change.
- Separate "files inspected" from "files modified" so the change boundary stays clear.

The default user question after any edit should be easy to answer from the UI: "What changed?"

## Alternatives considered
- Keep diffs only inside reports and `/review`. This preserves the current structure, but it still makes change tracking feel secondary.
- Show only `git diff --stat`. This is too coarse for real review and does not make the actual patch visible.
