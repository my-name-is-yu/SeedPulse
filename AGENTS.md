# SeedPulse Codex Rules

## Test Design

- Regression tests must exercise the same entrypoint shape and key input flags used in production. A fixture name or reused fake object is not enough.
- When a bug crosses a boundary between coordinator and runner, keep the narrow mock test, but add at least one contract test that runs the real downstream component that interprets the payload.
- For stateful chat, runtime, gateway, and TUI paths, cover at least two turns when the behavior depends on session state, route state, reply targets, persisted state paths, or resume semantics.
- Tests that claim "resume", "reuse", "latest", "current", "active", or "selected" must assert both the positive path and the stale/previous-turn value that must not be used.
- If a fix changes the meaning of an input field, add a test that would fail on the old implementation because that exact field is present.
