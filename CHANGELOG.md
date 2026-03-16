# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] - 2026-03-16

Milestone 7 delivery: recursive Goal Tree phase 2, cross-goal portfolio phase 2, and learning pipeline phase 2. 163 new tests (3105 → 3268, 89 test files).

### Added

- Added concreteness scoring (`scoreConcreteness()`) with LLM-based 4-dimension evaluation and auto-stop decomposition when the concreteness threshold is reached, plus maxDepth enforcement (default: 5).
- Added decomposition quality metrics (`evaluateDecompositionQuality()`) covering coverage, overlap, actionability, and depth efficiency, with reason-tracked pruning (`pruneSubgoal()`, `getPruneHistory()`) and auto-reverting restructure.
- Added momentum allocation (`calculateMomentum()`) with velocity and trend detection, dependency scheduling via topological sort and critical path analysis, and stall-triggered resource rebalancing (`rebalanceOnStall()`).
- Added embedding-based template recommendation (`indexTemplates()`, `recommendByEmbedding()`, `recommendHybrid()`) combining tag scoring and vector similarity for strategy selection.
- Added 4-step structural feedback recording (`recordStructuralFeedback()`) for observation accuracy, strategy selection, scope sizing, and task generation, with feedback aggregation and parameter auto-tuning suggestions.
- Added cross-goal pattern sharing (`extractCrossGoalPatterns()`, `sharePatternsAcrossGoals()`) with persistent storage and retrieval in KnowledgeTransfer.

## [0.2.0] - 2026-03-16

Latest release covering the last five commits, including Milestone 4 and 5 delivery, dogfooding-driven fixes, expanded documentation, and broader end-to-end validation.

### Added

- Added persistent runtime phase 2 capabilities, including graceful daemon shutdown, interrupted goal state restoration, date-based log rotation, and event-driven loop wakeups.
- Added semantic embedding phase 2 support with a shared knowledge base, vector search for implicit knowledge reuse, Drive-based memory management, semantic working-memory selection, and dynamic context budgeting.
- Added SMTP email delivery via `nodemailer` in place of the previous stub implementation.
- Added new end-to-end coverage for daemon lifecycle behavior, semantic memory flows, shared knowledge retrieval, and multi-goal integration scenarios.
- Added new contributor guidance in `CONTRIBUTING.md` generated through dogfooding.

### Changed

- Improved autonomous iteration behavior during dogfooding by tuning model temperature and lowering auto-progress sensitivity to better detect meaningful context changes.
- Improved progress stability with monotonic scoring controls that prevent score backsliding during repeated evaluations.
- Improved changelog and contributing documentation quality through self-hosted validation runs.

### Fixed

- Fixed overly aggressive file existence auto-registration by guarding it for non-`FileExistence` dimensions.
- Fixed progress oscillation during iterative evaluation by enforcing a minimum threshold for score regression handling.
- Fixed daemon runtime reliability issues around shutdown handling, restoration flow, and interruptible background waiting.

## [0.1.0] - 2026-03-16

Initial `0.1.0` release with workspace-aware execution improvements, broader automated test coverage, CLI and documentation updates, and core loop reliability fixes.

### Added

- Added workspace context support with goal-aware file selection and the ability to read files outside the workspace for richer task context.
- Added automatic registration of `file_existence` data sources after goal negotiation to improve follow-up observation coverage.
- Added comprehensive end-to-end and integration coverage for adapter execution, feedback loops, workspace context, provider validation, and CLI data-source behavior.
- Added a minimum-iteration control to the core loop so execution is guaranteed to reach at least one task cycle before declaring completion.
- Added npm publishing metadata and packaging support, including `exports`, license and author fields, and a dedicated `.npmignore`.

### Changed

- Improved CLI behavior by making the `--yes` flag position-independent and ensuring it skips confirmation prompts consistently, including archive and counter-proposal flows.
- Improved CLI stability and execution reporting so progress, archive handling, and failure modes are clearer during runs.
- Improved README and contributor documentation with npm installation, provider setup, programmatic usage, and contribution guidance.

### Fixed

- Fixed a core-loop short circuit that could declare completion before the task cycle executed.
- Fixed duplicate goal-negotiation dimension keys by deduplicating generated dimension identifiers.
- Fixed provider setup failures earlier by validating API keys during provider creation instead of failing deeper in execution.
- Fixed archived goal handling by adding archive fallback loading while keeping auto-archive disabled by default.
