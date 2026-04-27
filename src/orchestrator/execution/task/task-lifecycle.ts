import { execFileSync as _execFileSync } from "node:child_process";
import type { Logger } from "../../../runtime/logger.js";
import {
  runShellCommand as _runShellCommand,
  runPostExecutionHealthCheck as _runPostExecutionHealthCheck,
} from "./task-health-check.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import type { SessionManager } from "../session-manager.js";
import type { TrustManager } from "../../../platform/traits/trust-manager.js";
import type { StrategyManager } from "../../strategy/strategy-manager.js";
import type { StallDetector } from "../../../platform/drive/stall-detector.js";
import {
  selectTargetDimension as _selectTargetDimension,
  type DimensionSelectionOptions,
} from "../context/dimension-selector.js";
import type { Task, VerificationResult } from "../../../base/types/task.js";
import type { GapVector } from "../../../base/types/gap.js";
import type { DriveContext } from "../../../base/types/drive.js";
import type { Dimension } from "../../../base/types/goal.js";
import type { EthicsGate } from "../../../platform/traits/ethics-gate.js";
import type { CapabilityDetector } from "../../../platform/observation/capability-detector.js";
import {
  verifyTask as _verifyTask,
  handleVerdict as _handleVerdict,
  handleFailure as _handleFailure,
  type VerdictResult,
  type FailureResult,
  type CompletionJudgerConfig,
} from "./task-verifier.js";
export type { CompletionJudgerConfig } from "./task-verifier.js";
export type {
  ExecutorReport,
  VerdictResult,
  FailureResult,
} from "./task-verifier.js";

import type { AgentTask, AgentResult, IAdapter } from "../adapter-layer.js";
import { AdapterRegistry } from "../adapter-layer.js";
export type { AgentTask, AgentResult, IAdapter };
export { AdapterRegistry };

import type { TaskPipeline } from "../../../base/types/pipeline.js";

export { LLMGeneratedTaskSchema } from "./task-generation.js";
import { generateTask as _generateTask } from "./task-generation.js";
import { durationToMs } from "./task-executor.js";
import { executeTaskWithGuards, verifyExecutionWithGitDiff } from "./task-execution-helpers.js";
import { checkIrreversibleApproval as _checkIrreversibleApproval } from "./task-approval-check.js";
import { runPipelineTaskCycle as runPipelineTaskCycleFn } from "./task-pipeline-cycle.js";
import type { PipelineCycleOptions } from "./task-pipeline-types.js";
import type { KnowledgeTransfer } from "../../../platform/knowledge/transfer/knowledge-transfer.js";
import type { KnowledgeManager } from "../../../platform/knowledge/knowledge-manager.js";
import type { MemoryLifecycleManager } from "../../../platform/knowledge/memory/memory-lifecycle.js";
import { captureExecutionDiffArtifacts } from "./task-diff-capture.js";
import type { GuardrailRunner } from "../../../platform/traits/guardrail-runner.js";
import type { HookManager } from "../../../runtime/hook-manager.js";
import type { ToolExecutor } from "../../../tools/executor.js";
import type { TaskAgentLoopRunner } from "../agent-loop/task-agent-loop-runner.js";
import { taskAgentLoopResultToAgentResult } from "../agent-loop/task-agent-loop-result.js";
import type { IPromptGateway } from "../../../prompt/gateway.js";
import {
  formatPlaybookHints,
  formatPatternHints,
  formatWorkflowHints,
  loadDreamActivationState,
  loadDreamPlaybookRecords,
  loadDreamWorkflows,
  loadLearnedPatterns,
  selectPlaybookHints,
  selectPatternHints,
  selectWorkflowHints,
} from "../../../platform/dream/dream-activation.js";

export type { TaskCycleResult } from "./task-execution-types.js";
export type {
  PipelineCycleDeps,
  PipelineCycleOptions,
  SelectTargetDimensionFn,
  GenerateTaskFn,
} from "./task-pipeline-types.js";
import type { TaskCycleResult } from "./task-execution-types.js";
import { appendTaskOutcomeEvent } from "./task-outcome-ledger.js";
import { runTaskLifecycleCycle } from "./task-lifecycle-runner.js";

export interface TaskLifecycleCoreDeps {
  stateManager: StateManager;
  llmClient: ILLMClient;
  sessionManager: SessionManager;
  trustManager: TrustManager;
  strategyManager: StrategyManager;
  stallDetector: StallDetector;
}

