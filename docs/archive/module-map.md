# Module Boundary Map

> This document is a guide for Claude Code to immediately determine "which files to touch."
> Use it to quickly identify target files based on the type of change needed.

## Quick Reference: Change Type → Target Files

| What to change | Primary file | Test file |
|---|---|---|
| Goal negotiation and decomposition logic | src/goal/goal-negotiator.ts | tests/goal-negotiator-core.test.ts, tests/goal-negotiator-negotiate.test.ts, tests/goal-negotiator-decompose.test.ts, tests/goal-negotiator-character.test.ts |
| Negotiator context building | src/goal/negotiator-context.ts | tests/negotiate-context.test.ts |
| Negotiator prompt construction | src/goal/negotiator-prompts.ts | (via goal-negotiator tests) |
| Negotiator step execution | src/goal/negotiator-steps.ts | (via goal-negotiator tests) |
| Goal auto-suggestion and filtering | src/goal/goal-suggest.ts | tests/goal-negotiator-suggest.test.ts, tests/goal-negotiator-suggest-filter.test.ts, tests/goal-suggest-timeout.test.ts |
| Goal validation and dimension conversion | src/goal/goal-validation.ts | tests/goal-tree-quality.test.ts |
| Goal refiner | src/goal/goal-refiner.ts | tests/goal-refiner.test.ts, tests/goal-refiner.refine.test.ts, tests/goal-refiner-types.test.ts |
| Goal refiner prompts | src/goal/refiner-prompts.ts | tests/refiner-prompts.test.ts |
| Goal tree operations and quality evaluation | src/goal/goal-tree-manager.ts | tests/goal-tree-manager.test.ts, tests/goal-tree-quality.test.ts, tests/goal-tree-concreteness.test.ts |
| Goal tree pruning and cancellation | src/goal/goal-tree-pruner.ts | tests/goal-tree-manager.test.ts |
| Goal tree quality evaluation and concreteness score | src/goal/goal-tree-quality.ts | tests/goal-tree-quality.test.ts, tests/goal-tree-concreteness.test.ts |
| Goal decomposition and sub-goal generation | src/goal/goal-decomposer.ts | tests/goal-tree-manager.test.ts, tests/goal-negotiator-decompose.test.ts |
| Goal dependency graph | src/goal/goal-dependency-graph.ts | tests/goal-dependency-graph.test.ts, tests/capability-dependency.test.ts |
| Subgoal curriculum scheduling | src/goal/subgoal-curriculum.ts | tests/subgoal-curriculum.test.ts |
| Cross-goal state aggregation | src/goal/state-aggregator.ts | tests/state-aggregator.test.ts |
| Goal tree loop execution | src/goal/tree-loop-orchestrator.ts | tests/tree-loop-orchestrator.test.ts |
| Milestone evaluation | src/goal/milestone-evaluator.ts | (via goal-tree tests) |
| Gap calculation (5 threshold types) | src/drive/gap-calculator.ts | tests/gap-calculator.test.ts |
| Drive scoring | src/drive/drive-scorer.ts | tests/drive-scorer.test.ts |
| Drive system | src/drive/drive-system.ts | tests/drive-system.test.ts, tests/drive/drive-system.test.ts |
| Stall detection | src/drive/stall-detector.ts | tests/stall-detector.test.ts, tests/stall-detector-analysis.test.ts, tests/stall-detector-repetitive.test.ts |
| Satisficing judgment | src/drive/satisficing-judge.ts | tests/satisficing-judge-convergence.test.ts, tests/satisficing-judge-dimension-satisfied.test.ts, tests/satisficing-judge-double-confirm.test.ts, tests/satisficing-judge-goal-complete.test.ts, tests/satisficing-judge-undershoot.test.ts, tests/satisficing-judge-tree-convergence.test.ts |
| Satisficing helpers | src/drive/satisficing-helpers.ts | (via satisficing-judge tests) |
| Satisficing propagation | src/drive/satisficing-propagation.ts | tests/satisficing-judge-threshold-propagation.test.ts, tests/satisficing-judge-propagation-phase2.test.ts |
| Progress predictor | src/drive/progress-predictor.ts | tests/progress-predictor.test.ts |
| Reward log | src/drive/reward-log.ts | tests/reward-log.test.ts |
| Checkpoint save and restore | src/execution/checkpoint-manager.ts | tests/checkpoint-manager.test.ts |
| Context budget | src/execution/context/context-budget.ts | tests/context-budget.test.ts |
| Context builder | src/execution/context/context-builder.ts | (via session-manager tests) |
| Dimension selector | src/execution/context/dimension-selector.ts | (via session-manager tests) |
| Issue context fetcher | src/execution/context/issue-context-fetcher.ts | tests/issue-context-fetcher.test.ts |
| Task execution lifecycle | src/execution/task/task-lifecycle.ts | tests/task-lifecycle.test.ts, tests/task-lifecycle-cycle.test.ts, tests/task-lifecycle-dimension.test.ts, tests/task-lifecycle-ethics.test.ts, tests/task-lifecycle-execution.test.ts, tests/task-lifecycle-generation.test.ts, tests/task-lifecycle-verdict.test.ts, tests/task-lifecycle-verification.test.ts, tests/task-lifecycle-healthcheck.test.ts |
| Task executor | src/execution/task/task-executor.ts | tests/task-lifecycle-execution.test.ts |
| Task generation | src/execution/task/task-generation.ts | tests/task-lifecycle-generation.test.ts, tests/task-generation-group.test.ts |
| Task pipeline cycle | src/execution/task/task-pipeline-cycle.ts | tests/task-lifecycle-cycle.test.ts |
| Task verification | src/execution/task/task-verifier.ts | tests/task-lifecycle.test.ts, tests/execution/task-verifier.test.ts, tests/task-verifier-guards.test.ts |
| Task verifier LLM | src/execution/task/task-verifier-llm.ts | (via task-lifecycle tests) |
| Task verifier rules | src/execution/task/task-verifier-rules.ts | (via task-lifecycle tests) |
| Task verifier types | src/execution/task/task-verifier-types.ts | (via task-lifecycle tests) |
| Task prompt generation | src/execution/task/task-prompt-builder.ts | tests/task-prompt-builder.test.ts |
| Task health check | src/execution/task/task-health-check.ts | tests/task-lifecycle-healthcheck.test.ts |
| Task approval check | src/execution/task/task-approval-check.ts | (via task-lifecycle tests) |
| Task approval | src/execution/task/task-approval.ts | (via task-lifecycle tests) |
| Task execution types | src/execution/task/task-execution-types.ts | (via task-lifecycle tests) |
| Adapter abstraction layer and registry | src/execution/adapter-layer.ts | tests/adapter-layer.test.ts, tests/execution/adapter-layer.test.ts |
| Session and context management | src/execution/session-manager.ts | tests/session-manager.test.ts, tests/session-manager-phase2.test.ts |
| Impact analyzer | src/execution/impact-analyzer.ts | tests/execution/impact-analyzer.test.ts |
| Parallel executor | src/execution/parallel-executor.ts | tests/execution/parallel-executor.test.ts |
| Pipeline executor | src/execution/pipeline-executor.ts | tests/execution/pipeline-executor.test.ts |
| Result reconciler | src/execution/result-reconciler.ts | tests/execution/result-reconciler.test.ts |
| Reflection generator | src/execution/reflection-generator.ts | tests/reflection-generator.test.ts |
| Toolset lock | src/execution/toolset-lock.ts | tests/toolset-lock.test.ts |
| Observation engine | src/observation/observation-engine.ts | tests/observation-engine.test.ts, tests/observation-engine-llm.test.ts, tests/observation-engine-context.test.ts, tests/observation-engine-dedup.test.ts, tests/observation-engine-crossvalidation.test.ts, tests/observation-engine-prompt.test.ts |
| Observation LLM | src/observation/observation-llm.ts | tests/observation/observation-llm.test.ts |
| Observation helpers | src/observation/observation-helpers.ts | (via observation-engine tests) |
| Observation apply | src/observation/observation-apply.ts | (via observation-engine tests) |
| Observation datasource | src/observation/observation-datasource.ts | (via observation-engine tests) |
| Observation task | src/observation/observation-task.ts | (via observation-engine tests) |
| Dimension pre-checker | src/observation/dimension-pre-checker.ts | (via observation-engine tests) |
| Data source adapter foundation | src/observation/data-source-adapter.ts | tests/data-source-adapter.test.ts, tests/data-source-hotplug.test.ts |
| Capability detection and acquisition | src/observation/capability-detector.ts | tests/capability-detector-detect.test.ts, tests/capability-detector-escalate.test.ts, tests/capability-detector-goal.test.ts, tests/capability-detector-verify.test.ts |
| Capability registry management and escalation | src/observation/capability-registry.ts | tests/capability-detector-detect.test.ts |
| Capability dependency graph and acquisition order resolution | src/observation/capability-dependencies.ts | tests/capability-dependency.test.ts |
| Context provider | src/observation/context-provider.ts | tests/context-provider.test.ts |
| Workspace context | src/observation/workspace-context.ts | tests/workspace-context.test.ts |
| LLM client abstraction layer | src/llm/llm-client.ts | tests/llm-client.test.ts, tests/llm-client-send-message.test.ts |
| JSON sanitizer | src/llm/json-sanitizer.ts | tests/json-sanitizer.test.ts |
| OpenAI client | src/llm/openai-client.ts | tests/openai-client.test.ts |
| Ollama client | src/llm/ollama-client.ts | tests/ollama-client.test.ts |
| Codex CLI client | src/llm/codex-llm-client.ts | tests/codex-llm-client.test.ts |
| Provider configuration and switching | src/llm/provider-config.ts, src/llm/provider-factory.ts | tests/provider-config.test.ts, tests/provider-factory.test.ts |
| Base LLM client | src/llm/base-llm-client.ts | (via llm-client tests) |
| Strategy selection and management | src/strategy/strategy-manager.ts | tests/strategy-manager-core.test.ts, tests/strategy-manager-phase2.test.ts, tests/strategy-manager-stall.test.ts |
| Strategy template registration | src/strategy/strategy-template-registry.ts | tests/strategy-template-registry.test.ts, tests/strategy-template-embedding.test.ts |
| Cross-goal portfolio | src/strategy/cross-goal-portfolio.ts | tests/cross-goal-portfolio.test.ts, tests/cross-goal-portfolio-phase2.test.ts |
| Portfolio manager | src/strategy/portfolio-manager.ts | tests/portfolio-manager.test.ts |
| Memory lifecycle | src/knowledge/memory/memory-lifecycle.ts | tests/memory-lifecycle.test.ts, tests/memory-lifecycle-phase2.test.ts |
| Memory persistence utilities | src/knowledge/memory/memory-persistence.ts | (via memory-lifecycle tests) |
| Memory exports barrel | src/knowledge/memory/memory-exports.ts | (via memory-lifecycle tests) |
| Memory index operations and lesson storage | src/knowledge/memory/memory-index.ts | (via memory-lifecycle tests) |
| Memory tier management | src/knowledge/memory/memory-tier.ts | tests/memory-tier.test.ts |
| Memory statistics calculation | src/knowledge/memory/memory-stats.ts | (via memory-lifecycle tests) |
| Memory query and lesson search | src/knowledge/memory/memory-query.ts | (via memory-lifecycle tests) |
| LLM pattern extraction and distillation | src/knowledge/memory/memory-distill.ts | (via memory-lifecycle tests) |
| Memory compression, long-term storage, and GC | src/knowledge/memory/memory-compression.ts | tests/memory-lifecycle.test.ts, tests/memory-lifecycle-phase2.test.ts |
| Memory selection, relevance scoring, and semantic search | src/knowledge/memory/memory-selection.ts | tests/memory-selection.test.ts, tests/memory-lifecycle.test.ts |
| DriveScore adapter | src/knowledge/drive-score-adapter.ts | tests/drive-score-adapter.test.ts |
| Knowledge management | src/knowledge/knowledge-manager.ts | tests/knowledge-manager.test.ts, tests/knowledge-manager-phase2.test.ts |
| Knowledge manager LLM queries | src/knowledge/knowledge-manager-query.ts | tests/knowledge-manager.test.ts, tests/knowledge-manager-phase2.test.ts |
| Knowledge search and domain knowledge loading | src/knowledge/knowledge-search.ts | tests/knowledge-manager.test.ts, tests/knowledge-manager-phase2.test.ts |
| Knowledge revalidation and staleness task generation | src/knowledge/knowledge-revalidation.ts | tests/knowledge-manager.test.ts, tests/knowledge-manager-phase2.test.ts |
| Knowledge decisions | src/knowledge/knowledge-decisions.ts | tests/web/api-decisions.test.ts, tests/decision-record.test.ts |
| Knowledge graph | src/knowledge/knowledge-graph.ts | tests/knowledge-graph.test.ts |
| Transfer trust score | src/knowledge/transfer-trust.ts | tests/transfer-trust.test.ts |
| Knowledge transfer | src/knowledge/knowledge-transfer.ts | (via knowledge-transfer-* tests) |
| Knowledge transfer apply | src/knowledge/transfer/knowledge-transfer-apply.ts | tests/knowledge-transfer-apply.test.ts, tests/knowledge-transfer-auto-apply.test.ts |
| Knowledge transfer detect | src/knowledge/transfer/knowledge-transfer-detect.ts | tests/knowledge-transfer-detect.test.ts |
| Knowledge transfer evaluate | src/knowledge/transfer/knowledge-transfer-evaluate.ts | tests/knowledge-transfer-evaluate.test.ts |
| Knowledge transfer meta | src/knowledge/transfer/knowledge-transfer-meta.ts | (via knowledge-transfer tests) |
| Knowledge transfer prompts | src/knowledge/transfer/knowledge-transfer-prompts.ts | (via knowledge-transfer tests) |
| Knowledge transfer types | src/knowledge/transfer/knowledge-transfer-types.ts | (via knowledge-transfer tests) |
| Knowledge transfer incremental | src/knowledge/transfer/knowledge-transfer.ts | tests/knowledge-transfer-incremental.test.ts |
| Transfer trust (transfer subfolder) | src/knowledge/transfer/transfer-trust.ts | tests/transfer-trust.test.ts |
| Learning pipeline | src/knowledge/learning/learning-pipeline.ts | tests/learning-pipeline-extraction.test.ts, tests/learning-pipeline-feedback.test.ts, tests/learning-pipeline-persistence.test.ts, tests/learning-pipeline-sharing.test.ts, tests/learning-pipeline-phase2.test.ts |
| Learning feedback and auto-tuning | src/knowledge/learning/learning-feedback.ts | tests/learning-pipeline-feedback.test.ts |
| Cross-goal learning and pattern sharing | src/knowledge/learning/learning-cross-goal.ts | tests/learning-cross-goal.test.ts |
| Learning pipeline prompts | src/knowledge/learning/learning-pipeline-prompts.ts | (via learning-pipeline tests) |
| Learning exports barrel | src/knowledge/learning/learning-exports.ts | (via learning-pipeline tests) |
| Embedding client | src/knowledge/embedding-client.ts | tests/embedding-client.test.ts |
| Vector index | src/knowledge/vector-index.ts | tests/vector-index.test.ts |
| Ethics gate | src/traits/ethics-gate.ts | tests/ethics-gate-core.test.ts, tests/ethics-gate-layer1.test.ts |
| Ethics rules | src/traits/ethics-rules.ts | (via ethics-gate tests) |
| Guardrail runner | src/traits/guardrail-runner.ts | tests/guardrail-runner.test.ts, tests/guardrail-integration.test.ts |
| Trust manager | src/traits/trust-manager.ts | tests/trust-manager.test.ts, tests/trust-rate-limit.test.ts |
| Character configuration | src/traits/character-config.ts | tests/character-config.test.ts, tests/character-separation.test.ts |
| Curiosity engine | src/traits/curiosity-engine.ts | tests/curiosity-engine-constructor.test.ts, tests/curiosity-engine-budget.test.ts, tests/curiosity-engine-lifecycle.test.ts |
| Curiosity proposal generation, hashing, and cooldown | src/traits/curiosity-proposals.ts | tests/curiosity-engine-proposals.test.ts |
| Curiosity semantic transfer detection | src/traits/curiosity-transfer.ts | (via curiosity-engine tests) |
| Daemon execution management | src/runtime/daemon-runner.ts | tests/daemon-runner.test.ts, tests/daemon-runner-shutdown.test.ts |
| Daemon health checks | src/runtime/daemon-health.ts | (via daemon-runner tests) |
| Daemon signals | src/runtime/daemon-signals.ts | (via daemon-runner tests) |
| Cron scheduler | src/runtime/cron-scheduler.ts | tests/cron-scheduler.test.ts |
| Process ID management | src/runtime/pid-manager.ts | tests/pid-manager.test.ts |
| Logger | src/runtime/logger.ts | tests/logger.test.ts |
| Event server | src/runtime/event-server.ts | tests/event-server.test.ts, tests/event-file-watcher.test.ts |
| Notification dispatcher | src/runtime/notification-dispatcher.ts | tests/notification-dispatcher.test.ts, tests/notification-dispatcher-plugin.test.ts |
| Notification batcher | src/runtime/notification-batcher.ts | tests/notification-batcher.test.ts |
| Plugin loader | src/runtime/plugin-loader.ts | tests/plugin-loader.test.ts |
| Notifier plugin registry | src/runtime/notifier-registry.ts | tests/notifier-registry.test.ts |
| Hook manager | src/runtime/hook-manager.ts | tests/hook-manager.test.ts |
| Trigger mapper | src/runtime/trigger-mapper.ts | tests/trigger-mapper.test.ts |
| Notification channels (email/slack/http/webhook) | src/runtime/channels/ | (via notification-dispatcher tests) |
| Claude adapter (CLI) | src/adapters/agents/claude-code-cli.ts | tests/claude-code-cli-adapter.test.ts |
| Claude adapter (API) | src/adapters/agents/claude-api.ts | (via adapter-layer tests) |
| OpenAI Codex CLI adapter | src/adapters/agents/openai-codex.ts | tests/openai-codex-adapter.test.ts |
| A2A adapter | src/adapters/agents/a2a-adapter.ts | tests/a2a-adapter.test.ts |
| A2A client | src/adapters/agents/a2a-client.ts | tests/a2a-client.test.ts |
| Agent profile loader | src/adapters/agents/agent-profile-loader.ts | tests/agent-profile-loader.test.ts |
| Browser Use CLI adapter | src/adapters/agents/browser-use-cli.ts | tests/browser-use-cli-adapter.test.ts |
| OpenClaw ACP adapter | src/adapters/agents/openclaw-acp.ts | tests/adapters/openclaw-acp.test.ts |
| GitHub Issue adapter | src/adapters/github-issue.ts | tests/github-issue-adapter.test.ts |
| GitHub Issue data source | src/adapters/datasources/github-issue-datasource.ts | tests/github-issue-datasource.test.ts |
| File existence data source | src/adapters/datasources/file-existence-datasource.ts | tests/file-existence-datasource.test.ts |
| Shell data source | src/adapters/datasources/shell-datasource.ts | tests/adapters/shell-datasource.test.ts |
| MCP data source | src/adapters/datasources/mcp-datasource.ts | tests/mcp-datasource.test.ts |
| OpenClaw data source | src/adapters/datasources/openclaw-datasource.ts | tests/adapters/openclaw-datasource.test.ts |
| MCP client manager | src/adapters/mcp-client-manager.ts | tests/mcp-client-manager.test.ts |
| Spawn helper | src/adapters/spawn-helper.ts | (via adapter tests) |
| Core loop | src/loop/core-loop.ts | tests/core-loop.test.ts, tests/core-loop-integration.test.ts, tests/core-loop-capability.test.ts, tests/r1-core-loop-completion.test.ts, tests/core-loop-flow.test.ts, tests/core-loop-iteration.test.ts, tests/core-loop-reporting.test.ts, tests/core-loop-stall-refine.test.ts, tests/core-loop-tree.test.ts, tests/core-loop-auto-decompose.test.ts |
| Core loop type definitions and DI | src/loop/core-loop-types.ts | tests/core-loop.test.ts |
| Core loop phases (main) | src/loop/core-loop-phases.ts | tests/core-loop-flow.test.ts |
| Core loop phases B | src/loop/core-loop-phases-b.ts | (via core-loop tests) |
| Core loop phases C | src/loop/core-loop-phases-c.ts | (via core-loop tests) |
| Core loop learning | src/loop/core-loop-learning.ts | tests/core-loop-memory-tier.test.ts |
| Core loop capability | src/loop/core-loop-capability.ts | tests/core-loop-capability.test.ts |
| Tree loop execution helper | src/loop/tree-loop-runner.ts | tests/tree-loop-orchestrator.test.ts, tests/core-loop-tree.test.ts |
| Iteration budget | src/loop/iteration-budget.ts | tests/iteration-budget.test.ts |
| Loop report helper | src/loop/loop-report-helper.ts | (via core-loop tests) |
| Parallel dispatch | src/loop/parallel-dispatch.ts | (via core-loop tests) |
| Post-loop hooks | src/loop/post-loop-hooks.ts | (via core-loop tests) |
| State diff | src/loop/state-diff.ts | (via core-loop tests) |
| Checkpoint manager (loop) | src/loop/checkpoint-manager-loop.ts | tests/core-loop-checkpoint.test.ts |
| Reporting | src/reporting/reporting-engine.ts | tests/reporting-engine.test.ts |
| Report formatters | src/reporting/report-formatters.ts | (via reporting-engine tests) |
| State management (persistence) | src/state/state-manager.ts | tests/state-manager.test.ts |
| State persistence | src/state/state-persistence.ts | (via state-manager tests) |
| Prompt index | src/prompt/index.ts | tests/prompt/gateway.test.ts |
| Prompt slot definitions | src/prompt/slot-definitions.ts | tests/prompt/slot-definitions.test.ts |
| Prompt purposes (17 files) | src/prompt/purposes/ | tests/prompt/context-assembler.test.ts, tests/prompt/formatters.test.ts, tests/prompt/gateway-integration.test.ts |
| Reflection (dream/evening/morning/weekly) | src/reflection/ | tests/reflection/dream-consolidation.test.ts, tests/reflection/evening-catchup.test.ts, tests/reflection/morning-planning.test.ts, tests/reflection/weekly-review.test.ts |
| Orchestrator goal loop | src/orchestrator/goal-loop.ts | tests/orchestrator/goal-loop-guard.test.ts |
| Chat verifier | src/chat/chat-verifier.ts | tests/chat/chat-verifier.test.ts |
| Self-knowledge mutation tools | src/chat/self-knowledge-mutation-tools.ts | tests/chat/self-knowledge-mutation-tools.test.ts, tests/chat/self-knowledge-tools.test.ts |
| MCP server | src/mcp-server/index.ts, src/mcp-server/tools.ts | tests/mcp-server.test.ts |
| CLI entry point | src/cli/cli-runner.ts | tests/cli-runner.test.ts, tests/cli-runner-integration.test.ts, tests/cli-runner-datasource-auto.test.ts |
| CLI command registry | src/cli/cli-command-registry.ts | (via cli-runner tests) |
| CLI logger | src/cli/cli-logger.ts | tests/cli-logs.test.ts |
| CLI setup and DI | src/cli/setup.ts | tests/cli-setup.test.ts |
| CLI utils | src/cli/utils.ts | (via cli-runner tests) |
| CLI ensure-api-key | src/cli/ensure-api-key.ts | (via cli-setup tests) |
| CLI loop runner | src/cli/utils/loop-runner.ts | (via cli-runner tests) |
| CLI commands (goal) | src/cli/commands/goal.ts | tests/cli-runner.test.ts |
| CLI commands (goal-utils) | src/cli/commands/goal-utils.ts | tests/cli/goal-utils.test.ts |
| CLI commands (goal-infer) | src/cli/commands/goal-infer.ts | tests/cli/goal-infer.test.ts |
| CLI commands (goal-dispatch) | src/cli/commands/goal-dispatch.ts | tests/cli/goal-dispatch-infer.test.ts |
| CLI commands (goal-read/write/raw) | src/cli/commands/goal-read.ts, goal-write.ts, goal-raw.ts | tests/goal-cli-refine.test.ts |
| CLI commands (suggest and improve) | src/cli/commands/suggest.ts | tests/cli-improve.test.ts, tests/suggest-output-schema.test.ts |
| CLI commands (suggest-normalizer) | src/cli/commands/suggest-normalizer.ts | tests/cli/suggest-normalizer.test.ts |
| CLI commands (config) | src/cli/commands/config.ts | tests/cli-runner.test.ts |
| CLI commands (daemon) | src/cli/commands/daemon.ts | tests/cli-daemon-status.test.ts |
| CLI commands (doctor) | src/cli/commands/doctor.ts | tests/cli-doctor.test.ts |
| CLI commands (install) | src/cli/commands/install.ts | tests/cli-install.test.ts |
| CLI commands (knowledge) | src/cli/commands/knowledge.ts | tests/cli-knowledge.test.ts |
| CLI commands (notify) | src/cli/commands/notify.ts | tests/cli-notify.test.ts |
| CLI commands (plugin) | src/cli/commands/plugin.ts | tests/cli-plugin.test.ts |
| CLI commands (report) | src/cli/commands/report.ts | (via cli-runner tests) |
| CLI commands (run) | src/cli/commands/run.ts | tests/cli-runner.test.ts |
| CLI commands (logs) | src/cli/commands/logs.ts | tests/cli-logs.test.ts |
| CLI commands (task-read) | src/cli/commands/task-read.ts | (via cli tests) |
| CLI commands (telegram) | src/cli/commands/telegram.ts | tests/telegram-bot-plugin.test.ts |
| CLI commands (chat) | src/cli/commands/chat.ts | tests/chat/chat-runner.test.ts |
| TUI app body | src/tui/entry.ts | (via tui tests) |
| TUI loop hook | src/tui/use-loop.ts | tests/tui/use-loop.test.ts |
| TUI intent recognition | src/tui/intent-recognizer.ts | tests/tui/intent-recognizer.test.ts |
| TUI actions | src/tui/actions.ts | tests/tui/actions.test.ts |
| TUI fuzzy search | src/tui/fuzzy.ts | tests/tui/fuzzy.test.ts |
| TUI seedy art | src/tui/seedy-art.ts | (visual, no unit tests) |
| Public API (npm) | src/index.ts | tests/index-exports.test.ts |

