# Soil System Design

> Soil is PulSeed's human-readable knowledge surface and retrieval interface.
> Runtime stores remain authoritative for writes; Soil keeps a typed retrieval
> store plus Markdown projections for inspection, audit, and agent context.

> Related: `memory-lifecycle.md`, `learning-pipeline.md`, `knowledge-acquisition.md`, `../core/dream-mode.md`

> Current implementation note: Soil is not just a documentation surface. `soil_query` is now available to the native AgentLoop and to selected CoreLoop phases such as `knowledge_refresh`, `replanning_options`, and `verification_evidence`, making Soil part of live execution rather than a passive export.

---

## 1. Role

Soil has two jobs:

1. Provide a stable, human-readable knowledge surface in Markdown.
2. Provide a fast retrieval layer over typed memory records and chunks.

The important boundary is that Markdown is not the retrieval truth. Markdown is
a projection. Search truth lives in typed records and chunks, then projects back
to pages when results are assembled.

| Layer | Role | Storage |
|---|---|---|
| Runtime stores | Write truth for reports, schedules, knowledge, agent memory, decisions, and observations | Existing runtime JSON and subsystem stores |
| Soil records | Canonical retrieval units | `soil_records` in `.index/soil.sqlite` |
| Soil chunks | Lexical and dense retrieval units | `soil_chunks`, `soil_chunk_fts`, `soil_embeddings` |
| Soil pages | Human-readable projection | `soil_pages` plus Markdown files |
| Page members | `1 page : n records` assembly mapping | `soil_page_members` |

Legacy `.index/soil.db` remains the old `file-json-v1` Markdown snapshot and is
kept as a fallback path. The new SQLite retrieval store uses `.index/soil.sqlite`
so the two formats do not conflict.

Display integrations use the Markdown projection contract. Obsidian and Notion
do not read `soil_records` directly; the builtin `soil-display` integration
first materializes typed `soil_pages` into the Markdown tree and fallback
projects active typed records that do not yet have a page. Snapshot consumers
then read the publishable Markdown tree.

---

## 2. Record Model

`soil_record` is the canonical retrieval unit. It represents one stable fact,
workflow, preference, observation, decision, state, identity item, artifact, or
reflection.

Required versioning and lifecycle fields:

| Field | Purpose |
|---|---|
| `record_id` | Immutable row identity |
| `record_key` | Logical identity across versions |
| `version` | Monotonic version for the logical record |
| `record_type` | Search routing and memory type |
| `status` / `is_active` | Default search exclusion for stale or superseded data |
| `valid_from` / `valid_to` | Temporal validity |
| `supersedes_record_id` | Explicit replacement chain |
| `confidence`, `importance`, `source_reliability` | Ranking and later Dream consolidation signals |
| `source_type`, `source_id` | Runtime source traceability |

`kind` and `route` are page-scoped metadata, not record truth. They live on
`soil_pages` and are applied through `soil_page_members` joins when filtering or
assembling results.

---

## 3. Projection Model

A Soil page is a Markdown projection assembled from one or more records.

Cardinality is fixed:

- One record can appear on multiple pages.
- One page can contain multiple records.
- `soil_page_members` defines page membership, ordering, and role.

This prevents a human-readable page from becoming the retrieval unit. Long-lived
pages can grow and remain readable without making search chunks too coarse.

Manual overlays are still allowed in Markdown:

```md
<!-- soil:overlay-begin -->
Human-authored note or correction.
<!-- soil:overlay-end -->
```

Overlays are import candidates. They do not silently mutate runtime truth.

---

## 4. Retrieval

`soil_query` is the read path for agents and humans.

The retrieval order is:

1. Direct lookup by `soil_id`, path, or exact record/page key.
2. Metadata filtering over record fields and page fields.
3. FTS5 lexical retrieval over chunks.
4. Query-driven candidate pruning.
5. Dense retrieval over the pruned candidate set.
6. Reciprocal rank fusion.
7. Rerank, when a reranker is available.
8. Record/page assembly.

Dense retrieval is secondary. It should improve semantic matching inside a
bounded candidate set; it should not become an unfiltered full-corpus scan.

The current SQLite implementation does the following:

- Direct hits return immediately.
- Lexical retrieval uses `soil_chunk_fts`.
- If lexical hits exist, dense scoring is limited to those record IDs.
- If lexical has no hits, dense runs only when explicit metadata filters define
  a bounded subset.
- If neither lexical hits nor explicit filters exist, dense is skipped.
- Dense scoring ignores stale embeddings with open reindex jobs.
- Dense scoring uses only the latest `embedding_version` per chunk/model.
- Query embeddings carry `query_embedding_model`, and dense rows are filtered to
  the matching model when available.

If query embedding generation fails, `soil_query` stays successful and falls
back to lexical-only SQLite search. If the SQLite store is missing, empty, or
unusable, `soil_query` falls back to the legacy fresh `.index/soil.db` snapshot
and then to a bounded Markdown manifest scan.

---

## 5. Partition Keys

The natural Soil partitions are:

| Partition | Use |
|---|---|
| `record_type` | Route fact, decision, workflow, preference, observation, and reflection searches |
| `goal_id` | Scope search to a goal |
| `task_id` | Scope search to a task |
| page `kind` / `route` | Scope search to the projected knowledge area |
| `status` / `is_active` | Exclude superseded, archived, or rejected material by default |
| `valid_from` / `valid_to` | Avoid using temporally invalid facts |
| `updated_at` windows | Narrow search for recent operational context |

These filters are intentionally part of the contract so a future vector backend
such as `sqlite-vec` can use the same routing semantics.

---

## 6. Dream Boundary

Soil does online retrieval. Dream owns offline maintenance.

Dream is expected to consume and produce Soil-compatible updates for:

- Embedding reindex jobs from `soil_reindex_jobs`
- Episodic-to-semantic promotion
- Deduplication and merge decisions
- Supersede chains and tombstones
- Importance and confidence updates
- Workflow extraction
- Summary-tree or graph refreshes

Soil should not perform expensive consolidation during query execution. It
should queue maintenance work and continue serving fresh-enough lexical results
with explicit stale guards.

---

## 7. Tool Summary

| Tool | Permission class | Purpose |
|---|---|---|
| `soil_query` | Read-only | Retrieve Soil pages or search Soil content |
| `soil_doctor` | Read-only | Inspect Soil health and index consistency |
| `soil_rebuild` | Local write with approval | Rebuild projections and indexes from runtime stores |
| `soil_import` | Local write with approval | Maintain the manual overlay import queue |

The invariant is: runtime stores remain write truth; Soil provides typed
retrieval truth and human-readable projections.
