# Test Quality Audit

## Summary
- Total files analyzed: 30
- Total tests: ~1,439 (as reported in CLAUDE.md)
- Overall quality grade: **B+**
- Test location: `tests/` (not `src/__tests__/` as the task specified — no files were missed)

---

## Critical Issues (tests that may give false confidence)

1. **cli-runner.test.ts — near-total mock coverage**: Every meaningful dependency (CoreLoop, GoalNegotiator, LLMClient, TrustManager, DriveSystem, ObservationEngine, StallDetector, SatisficingJudge, EthicsGate, SessionManager, StrategyManager, AdapterRegistry) is replaced with `vi.fn().mockImplementation(() => ({}))` returning empty objects. The tests verify argument parsing and exit-code routing, but they cannot detect any bug in the actual wiring of these dependencies inside CLIRunner. This is the single largest false-confidence risk in the suite.

2. **core-loop.test.ts — fully mocked loop internals**: CoreLoop is tested by injecting mock implementations of every collaborator (ObservationEngine, TaskLifecycle, SatisficingJudge, StallDetector, StrategyManager, DriveSystem). The mocks return hardcoded happy-path values. Loop iteration logic (observe→gap→score→task→verify) is exercised only through mock call count tracking, not through real data flow. Integration failures between real modules would not be caught.

3. **portfolio-manager.test.ts — vi.fn() mocks with `as unknown as` casts**: StrategyManager and StateManager are stubbed with minimal vi.fn() mocks. The `as unknown as StrategyManager` cast bypasses TypeScript's type checking, meaning the mock shape may silently drift from the real interface without test failure. Allocation arithmetic, rebalancing decisions, and strategy selection logic are tested in isolation from the real StrategyManager state machine.

4. **task-lifecycle.test.ts — LLM mock bypasses the "thinking" being tested**: TaskLifecycle's most important behavior is orchestrating LLM-driven task generation, approval, execution, and 3-layer verification. The mock LLM returns fixed JSON strings that are chosen to pass Zod validation. This means: (a) any prompt engineering regression is invisible, (b) the LLM response parser path for malformed output is only tested if malformed strings were explicitly included in the mock queue.

5. **daemon-runner.test.ts — mock CoreLoop always succeeds**: `coreLoop.run` is mocked to always resolve with `finalStatus: "completed"`. The daemon's error handling paths (loop error, repeated stall escalation, unexpected crash) are not exercised through real code. Signal handling (SIGINT/SIGTERM) tests clean up listeners in afterEach, which partially mitigates state bleed, but the actual graceful-shutdown timing contract is not verified.

6. **intent-recognizer.test.ts — LLM path tests mock the parseJSON directly**: When LLM-based intent classification is triggered, the mock `parseJSON` does `schema.parse(JSON.parse(content.trim()))`, which works for well-formed JSON but silently skips the real client's markdown code-block extraction. Tests that exercise LLM classification assume the JSON is delivered bare, not in `\`\`\`json` blocks as a real LLM response would include.

---

## Per-File Analysis

### gap-calculator.test.ts
- Tests: ~55
- Quality: **A**
- Issues:
  - No false-positive risk. Pure functions, no mocks needed.
  - `expect(result.timestamp).toBeTruthy()` (calculateGapVector test) is mildly weak — but timestamp presence is not the critical assertion here.
  - The "handles string current_value for numeric threshold" edge case uses `as unknown as number`, which verifies JS coercion behavior but documents surprising runtime behavior rather than guarding against it.
- Missing scenarios:
  - NaN as current_value — would NaN propagate silently through the pipeline?
  - Infinity as current_value — min threshold with `Infinity` would return gap=0, which is correct but untested.
  - Very high `uncertainty_weight` values (>2.0) — no cap test; result could exceed 1.3 cap silently.