---

## Per-Directory Module Details

### src/goal/ — Goal Management

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| goal-negotiator.ts | Goal negotiation integrated entry point (delegates to context, steps) | ,  | llm/llm-client, traits/ethics-gate, observation/observation-engine, observation/capability-detector, goal/goal-suggest, goal/goal-validation, goal/negotiator-context, goal/negotiator-steps, state-manager, types/goal |
| negotiator-context.ts | Negotiator context building |  | state-manager, types/goal |
| negotiator-prompts.ts | Negotiator prompt templates | ,  | types/goal |
| negotiator-steps.ts | Negotiator step execution | ,  | llm/llm-client, types/goal |
| goal-suggest.ts | Goal auto-suggestion prompts and schemas | , , ,  | types/suggest |
| goal-validation.ts | Dimension conversion, threshold construction, dedup, matching | , , ,  | types/goal |
| goal-refiner.ts | Goal refinement integrated entry point |  | llm/llm-client, goal/refiner-prompts, types/goal |
| refiner-prompts.ts | Goal refiner prompt construction | ,  | types/goal |
| goal-tree-manager.ts | Integrated entry point for goal tree operations (delegates decomposition, pruning, and quality) | ,  | state-manager, llm/llm-client, traits/ethics-gate, goal/goal-dependency-graph, goal/goal-negotiator, goal/goal-tree-pruner, goal/goal-tree-quality, goal/goal-decomposer, types/goal, types/goal-tree |
| goal-tree-pruner.ts | Goal tree pruning, cancellation, and history management | , , , ,  | state-manager, types/goal, types/goal-tree |
| goal-tree-quality.ts | Goal tree concreteness score and decomposition quality evaluation | , ,  | llm/llm-client, types/goal, types/goal-tree |
| goal-decomposer.ts | Goal-to-sub-goal decomposition and LLM prompt generation | , ,  | llm/llm-client, types/goal, types/goal-tree |
| goal-dependency-graph.ts | Inter-goal dependency graph management |  | types/dependency |
| subgoal-curriculum.ts | Subgoal curriculum scheduling and difficulty progression |  | types/goal, types/goal-tree |
| state-aggregator.ts | State aggregation across the entire goal tree | ,  | state-manager, types/goal, types/goal-tree |
| tree-loop-orchestrator.ts | Loop execution across the entire goal tree |  | state-manager, goal/goal-tree-manager, goal/state-aggregator, execution/task-lifecycle, drive/satisficing-judge, types/goal-tree |
| milestone-evaluator.ts | Milestone completion evaluation |  | llm/llm-client, types/goal, types/goal-tree |

