# Memory / MEMORY.md / docs/ Cleanup Audit

**Audit date:** 2026-03-15
**Auditor:** researcher agent

---

## 1. MEMORY.md (Claude memory — project-scoped)

Path: `/Users/yuyoshimuta/.claude/projects/-Users-yuyoshimuta-Documents-dev-Motiva/memory/MEMORY.md`

### Inaccuracies found

| Field | Current (wrong) | Correct | Action |
|-------|-----------------|---------|--------|
| Test count (header) | 2663テスト、53テストファイル | 2809テスト、61ファイル | Update |
| Test count (module section) | 2763テスト通過（60ファイル） | 2809テスト、61ファイル | Update |
| `docs/status.md` note in ドキュメント構成 | says "23設計ドキュメント" in design/ | Actually 19 files listed in Glob | Verify and update count |
| `memory/archive/` count | "38ファイル" | 43 files found in Glob | Update |

### Content missing from MEMORY.md

- `src/adapters/file-existence-datasource.ts` — FileExistenceDataSourceAdapter (added during dogfooding Phase B, is in git as commit dc2d8c2) not listed in 実装済みモジュール
- Dogfooding Phase B: the `in-progress.md` says "Phase B dogfooding 完了" but MEMORY.md still says "次: Phase B（小さいゴールでdogfood開始）" in 次のステップ section — OUTDATED
- `in-progress.md` describes the next active task: GoalNegotiator dimension filtering improvement (ゴール交渉での無関係次元混入防止). MEMORY.md 次のステップ does not mention this.
- `motiva-workspace/` directory exists (Phase B created docs there) — not mentioned

### 次のステップ section — OUTDATED

Current text: "Dogfooding Phase A 完了 — GitHub Issueアダプタ実装済み。次: Phase B（小さいゴールでdogfood開始）"

Correct status:
- Phase A: complete
- Phase B: complete (1 iteration converged, Codex generated README.md + GETTING_STARTED.md in motiva-workspace/, FileExistenceDataSourceAdapter wired and working, latest commit dc2d8c2)
- Next task: GoalNegotiator dimension filtering improvement (see in-progress.md for full spec)

### E2Eテスト状況 — PARTIALLY OUTDATED

- States "テスト4 (ループ実行): 要改善 — 承認プロンプトが繰り返しループ"
- The dogfooding stall investigations (v1, v2) and dogfood-phase-b-fixes.md describe what happened during Phase B with detailed root causes found
- Whether テスト4 was explicitly resolved is not confirmed from these files — but the approval ordering research (`dogfood-approval-ordering-research.md`) proposes fixes that may or may not have been applied
- Status: needs clarification, but at minimum "要改善" note is stale if Phase B completed successfully

---

## 2. CLAUDE.md (project instructions)

Path: `/Users/yuyoshimuta/Documents/dev/Motiva/CLAUDE.md`

### Inaccuracies

| Field | Current (wrong) | Correct |
|-------|-----------------|---------|
| Test count | "2663 tests, 53 test files" | 2809 tests, 61 files |
| `docs/design/` count | "23 files" (implied by MEMORY.md) | Count from Glob = 19 files listed — but docs/design/ has more; need recount |

### No action needed

- Layer descriptions (0-14) are accurate
- Key constraints are accurate
- Tech stack is accurate

---

## 3. docs/status.md

Path: `/Users/yuyoshimuta/Documents/dev/Motiva/docs/status.md`

### Inaccuracies

| Field | Current (wrong) | Correct |
|-------|-----------------|---------|
| Header line | "2663 tests, 53 files" | 2809 tests, 61 files |
| Stage 14 status line | "2663テスト、53テストファイル" | 2809 tests, 61 files |

### Missing from status.md

- OpenAI/Codex adapter (`src/openai-client.ts`, `src/adapters/openai-codex.ts`, `src/provider-factory.ts`) — added 2026-03-15, not mentioned anywhere in status.md
- GitHub Issue adapter (`src/adapters/github-issue.ts`, `src/adapters/github-issue-datasource.ts`) — not in status.md
- `FileExistenceDataSourceAdapter` (`src/adapters/file-existence-datasource.ts`) — not in status.md
- These are post-Stage-14 additions that need their own section (e.g., "Dogfooding Infrastructure") or be rolled into the stage 13 DataSource section

### Accurate sections

- Stage 1–14 content is accurate; the additions are just missing

---

## 4. docs/architecture-map.md

Path: `/Users/yuyoshimuta/Documents/dev/Motiva/docs/architecture-map.md`