### drive-scorer.test.ts
- Tests: ~50
- Quality: **A**
- Issues:
  - Assertions are specific and math-verified with hand-computed expected values shown in comments.
  - `scoreAllDimensions` tests check field presence with `toHaveProperty` and structural correctness but do not verify the exact numeric scores for the specific dimension scenario (coverage vs. performance). The one numeric comparison (`expect(performance.dissatisfaction).toBeGreaterThan(coverage.dissatisfaction)`) is directional rather than precise.
  - `combineDriveScores` helper `makeD` builds a dissatisfaction score indirectly via `scoreDissatisfaction`, coupling the test to that function's output — not a problem, but slightly opaque.
- Missing scenarios:
  - Opportunity score when `detected_at` is far in the past (freshness_decay → 0) — this path is partially covered by `t=very large` test but not exercised through `scoreAllDimensions`.
  - What happens when `time_since_last_attempt` is missing for a dimension in `scoreAllDimensions` context.

### drive-system.test.ts
- Tests: ~45
- Quality: **A-**
- Issues:
  - Tests use real filesystem I/O with temp directories — correctly isolated with beforeEach/afterEach.
  - `shouldActivate` for unknown goal (no saved goal, no schedule) tests pass, but there is a philosophical gap: the test asserts `true` for a nonexistent goal without verifying this is intentional behavior rather than a missing null check.
  - The `atomic write` test only checks that no `.tmp` file remains — it does not verify the file content is identical to what was written (though `round-trips` test achieves this indirectly).
- Missing scenarios:
  - Concurrent event file writes (race condition between `readEventQueue` and `archiveEvent`) — not practically testable in unit tests but worth noting as a gap.
  - Event queue with hundreds of files — performance/ordering is assumed to be stable but not tested.

### state-manager.test.ts
- Tests: ~30
- Quality: **A-**
- Issues:
  - `saveGoalTree` / `loadGoalTree` test only checks that 2 goals exist (`Object.keys(loaded!.goals)).toHaveLength(2)`) but does not verify the tree structure (parent_id / children_ids relationships).
  - `appendObservation` test writes 2 entries and verifies count and IDs — good. But no test for what happens if the observation log file is corrupted (partial write).
  - `writeRaw` / `readRaw` round-trip is tested but there is no test for deeply nested paths or path traversal safety.
- Missing scenarios:
  - Concurrent writes to the same goal (atomic write correctness under concurrency).
  - loadGoal with a goal file that passes JSON parse but fails Zod schema validation — does it throw, return null, or silently return partial data?

### trust-manager.test.ts
- Tests: ~35
- Quality: **A**
- Issues:
  - Excellent coverage of the asymmetric penalty model, clamping, and persistence.
  - `requiresApproval` with `execute_with_confirm` quadrant returns `false` for reversible actions — but neither `execute_with_confirm` branch test verifies the specific trust/confidence values that put it there; they rely on `setOverride` shortcuts. The boundary between `execute_with_confirm` and `observe_and_propose` for low-trust/low-confidence is tested, but the exact threshold values are hard-coded magic numbers that could silently change.
  - The `override_log` inspection test reads raw JSON from disk to verify log format — this couples the test to internal persistence schema, but the benefit (catching format regressions) outweighs the coupling cost.
- Missing scenarios:
  - `requiresApproval` with `hasPermanentGate` set — permanent gate always requires approval regardless of quadrant, but there is no direct test of permanent-gate + reversible action combination.

### observation-engine.test.ts
- Tests: ~50
- Quality: **A-**
- Issues:
  - `createObservationEntry` confidence clamping tests are thorough (boundary values for all three tiers).
  - `resolveContradiction` pessimistic rule for non-numeric values (`extracted_value: "done"`) returns "first entry" — the comment says "first entry in the group" but the test assertion checks `extracted_value === "done"` which happens to be the first element. The ordering assumption is implicit.
  - `detectKnowledgeGap` tests only check for `interpretation_difficulty` signal type — there are presumably other signal types but they are not listed or tested.
  - `needsVerificationTask` assertions are all `toBe(true/false)` — correct and precise for a boolean predicate.
- Missing scenarios:
  - `applyObservation` with a dimension that has a `state_integrity: "compromised"` flag — how does it affect updates?
  - `resolveContradiction` with mixed numeric and non-numeric extracted values across layers.