### src/drive/ — Drive Calculation

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| gap-calculator.ts | 5-threshold-type gap calculation, normalization, and aggregation | , , , , , ,  | types/gap, types/core |
| drive-scorer.ts | Dissatisfaction, deadline, and opportunity score calculation | , , , , , ,  | types/drive, types/gap |
| drive-system.ts | Integrated drive score management |  | drive/gap-calculator, drive/drive-scorer, types/drive, types/core |
| stall-detector.ts | Progress stall detection |  | types/stall, types/state |
| satisficing-judge.ts | Satisficing judgment integrated entry point | ,  | drive/satisficing-helpers, drive/satisficing-propagation, types/satisficing, types/goal, types/goal-tree |
| satisficing-helpers.ts | Satisficing helper functions | ,  | types/satisficing, types/goal |
| satisficing-propagation.ts | Threshold propagation across goal tree | ,  | types/satisficing, types/goal, types/goal-tree |
| progress-predictor.ts | Progress prediction and ETA estimation |  | types/drive, types/state |
| reward-log.ts | Reward event logging and history | ,  | types/drive |

### src/execution/ — Task Execution

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| adapter-layer.ts | Adapter abstract interface and registry | , , ,  | types/task |
| session-manager.ts | Context budget management and session construction | , ,  | state-manager, knowledge/knowledge-manager, execution/context/context-budget, execution/context/context-builder, types/session |
| checkpoint-manager.ts | Cross-session checkpoint management |  | state-manager, types/checkpoint |
| impact-analyzer.ts | Task impact analysis and side-effect estimation |  | llm/llm-client, types/task |
| parallel-executor.ts | Parallel task execution coordination |  | execution/adapter-layer, types/task |
| pipeline-executor.ts | Sequential pipeline task execution |  | execution/adapter-layer, types/task |
| result-reconciler.ts | Parallel result reconciliation and conflict resolution |  | types/task |
| reflection-generator.ts | Post-execution reflection generation |  | llm/llm-client, types/task |
| toolset-lock.ts | Tool permission lock management |  | types/task |

