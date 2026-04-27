---
name: Feature Request
about: Suggest a feature for PulSeed
labels: enhancement
---

## Problem
PulSeed can surface lifecycle errors, loop errors, and approval denials, but failure handling still lacks a clear recovery path from the user's perspective.

Today, errors are often visible as messages, but the next step is not consistently proposed. In addition, `/retry` is intentionally unsupported, which makes recovery feel incomplete during interrupted or failed sessions.

This leaves too much ambiguity at exactly the moment when the system should be most explicit.

## Proposed solution
Add a standard recovery UX for failed turns and failed loops.

Suggested behavior:

- Explain the failure in a compact, user-facing form.
- Classify it where possible, for example:
  - permission failure
  - tool input failure
  - verification failure
  - runtime interruption
  - daemon loop failure
- Provide next actions inline, such as:
  - retry safely
  - reopen with stricter permissions
  - inspect diff
  - inspect test output
  - resume session
- Consider adding a bounded `/retry` flow for cases where replay is safe and well-defined.

## Alternatives considered
- Leave recovery to manual user commands such as `/review`, `/resume`, or restarting the run. This is flexible, but it pushes too much burden onto the user at failure time.
- Add retry without failure classification. That would improve convenience, but it would still leave the recovery model hard to understand.
