# Runtime Auto-Recovery

This document describes how PulSeed stabilizes and recovers its long-lived resident daemon. The design target is months-long operation on a single machine without an external broker. It replaces the earlier in-memory queue design with a durable single-node runtime that can recover from daemon, dispatcher, worker, and mid-task failures without silently losing goal state, task context, memory, or schedule state.

## Summary

PulSeed runs under a two-process model:

1. A `RuntimeWatchdog` parent process owns the visible daemon PID and restarts the child when health stops advancing.
2. A single runtime daemon child acquires a leader lock, accepts ingress durably, dispatches commands and events, and supervises goal execution.

The runtime is single-node by design. It does not require Redis or another external broker.

## Goals

- Restart automatically after daemon failure.
- Preserve accepted commands and events across process crashes.
- Prevent concurrent execution of the same `goal_id`.
- Preserve pending approvals across restarts.
- Allow clients to catch up from a durable outbox instead of depending on live SSE only.
- Make resident-daemon health measurable through explicit KPIs rather than relying on process liveness alone.
- Reconcile work that was `running` when the process died so the next daemon instance can retry safely.
- Preserve schedule cadence and retry state across mid-tick crashes.

## Non-Goals

- Multi-node consensus or distributed scheduling.
- Exactly-once delivery for arbitrary external side effects.
- Forcibly interrupting an in-flight goal iteration on `goal_stop`.

## Architecture

```text
RuntimeWatchdog
  └── Runtime Daemon
        ├── Gateway / EventServer ingress
        ├── JournalBackedQueue
        ├── CommandDispatcher
        ├── EventDispatcher
        ├── LoopSupervisor
        ├── ApprovalBroker
        └── Runtime health + outbox stores
```

Persistent runtime data lives under `~/.pulseed/runtime/` by default:

```text
runtime/
  approvals/
  health/
  leader/
  leases/
  outbox/
  queue.json
  supervisor-state.json
```

Task and schedule recovery also depends on durable state outside `runtime/`:

```text
daemon-state.json
schedules.json
tasks/<goal_id>/<task_id>.json
tasks/<goal_id>/ledger/<task_id>.json
tasks/<goal_id>/task-history.json
pipelines/<task_id>.json
memory/
checkpoints/
```

## Core Invariants

### 1. Single daemon leader

Only one daemon may hold the runtime leader lock at a time. PID files are no longer the source of truth for exclusivity.

### 2. Durable accept before processing

Ingress only becomes visible to the runtime after the envelope is written to the journal-backed queue.

### 3. Claim before execute

Workers do not execute a goal until they successfully claim a `goal_activated` envelope.

### 4. Lease plus fencing for goal ownership

Execution ownership is tracked per goal through `GoalLeaseManager`. A worker must still own the lease at commit time or its write is rejected by the state write fence.

### 5. At-least-once delivery

Commands and events may be retried after crash recovery. Handlers must therefore be idempotent or safely deduplicated.

### 6. Persist before side effects

State that determines future recovery must be persisted before side effects that are not guaranteed to complete. Examples:

- schedule `next_fire_at` and `retry_state` are saved before history recording,
- ingress envelopes are written before dispatch,
- task outcome events are written durably before KPI aggregation,
- pipeline state is written after each completed stage.

### 7. Running is not one bit

Daemon health separates three questions:

- process alive: is a daemon process present and fresh?
- command acceptance: does the EventServer `/health` endpoint answer live probes?
- task execution: is the runtime able to execute or resume goal work?

This avoids treating "PID exists" as equivalent to "the resident agent is usable."

## KPI Surface

The operational KPI surface is intentionally small:

| KPI | Meaning | Primary source |
|-----|---------|----------------|
| `process_alive` | daemon process and runtime heartbeat are fresh | `runtime/health/daemon.json` + PID inspection |
| `command_acceptance` | the command surface answers live `/health` probes | `daemon ping` / `probeDaemonHealth()` |
| `task_execution` | goal execution can start, continue, or be recovered | runtime health snapshot and task outcome ledgers |
| task success rate | terminal task outcomes that succeeded | `tasks/<goal>/ledger/*.json` |
| retry / abandon rate | tasks retained for retry or abandoned | `tasks/<goal>/ledger/*.json` |
| task latency p95 | ack/start/complete timings | task outcome ledger summaries |

Useful commands:

```bash
pulseed daemon ping
pulseed daemon status
pulseed doctor
```

`daemon ping` is the cheapest live check. `daemon status` shows the durable runtime state and KPI summary. `doctor` combines static setup checks with live daemon probe results.

## Data Flow

### Ingress

- HTTP and file-based ingress are normalized into `Envelope` records.
- The daemon writes each envelope into `JournalBackedQueue`.
- `CommandDispatcher` claims command envelopes.
- `EventDispatcher` claims non-execution events.
- `LoopSupervisor` claims `goal_activated` envelopes and assigns them to workers.

### Goal execution

