# Doc & Memory Cleanup Audit — 2026-03-15

Audited at Stage 14 completion (2663 tests, 53 files).

---

## A. Memory Cleanup Needed

### Files that should be archived (move to `memory/archive/`)

| File | Location | Reason |
|------|----------|--------|
| `memory/stage13-plan.md` | `memory/` root | Stage 13 is complete. This plan file belongs in `memory/archive/` alongside all other completed stage plans. |
| `memory/test-quality-audit.md` | `memory/` root | All P0/P1 issues are resolved per `project_test_audit_findings.md` (marked "完了" 2026-03-14). Content is historical, not actionable. Should be archived. |

### Files in `~/.claude/projects/.../memory/` to update or retire

| File | Issue |
|------|-------|
| `project_test_audit_findings.md` | Status says all 4 bugs "完了". The file is finished — its content should be summarized in a note in MEMORY.md and the file itself can be left (it serves as audit log), but MEMORY.md still references it under "プロダクションコード潜在バグ" framing, implying open issues. That section needs updating to say "全件解決済み". |
| `e2e-test-results.md` | Dated 2026-03-11 (4 days old). E2E test 4 is listed as "要改善" (unresolved), but no subsequent work has been recorded. Either the issue was fixed (in which case update the file) or it remains open (in which case it should be surfaced as an active known issue, not buried in a timestamped file). |
| `in-progress.md` | Contains "現在進行中のタスクなし" — up to date, no action needed. |

### Files already correctly in `memory/archive/` — no action needed

All `stage1` through `stage14*` research/plan files, `prod-bug-investigation.md`, `test-fix-research.md`, `doc-update-research.md`, `stage13-status-check.md` — all confirmed present and correctly archived.

---

## B. MEMORY.md Issues

**Confirmed: MEMORY.md is over the 200-line limit** — the system reminder warns it is 202 lines (limit: 200). The last 2 lines are truncated in context.

### Specific outdated or wrong content

1. **Line 17 — "潜在バグ4件（Stage 7で要確認）"**: This note is wrong. All 4 bugs were investigated and resolved on 2026-03-14 (see `project_test_audit_findings.md` status section). The framing implies open issues when there are none.

2. **Line 39 — "roadmap.md — Post-MVPロードマップ（Stage 7-13）"**: Roadmap now covers Stage 7-14+ (Stage 14 is complete, Stage 15 is next). The Stage 13/14 summary in `docs/roadmap.md` still shows both as "未着手" which is now wrong (see section D).

3. **Line 95 — archive listing is incomplete**: The archive listing does not include the Stage 13 files (`stage13-research.md`, `stage13-status-check.md`) or the five Stage 14 files (`stage14-plan.md`, `stage14b/c/d/e-research.md`). These files exist in the archive and are referenced in MEMORY.md §"次のステップ" (line 178) but omitted from the archive tree.

4. **Line 101 — "src/types/ — 25 Zodスキーマファイル"**: The actual count from `ls src/types/` is 29 files (confirmed via Glob). The count was accurate at Stage 1, but has grown through Stage 14 and is now stale.

5. **Line 9 — "TUI Phase 1-2: 実装済み（10ファイル in src/tui/）"**: Actual TUI file count from Glob is 5 `.ts` files in `src/tui/`. If the count of 10 previously included `.tsx`/`.js` files, those either do not exist or were consolidated. Needs verification and correction.

6. **Line 167 — テスト: 2663テスト通過（53ファイル）**: This is correct per `docs/status.md` and `CLAUDE.md`. No action needed.

7. **MEMORY.md exceeds 200 lines**: The detailed archive file tree (lines 63-96) is the main source of bloat. This should be trimmed or moved to a separate reference file, and MEMORY.md should just say "see `memory/archive/` for completed stage files".

### Recommended MEMORY.md edits

- Update "潜在バグ" section to "全件解決済み（2026-03-14）"
- Update roadmap description to "Stage 7-15 対象"
- Fix `src/types/` file count (29 files)
- Fix `src/tui/` file count (5 .ts files)
- Trim or remove the archive file tree block (lines 63-96) and replace with a one-liner
- Add Stage 13 and Stage 14 archive files to the archive listing or remove the listing entirely

---

## C. CLAUDE.md Issues

### Outdated content

1. **Line 40 — "For Stage 7-9 details, see docs/status.md"**: The project is now at Stage 14. This reference is misleading — it implies Stage 7-9 are the most recently documented stages. Should read: "For full stage-by-stage details, see `docs/status.md`."