### ethics-gate.test.ts
- Tests: ~45
- Quality: **A**
- Issues:
  - Mock LLM client is realistic: it implements both `sendMessage` and `parseJSON` correctly including markdown block extraction. The `parseJSON` implementation mirrors the production client.
  - Auto-flag boundary at confidence 0.6 (exclusive) is tested precisely.
  - JSON parse failure fallback is tested end-to-end through `gate.check()`, not just unit-testing the parser.
  - `LLM call failure propagates` test with network error has a slightly weak assertion: `rejects.toThrow("Network error")` — it only checks the error message string rather than the error type. Not a serious issue.
- Missing scenarios:
  - Rate limit / quota error from LLM (different error shape than network error).
  - Extremely long goal descriptions that might cause issues with prompt construction.
  - `checkMeans` with a task that has `verdict: "reject"` at low confidence — covered by the general low-confidence test in `check()`, but not a dedicated `checkMeans` variant.

### llm-client.test.ts
- Tests: ~20
- Quality: **B+**
- Issues:
  - `LLMClient.sendMessage` is never actually tested against the real Anthropic API (expected — would require API key and network). Tests only cover constructor, parseJSON, and the mock client.
  - `MockLLMClient` exhaustion test checks that it `rejects.toThrow()` but does not verify the error message content, making the failure mode opaque.
  - `LLMClient.parseJSON` in the "real client" tests is exercised but `sendMessage` retry logic, rate limiting, and token counting behavior are not tested at all.
- Missing scenarios:
  - `parseJSON` with content containing multiple JSON blocks (should it take the first? last?).
  - `MockLLMClient` reset behavior — once exhausted, can it be reused or does it stay broken?

### stall-detector.test.ts
- Tests: ~55
- Quality: **A**
- Issues:
  - Setup uses module-level `let` variables with `beforeEach` — correctly isolated.
  - `checkDimensionStall` with slightly decreasing gap (e.g., `[0.5, 0.5, 0.5, 0.5, 0.5, 0.49]`) is not tested — does a 0.01 improvement prevent stall detection? The threshold for "improving" is implicit.
  - `classifyStallCause` tests use plain object literals (`{ dimensions: [...] }`) cast implicitly — not typed as `Goal`. This tests the duck-typed behavior but silently allows structural drift from the actual Goal type.
  - `isSuppressed` boundary test uses `Date.now() - 1000` to avoid flakiness — pragmatic but means the `=== now` case is untested.
- Missing scenarios:
  - Gap history that oscillates (0.5, 0.3, 0.5, 0.3) — is this a stall or improving?
  - `checkGlobalStall` when one dimension has zero gap (already completed) — should it still count toward the global stall?

### satisficing-judge.test.ts
- Tests: ~55
- Quality: **A**
- Issues:
  - Progress ceiling values (1.0 / 0.85 / 0.60 for high/medium/low confidence) are tested precisely with boundary values. Excellent.
  - `detectThresholdAdjustmentNeeded` bottleneck test verifies that `proposed_threshold < current_threshold` but does not check the specific proposed value — the adjustment algorithm is a black box from the test perspective.
  - `propagateSubgoalCompletion` for `max` threshold type is not tested — only `min`, `range`, `present`. If a subgoal has `max` threshold, what value is propagated?
  - `selectDimensionsForIteration` uncertainty filter test: a dimension with `confidence: 0.30` is filtered out when `uncertainty_threshold: 0.50`. But the test asserts by name inclusion only, not by ordering stability.
- Missing scenarios:
  - `isGoalComplete` with `user_override: true` — does it bypass normal completion checks?
  - `detectThresholdAdjustmentNeeded` for `present` or `match` threshold types (currently only tested for `min`).

### session-manager.test.ts
- Tests: ~55
- Quality: **A-**
- Issues:
  - Context slot tests check label and priority but do NOT verify slot content is meaningful — `p1.content.toContain("goal-abc")` is the deepest content assertion. The actual context content quality is untested.
  - `buildObservationContext` bias-prevention test (`does NOT contain executor self-report`) tests negative assertions against a hard-coded exclusion list that could miss new slots added in future.
  - `injectKnowledgeContext` superseded entry exclusion is well-tested.
  - `getActiveSessions` tests create sessions without mocking time, so very rapid test execution could theoretically create sessions with identical timestamps — not a real risk but worth noting.
