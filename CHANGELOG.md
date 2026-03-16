# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0]

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
