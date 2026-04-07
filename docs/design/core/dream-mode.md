# Dream Mode Design

> Dream Mode is PulSeed's offline learning cycle. It persists operational traces, mines recurring patterns, consolidates them into reusable knowledge, and feeds the resulting artifacts back into runtime execution.

---

## 1. Purpose

PulSeed's live loop is optimized for forward progress: observe, decide, act, and verify. That loop produces useful evidence such as iteration outcomes, verification results, strategy pivots, stalls, and trust changes, but much of that evidence is transient unless it is explicitly persisted.

Dream Mode adds the missing offline cycle:

1. collect runtime traces that would otherwise disappear
2. identify high-signal events while the system is awake
3. analyze accumulated traces for repeated patterns and lessons
4. consolidate findings into durable knowledge and compact summaries
5. make those outputs available to future runtime decisions

The design goal is not background logging for its own sake. Dream Mode exists to improve later task generation, strategy selection, retrieval quality, and recovery from repeated failure modes.

---

## 2. Design Constraints

Dream Mode follows a few hard constraints:

- runtime behavior must continue to work when Dream Mode is disabled
- offline processing must degrade safely when data is incomplete or malformed
- logs and derived artifacts must be incrementally processable
- each activation path must be independently flaggable and measurable
- public design docs should describe the reusable architecture, not depend on private research notes

Dependency direction stays one-way:

```text
runtime systems -> emit traces / trigger dream runs
Dream Mode -> reads traces, writes artifacts
runtime systems -> optionally consume Dream outputs through gated integrations
```

This keeps Dream Mode additive. Core execution does not require Dream Mode internals to function.

---

## 3. Architecture Overview

Dream Mode has four phases. The first three belong to the offline Dream pipeline. The fourth phase activates the resulting knowledge in the live system.

```text
Normal runtime
  -> iteration logs, session summaries, event stream, importance buffer

DreamEngine
  -> Phase 1: log collection and importance tagging
  -> Phase 2: analysis pipeline
  -> Phase 3: consolidation

Runtime activation
  -> Phase 4: retrieval and policy-shaping integrations
```

Two execution tiers are supported:

- `light`: small-budget, recent-data, importance-first analysis for idle windows
- `deep`: larger-budget, full-corpus analysis and consolidation for scheduled runs

`light` runs are intended to surface immediate lessons cheaply. `deep` runs are intended to perform broader mining, consolidation, archival work, and higher-value knowledge generation.

---

## 4. Phase 1: Log Collection

Phase 1 establishes durable raw inputs for later Dream work.

Primary responsibilities:

- persist compact per-iteration logs from the core loop
- persist compact session summaries
- persist a bounded event stream for selected runtime events
- collect high-signal `ImportanceEntry` items during normal execution
- rotate logs and maintain processing watermarks

Representative artifacts:

- per-goal iteration logs under the goal state area
- shared Dream session log
- shared Dream importance buffer
- Dream watermark state for incremental processing

Phase 1 is intentionally simple. It favors append-only storage and stable schemas over rich in-memory objects so later phases can read the data incrementally and recover cleanly after interruption.

---

## 5. Phase 2: Analysis Pipeline

Phase 2 is the main offline analysis layer. It reads unprocessed logs, prioritizes important items, and turns operational history into reusable pattern candidates.

Core behaviors:

- ingest only new log material since the last successful watermark
- prioritize high-importance items before regular batches
- batch iteration windows instead of analyzing isolated events
- estimate token cost before LLM-backed analysis
- stop early and mark the run partial when budget is exhausted

Typical outputs:

- learned pattern candidates suitable for the learning pipeline
- schedule or trigger suggestions
- analysis metrics for Dream reports

Analysis should prefer fewer, richer synthesis calls over many shallow calls. The main objective is to discover repeatable structure such as recurring task patterns, strategy effectiveness, stall precursors, observation reliability issues, and verification bottlenecks.

---

## 6. Phase 3: Consolidation

Phase 3 reduces operational sprawl and promotes repeated signals into durable knowledge.

Consolidation responsibilities include:

- retention and archival of large runtime traces
- extraction of reusable lessons before pruning
- cross-goal transfer where evidence supports it
- synthesis of searchable summaries and reports
- metrics per consolidation category so runs are observable

This phase should wrap existing memory and knowledge APIs where possible rather than duplicating them. Dream Mode is a coordinator and synthesizer, not a replacement for the repository's core memory systems.

---

## 7. Phase 4: Knowledge Activation

Phase 4 is separate from the Dream pipeline itself. It modifies runtime consumers so the system can use Dream outputs during normal execution.

Activation points include:

- context construction
- working-memory selection
- task generation
- strategy proposal and evaluation
- cross-goal lesson retrieval
- optional recovery paths for detected knowledge gaps

Every activation is gated by its own feature flag and defaults to off. This keeps rollout measurable and allows each retrieval or heuristic path to be evaluated independently.

---

## 8. Key Data Products

Dream Mode works with three layers of data:

### 8.1 Raw Traces

- iteration logs
- session summaries
- bounded runtime events
- importance buffer entries

### 8.2 Intermediate Analysis Outputs

- iteration windows
- pattern candidates
- schedule suggestions
- per-run metrics and status

### 8.3 Consolidated Knowledge

- learned patterns
- reports and searchable summaries
- reusable strategy templates or heuristics
- archive and retention outputs

The transition between these layers should stay explicit. Raw traces are not runtime context by default; they must first be analyzed or consolidated into smaller, interpretable artifacts.

---

## 9. Operational Model

Dream Mode can be triggered in multiple ways:

- manual CLI invocation
- scheduled nightly or periodic runs
- daemon-driven idle windows
- importance-threshold-triggered light runs

Operational expectations:

- malformed lines in append-only logs are skipped with warnings, not fatal
- watermarks advance only after downstream persistence succeeds
- partial runs are valid outcomes when the budget is exhausted
- log rotation should bound file growth without losing the newest material

This design favors resumability over all-or-nothing execution.

---

## 10. Relationship to Existing Systems

Dream Mode is most valuable when it complements existing PulSeed subsystems:

- the core loop emits the most important execution traces
- observation, verification, strategy, and stall handling provide high-signal importance events
- the learning pipeline persists pattern-level outputs
- memory and knowledge subsystems own retention, transfer, and retrieval behavior
- runtime context builders and task or strategy managers consume Dream outputs only through explicit activation gates

This separation prevents Dream Mode from becoming a hidden dependency while still allowing it to improve future execution quality.

---

## 11. Rollout Guidance

Recommended rollout order:

1. ship Phase 1 persistence first
2. add offline analysis with strict budgets and dry-run support
3. consolidate into existing knowledge systems
4. enable runtime activation one capability at a time

For each step, measure:

- gap convergence
- stall frequency and recovery rate
- retrieval relevance
- cost of Dream runs
- artifact growth and retention quality

Dream Mode is successful only if offline processing leads to better future execution, not just more stored files.