export interface TaskLifecycleOptions {
  approvalFn?: (task: Task) => Promise<boolean>;
  ethicsGate?: EthicsGate;
  capabilityDetector?: CapabilityDetector;
  logger?: Logger;
  /** Optional adapter registry for L1 mechanical verification command execution */
  adapterRegistry?: AdapterRegistry;
  /** Enable post-execution build/test health check (disabled by default) */
  healthCheckEnabled?: boolean;
  /** Injectable execFileSync for testing (defaults to node:child_process execFileSync) */
  execFileSyncFn?: (cmd: string, args: string[], opts: { cwd: string; encoding: "utf-8" }) => string;
  /** Timeout + retry config for the completion judgment LLM call */
  completionJudgerConfig?: CompletionJudgerConfig;
  /** Optional KnowledgeTransfer for realtime candidate detection before task generation */
  knowledgeTransfer?: KnowledgeTransfer;
  /** Optional KnowledgeManager for reflection generation and retrieval */
  knowledgeManager?: KnowledgeManager;
  /** Optional MemoryLifecycleManager for lessons learned during task generation */
  memoryLifecycle?: MemoryLifecycleManager;
  /** Optional guardrail runner for before_tool/after_tool hooks */
  guardrailRunner?: GuardrailRunner;
  /** Optional HookManager for lifecycle hook events */
  hookManager?: HookManager;
  /** Optional ToolExecutor for post-execution git diff verification (read-only) */
  toolExecutor?: ToolExecutor;
  /** Native task-level agentloop runner. When present, runTaskCycle executes tasks through this path. */
  agentLoopRunner?: TaskAgentLoopRunner;
  /** Optional PromptGateway used for task generation and verifier review. */
  gateway?: IPromptGateway;
  /** Optional explicit workspace root for git-based revert operations. */
  revertCwd?: string;
  /** Optional explicit workspace root for post-execution health checks. */
  healthCheckCwd?: string;
}

export interface TaskCycleRunOptions {
  targetDimensionOverride?: string;
  knowledgeContextPrefix?: string;
}

export interface TaskLifecycleDeps extends TaskLifecycleCoreDeps {
  options?: TaskLifecycleOptions;
}

// ─── TaskLifecycle ───

/**
 * TaskLifecycle manages the full lifecycle of tasks:
 * select target dimension -> generate task -> approval check -> execute -> verify -> handle verdict.
 */
export class TaskLifecycle {
  private readonly stateManager: StateManager;
  private readonly llmClient: ILLMClient;
  private readonly sessionManager: SessionManager;
  private readonly trustManager: TrustManager;
  private readonly strategyManager: StrategyManager;
  private readonly stallDetector: StallDetector;
  private readonly approvalFn: (task: Task) => Promise<boolean>;
  private readonly ethicsGate?: EthicsGate;
  private readonly capabilityDetector?: CapabilityDetector;
  private readonly logger?: Logger;
  private readonly adapterRegistry?: AdapterRegistry;
  private readonly healthCheckEnabled: boolean;
  private readonly execFileSyncFn: (cmd: string, args: string[], opts: { cwd: string; encoding: "utf-8" }) => string;
  private readonly completionJudgerConfig?: CompletionJudgerConfig;
  private readonly knowledgeTransfer?: KnowledgeTransfer;
  private readonly knowledgeManager?: KnowledgeManager;
  private readonly memoryLifecycle?: MemoryLifecycleManager;
  private readonly guardrailRunner?: GuardrailRunner;
  private readonly hookManager?: HookManager;
  private readonly toolExecutor?: ToolExecutor;
  private readonly agentLoopRunner?: TaskAgentLoopRunner;
  private readonly gateway?: IPromptGateway;
  private readonly revertCwd?: string;
  private readonly healthCheckCwd?: string;
  private onTaskComplete?: (strategyId: string) => void;

