# Research: Progress Observation for Custom Dimensions

Date: 2026-03-15

## How Each Component Works

### 1. ObservationEngine (`src/observation-engine.ts`)

Two observation paths:

**`observe(goalId, methods)`** — self_report path (lines 290–318)
- Iterates every dimension, reads the dimension's current `current_value` and `confidence` from state, and re-records it as a new `self_report` observation log entry.
- Confidence is clamped to `[0.10, 0.49]` (self_report layer range).
- Does NOT read from any external source. If `current_value` is null, `extracted_value` stays null.
- This means if a dimension starts null, `observe()` just perpetually re-records null. The loop never converges.

**`observeFromDataSource(goalId, dimensionName, sourceId)`** — mechanical layer (lines 333–398)
- Looks up adapter by `sourceId` from `this.dataSources`.
- Builds a `DataSourceQuery`; if `dimension_mapping[dimensionName]` exists, sets `query.expression`.
- Calls `source.query(query)`.
- If `result.value` is null, throws: `Data source "${sourceId}" returned null for dimension "${dimensionName}"`.
- On success, creates a `mechanical` layer entry with `confidence: 0.90`.
- Calls `applyObservation()` to persist into goal state.

**CoreLoop observation flow** (`src/core-loop.ts` lines 456–513)
1. For each dimension, tries every registered data source via `observeFromDataSource()`.
2. If a data source throws (including the null-value throw), it logs a warning and tries the next source.
3. Dimensions where ALL data sources fail fall back to `observe()` (self_report).
4. The key: a data source that returns null causes `observeFromDataSource` to throw, which causes CoreLoop to log a warning and fall through to self_report — which re-records the stale null.

### 2. DataSourceAdapter (`src/data-source-adapter.ts`)

**`IDataSourceAdapter` interface** (lines 31–40):
```
sourceId: string
sourceType: DataSourceType
config: DataSourceConfig
connect(): Promise<void>
query(params: DataSourceQuery): Promise<DataSourceResult>
disconnect(): Promise<void>
healthCheck(): Promise<boolean>
getSupportedDimensions?(): string[]   // optional
```

`DataSourceResult.value` must be `number | string | boolean | null`.

**`FileDataSourceAdapter`** (lines 44–110):
- Requires `config.connection.path` pointing to an existing file.
- For JSON files with an `expression`, extracts a nested value via dot-path.
- Throws in `connect()` if the file doesn't exist.
- Not suitable for file-existence checking — it reads file contents, not existence.

### 3. GitHubIssueDataSourceAdapter (`src/adapters/github-issue-datasource.ts`)

Pattern to follow for custom adapters:
- Implements `IDataSourceAdapter` with `sourceType: "custom"`.
- `connect()` is a no-op.
- `query()` checks `params.expression ?? params.dimension_name` against a known set of dimensions.
- Returns `{ value: null }` for unknown dimensions (does NOT throw).
- Returns numeric values for known dimensions.
- `getSupportedDimensions()` returns the list of known dimension names.

**Key difference from what we need**: GitHubIssueDataSourceAdapter returns `null` for unknown dimensions (and returns a result with value null). `observeFromDataSource` then throws because result.value is null. CoreLoop catches this and falls back to self_report for that dimension.

### 4. DataSourceConfig (`src/types/data-source.ts`)

```
DataSourceTypeEnum = "file" | "http_api" | "database" | "custom" | "github_issue"
DataSourceConfig.connection:
  path?: string
  url?: string
  ...
DataSourceConfig.dimension_mapping?: Record<string, string>
```

### 5. CLIRunner `buildDeps()` (`src/cli-runner.ts` lines 100–198)

- Reads JSON files from `~/.motiva/datasources/`.
- Instantiates adapters based on `config.type`:
  - `"file"` → `FileDataSourceAdapter`
  - `"http_api"` → `HttpApiDataSourceAdapter`
  - `"github_issue"` | `"custom"` | `"database"` → `GitHubIssueDataSourceAdapter`
- **Problem**: there is no case for a "file_existence" type adapter. Any new type would need to be added here, OR piggyback on `"custom"`.

---

## Root Cause of the Problem

`observeFromDataSource` (line 370–374) throws when `result.value === null`:
```typescript
if (extractedValue === null || extractedValue === undefined) {
  throw new Error(
    `Data source "${sourceId}" returned null for dimension "${dimensionName}"`
  );
}
```

CoreLoop catches this throw and falls back to self_report. Self_report re-records the stale null. The loop spins but state never updates.

For `readme_created` and `getting_started_guide_created`, there is no adapter that knows how to map these dimension names to filesystem checks.