#### src/execution/context/ — Context Management

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| context-budget.ts | Context budget allocation and selection | , ,  | (none) |
| context-builder.ts | Context assembly from multiple sources |  | execution/context/dimension-selector, types/session |
| dimension-selector.ts | Dimension prioritization and selection | ,  | types/goal, types/drive |
| issue-context-fetcher.ts | GitHub Issue context fetching for tasks |  | adapters/github-issue |

#### src/execution/task/ — Task Lifecycle

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| task-lifecycle.ts | Full task lifecycle integrated orchestration (generation → execution → verification) | ,  | execution/task/task-executor, execution/task/task-generation, execution/task/task-pipeline-cycle, execution/task/task-approval, types/task |
| task-executor.ts | Task execution dispatch to adapter |  | execution/adapter-layer, types/task |
| task-generation.ts | Task generation from drive context | ,  | llm/llm-client, execution/task/task-prompt-builder, types/task |
| task-pipeline-cycle.ts | Pipeline cycle orchestration |  | execution/task/task-executor, execution/task/task-verifier, types/task |
| task-verifier.ts | Task verification integrated entry point | , , , , , ,  | execution/task/task-verifier-llm, execution/task/task-verifier-rules, traits/trust-manager, types/task |
| task-verifier-llm.ts | LLM-based task verification |  | llm/llm-client, types/task |
| task-verifier-rules.ts | Rule-based task verification |  | types/task |
| task-verifier-types.ts | Task verifier type definitions | ,  | types/task |
| task-prompt-builder.ts | Task generation prompt construction |  | types/task, types/drive, types/gap |
| task-health-check.ts | Post-task execution health check |  | (Node.js child_process) |
| task-approval-check.ts | Task pre-execution approval check |  | types/task, types/ethics |
| task-approval.ts | Task approval UI interaction |  | types/task |
| task-execution-types.ts | Task execution internal type definitions | ,  | types/task |