  constructor(deps: TaskLifecycleDeps);
  constructor(
    stateManager: StateManager,
    llmClient: ILLMClient,
    sessionManager: SessionManager,
    trustManager: TrustManager,
    strategyManager: StrategyManager,
    stallDetector: StallDetector,
    options?: TaskLifecycleOptions
  );
  constructor(
    stateManagerOrDeps: StateManager | TaskLifecycleDeps,
    llmClient?: ILLMClient,
    sessionManager?: SessionManager,
    trustManager?: TrustManager,
    strategyManager?: StrategyManager,
    stallDetector?: StallDetector,
    options?: TaskLifecycleOptions
  ) {
    const resolved = TaskLifecycle.isDepsObject(stateManagerOrDeps)
      ? stateManagerOrDeps
      : {
          stateManager: stateManagerOrDeps,
          llmClient: llmClient!,
          sessionManager: sessionManager!,
          trustManager: trustManager!,
          strategyManager: strategyManager!,
          stallDetector: stallDetector!,
          options,
        };
    const resolvedOptions = resolved.options;

    this.stateManager = resolved.stateManager;
    this.llmClient = resolved.llmClient;
    this.sessionManager = resolved.sessionManager;
    this.trustManager = resolved.trustManager;
    this.strategyManager = resolved.strategyManager;
    this.stallDetector = resolved.stallDetector;
    this.approvalFn = resolvedOptions?.approvalFn ?? ((_task: Task) => Promise.resolve(false));
    this.ethicsGate = resolvedOptions?.ethicsGate;
    this.capabilityDetector = resolvedOptions?.capabilityDetector;
    this.logger = resolvedOptions?.logger;
    this.adapterRegistry = resolvedOptions?.adapterRegistry;
    this.healthCheckEnabled = resolvedOptions?.healthCheckEnabled ?? false;
    this.execFileSyncFn = resolvedOptions?.execFileSyncFn ?? _execFileSync;
    this.completionJudgerConfig = resolvedOptions?.completionJudgerConfig;
    this.knowledgeTransfer = resolvedOptions?.knowledgeTransfer;
    this.knowledgeManager = resolvedOptions?.knowledgeManager;
    this.memoryLifecycle = resolvedOptions?.memoryLifecycle;
    this.guardrailRunner = resolvedOptions?.guardrailRunner;
    this.hookManager = resolvedOptions?.hookManager;
    this.toolExecutor = resolvedOptions?.toolExecutor;
    this.agentLoopRunner = resolvedOptions?.agentLoopRunner;
    this.gateway = resolvedOptions?.gateway;
    this.revertCwd = resolvedOptions?.revertCwd;
    this.healthCheckCwd = resolvedOptions?.healthCheckCwd;
  }

  /** Register a callback invoked when a task completes successfully (used by PortfolioManager). */
  setOnTaskComplete(callback: (strategyId: string) => void): void {
    this.onTaskComplete = callback;
  }

  /** Select highest-priority dimension to work on, weighted by confidence tier. */
  selectTargetDimension(
    gapVector: GapVector,
    driveContext: DriveContext,
    dimensions?: Dimension[],
    options?: DimensionSelectionOptions
  ): string {
    return _selectTargetDimension(gapVector, driveContext, dimensions, options);
  }

  /** Generate a task for the given goal and target dimension via LLM. */
  async generateTask(
    goalId: string,
    targetDimension: string,
    strategyId?: string,
    knowledgeContext?: string,
    adapterType?: string,
    existingTasks?: string[],
    workspaceContext?: string
  ): Promise<Task | null> {
    const result = await this._generateTaskWithTokens(goalId, targetDimension, strategyId, knowledgeContext, adapterType, existingTasks, workspaceContext);
    return result.task;
  }