### Inaccuracies

- Section 5 implementation status note (line ~305): "Stage 1-14完了 — 2663テスト通過、53テストファイル" → update to 2809/61
- The architecture diagram itself does not show the OpenAI/Codex or GitHub Issue adapters in the execution layer (shows Claude Code, Claude API, カスタムエージェント, 人間) — arguably correct at the conceptual level (カスタム covers them), so this may be acceptable

### No structural update needed

- All Layer 13/14 components are correctly represented
- TUI layer is represented
- The diagram reflects the current architecture accurately at a conceptual level

---

## 5. docs/dogfooding-plan.md

Path: `/Users/yuyoshimuta/Documents/dev/Motiva/docs/dogfooding-plan.md`

### Status

The plan still shows checkboxes in an unchecked state:
```
Phase Aの成功:
- [ ] `motiva run --adapter github_issue` でissueが作成される
- [ ] 作成されたissueが具体的で実行可能
- [ ] 次のループでissue状態を観測できる

Phase Bの成功:
- [ ] Motivaが3つ以上の有用なissueを自動起票
- [ ] issueを解決したらMotivaが進捗を正しく認識
- [ ] ループが自然に収束（ゴール達成 or satisficing判定）
```

### What actually happened

From `in-progress.md`:
- Phase B dogfooding complete: 1 iteration converged, Codex generated README.md + GETTING_STARTED.md in motiva-workspace/
- FileExistenceDataSourceAdapter successfully observed file existence mechanically
- `Final status: completed` — loop converged

Phase A was complete (GitHub Issue adapter built). Phase B achieved partial success (1-iteration convergence with file-existence observation — not the GitHub Issue issue-count loop originally envisioned). The checkboxes should be updated to reflect reality.

### Action: Update dogfooding-plan.md

- Check off completed Phase A items
- Update Phase B: note that Phase B completed with a modified approach (file existence adapter + Codex CLI), describe what was discovered (dimension-mismatch issues, fixes applied)
- Add Phase C status: not started, blocked on GoalNegotiator dimension filtering fix (in-progress.md)

---

## 6. memory/ files in /Users/yuyoshimuta/Documents/dev/Motiva/memory/ (non-archive)

### File-by-file assessment

| File | Date | Content | Still active? | Recommendation |
|------|------|---------|---------------|----------------|
| `dogfood-stall-investigation.md` | 2026-03-15 | First stall investigation: 4-iteration stall with goal e0b3a12f. Found 7 issues (gap history persistence, self_report null, wrong threshold types, etc.) | Superseded by v2 which has more precise analysis | **Archive** — v2 is the canonical version |
| `dogfood-stall-investigation-v2.md` | 2026-03-15 | Second stall investigation: 9-iteration stall, same goal. More precise root cause with exact stall timing math, full flow trace, 5 fix options (A-E) | Root cause is resolved (Phase B completed with different approach) | **Archive** — investigation complete, fixes implemented or bypassed |
| `dogfood-fixes-research.md` | 2026-03-15 | Research on 3 bugs: `gh` not in mechanicalPrefixes, task prompt missing goal context, handleFailure stale task overwrite | 3 bugs found, proposed fixes. Unknown if all were implemented | **Keep temporarily** — need to verify if these code fixes were applied; if yes, archive |
| `dogfood-approval-ordering-research.md` | 2026-03-15 | Root cause of approval prompt display ordering anomalies. 4 fixes proposed: pause/resume readline, newline after answer, gate debug logs, no fix needed for one non-bug | Fixes proposed but unclear if implemented | **Keep temporarily** — same as above; verify implementation then archive |
| `capability-negotiation-research.md` | 2026-03-15 | Research on capability-aware GoalNegotiator: what needs to change for negotiate() to detect adapter limitations. Comprehensive gap analysis. | Task is in-progress.md as next task | **Keep** — this is active reference for next implementation task |
| `dogfood-phase-b-fixes.md` | 2026-03-15 | Root cause of observation null for doc-quality dimensions. Full analysis + 3-fix plan (Fix A: negotiation prompt, Fix B: GitHub Issue dedup, Fix C: task prompt injection). Minimal fix pair recommendation. | Phase B is complete but these fixes affect future dogfooding | **Keep** — Fix A (negotiation prompt improvement) is still needed for next phase |
| `dogfood-progress-observation-research.md` | 2026-03-15 | Research on FileExistenceDataSourceAdapter design + implementation spec. | Implemented (commit dc2d8c2 and 90469be). Research served its purpose. | **Archive** — implementation complete |
| `capability-negotiation-gaps.md` | 2026-03-15 | Gap-fill research for capability-negotiation-research.md. Confirms: adapterCapabilities already wired in cli-runner.ts, all 3 main adapters have capabilities, GitHubIssueAdapter missing capabilities, CapabilityDetector needs new goal-level method, GoalNegotiator constructor needs 8th param | This is the companion to capability-negotiation-research.md, both active | **Keep** — still needed for next implementation task |
| `dogfood-observation-stall.md` | 2026-03-15 | Investigation of getting_started_guide_created stuck at 0. Root cause: filename mismatch in ds_file_existence.json (maps to GETTING_STARTED.md but actual file is docs/getting-started.md) | One-line data fix (update datasource JSON). Phase B converged anyway. | **Archive** — investigation resolved, data fix is a config-level fix in ~/.motiva |