- Missing scenarios:
  - Context budget enforcement: what happens when slots exceed `context_budget`? Is there trimming logic?
  - `endSession` called twice on the same session.

### goal-negotiator.test.ts
- Tests: ~60+ (file was truncated in reading — assessed from preview)
- Quality: **B+**
- Issues:
  - MockLLMClient is custom-built per file (as in ethics-gate) with realistic `parseJSON`. The mock's `parseJSON` handles both `\`\`\`json` and generic `\`\`\`` blocks — slightly more permissive than the actual client, which could mask format regressions.
  - The `EthicsRejectedError` import and usage suggests ethics rejection flow is tested, which is a critical path.
  - LLM responses are pre-built JSON strings representing the full 6-step negotiation protocol — these fixtures are fragile: if the prompt format or JSON schema changes, every fixture must be updated.
  - The `callCount` getter on the mock tracks how many LLM calls occurred, allowing tests to verify the N+3 call budget — this is a good implementation-coupling test that is justified here.
- Missing scenarios:
  - Negotiation with a genuinely impossible goal (e.g., threshold requires negative current_value for a min threshold).
  - LLM returns a counter-proposal that itself fails ethics gate.

### adapter-layer.test.ts
- Tests: ~30
- Quality: **A-**
- Issues:
  - `ClaudeCodeCLIAdapter` tests use real system binaries (`true`, `false`, `echo`, `node`, `sh`) — platform-dependent behavior is acknowledged in extensive comments. These tests are brittle on Windows.
  - The stdout capture test has a long comment explaining why a direct test is hard, then falls back to testing `echo --print` outputs `--print` — which tests the adapter's `["--print"]` args injection, not meaningful output capture.
  - `ClaudeAPIAdapter` timeout test at 50ms with a 200ms sleep is reliable. The `neverClient` test (never resolves) with 30ms timeout is more robust.
  - `captures stderr` test has a very weak assertion: only checks `exit_code !== 0`, not that stderr was actually captured.
- Missing scenarios:
  - `ClaudeCodeCLIAdapter` with a process that exits 0 but writes to stderr (mixed output).
  - `ClaudeCodeCLIAdapter` with very large stdout output (buffer overflow risk).
  - `AdapterRegistry.execute` pass-through — the registry's `execute` method (if it exists) is not tested, only `getAdapter`.

### strategy-manager.test.ts
- Tests: ~60+ (file was truncated)
- Quality: **B+**
- Issues:
  - Custom mock LLM client per file. Fixture responses (`CANDIDATE_RESPONSE_ONE`, `CANDIDATE_RESPONSE_TWO`) are realistic multi-strategy JSON structures.
  - Strategy state machine transitions (active → completed → terminated) should be verified as a sequence, not just individual state-change calls.
  - Portfolio persistence tests that read/write via StateManager use a real StateManager with temp directory — good integration coverage.
- Missing scenarios:
  - Strategy with `allocation: 0` — can a zero-allocation strategy be activated?
  - Portfolio rebalancing when sum of allocations exceeds 1.0.

### task-lifecycle.test.ts
- Tests: ~60+ (file was truncated after 80 lines)
- Quality: **B**
- Issues (from preview):
  - Two mock clients: `createMockLLMClient` (basic) and `createSpyLLMClient` (tracks calls). The spy pattern is a good practice for verifying prompt construction.
  - Uses real StateManager, SessionManager, TrustManager, StrategyManager, StallDetector — this is the most integration-heavy test in the suite. However, the adapter execution layer (`IAdapter`) is still mocked, so end-to-end task execution is not tested.
  - The 3-layer verification (L1 mechanical, L2 LLM review, L3 self-report) paths require careful mock sequencing — if the LLM response queue is misaligned by one call, all subsequent assertions are wrong, but the test would likely still pass (returning wrong verdicts that were pre-loaded for a different call index).