  /** Internal: generate task and return token count alongside the task. */
  private async _generateTaskWithTokens(
    goalId: string,
    targetDimension: string,
    strategyId?: string,
    knowledgeContext?: string,
    adapterType?: string,
    existingTasks?: string[],
    workspaceContext?: string
  ): Promise<{ task: Task | null; tokensUsed: number; playbookIdsUsed: string[] }> {
    let resolvedKnowledgeContext = knowledgeContext;
    const playbookIdsUsed = new Set<string>();
    try {
      const baseDir = this.stateManager.getBaseDir();
      const dreamActivation = await loadDreamActivationState(baseDir);
      if (
        dreamActivation.flags.learnedPatternHints ||
        dreamActivation.flags.playbookHints ||
        dreamActivation.flags.workflowHints
      ) {
        const goal = await this.stateManager.loadGoal(goalId);
        const query = [
          goal?.title ?? "",
          goal?.description ?? "",
          targetDimension,
          knowledgeContext ?? "",
        ].join(" ");

        if (dreamActivation.flags.learnedPatternHints) {
          const patterns = await loadLearnedPatterns(baseDir, goalId);
          const hints = selectPatternHints(patterns, query);
          const formattedHints = formatPatternHints(hints);
          if (formattedHints) {
            resolvedKnowledgeContext = resolvedKnowledgeContext
              ? `${resolvedKnowledgeContext}\n\n${formattedHints}`
              : formattedHints;
          }
        }

        if (dreamActivation.flags.playbookHints) {
          const playbooks = await loadDreamPlaybookRecords(baseDir);
          const hints = selectPlaybookHints(playbooks, query, { goalId, targetDimension });
          const formattedHints = formatPlaybookHints(hints);
          if (formattedHints) {
            for (const hint of hints) {
              playbookIdsUsed.add(hint.playbook_id);
            }
            resolvedKnowledgeContext = resolvedKnowledgeContext
              ? `${resolvedKnowledgeContext}\n\n${formattedHints}`
              : formattedHints;
          }
        }

        if (dreamActivation.flags.workflowHints) {
          const workflows = await loadDreamWorkflows(baseDir);
          const hints = selectWorkflowHints(workflows, query, { goalId, targetDimension });
          const formattedHints = formatWorkflowHints(hints);
          if (formattedHints) {
            resolvedKnowledgeContext = resolvedKnowledgeContext
              ? `${resolvedKnowledgeContext}\n\n${formattedHints}`
              : formattedHints;
          }
        }
      }
    } catch {
      // Non-fatal: proceed without Dream activation hints.
    }

    const generated = await _generateTask(
      {
        stateManager: this.stateManager,
        llmClient: this.llmClient,
        strategyManager: this.strategyManager,
        logger: this.logger,
        knowledgeManager: this.knowledgeManager,
        memoryLifecycle: this.memoryLifecycle,
        gateway: this.gateway,
      },
      goalId,
      targetDimension,
      strategyId,
      resolvedKnowledgeContext,
      adapterType,
      existingTasks,
      workspaceContext
    );
    return {
      ...generated,
      playbookIdsUsed: [...playbookIdsUsed],
    };
  }

  /** Check whether the task requires human approval and request it if so. */
  async checkIrreversibleApproval(task: Task, confidence: number = 0.5): Promise<boolean> {
    return _checkIrreversibleApproval(this.trustManager, this.approvalFn, task, confidence);
  }

  private async buildDimensionSelectionBackoff(goalId: string): Promise<DimensionSelectionOptions> {
    const failureStatuses = new Set(["failed", "error", "timed_out", "abandoned", "discarded"]);
    const backoffCounts = new Map<string, number>();

    try {
      const rawHistory = await this.stateManager.readRaw(`tasks/${goalId}/task-history.json`);
      if (!Array.isArray(rawHistory)) {
        return {};
      }

      for (const entry of rawHistory.slice(-20) as Array<Record<string, unknown>>) {
        const dimension = typeof entry.primary_dimension === "string" ? entry.primary_dimension : null;
        if (!dimension) {
          continue;
        }

        const status = typeof entry.status === "string" ? entry.status : "";
        const verdict = typeof entry.verification_verdict === "string" ? entry.verification_verdict : "";
        const failureCount = typeof entry.consecutive_failure_count === "number"
          ? entry.consecutive_failure_count
          : 0;
        const failed =
          failureStatuses.has(status)
          || verdict === "fail"
          || verdict === "partial"
          || failureCount > 0;
        const passed = status === "completed" && verdict === "pass" && failureCount === 0;

        if (failed && !passed) {
          backoffCounts.set(dimension, (backoffCounts.get(dimension) ?? 0) + 1);
        }
      }
    } catch {
      return {};
    }

    if (backoffCounts.size === 0) {
      return {};
    }

    const backoffByDimension: Record<string, number> = {};
    for (const [dimension, count] of backoffCounts) {
      backoffByDimension[dimension] = Math.max(0.1, 1 / (count + 1));
    }
    return { backoffByDimension };
  }

  /** Execute a task via the given adapter. */
  async executeTask(task: Task, adapter: IAdapter, workspaceContext?: string): Promise<AgentResult> {
    return executeTaskWithGuards({
      task,
      adapter,
      workspaceContext,
      ...this.executionDeps(),
    });
  }

  /** Execute a task through the native task-level agentloop. */
  async executeTaskWithAgentLoop(
    task: Task,
    workspaceContext?: string,
    knowledgeContext?: string,
  ): Promise<AgentResult> {
    if (!this.agentLoopRunner) {
      throw new Error("TaskLifecycle: agentLoopRunner is required for native agentloop execution.");
    }

    const runningTask = { ...task, status: "running" as const, started_at: new Date().toISOString() };
    await this.stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, runningTask);
    await appendTaskOutcomeEvent(this.stateManager, {
      task: runningTask,
      type: "started",
      attempt: task.consecutive_failure_count + 1,
    });

