# Dream Mode Design

> Dream Mode is PulSeed's offline memory and knowledge compiler. It collects execution traces, triages them into candidates, consolidates repeated signals into typed records, and emits bounded activation artifacts for runtime consumers. Dream is not the online search path and it is not Soil retrieval.

---

## 1. Purpose

PulSeed's live loop is optimized for execution: observe, decide, act, verify, and continue. That loop produces evidence such as iteration outcomes, failures, strategy shifts, decisions, and trust changes. Without an offline compiler, that evidence decays into logs that are expensive to read and hard to reuse.

Dream Mode exists to turn those traces into durable memory and knowledge products:

1. collect raw traces with bounded retention
2. triage high-signal events into candidates
3. analyze candidates for repeated patterns, lessons, and deltas
4. consolidate the result into typed runtime updates
5. activate a bounded subset of that knowledge in runtime, behind explicit gates

Dream is therefore a compiler and curator. It improves later task generation, strategy selection, recovery from repeated failure modes, and long-term memory quality. It does not answer ad hoc runtime queries and it does not sit in the Soil query path.

---

## 2. System Boundary

The boundary is intentionally simple:

```text
runtime systems -> emit traces and signals
Dream -> reads traces, produces typed records and activation artifacts
runtime stores -> remain authoritative for writes
Soil -> stores typed retrieval records and serves online retrieval / projection
runtime systems -> consume Dream outputs only through explicit gates
```

Runtime stores remain authoritative for writes. Soil remains the online retrieval surface. Dream is the coordinator that derives update intent from traces, commits durable truth through the owning runtime store, and then emits Soil-compatible retrieval and projection updates from that committed state. It does not replace Soil or bypass the runtime write owner.

At the design level, Dream writes in two directions:

- typed runtime updates, including knowledge records and tombstones
- Soil-compatible mutations that can be applied as versioned upserts, supersedes, and reindex requests

That write contract should be expressed as a small, typed mutation surface. The important behavior is not the storage primitive itself, but that Dream can express record creation, replacement, deletion, and reindex intent without hand-editing projection files.

---

## 3. Architecture Overview

Dream Mode has four phases. The first three belong to the offline compiler. The fourth phase activates the resulting knowledge in the live system.

```text
Normal runtime
  -> traces, session summaries, importance signals, bounded events

Dream compiler
  -> Phase 1: collection
  -> Phase 2: triage and analysis
  -> Phase 3: consolidation

Runtime activation
  -> Phase 4: feature-gated consumption of Dream artifacts
```

Two execution tiers are supported:

- `light`: recent-data, importance-first, bounded-cost runs for quick feedback
- `deep`: broader corpus, stronger synthesis, consolidation, and archival work

`light` runs should be cheap and frequent. `deep` runs should be scheduled or explicitly triggered when the system can spend more budget and is expected to produce more durable changes.

---

## 4. Data Products

Dream works with five kinds of products. Keeping them separate is important for idempotency and for long-running operation.

### 4.1 Raw Traces

Append-only operational evidence such as:

- iteration logs
- session summaries
- bounded runtime events
- importance buffer entries
- analysis watermarks and processing cursors

Raw traces are input material, not runtime truth.

### 4.2 Candidates

Intermediate items produced by triage and analysis:

- repeated failure candidates
- pattern candidates
- decision candidates
- workflow candidates
- schedule or trigger candidates
- evidence bundles for follow-up review

Candidates are disposable until consolidated.

### 4.3 Consolidated Records

Typed knowledge records that are safe to persist and project:

- fact
- workflow
- preference
- observation
- decision
- reflection

These records are versioned and can supersede earlier versions.

### 4.4 Activation Artifacts

Bounded outputs that runtime can consume without pulling the whole Dream corpus:

- evidence packs
- learned pattern hints
- strategy templates
- decision heuristics
- semantic context bundles
- knowledge acquisition suggestions

These artifacts must be small enough to load on demand and cheap enough to ignore when inactive.

### 4.5 Reports

Human-readable outputs for inspection and control:

- run summaries
- consolidation summaries
- retention reports
- coverage gaps
- failure isolation reports

Reports help operators see what Dream did, what it skipped, and what remains to be consolidated.

---

## 5. Phases

### 5.1 Phase 1: Collection

Phase 1 establishes durable raw inputs for later Dream work.

Primary responsibilities:

- persist compact per-iteration logs from the core loop
- persist compact session summaries
- persist a bounded event stream for selected runtime events
- collect high-signal importance entries during normal execution
- maintain watermarks and retention bounds
- keep collection append-only where possible

Collection should be cheap enough to run continuously. The only goal here is to preserve enough evidence for later processing without letting logs grow without control.

### 5.2 Phase 2: Triage and Analysis

Phase 2 reads only unprocessed material and turns it into candidates.

Core behaviors:

- ingest only new material since the last successful watermark
- triage importance first, then regular batches
- analyze windows rather than isolated events
- estimate cost before LLM-backed synthesis
- stop early when the run budget is exhausted
- isolate failures so a bad batch does not poison the whole run

Typical outputs:

- candidate patterns
- candidate workflows
- candidate decisions or reflections
- schedule suggestions
- evidence packs
- analysis metrics

Analysis should prefer fewer, richer synthesis calls over many shallow calls. The main objective is to discover repeatable structure such as recurring task patterns, strategy effectiveness, stall precursors, observation reliability issues, and verification bottlenecks.

### 5.3 Phase 3: Consolidation

Phase 3 promotes repeated signals into durable knowledge and writes Soil-compatible updates.

Consolidation responsibilities include:

- deduping near-identical candidates
- versioned upsert of records
- superseding older truth when a stronger version exists
- writing tombstones for removed or invalidated material
- recording retention and archival actions
- queuing reindex work when embeddings or derived chunks change
- producing reports for operators and later review

This phase should be the main place where Dream becomes useful to Soil. The output is not a log dump; it is a typed update set that can be applied safely and repeatedly.

### 5.4 Phase 4: Activation

Phase 4 is separate from the compiler itself. It lets runtime consumers use Dream outputs during normal execution.

Activation points include:

- context construction
- working-memory selection
- task generation
- strategy proposal and evaluation
- recovery paths for repeated failure modes
- optional knowledge-gap handling

Every activation is gated by its own feature flag and should default to off. The runtime should only read bounded evidence packs or small activation artifacts. There must be no hidden hard dependency on Dream for core execution.

---

## 6. Dream to Soil Write Contract

Dream should commit typed truth through the owning runtime store first, then emit Soil-compatible retrieval records and projections from that committed truth. Soil pages remain projections; retrieval records mirror durable truth and version history for search.

The design contract is:

1. Dream derives an update set from trace evidence.
2. The owning runtime store commits typed records, supersedes links, and tombstones.
3. Dream emits Soil-compatible retrieval/projection mutation intent from the committed state.
4. Dream requests reindexing only when derived search material changes.
5. Soil applies the retrieval/projection mutation and keeps search current.

If no runtime store exists yet for a record class, the implementation must define that owner before treating Soil as persistence. Soil should not become the accidental write truth for new Dream output types.

The contract should support a small set of fields that matter for long-running correctness:

- `record_key`
- `version`
- `supersedes_record_id`
- `valid_from`
- `valid_to`
- `status`
- `is_active`
- `confidence`
- `importance`
- `source_reliability`
- `updated_at`

Semantics:

- `record_key` identifies the logical entity across versions
- `version` increases when the same logical entity is restated or refined
- `supersedes_record_id` links a newer record to the record it replaces
- `valid_from` and `valid_to` capture temporal truth
- `status` and `is_active` control retrieval visibility
- `confidence` describes how strong the evidence is
- `importance` describes how likely the record is to matter later
- `source_reliability` describes how much to trust the source

Versioned upsert is the default write pattern. Tombstones are used when a record should stop participating in retrieval or should be preserved only as history. Reindex requests are queued when chunk text, embeddings, or other derived search material changes.

Dream should not edit projection files directly. It should emit updates that the storage layer can apply and then project into Soil pages and indexes.

---

## 7. Mapping From Existing Memory Types

Dream needs to bridge the current agent memory vocabulary into Soil-compatible types without losing history.

| Existing memory type | Dream output type | Notes |
| --- | --- | --- |
| `fact` | `fact` record | Stable claims, environment facts, durable task facts |
| `procedure` | `workflow` record | Repeatable steps, playbooks, failure recovery sequences |
| `preference` | `preference` record | User, project, or system preferences that remain useful across runs |
| `observation` | `observation` record | Time-bounded evidence, signals, or measured runtime facts |

Dream should also produce:

