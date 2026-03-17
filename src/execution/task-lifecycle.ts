import { randomUUID } from "node:crypto";
import { execFileSync as _execFileSync } from "node:child_process";
import type { Logger } from "../runtime/logger.js";
import { buildTaskGenerationPrompt } from "./task-prompt-builder.js";
import { runShellCommand as _runShellCommand } from "./task-health-check.js";
import { z } from "zod";
import { StateManager } from "../state-manager.js";
import type { ILLMClient } from "../llm/llm-client.js";
import { SessionManager } from "./session-manager.js";
import { TrustManager } from "../traits/trust-manager.js";
import { StrategyManager } from "../strategy/strategy-manager.js";
import { StallDetector } from "../drive/stall-detector.js";
import { scoreAllDimensions, rankDimensions } from "../drive/drive-scorer.js";
import { TaskSchema, VerificationResultSchema } from "../types/task.js";
import type { Task, VerificationResult } from "../types/task.js";
import type { GapVector } from "../types/gap.js";
import type { DriveContext } from "../types/drive.js";
import type { Dimension } from "../types/goal.js";
import type { EthicsGate } from "../traits/ethics-gate.js";
import type { CapabilityDetector } from "../observation/capability-detector.js";
import type { CapabilityAcquisitionTask } from "../types/capability.js";
import {
  verifyTask as _verifyTask,
  handleVerdict as _handleVerdict,
  handleFailure as _handleFailure,
  type VerdictResult,
  type FailureResult,
} from "./task-verifier.js";
export type {
  ExecutorReport,
  VerdictResult,
  FailureResult,
} from "./task-verifier.js";

// ─── Adapter types (re-exported from adapter-layer) ───

import type { AgentTask, AgentResult, IAdapter } from "./adapter-layer.js";
import { AdapterRegistry } from "./adapter-layer.js";
export type { AgentTask, AgentResult, IAdapter };
export { AdapterRegistry };

const DEBUG = process.env.MOTIVA_DEBUG === "true";

// ─── Internal types ───

export interface TaskCycleResult {
  task: Task;
  verificationResult: VerificationResult;
  action: "completed" | "keep" | "discard" | "escalate" | "approval_denied" | "capability_acquiring";
  acquisition_task?: CapabilityAcquisitionTask;
}

// ─── Schema for LLM-generated task fields ───