---

## Recommended Approach: Option A — New FileExistenceDataSourceAdapter

**Rationale**:
- Options B (smarter self_report) and D (LLM observation) both produce low-confidence (`self_report`/`independent_review` layer) results, which cap progress at 0.70 and 0.90 respectively. File existence checking is fully deterministic — it belongs in the `mechanical` layer (confidence 0.90, ceiling 1.0).
- Option C (shell command in mechanical verification) only runs post-task, not at the start of each loop iteration. It cannot drive the observe→gap→score cycle.
- Option A fits the existing pattern perfectly: write a new adapter, register it via a config file in `~/.motiva/datasources/`, done. No changes to CoreLoop, ObservationEngine, or any existing module.
- GitHubIssueDataSourceAdapter is the template. The pattern is: check `params.dimension_name` against a config-driven map, return `{ value: 1 }` (exists) or `{ value: 0 }` (missing).

**How it works for the "present" threshold type**:
- Threshold type `present` in GapCalculator treats non-null, non-zero values as "present."
- `value: 1` = file exists → gap = 0 → dimension satisfied.
- `value: 0` = file missing → gap > 0 → task generated.
- Confidence = 0.90 (mechanical layer), which meets the `>= 0.85` bar for mechanical verification.

---

## Implementation Spec

### File to create: `src/adapters/file-existence-datasource.ts`

New `FileExistenceDataSourceAdapter` implementing `IDataSourceAdapter`:

```typescript
// config.connection.path = base directory to check files in
// config.dimension_mapping = { "readme_created": "README.md", "getting_started_guide_created": "GETTING_STARTED.md", ... }
// query("readme_created") → checks if path.join(baseDir, dimension_mapping["readme_created"]) exists
// returns { value: 1 } if exists, { value: 0 } if not
// getSupportedDimensions() returns Object.keys(config.dimension_mapping ?? {})
// connect(): verify baseDir is accessible (non-fatal if not)
// healthCheck(): return true always (or check baseDir readability)
// sourceType: "custom"
```

The adapter must return `{ value: 0 }` (not null) for missing files — so that `observeFromDataSource` does NOT throw and records a real observation.

### File to modify: `src/cli-runner.ts`

In `buildDeps()`, add a new branch in the datasource loading loop:

```typescript
} else if (config.type === 'file_existence') {
  dataSources.push(new FileExistenceDataSourceAdapter(config));
}
```

Import `FileExistenceDataSourceAdapter` at the top.

### DataSource config file to create: `~/.motiva/datasources/file-existence.json`

Example for the dogfooding goal:
```json
{
  "id": "file-existence",
  "name": "File Existence Checker",
  "type": "file_existence",
  "connection": {
    "path": "/path/to/motiva/repo"
  },
  "dimension_mapping": {
    "readme_created": "README.md",
    "getting_started_guide_created": "GETTING_STARTED.md"
  },
  "enabled": true,
  "created_at": "2026-03-15T00:00:00.000Z"
}
```

### Optional: Add "file_existence" to DataSourceTypeEnum

In `src/types/data-source.ts`, add `"file_existence"` to `DataSourceTypeEnum`. This is clean but not strictly required (adapters use `"custom"` as a fallback type in the current pattern). Adding it explicitly makes the type system cleaner.

---

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/adapters/file-existence-datasource.ts` | **Create** | New adapter |
| `src/cli-runner.ts` | **Modify** | Add `file_existence` branch + import |
| `src/types/data-source.ts` | **Modify** (optional) | Add `"file_existence"` to enum |
| `~/.motiva/datasources/file-existence.json` | **Create** | Runtime config file |

---

## Parallelization

The two code changes (`file-existence-datasource.ts` creation + `cli-runner.ts` modification) touch distinct files and can be parallelized. `types/data-source.ts` change is a one-line enum addition that can be bundled with either worker.

---

## Confidence Labels

- CoreLoop observation flow (try data source → fallback to self_report): **Confirmed** (src/core-loop.ts lines 476–503)
- `observeFromDataSource` throws on null value: **Confirmed** (src/observation-engine.ts lines 370–374)
- `buildDeps()` datasource loading pattern: **Confirmed** (src/cli-runner.ts lines 107–124)
- "present" threshold + value 1/0 works as gap signal: **Likely** (requires checking gap-calculator.ts "present" branch, not read in this session)
- FileExistenceDataSourceAdapter returning `{ value: 0 }` instead of null will prevent the null-throw: **Confirmed** (observation-engine.ts null check is explicit)