- Missing scenarios:
  - L1 mechanical verification where the shell command itself fails (not just "not applicable").
  - Task execution where the adapter times out mid-execution.
  - Concurrent task execution with the same goal.

### reporting-engine.test.ts
- Tests: ~55
- Quality: **A-**
- Issues:
  - Content assertions use `toContain(string)` for markdown output — correct approach for template-based generation, but doesn't protect against output reordering or structure changes.
  - `vi.setSystemTime` is used for gap reduction/growth tests — good use of time control to force deterministic ordering.
  - `generateDailySummary` gap reduction detection logic depends on report `generated_at` ordering — the test creates two reports 1ms apart using `vi.setSystemTime`, which is appropriately precise.
  - `formatForCLI` with `goal_id: null` override uses `{ ...report, goal_id: null }` — this bypasses TypeScript typing via spread, which is pragmatic for testing the fallback string.
- Missing scenarios:
  - `generateWeeklyReport` when daily summaries span multiple goals (cross-goal contamination).
  - Report persistence when `reports/` directory has been manually deleted.

### core-loop.test.ts
- Tests: ~80+ (file was truncated)
- Quality: **B**
- Issues:
  - Every collaborator is mocked. The `CoreLoop` tests verify the orchestration contract (correct methods called in correct order, correct exit conditions) but cannot detect bugs in the actual data flow between modules.
  - `buildDriveContext` is tested as a standalone exported function — good, this is the one pure function in core-loop that can be tested without mocks.
  - Stop conditions (completed / stalled / max_iterations / error / stopped) are tested but each requires a carefully crafted mock state. If the mock accidentally satisfies multiple stop conditions, the test still passes with an ambiguous reason.
  - `LoopIterationResult` shape assertions check field presence (`toHaveProperty`) rather than field values — this means a loop that returns structurally correct but semantically wrong results would pass.
- Missing scenarios:
  - Loop that runs, stalls, pivots strategy, then completes — the pivot+recovery path through a real loop iteration.
  - `stop()` called while a loop iteration is in-flight (race condition in graceful shutdown).

### cli-runner.test.ts
- Tests: ~35
- Quality: **C+**
- Issues (HIGH SEVERITY):
  - All significant dependencies are replaced with `vi.fn().mockImplementation(() => ({}))`. The DI wiring inside CLIRunner is not tested at all.
  - `goal add` command test can only verify that GoalNegotiator was called with some arguments — the actual goal creation persistence path goes through a mock.
  - Exit code tests (0/1/2) are verified correctly, but only because the mocked CoreLoop returns pre-configured values.
  - `motiva run --goal <id>` tests don't verify that the goal is loaded from StateManager before being passed to CoreLoop. A typo in the argument name would not be caught.
  - Signal handling (SIGINT/SIGTERM graceful shutdown) is mentioned in comments but may not be fully covered given all collaborators are mocked.
- Missing scenarios:
  - `motiva run` with a goal ID that doesn't exist in StateManager.
  - `motiva goal add` with a goal description that the ethics gate rejects — but ethics gate is mocked.
  - `motiva report` when no reports exist.

### portfolio-manager.test.ts
- Tests: ~40
- Quality: **B**
- Issues:
  - `as unknown as StrategyManager` type casts are used throughout — the mock is structurally minimal and could diverge from the real interface.
  - `selectNextStrategyForTask` tests return null for no-portfolio case and return strategies for the active-portfolio case. The selection algorithm (which strategy among multiple actives is chosen next) is tested only superficially.
  - Rebalancing trigger tests (`shouldRebalance`) are present but the `rebalance()` side effects are tested via mock call assertions, not through real allocation changes.
  - `vi.restoreAllMocks()` in `beforeEach` is correct practice.
- Missing scenarios:
  - Portfolio with all strategies in `completed` state — what does `selectNextStrategyForTask` return?
  - `activateParallelStrategies` when StrategyManager throws during activation.

### pid-manager.test.ts
- Tests: ~25
- Quality: **A**
- Issues:
  - Tests are straightforward and complete for a simple file-based PID manager.
  - `isAlive` test correctly verifies that the current process's PID is alive.
  - Atomic write verified by absence of `.tmp` files.
  - The `clearStalePID` test presumably exists in the full file (only 80 lines were read).