const LLMGeneratedTaskSchema = z.object({
  work_description: z.string(),
  rationale: z.string(),
  approach: z.string(),
  success_criteria: z.array(
    z.object({
      description: z.string(),
      verification_method: z.string(),
      is_blocking: z.boolean().default(true),
    })
  ),
  scope_boundary: z.object({
    in_scope: z.array(z.string()),
    out_of_scope: z.array(z.string()),
    blast_radius: z.string(),
  }),
  constraints: z.array(z.string()),
  reversibility: z.enum(["reversible", "irreversible", "unknown"]).default("reversible"),
  estimated_duration: z
    .object({
      value: z.number(),
      unit: z.enum(["minutes", "hours", "days", "weeks"]),
    })
    .nullable()
    .default(null),
});

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
  private onTaskComplete?: (strategyId: string) => void;

  constructor(
    stateManager: StateManager,
    llmClient: ILLMClient,
    sessionManager: SessionManager,
    trustManager: TrustManager,
    strategyManager: StrategyManager,
    stallDetector: StallDetector,
    options?: {
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
    }
  ) {
    this.stateManager = stateManager;
    this.llmClient = llmClient;
    this.sessionManager = sessionManager;
    this.trustManager = trustManager;
    this.strategyManager = strategyManager;
    this.stallDetector = stallDetector;
    this.approvalFn = options?.approvalFn ?? ((_task: Task) => Promise.resolve(false));
    this.ethicsGate = options?.ethicsGate;
    this.capabilityDetector = options?.capabilityDetector;
    this.logger = options?.logger;
    this.adapterRegistry = options?.adapterRegistry;
    this.healthCheckEnabled = options?.healthCheckEnabled ?? false;
    this.execFileSyncFn = options?.execFileSyncFn ?? _execFileSync;
  }

  // ─── setOnTaskComplete ───

  /**
   * Register a callback to be invoked when a task completes successfully.
   * Used by PortfolioManager to track task completion times per strategy.
   */
  setOnTaskComplete(callback: (strategyId: string) => void): void {
    this.onTaskComplete = callback;
  }

  // ─── selectTargetDimension ───

  /**
   * Confidence-tier weights for dimension selection.
   * Mechanically-observable dimensions are prioritized over LLM-only ones.
   */
  private static readonly CONFIDENCE_WEIGHTS: Record<string, number> = {
    mechanical: 1.0,
    verified: 0.9,
    independent_review: 0.7,
    self_report: 0.3,
  };

  private static getConfidenceWeight(dim: Dimension): number {
    const tier = dim.observation_method.confidence_tier;
    return TaskLifecycle.CONFIDENCE_WEIGHTS[tier] ?? 0.3;
  }

  /**
   * Select the highest-priority dimension to work on based on drive scoring,
   * weighted by observation confidence tier so that mechanically-observable
   * dimensions are preferred over LLM-only ones at equal gap severity.
   *
   * @param gapVector - current gap state for the goal
   * @param driveContext - per-dimension timing/deadline/opportunity context
   * @param dimensions - optional goal dimensions used to apply confidence-tier weighting
   * @returns the name of the top-ranked dimension
   * @throws if gapVector has no gaps (empty)
   */
  selectTargetDimension(gapVector: GapVector, driveContext: DriveContext, dimensions?: Dimension[]): string {
    if (gapVector.gaps.length === 0) {
      throw new Error("selectTargetDimension: gapVector has no gaps (empty gap vector)");
    }

    const scores = scoreAllDimensions(gapVector, driveContext);
    const ranked = rankDimensions(scores);

    if (!dimensions || dimensions.length === 0) {
      // No dimension metadata available — fall back to drive-score ranking only
      return ranked[0]!.dimension_name;
    }

    // Build a lookup from dimension name → confidence weight
    const weightByName = new Map<string, number>();
    for (const dim of dimensions) {
      weightByName.set(dim.name, TaskLifecycle.getConfidenceWeight(dim));
    }

    // Apply confidence-tier weighting to final_score for selection only
    const weighted = ranked.map((score) => ({
      dimension_name: score.dimension_name,
      weighted_score: score.final_score * (weightByName.get(score.dimension_name) ?? 0.3),
    }));

    weighted.sort((a, b) => b.weighted_score - a.weighted_score);

    return weighted[0]!.dimension_name;
  }

  // ─── generateTask ───

  /**
   * Generate a task for the given goal and target dimension via LLM.
   *
   * @param goalId - the goal this task belongs to
   * @param targetDimension - the dimension this task should improve
   * @param strategyId - optional override; if not provided, uses active strategy
   * @returns the generated and persisted Task
   */
  async generateTask(
    goalId: string,
    targetDimension: string,
    strategyId?: string,
    knowledgeContext?: string,
    adapterType?: string,
    existingTasks?: string[],
    workspaceContext?: string
  ): Promise<Task> {
    const prompt = this.buildTaskGenerationPrompt(goalId, targetDimension, knowledgeContext, adapterType, existingTasks, workspaceContext);

    const response = await this.llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      {
        system:
          "You are a task generation assistant. Given a goal and target dimension, generate a concrete, actionable task. Respond with a JSON object inside a markdown code block.",
        max_tokens: 2048,
      }
    );

    let generated: ReturnType<typeof LLMGeneratedTaskSchema.parse>;
    try {
      generated = this.llmClient.parseJSON(response.content, LLMGeneratedTaskSchema) as ReturnType<typeof LLMGeneratedTaskSchema.parse>;
    } catch (err) {
      this.logger?.error(
        "Task generation failed: LLM response did not match expected schema.",
        { rawResponse: response.content.substring(0, 500) }
      );
      throw err;
    }

    // Resolve strategy_id
    const activeStrategy = this.strategyManager.getActiveStrategy(goalId);
    const resolvedStrategyId = strategyId ?? activeStrategy?.id ?? null;

    const taskId = randomUUID();
    const now = new Date().toISOString();

    const task = TaskSchema.parse({
      id: taskId,
      goal_id: goalId,
      strategy_id: resolvedStrategyId,
      target_dimensions: [targetDimension],
      primary_dimension: targetDimension,
      work_description: generated.work_description,
      rationale: generated.rationale,
      approach: generated.approach,
      success_criteria: generated.success_criteria,
      scope_boundary: generated.scope_boundary,
      constraints: generated.constraints,
      reversibility: generated.reversibility,
      estimated_duration: generated.estimated_duration,
      status: "pending",
      created_at: now,
    });

    // Persist
    this.stateManager.writeRaw(`tasks/${goalId}/${taskId}.json`, task);

    return task;
  }

  // ─── checkIrreversibleApproval ───

  /**
   * Check whether the task requires human approval and, if so, request it.
   *
   * @param task - the task to check
   * @param confidence - observation confidence for the approval check (default 0.5)
   * @returns true if approved or approval not needed; false if approval was denied
   */
  async checkIrreversibleApproval(task: Task, confidence: number = 0.5): Promise<boolean> {
    const domain = task.task_category;
    const needsApproval = this.trustManager.requiresApproval(
      task.reversibility,
      domain,
      confidence,
      task.task_category
    );

    if (!needsApproval) {
      return true;
    }

    const approved = await this.approvalFn(task);
    return approved;
  }

  // ─── executeTask ───

  /**
   * Execute a task via the given adapter.
   *
   * Creates a session, builds context, converts to AgentTask, executes
   * via adapter, ends session, and updates task status based on result.
   */
  async executeTask(task: Task, adapter: IAdapter, workspaceContext?: string): Promise<AgentResult> {
    // Create execution session
    const session = this.sessionManager.createSession(
      "task_execution",
      task.goal_id,
      task.id
    );

    // Build context
    const contextSlots = this.sessionManager.buildTaskExecutionContext(
      task.goal_id,
      task.id
    );

    // Convert to AgentTask
    let prompt: string;
    if (adapter.adapterType === "github_issue") {
      // For github_issue adapter, format as a structured JSON block so
      // GitHubIssueAdapter.parsePrompt extracts a proper title instead of
      // picking up the context-slot label as the issue title.
      const titleLine = task.work_description.split("\n")[0]?.trim() ?? task.work_description;
      const title = titleLine.length > 120 ? titleLine.slice(0, 117) + "..." : titleLine;
      const issuePayload = JSON.stringify({ title, body: task.work_description });
      prompt = `\`\`\`github-issue\n${issuePayload}\n\`\`\``;
    } else {
      // Build prompt with task description as primary content
      const scopeConstraints =
        `\n\nSCOPE CONSTRAINTS (CRITICAL — violations will cause task failure):\n` +
        `- ONLY modify files directly related to the task\n` +
        `- Do NOT modify: config files (*.config.*, package.json, tsconfig.json), CI/CD files, build configuration, dependency files\n` +
        `- Do NOT change function visibility (private→export) or imports in unrelated files\n` +
        `- If a file contains the target pattern inside a string literal or template, leave it as-is`;
      const contextSection = workspaceContext
        ? `\n\nWORKSPACE CONTEXT (use these specific locations):\n${workspaceContext}`
        : "";
      const taskDescription = `You are an AI agent executing a task.\n\nTask: ${task.work_description}\n\nApproach: ${task.approach}\n\nSuccess Criteria:\n${task.success_criteria.map((c) => `- ${c.description}`).join("\n")}${scopeConstraints}${contextSection}`;

      const contextContent = contextSlots
        .filter((slot) => slot.content.trim().length > 0) // Skip empty slots
        .sort((a, b) => a.priority - b.priority)
        .map((slot) => `[${slot.label}]\n${slot.content}`)
        .join("\n\n");

      prompt = contextContent
        ? `${taskDescription}\n\n--- Context ---\n${contextContent}`
        : taskDescription;
    }

    const timeoutMs = task.estimated_duration
      ? this.durationToMs(task.estimated_duration)
      : 30 * 60 * 1000; // default 30 minutes

    const agentTask: AgentTask = {
      prompt,
      timeout_ms: timeoutMs,
      adapter_type: adapter.adapterType,
    };

    // Update task status to running
    const runningTask = { ...task, status: "running" as const, started_at: new Date().toISOString() };
    this.stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, runningTask);

    // Execute
    let result: AgentResult;
    try {
      // Generic dedup check — any adapter may optionally implement checkDuplicate
      if ('checkDuplicate' in adapter && typeof (adapter as unknown as Record<string, unknown>).checkDuplicate === 'function') {
        try {
          const isDuplicate = await (adapter as unknown as { checkDuplicate: (t: AgentTask) => Promise<boolean> }).checkDuplicate(agentTask);
          if (isDuplicate) {
            // Return synthetic result — task already exists, skip execution
            result = {
              success: true,
              output: 'Skipped: duplicate task detected by adapter',
              error: null,
              exit_code: 0,
              elapsed_ms: 0,
              stopped_reason: 'completed',
            };
            // End session and update task status without calling adapter.execute
            const skipSummary = 'Task skipped: duplicate detected by adapter';
            this.sessionManager.endSession(session.id, skipSummary);
            const skipNow = new Date().toISOString();
            const skippedTask = { ...runningTask, status: 'completed' as const, completed_at: skipNow };
            this.stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, skippedTask);
            return result;
          }
        } catch { /* non-fatal: proceed with execution if dedup check fails */ }
      }
      result = await adapter.execute(agentTask);
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

    // Post-execution scope check: revert changes to protected files
    if (result.success) {
      try {
        const diffOutput = this.execFileSyncFn("git", ["diff", "--name-only"], {
          cwd: process.cwd(),
          encoding: "utf-8",
        }).trim();

        if (diffOutput) {
          const changedFiles = diffOutput.split("\n");
          const protectedPatterns = [
            /vitest\.config/,
            /jest\.config/,
            /tsconfig/,
            /package\.json$/,
            /package-lock\.json$/,
            /\.config\.(ts|js|mjs)$/,
          ];

          const protectedChanges = changedFiles.filter((f) =>
            protectedPatterns.some((p) => p.test(f))
          );

          if (protectedChanges.length > 0) {
            this.execFileSyncFn("git", ["checkout", "--", ...protectedChanges], {
              cwd: process.cwd(),
              encoding: "utf-8",
            });
            result.output = (result.output || "") +
              `\n[Scope Check] Reverted ${protectedChanges.length} protected file(s): ${protectedChanges.join(", ")}`;
          }
        }
      } catch {
        // Non-fatal: scope check failure should not break execution
      }
    }

    // Post-execution: check whether any files were actually modified via git diff --stat.
    // This is a diagnostic annotation only — it does NOT fail the task.
    if (result.success) {
      try {
        const diffStat = this.execFileSyncFn("git", ["diff", "--stat"], {
          cwd: process.cwd(),
          encoding: "utf-8",
        });
        result.filesChanged = diffStat.trim().length > 0;
        if (!result.filesChanged) {
          if (DEBUG) {
            console.warn(
              "[TaskLifecycle] Adapter reported success but no files were modified"
            );
          }
          this.logger?.warn(
            "[TaskLifecycle] Adapter reported success but no files were modified",
            { taskId: task.id }
          );
        }
      } catch {
        // Not a git repo or git is unavailable — skip the check silently
      }
    }

    // End session
    const summary = result.success
      ? `Task completed successfully. Output length: ${result.output.length}`
      : `Task failed: ${result.stopped_reason}. Error: ${result.error ?? "unknown"}`;
    this.sessionManager.endSession(session.id, summary);

    // Update task status based on result
    const now = new Date().toISOString();
    let newStatus: "completed" | "timed_out" | "error";
    if (result.stopped_reason === "timeout") {
      newStatus = "timed_out";
    } else if (result.stopped_reason === "error" || !result.success) {
      newStatus = "error";
    } else {
      newStatus = "completed";
    }

    const updatedTask = {
      ...runningTask,
      status: newStatus,
      completed_at: now,
      ...(newStatus === "timed_out" ? { timeout_at: now } : {}),
    };
    this.stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, updatedTask);

    return result;
  }

  // ─── verifyTask ───

  /**
   * Verify task execution results using 3-layer verification.
   *
   * Layer 1: Mechanical verification (via adapter in review session)
   * Layer 2: LLM task reviewer (independent, no self-report)
   * Layer 3: Executor self-report (reference only)
   *
   * Delegation: logic lives in task-verifier.ts#verifyTask.
   */
  async verifyTask(
    task: Task,
    executionResult: AgentResult
  ): Promise<VerificationResult> {
    return _verifyTask(this.verifierDeps(), task, executionResult);
  }

  // ─── handleVerdict ───

  /**
   * Handle a verification verdict (pass/partial/fail).
   *
   * Delegation: logic lives in task-verifier.ts#handleVerdict.
   */
  async handleVerdict(
    task: Task,
    verificationResult: VerificationResult
  ): Promise<VerdictResult> {
    return _handleVerdict(this.verifierDeps(), task, verificationResult);
  }

  // ─── handleFailure ───

  /**
   * Handle a task failure: increment failure count, record failure,
   * decide keep/discard/escalate.
   *
   * Delegation: logic lives in task-verifier.ts#handleFailure.
   */
  async handleFailure(
    task: Task,
    verificationResult: VerificationResult
  ): Promise<FailureResult> {
    return _handleFailure(this.verifierDeps(), task, verificationResult);
  }

  // ─── runTaskCycle ───

  /**
   * Run a full task cycle: select → generate → approve → execute → verify → verdict.
   */
  async runTaskCycle(
    goalId: string,
    gapVector: GapVector,
    driveContext: DriveContext,
    adapter: IAdapter,
    knowledgeContext?: string,
    existingTasks?: string[],
    workspaceContext?: string
  ): Promise<TaskCycleResult> {
    // 1. Select target dimension (with confidence-tier weighting when available)
    let goalDimensions: Dimension[] | undefined;
    try {
      const goal = this.stateManager.loadGoal(goalId);
      goalDimensions = goal?.dimensions ?? undefined;
    } catch {
      // If goal load fails, fall back to unweighted selection
    }
    const targetDimension = this.selectTargetDimension(gapVector, driveContext, goalDimensions);

    // 2. Generate task (optionally with injected knowledge context)
    const task = await this.generateTask(goalId, targetDimension, undefined, knowledgeContext, adapter.adapterType, existingTasks, workspaceContext);

    // 3a. Ethics means check (reject → skip, flag → require approval, pass → proceed)
    if (this.ethicsGate) {
      const ethicsVerdict = await this.ethicsGate.checkMeans(
        task.id,
        task.work_description,
        task.approach
      );
      if (ethicsVerdict.verdict === "reject") {
        const rejectedResult = VerificationResultSchema.parse({
          task_id: task.id,
          verdict: "fail",
          confidence: 1.0,
          evidence: [
            {
              layer: "mechanical",
              description: `Ethics gate rejected task: ${ethicsVerdict.reasoning}`,
              confidence: 1.0,
            },
          ],
          dimension_updates: [],
          timestamp: new Date().toISOString(),
        });
        return { task, verificationResult: rejectedResult, action: "discard" };
      }
      if (ethicsVerdict.verdict === "flag") {
        // Treat flag as requiring human approval via the existing approvalFn
        const approved = await this.approvalFn(task);
        if (!approved) {
          const flagDeniedResult = VerificationResultSchema.parse({
            task_id: task.id,
            verdict: "fail",
            confidence: 1.0,
            evidence: [
              {
                layer: "mechanical",
                description: `Ethics flag: approval denied. Reasoning: ${ethicsVerdict.reasoning}`,
                confidence: 1.0,
              },
            ],
            dimension_updates: [],
            timestamp: new Date().toISOString(),
          });
          return { task, verificationResult: flagDeniedResult, action: "approval_denied" };
        }
      }
      // verdict === "pass" → fall through
    }

    // 3b. Capability check
    // Skip for capability_acquisition tasks to prevent infinite delegation loops.
    if (this.capabilityDetector && task.task_category !== "capability_acquisition") {
      const gap = await this.capabilityDetector.detectDeficiency(task);
      if (gap !== null) {
        const capabilityResult = VerificationResultSchema.parse({
          task_id: task.id,
          verdict: "fail",
          confidence: 1.0,
          evidence: [
            {
              layer: "mechanical",
              description: `Capability deficiency: ${gap.missing_capability.name} — ${gap.reason}`,
              confidence: 1.0,
            },
          ],
          dimension_updates: [],
          timestamp: new Date().toISOString(),
        });

        // Determine acquisition method. Permissions always require human approval.
        const acquisitionTask = this.capabilityDetector.planAcquisition(gap);

        if (acquisitionTask.method === "permission_request") {
          // Permissions cannot be autonomously acquired — escalate to human.
          return { task, verificationResult: capabilityResult, action: "escalate" };
        }

        // For tool_creation and service_setup: mark as acquiring and delegate.
        await this.capabilityDetector.setCapabilityStatus(
          gap.missing_capability.name,
          gap.missing_capability.type,
          "acquiring"
        );

        return {
          action: "capability_acquiring" as const,
          task,
          verificationResult: capabilityResult,
          acquisition_task: acquisitionTask,
        };
      }
    }

    // 3c. Check irreversible approval
    const approved = await this.checkIrreversibleApproval(task);
    if (!approved) {
      // Build a minimal verification result for the cycle result
      const deniedResult = VerificationResultSchema.parse({
        task_id: task.id,
        verdict: "fail",
        confidence: 1.0,
        evidence: [
          {
            layer: "mechanical",
            description: "Approval denied by human",
            confidence: 1.0,
          },
        ],
        dimension_updates: [],
        timestamp: new Date().toISOString(),
      });
      return {
        task,
        verificationResult: deniedResult,
        action: "approval_denied",
      };
    }

    // 4. Execute task
    if (DEBUG) console.log(`[DEBUG-TL] Executing task ${task.id} via adapter ${adapter.adapterType}`);
    const executionResult = await this.executeTask(task, adapter, workspaceContext);
    if (DEBUG) console.log(`[DEBUG-TL] Execution result: success=${executionResult.success}, stopped=${executionResult.stopped_reason}, error=${executionResult.error}, output=${executionResult.output?.substring(0, 200)}`);

    // 4b. Post-execution health check (opt-in)
    if (executionResult.success && this.healthCheckEnabled) {
      const healthCheck = await this.runPostExecutionHealthCheck(adapter, task);
      if (!healthCheck.healthy) {
        console.warn(`[TaskLifecycle] Post-execution health check FAILED: ${healthCheck.output}`);
        executionResult.success = false;
        executionResult.output = (executionResult.output || "") +
          `\n\n[Health Check Failed]\n${healthCheck.output}`;
      }
    }

    // Reload task from disk to get accurate status/started_at/completed_at set by executeTask
    let taskForVerification = task;
    try {
      const raw = this.stateManager.readRaw(`tasks/${task.goal_id}/${task.id}.json`);
      if (raw) taskForVerification = TaskSchema.parse(raw);
    } catch { /* fall back to in-memory task */ }

    // 5. Verify task
    const verificationResult = await this.verifyTask(taskForVerification, executionResult);
    if (DEBUG) console.log(`[DEBUG-TL] Verification: verdict=${verificationResult.verdict}, evidence=${verificationResult.evidence.map(e => e.description).join('; ').substring(0, 300)}`);

    // 6. Handle verdict
    const verdictResult = await this.handleVerdict(taskForVerification, verificationResult);

    return {
      task: verdictResult.task,
      verificationResult,
      action: verdictResult.action,
    };
  }

  // ─── Private Helpers ───

  private buildTaskGenerationPrompt(
    goalId: string,
    targetDimension: string,
    knowledgeContext?: string,
    adapterType?: string,
    existingTasks?: string[],
    workspaceContext?: string
  ): string {
    return buildTaskGenerationPrompt(
      this.stateManager,
      goalId,
      targetDimension,
      knowledgeContext,
      adapterType,
      existingTasks,
      workspaceContext
    );
  }

  // ─── verifierDeps ───

  /**
   * Build the VerifierDeps object passed to task-verifier.ts functions.
   */
  private verifierDeps() {
    return {
      stateManager: this.stateManager,
      llmClient: this.llmClient,
      sessionManager: this.sessionManager,
      trustManager: this.trustManager,
      stallDetector: this.stallDetector,
      adapterRegistry: this.adapterRegistry,
      logger: this.logger,
      onTaskComplete: this.onTaskComplete,
      durationToMs: this.durationToMs.bind(this),
    };
  }

  private durationToMs(duration: { value: number; unit: string }): number {
    const multipliers: Record<string, number> = {
      minutes: 60 * 1000,
      hours: 60 * 60 * 1000,
      days: 24 * 60 * 60 * 1000,
      weeks: 7 * 24 * 60 * 60 * 1000,
    };
    return duration.value * (multipliers[duration.unit] ?? 60 * 60 * 1000);
  }

  // ─── Post-Execution Health Check ───

  /**
   * Run build and test checks after successful task execution to verify
   * the codebase remains healthy. Opt-in via healthCheckEnabled constructor option.
   */
  async runPostExecutionHealthCheck(
    _adapter: IAdapter,
    _task: Task,
  ): Promise<{ healthy: boolean; output: string }> {
    // Run build check
    try {
      const buildResult = await this.runShellCommand(["npm", "run", "build"], {
        timeout: 60000,
        cwd: process.cwd(),
      });
      if (!buildResult.success) {
        return {
          healthy: false,
          output: `Build failed: ${buildResult.stderr || buildResult.stdout}`,
        };
      }
    } catch (err) {
      return { healthy: false, output: `Build check error: ${err}` };
    }

    // Run quick test check (just verify tests still pass)
    try {
      const testResult = await this.runShellCommand(
        ["npx", "vitest", "run", "--reporter=dot"],
        { timeout: 120000, cwd: process.cwd() }
      );
      if (!testResult.success) {
        return {
          healthy: false,
          output: `Tests failed: ${testResult.stderr || testResult.stdout}`,
        };
      }
    } catch (err) {
      return { healthy: false, output: `Test check error: ${err}` };
    }

    return { healthy: true, output: "Build and tests passed" };
  }

  /**
   * Run a shell command safely using execFile (not exec) to avoid shell injection.
   *
   * Delegates to task-health-check.ts.
   */
  async runShellCommand(
    argv: string[],
    options: { timeout: number; cwd: string }
  ): Promise<{ success: boolean; stdout: string; stderr: string }> {
    return _runShellCommand(argv, options);
  }
}