- `goal_start` and schedule-derived activations are converted into `goal_activated`.
- `LoopSupervisor` acquires a per-goal lease before starting work.
- The worker renews both queue claim and goal lease while executing.
- On success, the queue claim is acknowledged.
- On failure, the claim is retried with backoff or dead-lettered after the retry budget is exhausted.
- Successful cycles reset the per-goal crash counter.
- A goal suspended by a transient previous process is not permanently restored as suspended after daemon restart; an explicit activation can run it again.

### Approvals and outbound events

- Approval requests are stored durably in `approvals/`.
- Runtime-facing client events are mirrored into the durable outbox so reconnecting clients can catch up.

## Recovery Behavior

### Daemon crash

If the daemon dies or stops renewing health, the watchdog starts a replacement child. The new daemon:

- re-acquires the leader lock,
- sweeps expired queue claims,
- reclaims expired goal leases,
- reloads pending approvals,
- restores interrupted goals from `daemon-state.json`,
- resumes command and event dispatch from the durable queue,
- reconciles stale running tasks and pipelines before starting new work.

The watchdog does not only watch process exit. It also uses the same live health probe as `daemon ping`. If the child process is alive but the command surface stops responding repeatedly, the watchdog restarts it.

### Dispatcher crash

Dispatchers are stateless consumers. After restart they simply continue claiming uncompleted queue items.

### Worker crash

If a worker dies mid-execution, its queue claim and goal lease expire. A later daemon instance, or a later sweep inside the same daemon, reclaims the activation and retries it.

### In-flight task crash

A task can be interrupted after `tasks/<goal>/<task>.json` has already been written with `status: "running"` but before verification and history updates complete. Startup reconciliation scans task files and converts those stale running tasks into durable recovery records:

- the task file is marked `status: "error"` with a recovery marker in `execution_output`,
- `task-history.json` receives a terminal record,
- the task outcome ledger receives `failed` and `retried` events,
- the owning goal is added back to the activation set so the next loop can retry with context.

This does not resume the killed subprocess itself. It preserves the task, result context, KPI history, and goal activation so a safe retry can be generated.

### Pipeline crash

Pipeline execution writes state after each completed stage. On startup, stale `pipelines/<task_id>.json` records with `status: "running"` are changed to `status: "interrupted"`. The pipeline executor treats interrupted state as resumable and continues from the persisted `current_stage_index` instead of starting from scratch.

### Schedule tick crash

Schedule entries persist cadence and retry state before recording history. If a crash happens after a schedule entry fires but before history is written, the persisted entry still contains the advanced `next_fire_at`, `last_fired_at`, and retry state. That prevents repeated immediate replays caused by stale schedule state.

Schedule activations without a `goal_id` are not enqueued as `schedule_activated` events. Non-goal schedule layers such as heartbeat, probe, and cron preserve their own state in `schedules.json`; they should not poison the goal-activation queue with unprocessable messages.

### Memory and context recovery

PulSeed's long-term memory and checkpoints live outside the daemon process. Recovery checks treat the following as durable state that must survive restart:

- agent memory and shared knowledge under `memory/`,
- execution checkpoints under `checkpoints/`,
- cross-goal knowledge transfer patterns in the knowledge transfer snapshot,
- task history and outcome ledgers under `tasks/`.

### Client disconnect

SSE is treated as a transport, not as durable state. Clients are expected to resume from the outbox instead of relying on a live connection to remain uninterrupted.

## Operational Notes

- The runtime is intentionally single-node. Horizontal scaling would require a different leader and lease backend.
- `goal_stop` prevents future reactivation for that goal, but it does not abort the currently running iteration.
- The legacy `runtime_journal_v2` config field is kept only as a compatibility alias for older config files. The durable runtime is always on.
- Runtime queue recovery uses a high retry budget for daemon-owned runtime envelopes so repeated crash/lease-expiry cycles do not quickly dead-letter resumability.
- Core recovery paths are implemented with Node filesystem, HTTP, and process primitives and are intended to work on POSIX-like systems. The `install`/`uninstall` service integration remains macOS `launchd`-specific.

## Verification Strategy

The recovery mechanism is tested at three levels:

- Unit tests for queue, supervisor, schedule persistence, task ledger aggregation, and knowledge transfer persistence.
- CLI tests for `daemon ping`, `daemon status`, and `doctor` KPI reporting.
- A forced-failure smoke test on a disposable runtime home that kills the runtime child, kills the full daemon tree, restarts without explicit goals, and verifies:
  - the active goal is restored,
  - the runtime accepts commands again,
  - an active worker resumes,
  - memory and shared knowledge sentinels remain,
  - checkpoint context remains,
  - all four schedule layers remain: `heartbeat`, `probe`, `cron`, and `goal_trigger`.

## Why This Design

The earlier in-memory queue design could lose accepted work on process crash and only prevented duplicate goal execution inside one process. The current design moves the source of truth for runtime coordination onto disk:

- leader state is durable,
- queue state is durable,
- approval state is durable,
- goal ownership is durable.

That gives PulSeed automatic recovery without introducing an external broker in the single-node deployment target.
