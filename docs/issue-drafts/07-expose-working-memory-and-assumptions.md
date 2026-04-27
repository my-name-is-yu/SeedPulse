---
name: Feature Request
about: Suggest a feature for PulSeed
labels: enhancement
---

## Problem
PulSeed has strong internal concepts around session context, state handoff, and persistent memory, but users cannot easily see the active working memory that is shaping the current turn.

The system stores history, compaction summaries, and resumable state, but it does not present a clear user-facing view of:

- current assumptions
- active constraints
- selected context
- narrowed target scope
- why certain prior information was included or excluded

This creates a gap between PulSeed's internal context model and the user's mental model.

## Proposed solution
Expose a compact, user-facing working-memory panel for the current turn or session.

Suggested behavior:

- Show the active assumptions and constraints for the turn.
- Show what context PulSeed currently considers in scope.
- Distinguish persisted session memory from ephemeral turn-local working memory.
- Allow quick inspection through a slash command or side panel, for example `/context` or `/working-memory`.

The goal is not to expose hidden reasoning verbatim. The goal is to expose operational context in a reviewable form.

## Alternatives considered
- Keep this information implicit and rely on final answers to reflect it. That does not help when users need to understand or redirect the process while it is happening.
- Expose raw serialized state files. That would be transparent, but not usable as an interactive UX surface.