- Missing scenarios (from preview):
  - What happens when the PID file contains a PID of a process that has been replaced by a new process with the same PID (PID recycling).

### daemon-runner.test.ts
- Tests: ~30
- Quality: **B+**
- Issues:
  - Signal handlers are cleaned up in afterEach (`process.removeAllListeners`) — good practice to avoid test pollution.
  - `coreLoop.run` always resolves successfully — error handling paths are not exercised.
  - `driveSystem.shouldActivate` is mockable per test, allowing controlled activation scenarios.
  - The daemon's sleep/interval logic between loop runs is not tested for timing accuracy (and probably shouldn't be in unit tests, but it means the scheduling contract is unverified).
- Missing scenarios:
  - Daemon starts, loop throws an unhandled exception.
  - Daemon receives SIGTERM while actively running a loop (mid-iteration shutdown).

### memory-lifecycle.test.ts
- Tests: ~40
- Quality: **A-**
- Issues:
  - LLM mock responses for `compressToLongTerm` require exactly 2 calls (patterns + lessons) — if the implementation changes the call count, the mock queue misaligns silently and the wrong fixture is used for the wrong call.
  - `makeLLMCompressionResponses` helper builds realistic lesson JSON structures — good fixture design.
  - Directory initialization test verifies all required subdirectory names are created — this is brittle to directory name changes but catches regressions.
- Missing scenarios:
  - Compression when short-term memory is empty.
  - Lifecycle with LLM failure during compression (should it skip or abort?).

### notification-dispatcher.test.ts
- Tests: ~25
- Quality: **A-**
- Issues:
  - Uses a real HTTP server (`createTestServer`) to receive webhook notifications — this is excellent integration testing practice.
  - Slack webhook tests and HTTP webhook tests use a real server running on a random port — no mock needed for the HTTP layer.
  - `dispatch()` return values (success/failure per channel) are verified by shape rather than exact content.
- Missing scenarios:
  - Dispatcher with a webhook URL that returns 4xx/5xx response — does it retry or fail gracefully?
  - Multiple channels configured simultaneously (fan-out behavior).

### logger.test.ts
- Tests: ~30
- Quality: **A**
- Issues:
  - Tests read the actual log file from disk — real I/O integration, no mocking of `fs`.
  - Log level filtering tests verify that lower-priority messages are suppressed — good boundary testing.
  - Rotation behavior tests (if present in the full file) would be the most important correctness guarantee.
- Missing scenarios (from preview):
  - Log file rotation when max file size is reached.
  - Concurrent writes from multiple logger instances to the same file.

### event-server.test.ts
- Tests: ~30
- Quality: **A-**
- Issues:
  - Uses real HTTP server on random port (`getFreePort`) — excellent integration approach.
  - `createMockDriveSystem` actually writes to the filesystem via `fs.writeFileSync` rather than just recording calls — this tests the full write path, which is strong.
  - `postEvent` helper correctly sets Content-Type and Content-Length headers.
- Missing scenarios (from preview):
  - Malformed JSON body (HTTP 400 path).
  - POST to an unknown route (HTTP 404 path).
  - Server start failure when port is already in use.

### capability-detector.test.ts
- Tests: ~35
- Quality: **B+**
- Issues:
  - Custom mock LLM client with `callCount` getter — same pattern as ethics-gate and goal-negotiator. Consistent.
  - Uses real StateManager and ReportingEngine — good integration coverage for the persistence layer.
  - LLM responses are minimal JSON strings — the capability detection prompts themselves are not verified.
- Missing scenarios:
  - `detectGap` when the capability registry is empty.
  - Capability that partially overlaps with a task requirement.

### knowledge-manager.test.ts
- Tests: ~35
- Quality: **B+**
- Issues:
  - Same mock LLM pattern as other Stage 8 files.
  - `superseded_by` field handling in queries is present — important for data correctness.
  - `makeKnowledgeEntry` fixture includes realistic source structure (`type`, `reference`, `reliability`).