### src/observation/ — Observation

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| observation-engine.ts | State observation integrated entry point | , ,  | observation/observation-llm, observation/observation-helpers, observation/observation-apply, observation/observation-datasource, observation/dimension-pre-checker, state-manager, types/state, types/core |
| observation-llm.ts | LLM-based observation scoring |  | llm/llm-client, types/state, types/core |
| observation-helpers.ts | Observation utility functions | (internal helpers) | types/state |
| observation-apply.ts | Observation result application to state |  | state-manager, types/state |
| observation-datasource.ts | Data source integration for observations |  | observation/data-source-adapter, types/state |
| observation-task.ts | Observation task management |  | types/task |
| dimension-pre-checker.ts | Dimension pre-check before full observation |  | types/state, types/core |
| data-source-adapter.ts | Data source abstraction layer, file/HTTP adapters, and registry | , , , ,  | types/data-source |
| capability-detector.ts | Integrated entry point for capability detection, autonomous acquisition planning, and verification |  | observation/capability-registry, observation/capability-dependencies, state-manager, llm/llm-client, types/capability |
| capability-registry.ts | Capability registry CRUD, status management, and escalation | , , , , , , , , ,  | state-manager, types/capability |
| capability-dependencies.ts | Capability dependency graph management, acquisition order resolution, and cycle detection | , , , , , , ,  | state-manager, types/capability |
| context-provider.ts | Workspace context collection |  | (Node.js fs, child_process) |
| workspace-context.ts | Workspace context provider factory | ,  | (Node.js fs, child_process) |