    let result: AgentResult;
    try {
      const agentLoopResult = await this.agentLoopRunner.runTask({
        task: runningTask,
        workspaceContext,
        knowledgeContext,
      });
      result = taskAgentLoopResultToAgentResult(agentLoopResult);
      if (agentLoopResult.workspace?.executionCwd) {
        const diffArtifacts = captureExecutionDiffArtifacts(
          this.execFileSyncFn,
          agentLoopResult.workspace.executionCwd,
        );
        if (diffArtifacts.available) {
          result.filesChangedPaths = diffArtifacts.changedPaths;
          result.fileDiffs = diffArtifacts.fileDiffs;
          result.filesChanged = diffArtifacts.changedPaths.length > 0;
        }
      }
    } catch (err) {
      result = {
        success: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
        exit_code: null,
        elapsed_ms: 0,
        stopped_reason: "error",
      };
    }

    const completedAt = new Date().toISOString();
    const nextStatus =
      result.success ? "completed" as const :
      result.stopped_reason === "timeout" ? "timed_out" as const :
      "error" as const;
    await this.stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, {
      ...runningTask,
      status: nextStatus,
      execution_output: result.output,
      ...(nextStatus === "completed" ? { completed_at: completedAt } : {}),
      ...(nextStatus === "timed_out" ? { timeout_at: completedAt } : {}),
    });

    await appendTaskOutcomeEvent(this.stateManager, {
      task: { ...runningTask, status: nextStatus },
      type: result.success ? "succeeded" : "failed",
      attempt: task.consecutive_failure_count + 1,
      reason: result.error ?? undefined,
    });

    return result;
  }

  /** Verify task execution results using 3-layer verification. */
  async verifyTask(
    task: Task,
    executionResult: AgentResult,
    preferredAdapterType?: string
  ): Promise<VerificationResult> {
    return _verifyTask(this.verifierDeps(preferredAdapterType), task, executionResult);
  }

  /** Handle a verification verdict (pass/partial/fail). */
  async handleVerdict(
    task: Task,
    verificationResult: VerificationResult
  ): Promise<VerdictResult> {
    return _handleVerdict(this.verifierDeps(), task, verificationResult);
  }

  /** Handle a task failure: increment failure count, record failure, decide keep/discard/escalate. */
  async handleFailure(
    task: Task,
    verificationResult: VerificationResult
  ): Promise<FailureResult> {
    return _handleFailure(this.verifierDeps(), task, verificationResult);
  }

  /** Run a full task cycle: select → generate → approve → execute → verify → verdict. */
  async runTaskCycle(
    goalId: string,
    gapVector: GapVector,
    driveContext: DriveContext,
    adapter: IAdapter,
    knowledgeContext?: string,
    existingTasks?: string[],
    workspaceContext?: string,
    options?: TaskCycleRunOptions
  ): Promise<TaskCycleResult> {
    return runTaskLifecycleCycle({
      goalId,
      gapVector,
      driveContext,
      adapter,
      knowledgeContext,
      existingTasks,
      workspaceContext,
      options,
      stateManager: this.stateManager,
      logger: this.logger,
      hookManager: this.hookManager,
      toolExecutor: this.toolExecutor,
      healthCheckEnabled: this.healthCheckEnabled,
      healthCheckCwd: this.healthCheckCwd,
      runPostExecutionHealthCheck: () => this.runPostExecutionHealthCheck(),
      verificationDeps: (preferredAdapterType) => this.verifierDeps(preferredAdapterType),
      sideEffectDeps: () => this.sideEffectDeps(),
      buildDimensionSelectionBackoff: (runGoalId) => this.buildDimensionSelectionBackoff(runGoalId),
      selectTargetDimension: (runGapVector, runDriveContext, dimensions, selectionOptions) =>
        this.selectTargetDimension(runGapVector, runDriveContext, dimensions, selectionOptions),
      generateTaskWithTokens: (runGoalId, targetDimension, strategyId, runKnowledgeContext, adapterType, runExistingTasks, runWorkspaceContext) =>
        this._generateTaskWithTokens(runGoalId, targetDimension, strategyId, runKnowledgeContext, adapterType, runExistingTasks, runWorkspaceContext),
      enrichmentDeps: () => this.enrichmentDeps(),
      checkIrreversibleApproval: (task) => this.checkIrreversibleApproval(task),
      preExecution: {
        ethicsGate: this.ethicsGate,
        capabilityDetector: this.capabilityDetector,
        approvalFn: this.approvalFn,
      },
      hasNativeAgentLoop: Boolean(this.agentLoopRunner),
      executeTask: (task, runAdapter, runWorkspaceContext) => this.executeTask(task, runAdapter, runWorkspaceContext),
      executeTaskWithAgentLoop: (task, runWorkspaceContext, runKnowledgeContext) =>
        this.executeTaskWithAgentLoop(task, runWorkspaceContext, runKnowledgeContext),
      handleVerdict: (task, verificationResult) => this.handleVerdict(task, verificationResult),
    });
  }

  /**
   * Run a pipeline-based task cycle: select → generate → observe → approve → pipeline execute → map verdict.
   * Uses PipelineExecutor to orchestrate multi-role sequential execution.
   */
  async runPipelineTaskCycle(
    goalId: string,
    gapVector: GapVector,
    driveContext: DriveContext,
    adapter: IAdapter,
    pipeline: TaskPipeline,
    options?: PipelineCycleOptions
  ): Promise<TaskCycleResult> {
    return runPipelineTaskCycleFn(
      {
        stateManager: this.stateManager,
        sessionManager: this.sessionManager,
        llmClient: this.llmClient,
        ethicsGate: this.ethicsGate,
        capabilityDetector: this.capabilityDetector,
        approvalFn: this.approvalFn,
        adapterRegistry: this.adapterRegistry,
        logger: this.logger,
        knowledgeManager: this.knowledgeManager,
        checkIrreversibleApproval: (t) => this.checkIrreversibleApproval(t),
        selectTargetDimension: (gv, dc, dims) => this.selectTargetDimension(gv, dc, dims),
        generateTask: (gid, dim, sid, kc, at, et, wc) => this.generateTask(gid, dim, sid, kc, at, et, wc),
      },
      goalId,
      gapVector,
      driveContext,
      adapter,
      pipeline,
      options
    );
  }

  /** Build the VerifierDeps object passed to task-verifier.ts functions. */
  private verifierDeps(preferredAdapterType?: string) {
    return {
      stateManager: this.stateManager,
      llmClient: this.llmClient,
      sessionManager: this.sessionManager,
      trustManager: this.trustManager,
      stallDetector: this.stallDetector,
      adapterRegistry: this.adapterRegistry,
      preferredAdapterType,
      logger: this.logger,
      onTaskComplete: this.onTaskComplete,
      gateway: this.gateway,
      durationToMs: durationToMs,
      completionJudgerConfig: this.completionJudgerConfig,
      toolExecutor: this.toolExecutor,
      revertCwd: this.revertCwd,
    };
  }

  private executionDeps() {
    return {
      guardrailRunner: this.guardrailRunner,
      toolExecutor: this.toolExecutor,
      adapterRegistry: this.adapterRegistry,
      stateManager: this.stateManager,
      sessionManager: this.sessionManager,
      logger: this.logger,
      execFileSyncFn: this.execFileSyncFn,
    };
  }

  private enrichmentDeps() {
    return {
      knowledgeTransfer: this.knowledgeTransfer,
      knowledgeManager: this.knowledgeManager,
      logger: this.logger,
    };
  }

  private postExecutionDeps() {
    return {
      healthCheck: {
        enabled: this.healthCheckEnabled,
        run: () => this.runPostExecutionHealthCheck(),
      },
      successVerification: {
        toolExecutor: this.toolExecutor,
        verifyWithGitDiff: verifyExecutionWithGitDiff,
      },
    };
  }

  private sideEffectDeps() {
    return {
      stateManager: this.stateManager,
      sessionManager: this.sessionManager,
      llmClient: this.llmClient,
      knowledgeManager: this.knowledgeManager,
      logger: this.logger,
    };
  }

  /** Run build and test checks after successful task execution. Opt-in via healthCheckEnabled. */
  async runPostExecutionHealthCheck(): Promise<{ healthy: boolean; output: string }> {
    return _runPostExecutionHealthCheck(
      this.runShellCommand.bind(this),
      this.toolExecutor,
      this.healthCheckCwd,
    );
  }

  /** Run a shell command safely using execFile (not exec) to avoid shell injection. */
  async runShellCommand(
    argv: string[],
    options: { timeout: number; cwd: string }
  ): Promise<{ success: boolean; stdout: string; stderr: string }> {
    return _runShellCommand(argv, options);
  }

  private static isDepsObject(value: StateManager | TaskLifecycleDeps): value is TaskLifecycleDeps {
    return "stateManager" in value;
  }
}