---

## 7. Claude agent memory files

Path: `/Users/yuyoshimuta/.claude/projects/-Users-yuyoshimuta-Documents-dev-Motiva/memory/`

### File assessment

| File | Content | Recommendation |
|------|---------|----------------|
| `MEMORY.md` | Main index — multiple inaccuracies (see section 1) | Update |
| `in-progress.md` | Describes completed Phase B and next task (GoalNegotiator dimension filtering). Accurate. | Keep, update when next task starts |
| `e2e-test-results.md` | E2E test results from 2026-03-11. Marked "4 days old" by memory system. Test 4 still shows "要改善". | Update status of Test 4 if resolved, or note Phase B completed successfully despite it |
| `project_test_audit_findings.md` | 4 production bugs from test audit. All 4 marked as resolved (2026-03-14). | Still accurate — all 4 resolved. Keep as reference for past bug pattern. Could archive but low cost to keep. |
| `feedback_smaller_stages.md` | Feedback: split large stages into sub-stages | Keep — ongoing guidance |
| `feedback_default_test_model.md` | Feedback: use Codex 5.3 as default for dogfooding/manual tests | Keep — ongoing guidance |
| `feedback_test_failure_code_first.md` | Feedback: check production code before modifying tests | Keep — ongoing guidance |

---

## 8. Summary: Recommended Actions

### Immediate updates (outdated facts)

1. **MEMORY.md** — Update test count to 2809/61; update 次のステップ to reflect Phase B completion and GoalNegotiator dimension filtering as next task; add FileExistenceDataSourceAdapter to 実装済みモジュール
2. **CLAUDE.md** — Update test count to 2809 tests, 61 test files
3. **docs/status.md** — Update test count; add section for post-Stage-14 additions (OpenAI/Codex adapter, GitHub Issue adapter, FileExistenceDataSourceAdapter)
4. **docs/architecture-map.md** — Update test count in §5 note (line ~305)
5. **docs/dogfooding-plan.md** — Check off completed Phase A/B items; add Phase C status and blockers

### Archive (work complete, no longer needed for active reference)

Move to `memory/archive/`:
- `dogfood-stall-investigation.md` (superseded by v2)
- `dogfood-stall-investigation-v2.md` (root cause resolved)
- `dogfood-progress-observation-research.md` (implementation complete)
- `dogfood-observation-stall.md` (config-level fix identified)

### Keep (still needed)

Keep in `memory/` (active reference):
- `dogfood-fixes-research.md` — 3 bugs may not all be fixed yet
- `dogfood-approval-ordering-research.md` — fixes may not be applied
- `capability-negotiation-research.md` — next implementation task
- `capability-negotiation-gaps.md` — next implementation task (companion)
- `dogfood-phase-b-fixes.md` — Fix A (negotiation prompt) still needed

### Conditionally archive (verify first)

- `dogfood-fixes-research.md` — if all 3 bugs (gh mechanicalPrefixes, task prompt, handleFailure stale task) are confirmed fixed → archive
- `dogfood-approval-ordering-research.md` — if approval ordering fixes applied → archive

---

## 9. Gaps (could not determine)

- Whether the 3 bugs in `dogfood-fixes-research.md` were implemented (would require reading task-lifecycle.ts and cli-runner.ts current state)
- Whether the approval ordering fixes in `dogfood-approval-ordering-research.md` were applied
- Exact current test count (2809/61 is from CLAUDE.md system context, which itself may be stale if tests changed since last session)
- Whether `docs/design/` contains exactly 19 or 23 files (Glob returned 19 .md files in design/, but MEMORY.md says 23 — the discrepancy may be because some design docs are in a subdirectory or MEMORY.md count is wrong)