2. **Line 65 — "docs/design/ — detailed design for each subsystem (19 files)"**: Actual count from Glob is **23 design files** (the original 19 + `data-source.md`, `goal-tree.md`, `learning-pipeline.md`, `knowledge-transfer.md` added in Stages 13-14). The count is wrong.

3. **Layer numbering inconsistency**: CLAUDE.md lists Layer 13 as "CapabilityDetector, DataSourceAdapter" but also lists Layer 8 as "KnowledgeManager, CapabilityDetector". CapabilityDetector appears in both Layer 8 and Layer 13. This reflects the fact that Stage 8 introduced CapabilityDetector and Stage 13 extended it, but the layer list is ambiguous for new readers. Layer 8 should say "KnowledgeManager" only, and Layer 13 should say "CapabilityDetector (extended), DataSourceAdapter".

### Missing content

4. **`src/ollama-client.ts` is unmentioned**: The source tree contains `src/ollama-client.ts` which is not referenced anywhere in CLAUDE.md, MEMORY.md, or `docs/status.md`. It may have been introduced quietly. No documentation.

5. **`src/tui/markdown-renderer.ts` is unmentioned**: MEMORY.md states TUI has "10ファイル" but actually has 5 `.ts` files including `markdown-renderer.ts`. The TUI architecture doc in `runtime.md` lists only `App | Dashboard | Chat | ApprovalOverlay | HelpOverlay | ReportView | IntentRecognizer` but none of these `.tsx` files appear in the Glob results. The TUI implementation may have been restructured — `app.tsx`, `dashboard.tsx`, `chat.tsx`, etc. are NOT present in `src/tui/`. Only: `markdown-renderer.ts`, `intent-recognizer.ts`, `actions.ts`, `entry.ts`, `use-loop.ts`.

---

## D. docs/ Issues

### `docs/roadmap.md` — stale stage status table

The roadmap summary table (line ~44-50) shows:

| Stage | 状態 |
|-------|------|
| 13 | 未着手 |
| 14 | 未着手 |

Both Stage 13 and Stage 14 are **complete**. The table needs updating to "実装済み" for both. The dependency tree diagram and the per-stage narrative text do not need structural changes, but the status column and the preamble ("前提: Stage 1-12 完了（1919テスト、40テストファイル）") are wrong — should reflect Stage 1-14 complete, 2663 tests, 53 files.

### `docs/status.md` — Stage 13 description is sparse

Stage 13's entry (lines 119-127) is unusually short (7 lines) compared to other stages. It mentions CapabilityDetector and DataSourceAdapter but omits:
- The `planAcquisition` / `verifyAcquiredCapability` / `registerCapability` / `getAcquisitionHistory` methods added to CapabilityDetector
- The `IDataSourceAdapter`, `FileDataSourceAdapter`, `HttpApiDataSourceAdapter`, `DataSourceRegistry` implementations
- The new CLI subcommands: `datasource add / list / remove`
- The `docs/design/data-source.md` design doc created
- Test file additions

This should be expanded to match the detail level of other completed stages.

### `docs/architecture-map.md` — appears up to date

The architecture map (§5 "ドキュメントマップ") has an implementation note at line 305-309 explicitly mentioning Stage 13 and Stage 14 additions with the current date (2026-03-15). **Confirmed up to date.**

### `docs/mechanism.md` — appears up to date

Contains explicit "Stage 14（完了）" note at line 366 with full list of Stage 14 modules. **Confirmed up to date.**

### `docs/vision.md` — appears up to date

Contains "実装状況（Stage 14完了）" notes at §5.2 and §5.5. **Confirmed up to date.**

### `docs/runtime.md` — partially outdated

The runtime doc describes the TUI architecture (Phase 1b section) listing `app.tsx`, `dashboard.tsx`, `chat.tsx`, etc. as TUI components. However, based on the actual source tree, these `.tsx` files do not exist. The TUI appears to have been restructured — only `.ts` files remain in `src/tui/`. The runtime.md TUI component listing may describe a planned or partially implemented architecture that was changed. **Needs investigation and correction.**

### `docs/design/` — new files not listed in CLAUDE.md

4 new design docs added in Stage 13/14 are present:
- `docs/design/data-source.md` (Stage 13)
- `docs/design/goal-tree.md` (Stage 14)
- `docs/design/learning-pipeline.md` (Stage 14)
- `docs/design/knowledge-transfer.md` (Stage 14)

CLAUDE.md says "19 files" but there are now 23. MEMORY.md's design doc listing also shows only the original 15 (missing `data-source.md`, `goal-tree.md`, `learning-pipeline.md`, `knowledge-transfer.md`).