- `decision` records for durable choices and tradeoffs
- `reflection` records for abstractions, lessons, and postmortems
- workflow or pattern records for learned procedures and reusable heuristics

The current `raw / compiled / archived` lifecycle should be treated as an implementation detail of the pipeline, not as the long-term record model. The long-term model is the typed record set plus version history and tombstones.

---

## 8. Long-Running Operation

Dream is expected to run for months or years without manual reset. The design must therefore assume that logs grow, evidence changes, and earlier conclusions can be superseded.

Operational requirements:

- logs must be bounded by rotation and retention rules
- watermarks must move forward only after downstream writes succeed
- partial runs are valid outcomes when the budget is exhausted
- repeated runs must be idempotent against the same watermark range
- versioned upsert must prevent duplicate truth from accumulating
- tombstones must preserve deletion history without keeping deleted items active
- reindex jobs must be trackable and replayable
- metrics must distinguish collection, analysis, consolidation, and activation failures
- failure isolation must prevent one bad batch from blocking the rest of the system

Dream should treat malformed or incomplete input as a recoverable condition. A single broken trace line, stale candidate, or failed synthesis call must not stop the pipeline.

Suggested operational controls:

- per-run budget caps
- per-phase timeouts
- per-batch failure isolation
- watermark checkpoints
- replayable runs from a known cursor
- health metrics for backlog, lag, and artifact growth

This is the main difference between a useful compiler and a one-off report generator.

---

## 9. Runtime Activation

Runtime activation is the part of Dream that affects live behavior. It must remain narrow and predictable.

Activation principles:

- feature-gated by capability, not by a single global switch
- bounded evidence packs only, never unbounded trace loading
- separate flags for strategy hints, semantic context, workflow hints, decision heuristics, and knowledge-gap recovery
- no hidden hard dependency on Dream for core task execution
- runtime should degrade cleanly to the base system when Dream artifacts are absent

Activation is not a search endpoint. Runtime consumers should read prepared artifacts, not scan raw Dream logs.

The intended flow is:

1. Dream emits a consolidated artifact.
2. Runtime consumers check the relevant activation flag.
3. Runtime loads a bounded evidence pack or typed artifact.
4. Runtime uses the artifact for context or policy shaping.
5. Runtime proceeds even if the artifact is missing or stale.

This keeps Dream additive and makes rollout measurable.

---

## 10. Relationship to Soil

Soil is the online retrieval and projection layer. Dream is the offline compiler that prepares Soil-compatible updates.

The relationship should stay asymmetric:

- Soil serves online reads
- Dream produces typed writes and consolidation artifacts
- Soil pages are projections, not the canonical truth store
- Dream can request reindexing, but it should not own query-time retrieval

This separation matters for scale. Soil can optimize retrieval paths, indexing, and projection rules while Dream focuses on evidence selection, consolidation, and semantic improvement.

Dream should be allowed to produce the following Soil-facing effects:

- versioned record upserts
- supersedes links
- tombstones
- chunk updates
- projection inputs and page records through the Soil projection layer
- reindex requests

Dream should not be allowed to require runtime search to make progress. Offline compilation must remain valid even if the online retrieval surface is temporarily degraded.

---

## 11. Legacy and Compatibility

`src/platform/dream/*` is the canonical Dream surface.

`src/reflection/dream-consolidation.ts` should be treated as legacy compatibility until it is migrated into the platform Dream path. It may remain as a bridge during rollout, but it should not become the preferred long-term entry point.

The design target is a single Dream system with:

- one collection path
- one analysis path
- one consolidation path
- one activation policy surface

Compatibility layers are acceptable during migration, but the public design should point new work toward the platform Dream path.

---

## 12. Rollout Priorities

Recommended rollout order:

1. build the Dream to typed-records and Soil mutation contract
2. make consolidation perform real versioned writes, tombstones, and reindex requests
3. keep activation narrow and feature-gated
4. improve activation quality after the write path is stable

The priority is to make Dream materially improve memory quality first. Activation quality matters, but it is downstream of having reliable records, stable versioning, and correct consolidation.

For each step, measure:

- backlog and watermark lag
- partial run rate
- write idempotency
- supersede rate
- tombstone rate
- reindex queue depth
- activation hit rate
- activation artifact size
- retrieval relevance after consolidation

Dream is successful only if offline processing leads to better future execution, not just more stored files.
