# Investigation: getting_started_guide_created stuck at 0

**Goal:** `0748b097-fa5b-48f5-a30c-ddaaeb44bc59`
**Date:** 2026-03-15

## Root Cause: Filename Mismatch (Option d)

**Confirmed.** The `ds_file_existence` data source maps the dimension to the wrong filename.

```
~/.motiva/datasources/ds_file_existence.json:
  "getting_started_guide_created": "GETTING_STARTED.md"   ← does not exist

Actual file location:
  motiva-workspace/docs/getting-started.md                ← exists
```

`FileExistenceDataSourceAdapter` calls `fs.existsSync(baseDir + "/" + filename)`.
`baseDir` = `/Users/yuyoshimuta/Documents/dev/Motiva/motiva-workspace`.
It looks for `GETTING_STARTED.md` at the root of that directory, but the real file is at `docs/getting-started.md`.
Result: `exists = false` → `value = 0` → dimension stays at 0.

`readme_created` works correctly because `README.md` IS at the root of the workspace.

## Why Observation Returns 0 with Confidence 0.9

The `FileExistenceDataSourceAdapter` IS wired up (cli-runner.ts line 122–124) and IS being called (observation entries show `layer: "mechanical"`, `source: "data_source"`, `endpoint: "ds_file_existence"` — or it would if registered). However, looking at the actual observations in `observations.json`, the mechanical entries all come from `ds_1773556087162` (GitHub Issues), not `ds_file_existence`. The self_report entries for `getting_started_guide_created` consistently show `raw_result: null, extracted_value: null, confidence: 0.1` during the early phase, then flipped to 0 with 0.9 confidence starting at `10:42` (mechanical via FileExistence or FileExistence erroring out).

The goal.json history confirms the flip pattern:
- Before ~10:42: value=null, confidence=0.1 (LLM can't observe filesystem)
- After ~10:42: value=1 for both dimensions (FileExistenceDataSource was correctly observing)
- At 11:11:49: both dimensions flipped to 0 (the data source started returning 0)

The flip to 0 at 11:11 is the new stall. The FileExistenceDataSourceAdapter is now checking for `GETTING_STARTED.md` (root of workspace) and getting false. The `readme_created=1` at the same time confirms `README.md` at root is found, but `GETTING_STARTED.md` is not.

## The 3-Data-Source Collision (Secondary Issue)

In CoreLoop `runOneIteration` (core-loop.ts lines 476–489), it tries ALL data sources for EACH dimension, stopping at the first success. With both `ds_1773556087162` (GitHub Issues) and `ds_file_existence` registered, the GitHub Issues adapter is tried first (file listing order). It succeeds for dimensions like `open_issue_count` / `closed_issue_count` / `completion_ratio` but will error on `readme_created` / `getting_started_guide_created` (unknown to GitHub Issues), allowing the FileExistenceDataSourceAdapter to handle those.

## Fix Required

Update `~/.motiva/datasources/ds_file_existence.json` to use the correct relative path:

```json
"dimension_mapping": {
  "readme_created": "README.md",
  "getting_started_guide_created": "docs/getting-started.md"
}
```

## Summary: Why Option d — File Path Mismatch

| Option | Status |
|--------|--------|
| a — LLM has no filesystem access | Partially true early on (first 16 obs returned null/0.1), but NOT the current cause |
| b — Observation prompt doesn't say WHERE to look | Also true early on, but not current cause |
| c — FileExistenceDataSource exists but not wired | FALSE — it IS wired in cli-runner.ts and ds_file_existence.json exists |
| d — File path doesn't match what observation expects | **CONFIRMED ROOT CAUSE** — datasource maps to `GETTING_STARTED.md` but actual file is `docs/getting-started.md` |

## Files Referenced

- `/Users/yuyoshimuta/.motiva/datasources/ds_file_existence.json` — dimension_mapping to fix
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/adapters/file-existence-datasource.ts` — adapter code (correct, no bug)
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/cli-runner.ts` lines 109–127 — datasource loading
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/core-loop.ts` lines 476–489 — data source dispatch loop
- `/Users/yuyoshimuta/Documents/dev/Motiva/motiva-workspace/docs/getting-started.md` — actual file location