Also: `docs/design/portfolio-management.md` is listed in `docs/architecture-map.md` as "実装済み" but is NOT listed in MEMORY.md's design doc tree. Needs adding.

### `docs/design/reporting.md` vs `docs/design/goal-ethics.md` naming

The architecture-map references `goal-ethics.md` but the actual file is `docs/design/goal-ethics.md` — consistent. However MEMORY.md's design tree (line 48) lists `goal-ethics-gate.md` (with `-gate`) while the actual filename is `goal-ethics.md`. Minor naming discrepancy in MEMORY.md.

---

## E. Inconsistencies (Docs vs. Code)

### 1. TUI file list mismatch — HIGH PRIORITY

**Docs claim**: `runtime.md` §Phase 1b lists `App (app.tsx)`, `Dashboard`, `Chat`, `ApprovalOverlay`, `HelpOverlay`, `ReportView`, `IntentRecognizer` as TUI components. MEMORY.md says "10ファイル in `src/tui/`".

**Code reality**: `src/tui/` contains exactly 5 `.ts` files:
- `markdown-renderer.ts`
- `intent-recognizer.ts`
- `actions.ts`
- `entry.ts`
- `use-loop.ts`

No `.tsx` files exist. No `app`, `dashboard`, `chat`, `approval-overlay`, `help-overlay`, `report-view` files. Either: (a) these were never implemented and the docs are aspirational, (b) they were implemented then removed, or (c) they were renamed/consolidated. The MEMORY.md "10 files" count cannot be reconciled with 5 actual files.

**Impact**: `runtime.md` §Phase 1b is documenting an architecture that does not match the code. New developers reading this would be confused.

### 2. `ollama-client.ts` exists in src/ but is undocumented

`src/ollama-client.ts` appears in the source tree. It is not mentioned in MEMORY.md, CLAUDE.md, `docs/status.md`, or any design doc. The MEMORY.md "技術メモ" section lists `EmbeddingClient` classes but not `OllamaClient` as a separate top-level module. This may be a client extracted from `embedding-client.ts` for standalone use — unclear.

### 3. `docs/roadmap.md` preamble vs. actual state

The roadmap preamble says "前提: Stage 1-12 完了（1919テスト、40テストファイル）" — but Stage 13 and 14 are now complete with 2663 tests and 53 files. The entire document was written as forward-looking from Stage 12, and its "未着手" status entries for Stage 13/14 have never been updated.

### 4. MEMORY.md design doc listing missing `portfolio-management.md`

`docs/design/portfolio-management.md` exists on disk (confirmed via Glob) but is not in MEMORY.md's design doc listing. The architecture-map.md table does list it. Minor gap.

### 5. Stage 13 description in `memory/stage13-plan.md` — "未着手" header

`memory/stage13-plan.md` (which should be archived) has a header "ステータス: 計画策定済み、未着手". This conflicts with Stage 13 being complete. Archiving this file (see Section A) would resolve this.

---

## Summary: Priority Actions

| Priority | Action | File(s) |
|----------|--------|---------|
| P0 | Investigate TUI `.tsx` file discrepancy — docs reference files that don't exist | `runtime.md`, MEMORY.md, `src/tui/` |
| P0 | Archive `memory/stage13-plan.md` | `memory/stage13-plan.md` → `memory/archive/` |
| P1 | Archive `memory/test-quality-audit.md` | `memory/test-quality-audit.md` → `memory/archive/` |
| P1 | Update `docs/roadmap.md` Stage 13/14 status to "実装済み" + fix preamble | `docs/roadmap.md` |
| P1 | Expand `docs/status.md` Stage 13 section | `docs/status.md` |
| P1 | Fix MEMORY.md: "潜在バグ" → "全件解決済み"、type count 25→29、TUI count 10→5 | MEMORY.md |
| P1 | Fix CLAUDE.md: "19 files" → "23 files", fix Stage 7-9 reference | `CLAUDE.md` |
| P2 | Add `docs/design/` new files to MEMORY.md listing (data-source, goal-tree, learning-pipeline, knowledge-transfer, portfolio-management) | MEMORY.md |
| P2 | Document `src/ollama-client.ts` | MEMORY.md or `docs/status.md` |
| P2 | Fix MEMORY.md archive tree listing (add Stage 13/14 archive files) | MEMORY.md |
| P2 | Trim MEMORY.md below 200 lines | MEMORY.md |
| P3 | Clarify CapabilityDetector dual-layer mention (Layer 8 vs Layer 13) | `CLAUDE.md` |
| P3 | Resolve `goal-ethics.md` vs `goal-ethics-gate.md` naming discrepancy in MEMORY.md | MEMORY.md |