### src/llm/ — LLM Clients

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| llm-client.ts | LLM interface definition, Anthropic implementation, and Mock | , , , , , ,  | @anthropic-ai/sdk |
| base-llm-client.ts | Base LLM client with shared retry and error handling logic |  | types (internal) |
| openai-client.ts | OpenAI API implementation | ,  | openai SDK |
| ollama-client.ts | Ollama local LLM implementation | ,  | node:http |
| codex-llm-client.ts | OpenAI Codex CLI-based LLM implementation | ,  | node:child_process |
| json-sanitizer.ts | LLM response JSON sanitization before Zod parsing | ,  | (none) |
| provider-config.ts | Provider configuration file read/write | , ,  | node:fs |
| provider-factory.ts | DI factory for LLM client and adapter registry | ,  | llm/provider-config, llm/llm-client, llm/openai-client, llm/ollama-client, llm/codex-llm-client, adapters/* |

### src/strategy/ — Strategy Management

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| strategy-manager.ts | Strategy selection, activation, and updating |  | state-manager, llm/llm-client, types/strategy, types/knowledge |
| strategy-template-registry.ts | Strategy template registration and embedding-based search |  | knowledge/embedding-client, knowledge/vector-index, types/strategy |
| cross-goal-portfolio.ts | Cross-goal portfolio integrated entry point (delegates allocation, scheduling, and momentum) |  | state-manager, types/cross-portfolio, types/goal |
| portfolio-manager.ts | Parallel portfolio strategy management |  | state-manager, drive/drive-scorer, execution/task-lifecycle, strategy/cross-goal-portfolio, types/portfolio |

### src/knowledge/ — Knowledge and Memory Management

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| knowledge-manager.ts | Integrated entry point for knowledge management (delegates save, search, and revalidation) |  | state-manager, llm/llm-client, knowledge/vector-index, knowledge/embedding-client, knowledge/knowledge-search, knowledge/knowledge-revalidation, knowledge/knowledge-manager-query, types/knowledge, types/task |
| knowledge-manager-query.ts | LLM query methods extracted from KnowledgeManager | ,  | llm/llm-client, types/knowledge |
| knowledge-search.ts | Knowledge search, domain knowledge loading, and embedding search | , , , , , ,  | state-manager, knowledge/embedding-client, knowledge/vector-index, types/knowledge |
| knowledge-revalidation.ts | Knowledge revalidation, staleness detection, and revalidation task generation | , , , ,  | state-manager, llm/llm-client, types/knowledge |
| knowledge-decisions.ts | Decision record storage and querying | ,  | state-manager, types/knowledge |
| knowledge-graph.ts | Graph structure management between goals, tasks, and knowledge |  | types/knowledge |
| drive-score-adapter.ts | Adapter connecting DriveScore to MemoryLifecycle | ,  | drive/drive-scorer, types/drive |
| embedding-client.ts | Embedding vector generation interface | , , , ,  | openai SDK, node:http |
| vector-index.ts | Vector nearest-neighbor search by cosine similarity |  | knowledge/embedding-client |

#### src/knowledge/memory/ — Memory Management

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| memory-lifecycle.ts | Integrated memory lifecycle management (short/long-term/compression) | ,  (re-export) | llm/llm-client, knowledge/embedding-client, knowledge/vector-index, knowledge/drive-score-adapter, knowledge/memory/memory-compression, knowledge/memory/memory-selection, knowledge/memory/memory-index, knowledge/memory/memory-stats, knowledge/memory/memory-query, knowledge/memory/memory-distill, knowledge/memory/memory-persistence |
| memory-exports.ts | Backward-compatible barrel re-exports | (transparently re-exports each function) | knowledge/memory/memory-index, knowledge/memory/memory-stats, knowledge/memory/memory-query, knowledge/memory/memory-distill |
| memory-index.ts | Memory index CRUD and lesson long-term storage | , , , , , , , ,  | types/memory-lifecycle, knowledge/memory/memory-persistence |
| memory-tier.ts | Memory tier management (short/working/long-term boundaries) | ,  | types/memory-lifecycle |
| memory-stats.ts | Memory statistics calculation, task/dimension merge, and trend | , , , ,  | types/memory-lifecycle |
| memory-query.ts | Lesson search and cross-goal queries | ,  | types/memory-lifecycle |
| memory-distill.ts | LLM pattern extraction, lesson distillation, and compression quality validation | , ,  | llm/llm-client, types/memory-lifecycle |
| memory-compression.ts | Short-term to long-term compression, retention policy, and GC | , , , , ,  | llm/llm-client, knowledge/memory/memory-index, knowledge/memory/memory-distill, knowledge/memory/memory-persistence, types/memory-lifecycle |
| memory-selection.ts | Relevance scoring, working memory selection, and semantic search | , , , , , ,  | knowledge/embedding-client, knowledge/vector-index, types/memory-lifecycle |
| memory-persistence.ts | File I/O, atomic write, and ID generator | , , , , ,  | node:fs |

#### src/knowledge/learning/ — Learning Pipeline

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| learning-pipeline.ts | Integrated entry point for extracting lessons from execution results |  | llm/llm-client, knowledge/memory-lifecycle, knowledge/knowledge-transfer, knowledge/learning/learning-feedback, knowledge/learning/learning-cross-goal, knowledge/learning/learning-pipeline-prompts, types/learning |
| learning-feedback.ts | Structural feedback recording, aggregation, and automatic parameter tuning | , , , ,  | types/learning |
| learning-cross-goal.ts | Cross-goal pattern extraction and pattern sharing | , ,  | knowledge/knowledge-transfer, types/learning |
| learning-pipeline-prompts.ts | Learning pipeline prompt templates | ,  | types/learning |
| learning-exports.ts | Learning module barrel re-exports | (transparently re-exports) | learning/* |

#### src/knowledge/transfer/ — Knowledge Transfer

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| knowledge-transfer.ts | Cross-goal knowledge transfer orchestration |  | knowledge/embedding-client, knowledge/vector-index, knowledge/transfer/*, types/knowledge, types/learning |
| knowledge-transfer-apply.ts | Knowledge transfer application | ,  | state-manager, types/knowledge, types/learning |
| knowledge-transfer-detect.ts | Transfer candidate detection |  | knowledge/embedding-client, knowledge/vector-index, types/knowledge |
| knowledge-transfer-evaluate.ts | Transfer quality evaluation |  | llm/llm-client, types/knowledge, types/learning |
| knowledge-transfer-meta.ts | Transfer metadata management |  | types/learning |
| knowledge-transfer-prompts.ts | Transfer evaluation prompt templates |  | types/learning |
| knowledge-transfer-types.ts | Transfer-specific type definitions | ,  | types/learning |
| transfer-trust.ts | Transfer trust score learning and invalidation judgment |  | state-manager, types/cross-portfolio |

### src/traits/ — Character, Ethics, and Trust

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| ethics-gate.ts | Task ethics review and block judgment (destructive/credential/integrity/privacy) |  | traits/ethics-rules, llm/llm-client, types/ethics, types/task |
| ethics-rules.ts | Ethics rule definitions and evaluation | ,  | types/ethics, types/task |
| guardrail-runner.ts | Guardrail execution and integration |  | traits/ethics-gate, types/ethics, types/task |
| trust-manager.ts | Agent trust score management ([-100,+100]) |  | state-manager, types/trust |
| character-config.ts | Agent character configuration read/write |  | state-manager, types/character |
| curiosity-engine.ts | Curiosity engine integrated entry point (delegates proposal generation and transfer detection) | ,  | llm/llm-client, observation/observation-engine, traits/curiosity-proposals, traits/curiosity-transfer, types/curiosity |
| curiosity-proposals.ts | Proposal prompt generation, hashing, cooldown, and LLM calls | , , , ,  | llm/llm-client, types/curiosity |
| curiosity-transfer.ts | Semantic transfer opportunity detection | , ,  | knowledge/embedding-client, types/curiosity |

### src/runtime/ — Process Management and I/O

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| logger.ts | Structured log output (debug/info/warn/error) | , ,  | node:fs |
| pid-manager.ts | Daemon PID file management |  | node:fs |
| daemon-runner.ts | Daemon start, stop, restart management integrated entry point | ,  | runtime/daemon-health, runtime/daemon-signals, runtime/pid-manager, runtime/logger, runtime/event-server, types/daemon |
| daemon-health.ts | Daemon health check and crash recovery | ,  | runtime/pid-manager, types/daemon |
| daemon-signals.ts | Daemon signal handling (SIGTERM, SIGHUP) |  | types/daemon |
| cron-scheduler.ts | Cron-based scheduling for periodic tasks | ,  | runtime/logger, types/daemon |
| event-server.ts | File-queue-based event reception and real-time file watcher (fs.watch) | ,  | node:fs |
| notification-dispatcher.ts | Notification delivery (stdout/file/webhook) + routing to INotifier plugins | ,  | runtime/logger, runtime/notifier-registry, types/notification |
| notification-batcher.ts | Notification batching and debouncing |  | types/notification |
| plugin-loader.ts | Dynamic plugin loading from , manifest validation, and auto-registration to registry | ,  | runtime/notifier-registry, execution/adapter-layer, observation/data-source-adapter, types/plugin |
| notifier-registry.ts | INotifier plugin CRUD management and eventType-based routing |  | types/plugin |
| hook-manager.ts | Lifecycle hook registration and execution | ,  | types/daemon |
| trigger-mapper.ts | Event-to-action trigger mapping |  | runtime/hook-manager, types/daemon |

#### src/runtime/channels/ — Notification Channels

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| email-channel.ts | Email notification channel |  (INotifier) | types/plugin |
| http-post.ts | HTTP POST notification channel |  (INotifier) | types/plugin |
| slack-channel.ts | Slack notification channel |  (INotifier) | types/plugin |
| webhook-channel.ts | Webhook notification channel |  (INotifier) | types/plugin |

### src/adapters/ — Agent Adapter Implementations

#### src/adapters/agents/ — Agent Adapters

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| claude-code-cli.ts | Task execution via Claude Code CLI |  (IAdapter) | execution/adapter-layer, types/task |
| claude-api.ts | Task execution via Anthropic API |  (IAdapter) | execution/adapter-layer, llm/llm-client |
| openai-codex.ts | Task execution via OpenAI Codex CLI | ,  | execution/adapter-layer |
| a2a-adapter.ts | Agent-to-Agent (A2A) protocol adapter |  (IAdapter) | adapters/agents/a2a-client, execution/adapter-layer |
| a2a-client.ts | A2A protocol client implementation |  | (node:http) |
| agent-profile-loader.ts | Agent profile configuration loading | ,  | (node:fs) |
| browser-use-cli.ts | Task execution via browser-use CLI |  (IAdapter) | execution/adapter-layer |
| openclaw-acp.ts | OpenClaw ACP (Agent Communication Protocol) adapter | ,  | (node:child_process) |

#### src/adapters/datasources/ — Data Source Adapters

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| github-issue-datasource.ts | GitHub Issue state observation data source |  (IDataSourceAdapter) | observation/data-source-adapter, types/data-source |
| file-existence-datasource.ts | Data source observing file existence |  (IDataSourceAdapter) | observation/data-source-adapter, types/data-source |
| shell-datasource.ts | Data source observing shell command output | ,  | observation/data-source-adapter, types/data-source |
| mcp-datasource.ts | MCP (Model Context Protocol) data source |  (IDataSourceAdapter) | adapters/mcp-client-manager, observation/data-source-adapter, types/data-source |
| openclaw-datasource.ts | OpenClaw session log observation data source | ,  | (node:fs/promises) |

#### src/adapters/ — Root Adapters

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| github-issue.ts | GitHub Issue creation and management adapter | , ,  | execution/adapter-layer |
| mcp-client-manager.ts | MCP client lifecycle and connection management |  | (node:child_process) |
| spawn-helper.ts | Child process spawning helper utilities | ,  | (node:child_process) |

### src/loop/ — Core Loop

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| core-loop.ts | Main orchestration loop integrated entry point |  | loop/core-loop-types, loop/core-loop-phases, loop/core-loop-phases-b, loop/core-loop-phases-c, loop/core-loop-learning, loop/core-loop-capability, loop/tree-loop-runner, all modules (DI injection) |
| core-loop-types.ts | Core loop type definitions, interfaces, DI dependency types, and  | , , , , , , ,  | types/goal, types/drive, types/core |
| core-loop-phases.ts | Main iteration phase execution (observe → gap → score → task) | , , ,  | loop/core-loop-types, all modules |
| core-loop-phases-b.ts | Secondary iteration phases (verify → report → stall) | , ,  | loop/core-loop-types, all modules |
| core-loop-phases-c.ts | Tertiary iteration phases (curiosity, learning, knowledge) | , ,  | loop/core-loop-types, all modules |
| core-loop-learning.ts | Learning pipeline, knowledge transfer, and capability acquisition failure tracking |  | loop/core-loop-types, runtime/logger |
| core-loop-capability.ts | Capability acquisition and detection in loop |  | loop/core-loop-types, observation/capability-detector |
| tree-loop-runner.ts | Iteration execution helper for multi-goal/tree loops | ,  | state-manager, goal/goal-tree-manager, goal/state-aggregator, execution/task-lifecycle, drive/satisficing-judge, types/goal-tree |
| iteration-budget.ts | Iteration budget tracking and enforcement | ,  | types/core |
| loop-report-helper.ts | Loop reporting utilities |  | types/core, types/report |
| parallel-dispatch.ts | Parallel goal dispatch within a loop iteration |  | execution/parallel-executor, types/goal |
| post-loop-hooks.ts | Post-loop hook execution (archiving, notifications) |  | runtime/hook-manager, types/core |
| state-diff.ts | State diff calculation between iterations | ,  | types/state |
| checkpoint-manager-loop.ts | Loop-level checkpoint save and restore | ,  | execution/checkpoint-manager, types/checkpoint |

### src/reporting/ — Reporting

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| reporting-engine.ts | Execution summary and notification generation |  | runtime/notification-dispatcher, types/report |
| report-formatters.ts | Report formatting utilities | , ,  | types/report |

### src/state/ — State Management

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| state-manager.ts | File-based JSON persistence for goals, state, and logs |  | node:fs, types/goal, types/state |
| state-persistence.ts | State I/O helpers and atomic writes | , ,  | node:fs |

### src/prompt/ — Prompt Management

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| index.ts | Prompt gateway and context assembler entry point | ,  | prompt/slot-definitions, prompt/purposes/* |
| slot-definitions.ts | Prompt slot type definitions | ,  | (none) |
| purposes/ | 17 purpose-specific prompt templates (observation, task generation, etc.) | (various) | prompt/slot-definitions |

### src/reflection/ — Reflection and Scheduling

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| dream-consolidation.ts | Dream-phase knowledge consolidation |  | knowledge/memory-lifecycle, llm/llm-client |
| evening-catchup.ts | Evening catch-up summary generation |  | knowledge/memory-lifecycle, reporting/reporting-engine |
| morning-planning.ts | Morning planning session |  | goal/goal-negotiator, drive/drive-system |
| weekly-review.ts | Weekly progress review |  | knowledge/learning-pipeline, reporting/reporting-engine |
| types.ts | Reflection type definitions | ,  | (none) |
| index.ts | Reflection module barrel re-exports | (re-exports all) | reflection/* |

### src/orchestrator/ — Orchestrator

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| goal-loop.ts | Goal-level loop guard and orchestration entry | ,  | loop/core-loop, state-manager, types/goal |

### src/chat/ — Chat Interface

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| chat-verifier.ts | Chat response verification and grounding |  | llm/llm-client, types/task |
| self-knowledge-mutation-tools.ts | Self-knowledge mutation tool definitions for chat |  | knowledge/knowledge-manager, types/knowledge |

### src/mcp-server/ — MCP Server

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| index.ts | MCP server entry point | (main function) | mcp-server/tools |
| tools.ts | MCP tool definitions and handlers |  | state-manager, goal/goal-negotiator |

### src/cli/ — CLI Command Implementations

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| cli-runner.ts | CLI entry point and command routing | (no default export, main function) | cli/cli-command-registry, cli/setup, cli/commands/* |
| cli-command-registry.ts | CLI command registration and routing |  | cli/commands/* |
| cli-logger.ts | CLI-specific logging |  | runtime/logger |
| setup.ts | DI assembly for all dependencies |  | all modules (DI assembly) |
| utils.ts | CLI helpers and usage display | , ,  | (none) |
| ensure-api-key.ts | API key presence check and prompt |  | llm/provider-config |
| utils/loop-runner.ts | CLI-level loop execution helper |  | loop/core-loop |
| commands/run.ts |  command implementation |  | loop/core-loop, state-manager |
| commands/goal.ts |  command group | , , , , , ,  | state-manager, observation/data-source-adapter, adapters/file-existence-datasource |
| commands/goal-utils.ts | Goal utility functions for CLI | ,  | state-manager, types/goal |
| commands/goal-infer.ts | Goal inference from natural language |  | goal/goal-negotiator, llm/llm-client |
| commands/goal-dispatch.ts | Goal dispatch to core loop |  | loop/core-loop, state-manager |
| commands/goal-read.ts | Goal state read command |  | state-manager, types/goal |
| commands/goal-write.ts | Goal state write command |  | state-manager, types/goal |
| commands/goal-raw.ts | Raw goal JSON manipulation |  | state-manager |
| commands/report.ts |  command |  | state-manager, reporting/reporting-engine |
| commands/suggest.ts |  /  commands |  | goal/goal-negotiator, observation/capability-detector, state-manager |
| commands/suggest-normalizer.ts | Suggest output normalization |  | types/suggest |
| commands/config.ts |  /  /  | , , , ,  | llm/provider-config, traits/character-config, state-manager |
| commands/daemon.ts |  commands | (internal implementation) | runtime/daemon-runner, runtime/pid-manager |
| commands/doctor.ts |  system diagnostics |  | observation/capability-detector, runtime/pid-manager |
| commands/install.ts |  setup command |  | (node:fs) |
| commands/knowledge.ts |  commands |  | knowledge/knowledge-manager |
| commands/notify.ts |  test notification |  | runtime/notification-dispatcher |
| commands/plugin.ts |  management commands |  | runtime/plugin-loader |
| commands/logs.ts |  command |  | runtime/logger |
| commands/task-read.ts |  read command |  | state-manager |
| commands/telegram.ts | Telegram bot integration command |  | (runtime/channels) |
| commands/chat.ts |  interactive chat command |  | chat/chat-verifier, llm/llm-client |

### src/tui/ — TUI Dashboard (Ink/React)

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| entry.ts | TUI startup entry point | (main function) | tui/app (conceptual), loop/core-loop |
| use-loop.ts | React integration hook with core loop | , , , , ,  | loop/core-loop |
| intent-recognizer.ts | Chat input intent classification | , ,  | (none) |
| actions.ts | TUI action handlers | , ,  | loop/core-loop, goal/goal-negotiator |
| fuzzy.ts | Fuzzy search for TUI | ,  | (none) |
| markdown-renderer.ts | Markdown text rendering | , ,  | (none) |
| seedy-art.ts | Seedy pixel art rendering for TUI startup |  | (none) |
| theme.ts | TUI color theme definitions | ,  | (none) |

### src/types/ — Type Definitions (Zod Schemas)

| File | Key Types |
|---|---|
| types/core.ts | ObservationLayer, ConfidenceTier, StrategyState, etc. |
| types/goal.ts | Goal, Dimension, Threshold, GoalSchema |
| types/goal-tree.ts | GoalTreeNode, ConcretenessScore, DecompositionQualityMetrics |
| types/gap.ts | GapVector, DimensionGap |
| types/drive.ts | DriveContext, DriveScore |
| types/task.ts | Task, VerificationResult |
| types/strategy.ts | Strategy, Portfolio, WaitStrategy |
| types/state.ts | ObservationLog, ObservationLogEntry |
| types/session.ts | SessionContext |
| types/trust.ts | TrustScore |
| types/satisficing.ts | SatisficingResult |
| types/stall.ts | StallSignal |
| types/ethics.ts | EthicsVerdict |
| types/knowledge.ts | KnowledgeGapSignal, KnowledgeEntry |
| types/memory-lifecycle.ts | ShortTermEntry, LongTermEntry, MemoryIndex, RetentionConfig |
| types/learning.ts | LessonRecord, LearningResult |
| types/cross-portfolio.ts | TransferCandidate |
| types/capability.ts | CapabilityInfo, CapabilityAcquisitionTask |
| types/data-source.ts | DataSourceConfig, DataSourceQuery |
| types/dependency.ts | GoalDependency |
| types/embedding.ts | EmbeddingVector |
| types/character.ts | CharacterConfig |
| types/curiosity.ts | CuriosityProposal |
| types/notification.ts | NotificationPayload |
| types/daemon.ts | DaemonConfig |
| types/report.ts | ReportEntry |
| types/portfolio.ts | PortfolioState |
| types/negotiation.ts | NegotiationResult |
| types/suggest.ts | SuggestOutput |
| types/plugin.ts | PluginManifest, INotifier, NotificationEvent, NotificationEventType |
| types/checkpoint.ts | CheckpointSchema, CheckpointIndexSchema |
| types/index.ts | Re-export of all types |

### src/ — Root Files

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| index.ts | Library public API (for npm publish) | (all major classes re-exported) | all modules |

### src/utils/ — Utilities

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| errors.ts | Custom error classes | , ,  | (none) |
| execFileNoThrow.ts | execFile wrapper that never throws |  | node:child_process |
| json-io.ts | JSON file read/write helpers | ,  | node:fs |
| paths.ts | Path resolution utilities | , ,  | node:path |
| sleep.ts | Promise-based sleep utility |  | (none) |

### plugins/ — Sample Plugins (Outside Core)

| Directory | Overview | Test File |
|---|---|---|
| plugins/slack-notifier/ | Slack Webhook notification plugin (INotifier implementation sample). plugin.yaml (manifest) + src/index.ts (implementation). Core-independent, standalone npm package. | tests/plugin-slack-notifier.test.ts |

---

## Architectural Notes

- **CoreLoop receives all modules via DI** — Changing  has broad impact
- **IAdapter / IDataSourceAdapter are independent abstraction layers** — Adding a new adapter only requires implementing the interfaces in  / 
- **ILLMClient is also an abstraction layer** — Adding/switching LLM providers requires only changing 
- **types/ has zero dependencies** — Does not import other src modules. Type changes have the widest impact
- **memory-exports.ts is a backward-compatible barrel** — For compatibility maintenance only. New code should import directly from memory-index/stats/query/distill
- **src/state/ (StateManager, StatePersistence) is now isolated** — Previously at src/state-manager.ts and src/state-persistence.ts; now in src/state/
- **src/reporting/ is now isolated** — Previously at src/reporting-engine.ts; now in src/reporting/
- **src/strategy/portfolio-manager.ts** — Previously at src/portfolio-manager.ts; now in src/strategy/
- **src/cli/cli-runner.ts** — Previously at src/cli-runner.ts; now in src/cli/
- **src/loop/core-loop.ts** — Previously at src/core-loop.ts; now in src/loop/
- **src/execution/task/** — Task lifecycle files extracted into dedicated subfolder
- **src/execution/context/** — Context management files extracted into dedicated subfolder
- **src/knowledge/memory/** — Memory management files extracted into dedicated subfolder
- **src/knowledge/learning/** — Learning pipeline files extracted into dedicated subfolder
- **src/knowledge/transfer/** — Knowledge transfer files extracted into dedicated subfolder
- **src/adapters/agents/** — Agent adapter files moved to dedicated subfolder
- **src/adapters/datasources/** — Data source adapters moved to dedicated subfolder