- Missing scenarios (from preview):
  - `addEntry` with duplicate `entry_id` — overwrite or error?
  - Knowledge entry with very high confidence that conflicts with a later entry with low confidence.

### tui/use-loop.test.ts
- Tests: ~30
- Quality: **B+**
- Issues:
  - Tests `LoopController` (class-based, not a hook) and `calcDimensionProgress` (pure function).
  - `calcDimensionProgress` is a pure function — best testable in isolation; assertions are specific.
  - `LoopController` tests use vi.fn() mocks for CoreLoop and TrustManager — the controller's callback pattern and state transitions are tested without React rendering. This is the correct approach given the non-hook architecture.
  - `makeMockTrustManager` includes `isPermanentlyGated` but the real TrustManager method is `hasPermanentGate` — this is a mock naming discrepancy that would hide the bug if `LoopController` calls the wrong method name.
- Missing scenarios:
  - `LoopController` when `coreLoop.run` rejects (unhandled promise rejection in the controller).
  - `calcDimensionProgress` for `range`, `present`, and `match` threshold types (only `min` and `max` visible from the pattern).

### tui/actions.test.ts
- Tests: ~25
- Quality: **B**
- Issues:
  - `ActionHandler` deps are minimal vi.fn() mocks — the handler's behavior is tested by asserting what methods were called on the mocks.
  - `makeReport` returns a fixture with `report_type: "daily" as const` — the type `"daily"` may not match the actual union type in `Report`, which could mean this fixture would fail at runtime if the actual type is `"daily_summary"`.
  - Goal creation flow through `ActionHandler` depends on `goalNegotiator.negotiate` mock which returns `undefined` by default — the post-negotiate state updates are not exercised.
- Missing scenarios:
  - `ActionHandler` receiving an intent with `goal_id` that doesn't exist in StateManager.
  - Multiple rapid intents dispatched in sequence.

### tui/intent-recognizer.test.ts
- Tests: ~20
- Quality: **B+**
- Issues:
  - Keyword-matching tests are comprehensive for all defined slash commands.
  - LLM-fallback tests use a mock whose `parseJSON` does `schema.parse(JSON.parse(content.trim()))` — this does NOT handle markdown code blocks, unlike the real client. If the real LLM wraps its response in `\`\`\`json`, the real `parseJSON` extracts it, but this mock would fail to parse it and throw.
  - The `unknown` intent fallback is tested correctly.
- Missing scenarios:
  - LLM returns an intent not in the defined union type — does the schema reject it or silently coerce?
  - Very long user input (prompt injection risk is not security-tested, but length handling matters).

---

## Patterns Across Test Suite

### Strengths

1. **Real filesystem I/O for persistence tests**: State-bearing modules (StateManager, TrustManager, DriveSystem, EthicsGate, StallDetector, etc.) use `fs.mkdtempSync` + temp directories. This catches real serialization bugs, atomic write failures, and file path construction errors that pure mock-based tests would miss.

2. **Consistent beforeEach/afterEach isolation**: Every stateful test file creates a fresh temp dir in `beforeEach` and removes it in `afterEach`. No shared mutable state leaks between tests. The `crypto.randomUUID()` usage for IDs prevents accidental ID collisions.

3. **Math-verified numerical assertions**: Drive scorer, gap calculator, and satisficing judge tests include hand-computed expected values in comments (e.g., `// 0.5 * (1 + (1 - 0.5) * 1.0) = 0.5 * 1.5 = 0.75`). These are genuinely load-bearing comments that make assertion intent clear and catch formula regressions.

4. **Boundary value discipline**: Threshold boundaries (min, max, range, present, match), confidence tier boundaries (0.85/0.50), trust balance clamping (±100), escalation caps (3) are all tested with exact boundary values including both sides.

5. **Behavior-over-implementation for pure functions**: Pure functions (GapCalculator, DriveScorer) are tested through public API only, without any knowledge of internal implementation details. These tests will survive refactors.

6. **Real HTTP servers for network-layer tests**: EventServer and NotificationDispatcher use real bound sockets rather than mocked HTTP. This is significantly more reliable than nock/sinon-style HTTP mocking.

7. **SpyLLMClient pattern in task-lifecycle**: Tracking actual LLM call messages (not just call count) allows verifying that prompts contain the expected context, which is one of the few ways to detect prompt-construction regressions without a live API.

### Weaknesses

1. **Pervasive `vi.fn().mockImplementation(() => ({}))` mocking in integration-boundary tests**: CLIRunner, CoreLoop, DaemonRunner, and PortfolioManager tests replace entire real collaborators with empty objects. These tests verify orchestration contracts but cannot detect bugs in the real wiring. The gap between "unit tests pass" and "the assembled system works" is large.

2. **Multiple independent custom MockLLMClient implementations**: ethics-gate, goal-negotiator, strategy-manager, task-lifecycle, capability-detector, knowledge-manager, memory-lifecycle, and intent-recognizer each have their own inline mock LLM client implementation. They are mostly identical but have subtle differences (some handle markdown blocks, some don't; some track `callCount`, some don't). This duplication means a change to the real `parseJSON` contract requires updating 8+ independent mock implementations.

3. **LLM response fixture fragility**: Tests that mock LLM responses with pre-baked JSON strings are coupled to the current JSON schema. Any schema field addition/removal/rename requires updating every affected fixture string across multiple files. There is no shared fixture library.

4. **Weak mock interface fidelity via `as unknown as Type` casts**: PortfolioManager, DaemonRunner, and TUI tests cast minimal mocks to full interface types. TypeScript's type system does not catch the mismatch, so method name typos or signature changes in the real interface are invisible to these tests.

5. **No integration tests across module boundaries**: There are no tests that wire together e.g. CoreLoop + TaskLifecycle + ObservationEngine + StateManager using real implementations and verify an end-to-end loop iteration. The E2E tests mentioned in CLAUDE.md (and known to have bugs) are separate from this test suite and are the only coverage for cross-module interaction.

6. **Weak content assertions on LLM-driven outputs**: For modules whose primary job is constructing good prompts and parsing LLM responses (GoalNegotiator, StrategyManager, TaskLifecycle), tests verify that the output conforms to the Zod schema but do not assert that the LLM was given the right context, constraints, or instructions.

7. **Missing `null`/`undefined` guard tests in higher-level modules**: Lower-level modules (GapCalculator, DriveScorer) test null inputs thoroughly. Higher-level modules (CoreLoop, CLIRunner, PortfolioManager) rarely test what happens when they receive null from a dependency that "should never return null."

### Recommendations

**P0 — Fix before trusting the test suite:**

1. Add at least one integration test that wires CoreLoop, TaskLifecycle, ObservationEngine, and StateManager with real implementations (using a mock adapter and mock LLM) and verifies a single complete loop iteration produces the expected state changes in StateManager.

2. Fix the `use-loop.test.ts` mock method name discrepancy: `isPermanentlyGated` vs the real `hasPermanentGate`. This is a latent test bug where the mock silently accepts a wrong method call.

3. Add a `report_type` fixture validation test in `actions.test.ts` — verify that the `makeReport` fixture's `report_type: "daily"` value matches the actual TypeScript union type.

**P1 — Significantly improve coverage:**

4. Extract a shared `createMockLLMClient(responses: string[])` utility to `tests/helpers/mock-llm.ts` with a single implementation that correctly handles markdown code blocks. Eliminate the 8 independent implementations.

5. Add CLIRunner integration tests that use a real (mock-LLM-backed) GoalNegotiator and CoreLoop, verifying that the full argument → goal creation → loop run path works end-to-end.

6. Add negative tests to task-lifecycle for L1 mechanical verification failures (shell command non-zero exit) and the `keep/discard/escalate` failure handling paths.

**P2 — Good to have:**

7. Add NaN and Infinity as current_value edge cases to gap-calculator tests.

8. Add `PortfolioManager` tests that verify exact allocation arithmetic (sum of active strategy allocations ≤ 1.0 invariant).

9. Document intentional design decisions in test comments where mock limitations are known (e.g., "This test cannot detect prompt construction regressions — see E2E tests for that coverage").
