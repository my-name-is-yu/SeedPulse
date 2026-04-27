/**
 * Completion checks and task execution for a CoreLoop iteration.
 */

import * as path from "node:path";
import type { Goal } from "../../../base/types/goal.js";
import type { GapVector } from "../../../base/types/gap.js";
import type { DriveScore } from "../../../base/types/drive.js";
import { KnowledgeGraph } from "../../../platform/knowledge/knowledge-graph.js";
import { loadDreamActivationState, mergeUniqueKnowledgeEntries } from "../../../platform/dream/dream-activation.js";
import {
  buildDriveContext,
  type LoopIterationResult,
} from "./contracts.js";
import type { PhaseCtx } from "./preparation.js";
import {
  getMilestones,
  evaluatePace,
} from "../../goal/milestone-evaluator.js";
import { verifyWithTools } from "../verification-layer1.js";
import { buildLoopToolContext } from "./preparation.js";
import {
  expandKnowledgeEntriesWithGraph,
  mergeWorkingMemorySelections,
} from "../../execution/context/context-builder.js";
import type { CapabilityAcquisitionOutcome } from "./capability.js";
import type { CoreLoopEvidenceLedger } from "./evidence-ledger.js";
export { detectStallsAndRebalance } from "./task-cycle-stall.js";
export {
  evaluateWaitStrategiesForObserveOnly,
  type WaitStrategyObservationDecision,
} from "./task-cycle-wait.js";

// ─── Phase 5 ───

/** Completion check + milestone deadline check.
 * Sets result.error on fatal failure, sets result.completionJudgment. */
export async function checkCompletionAndMilestones(
  ctx: PhaseCtx,
  goalId: string,
  goal: Goal,
  result: LoopIterationResult,
  startTime: number
): Promise<void> {
  // R1-1: record pre-task judgment (do NOT early-return here)
  try {
    const judgment = goal.children_ids.length > 0
      ? await ctx.deps.satisficingJudge.judgeTreeCompletion(goalId)
      : ctx.deps.satisficingJudge.isGoalComplete(goal);
    result.completionJudgment = judgment;

    // Wire satisficing callback to MemoryLifecycleManager
    // SatisficingJudge fires (goalId, satisfiedDimensions[]) but MLM expects per-dimension calls
    if (ctx.deps.memoryLifecycleManager) {
      const blockingSet = new Set(judgment.blocking_dimensions);
      for (const dim of goal.dimensions) {
        const isSatisfied = !blockingSet.has(dim.name);
        ctx.deps.memoryLifecycleManager.onSatisficingJudgment(goalId, dim.name, isSatisfied);
      }
    }
  } catch (err) {
    result.error = `Completion check failed: ${err instanceof Error ? err.message : String(err)}`;
    ctx.logger?.error(`CoreLoop: ${result.error}`, { goalId });
    result.elapsedMs = Date.now() - startTime;
    return;
  }

  // Milestone deadline check
  try {
    const allGoals = [goal];
    for (const childId of goal.children_ids) {
      const child = await ctx.deps.stateManager.loadGoal(childId);
      if (child) allGoals.push(child);
    }

    const milestones = getMilestones(allGoals);
    if (milestones.length > 0) {
      const milestoneAlerts: Array<{ goalId: string; status: string; pace_ratio: number }> = [];
      for (const milestone of milestones) {
        const currentAchievement =
          milestone.pace_snapshot?.achievement_ratio ??
          (typeof milestone.dimensions[0]?.current_value === "number"
            ? Math.min((milestone.dimensions[0].current_value as number) / 100, 1)
            : 0);

        const snapshot = evaluatePace(milestone, currentAchievement);
        await ctx.deps.stateManager.savePaceSnapshot(milestone.id, snapshot);

        if (snapshot.status === "at_risk" || snapshot.status === "behind") {
          milestoneAlerts.push({
            goalId: milestone.id,
            status: snapshot.status,
            pace_ratio: snapshot.pace_ratio,
          });
        } else {
          if (ctx.deps.learningPipeline) {
            try {
              await ctx.deps.learningPipeline.onMilestoneReached(
                goalId,
                `Milestone ${milestone.title}: pace ${snapshot.status}`
              );
            } catch {
              // non-fatal
            }
          }
        }
      }
      if (milestoneAlerts.length > 0) {
        result.milestoneAlerts = milestoneAlerts;
      }
    }
  } catch {
    // Milestone check failure is non-fatal
  }
}

// ─── Phase 6b ───

/** Check dependency graph block.
 * Returns true if goal is blocked (result.error set, caller should return). */
export function checkDependencyBlock(
  ctx: PhaseCtx,
  goalId: string,
  result: LoopIterationResult
): boolean {
  if (ctx.deps.goalDependencyGraph) {
    try {
      if (ctx.deps.goalDependencyGraph.isBlocked(goalId)) {
        const blockingGoals = ctx.deps.goalDependencyGraph.getBlockingGoals(goalId);
        result.error = `Goal ${goalId} is blocked by prerequisites: ${blockingGoals.join(", ")}`;
        return true;
      }
    } catch {
      // Dependency graph errors are non-fatal
    }
  }
  return false;
}

// ─── Phase 7 ───

/** Callbacks passed to runTaskCycleWithContext to keep mutable state and side-effects on CoreLoop. */
export interface LoopCallbacks {
  handleCapabilityAcquisition: (task: unknown, goalId: string, adapter: unknown) => Promise<CapabilityAcquisitionOutcome | void>;
  incrementTransferCounter: () => number;
  tryGenerateReport: (goalId: string, loopIndex: number, result: LoopIterationResult, goal: Goal) => void;
}

export interface TaskGenerationHints {
  targetDimensionOverride?: string;
  knowledgeContextPrefix?: string;
}

export interface StallActionHints {
  recommendedAction?: "continue" | "refine" | "pivot";
}

/** Collect context, run task cycle, handle capability acquisition,
 * transfer detection, and post-task completion re-check.
 * Returns true on success, false if the caller should return result early.
 * `transferCheckCounter` is incremented via the callback to keep mutable state on CoreLoop. */
export async function runTaskCycleWithContext(
  ctx: PhaseCtx,
  goalId: string,
  goal: Goal,
  gapVector: GapVector,
  driveScores: DriveScore[],
  highDissatisfactionDimensions: string[],
  loopIndex: number,
  result: LoopIterationResult,
  startTime: number,
  callbacks: LoopCallbacks,
  evidenceLedger?: CoreLoopEvidenceLedger,
  taskGenerationHints?: TaskGenerationHints,
): Promise<boolean> {
  const { handleCapabilityAcquisition, incrementTransferCounter, tryGenerateReport } = callbacks;
  try {
    const runPhase = async <T>(phase: string, fn: () => Promise<T>): Promise<T> => {
      const phaseStart = Date.now();
      ctx.logger?.info("CoreLoop: task-cycle phase started", { goalId, phase });
      try {
        const value = await fn();
        ctx.logger?.info("CoreLoop: task-cycle phase completed", {
          goalId,
          phase,
          duration_ms: Date.now() - phaseStart,
        });
        return value;
      } catch (err) {
        ctx.logger?.warn("CoreLoop: task-cycle phase failed", {
          goalId,
          phase,
          duration_ms: Date.now() - phaseStart,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };
    const taskStartTime = Date.now();
    const driveContext = buildDriveContext(goal);
    const adapter = ctx.deps.adapterRegistry.getAdapter(ctx.config.adapterType);
    const baseDir = typeof ctx.deps.stateManager.getBaseDir === "function"
      ? ctx.deps.stateManager.getBaseDir()
      : null;
    const dreamActivation = baseDir
      ? await loadDreamActivationState(baseDir).catch(() => null)
      : null;
    const activationFlags = dreamActivation?.flags;

    // Portfolio: select strategy for next task
    if (ctx.deps.portfolioManager) {
      try {
        const selectionResult = await ctx.deps.portfolioManager.selectNextStrategyForTask(goalId);
        if (selectionResult) {
          ctx.deps.taskLifecycle.setOnTaskComplete((strategyId: string) => {
            ctx.deps.portfolioManager?.recordTaskCompletion(strategyId);
          });
        }
      } catch {
        // Portfolio strategy selection is non-fatal
      }
    }

    // Collect knowledge context
    let knowledgeContext: string | undefined;
    if (ctx.deps.knowledgeManager) {
      try {
        await runPhase("collect-knowledge-context", async () => {
          const topDimension = driveScores[0]?.dimension_name ?? goal.dimensions[0]?.name;
          if (!topDimension) return;
          let entries = await ctx.deps.knowledgeManager!.getRelevantKnowledge(goalId, topDimension);

          if (
            activationFlags?.semanticContext &&
            typeof ctx.deps.knowledgeManager!.searchKnowledge === "function"
          ) {
            const semanticEntries = await ctx.deps.knowledgeManager!.searchKnowledge(
              `${goal.title} ${goal.description} ${topDimension}`,
              5
            ).catch(() => []);
            entries = mergeUniqueKnowledgeEntries(entries, semanticEntries, 8);
          }

          let contradictionWarnings: string[] = [];
          if (
            activationFlags?.graphTraversal &&
            entries.length > 0 &&
            typeof ctx.deps.knowledgeManager!.loadKnowledge === "function"
          ) {
            const graph = baseDir
              ? await KnowledgeGraph.create(
                  path.join(baseDir, "knowledge", "graph.json")
                ).catch(() => null)
              : null;
            if (graph) {
              const allEntries = await ctx.deps.knowledgeManager!.loadKnowledge(goalId).catch(() => []);
              const expanded = expandKnowledgeEntriesWithGraph(entries, allEntries, graph);
              entries = mergeUniqueKnowledgeEntries(entries, expanded.relatedEntries, 10);
              contradictionWarnings = expanded.contradictionWarnings;
            }
          }

          if (entries.length > 0) {
            knowledgeContext = entries
              .map((e) => `Q: ${e.question}\nA: ${e.answer}`)
              .join("\n\n");
            if (contradictionWarnings.length > 0) {
              knowledgeContext += `\n\nContradiction warnings:\n${contradictionWarnings
                .map((warning) => `- ${warning}`)
                .join("\n")}`;
            }
          }
        });
      } catch {
        // Knowledge retrieval failure is non-fatal
      }
    }

    if (activationFlags?.crossGoalLessons && ctx.deps.memoryLifecycleManager) {
      try {
        await runPhase("collect-cross-goal-lessons", async () => {
          const topDimension = driveScores[0]?.dimension_name ?? goal.dimensions[0]?.name ?? "";
          const lessons = await ctx.deps.memoryLifecycleManager!.searchCrossGoalLessons(
            `${goal.title} ${goal.description} ${topDimension}`,
            3
          );
          if (lessons.length > 0) {
            const lessonsBlock = [
              "Cross-goal lessons:",
              ...lessons.map((lesson, index) => `${index + 1}. ${lesson.lesson}`),
            ].join("\n");
            knowledgeContext = knowledgeContext ? `${knowledgeContext}\n\n${lessonsBlock}` : lessonsBlock;
          }
        });
      } catch {
        // Non-fatal: proceed without cross-goal lessons.
      }
    }

    // Tier-aware memory selection: use highDissatisfactionDimensions and dynamic budget
    if (ctx.deps.memoryLifecycleManager) {
      try {
        await runPhase("select-working-memory", async () => {
          const dimensions = goal.dimensions.map((d) => d.name);
          const maxDissatisfaction = driveScores.length > 0
            ? Math.max(...driveScores.map((s) => s.dissatisfaction))
            : 0;
          const satisfiedDimensions = goal.dimensions
            .filter((d) => !result.completionJudgment?.blocking_dimensions.includes(d.name))
            .map((d) => d.name);
          const tierAwareMemory = await ctx.deps.memoryLifecycleManager!.selectForWorkingMemoryTierAware(
            goalId,
            dimensions,
            [],
            10,
            [goalId],
            [],
            satisfiedDimensions,
            highDissatisfactionDimensions,
            maxDissatisfaction
          );

          if (activationFlags?.semanticWorkingMemory) {
            const topDimension = driveScores[0]?.dimension_name ?? goal.dimensions[0]?.name ?? "";
            const semanticMemory = await ctx.deps.memoryLifecycleManager!.selectForWorkingMemorySemantic(
              goalId,
              `${goal.title} ${goal.description} ${topDimension}`,
              dimensions,
              [],
              5,
              driveScores.map((score) => ({
                dimension: score.dimension_name,
                dissatisfaction: score.dissatisfaction,
                deadline: score.deadline,
              }))
            );
            const mergedEntries = mergeWorkingMemorySelections(
              tierAwareMemory.shortTerm,
              semanticMemory.shortTerm,
              5
            );
            if (mergedEntries.length > 0) {
              const memoryBlock = [
                "Working memory:",
                ...mergedEntries.map(
                  (entry, index) =>
                    `${index + 1}. [${entry.data_type}] ${JSON.stringify(entry.data)}`
                ),
              ].join("\n");
              knowledgeContext = knowledgeContext ? `${knowledgeContext}\n\n${memoryBlock}` : memoryBlock;
            }
          }
        });
      } catch {
        // Memory selection failure is non-fatal
      }
    }

    // Fetch existing tasks for dedup context
    let existingTasks: string[] | undefined;
    if (adapter.listExistingTasks) {
      try {
        existingTasks = await runPhase("list-existing-tasks", () => adapter.listExistingTasks!());
      } catch {
        // Non-fatal: proceed without existing tasks context
      }
    }

    // Collect workspace context
    let workspaceContext: string | undefined;
    if (ctx.deps.contextProvider) {
      try {
        const topDimension = driveScores[0]?.dimension_name ?? goal.dimensions[0]?.name ?? "";
        workspaceContext = await runPhase("build-workspace-context", () =>
          ctx.deps.contextProvider!(goalId, topDimension)
        );
      } catch {
        // Non-fatal: proceed without workspace context
      }
    }

    knowledgeContext = evidenceLedger?.augmentKnowledgeContext(knowledgeContext) ?? knowledgeContext;
    workspaceContext = evidenceLedger?.augmentWorkspaceContext(workspaceContext) ?? workspaceContext;

    ctx.logger?.debug("CoreLoop: running task cycle", { adapter: adapter.adapterType, goalId });
    ctx.deps.onProgress?.({
      iteration: loopIndex + 1,
      maxIterations: ctx.config.maxIterations,
      phase: "Executing task...",
      gap: result.gapAggregate,
    });
    const taskResult = await ctx.deps.taskLifecycle.runTaskCycle(
      goalId,
      gapVector,
      driveContext,
      adapter,
      knowledgeContext,
      existingTasks,
      workspaceContext,
      taskGenerationHints,
    );
    ctx.logger?.info("CoreLoop: task cycle result", { action: taskResult.action, taskId: taskResult.task.id });
    result.taskResult = taskResult;
    result.tokensUsed = (result.tokensUsed ?? 0) + (taskResult.tokensUsed ?? 0);
    ctx.deps.onProgress?.({
      iteration: loopIndex + 1,
      maxIterations: ctx.config.maxIterations,
      phase: "Verifying result...",
      gap: result.gapAggregate,
      taskDescription: taskResult.task.work_description
        ? taskResult.task.work_description.split("\n")[0]?.slice(0, 80)
        : undefined,
    });

    // Handle capability_acquiring
    if (taskResult.action === "capability_acquiring" && taskResult.acquisition_task) {
      const acquisitionOutcome = await handleCapabilityAcquisition(taskResult.acquisition_task, goalId, adapter);
      if (acquisitionOutcome?.replanRequired) {
        ctx.logger?.info("CoreLoop: capability acquisition requested replanning", {
          capabilityName: acquisitionOutcome.capabilityName,
          replanRequired: acquisitionOutcome.replanRequired,
          recommendationSource: acquisitionOutcome.recommendationSource,
          recommendedPlugin: acquisitionOutcome.recommendedPlugin,
        });
        ctx.deps.onProgress?.({
          iteration: loopIndex + 1,
          maxIterations: ctx.config.maxIterations,
          phase: "Generating task...",
          gap: result.gapAggregate,
          taskDescription: `Replanning after capability acquisition: ${acquisitionOutcome.capabilityName}`,
        });
      }
    }

    // Portfolio: record task completion
    if (ctx.deps.portfolioManager && taskResult.action === "completed" && taskResult.task.strategy_id) {
      try {
        ctx.deps.portfolioManager.recordTaskCompletion(taskResult.task.strategy_id);
      } catch {
        // Non-fatal
      }
    }

    // Phase 7: tool-based verification (Layer 1)
    if (ctx.toolExecutor && taskResult.task.success_criteria.length > 0) {
      try {
        const toolCtx = await buildLoopToolContext(ctx, goalId);
        const verificationResult = await verifyWithTools(taskResult.task.success_criteria, ctx.toolExecutor, toolCtx);
        if (!verificationResult.mechanicalPassed) {
          taskResult.verificationResult = { ...taskResult.verificationResult, verdict: "fail" };
          ctx.logger?.info("CoreLoop Phase 7: tool verification failed", {
            taskId: taskResult.task.id,
            details: verificationResult.details,
          });
        }
        result.toolVerification = verificationResult;

        // Feed execution results back to strategy for scoring
        if (typeof ctx.deps.strategyManager.recordExecutionFeedback === 'function') {
          const activeStrat = await ctx.deps.strategyManager.getActiveStrategy(goalId);
          if (activeStrat) {
            ctx.deps.strategyManager.recordExecutionFeedback({
              strategyId: activeStrat.hypothesis,
              taskId: taskResult.task?.id ?? 'unknown',
              success: taskResult.action === 'completed',
              verificationPassed: verificationResult.mechanicalPassed,
              duration_ms: Date.now() - taskStartTime,
              timestamp: Date.now(),
            });
          }
        }
      } catch (err) {
        ctx.logger?.warn("CoreLoop Phase 7: tool verification threw (non-fatal)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Re-check completion after task execution
    const updatedGoal = await ctx.deps.stateManager.loadGoal(goalId);
    if (updatedGoal) {
      const postTaskJudgment = updatedGoal.children_ids.length > 0
        ? await ctx.deps.satisficingJudge.judgeTreeCompletion(updatedGoal.id)
        : ctx.deps.satisficingJudge.isGoalComplete(updatedGoal);
      result.completionJudgment = postTaskJudgment;
    }
  } catch (err) {
    result.error = `Task cycle failed: ${err instanceof Error ? err.message : String(err)}`;
    ctx.logger?.error(`CoreLoop: ${result.error}`, { goalId });
    result.elapsedMs = Date.now() - startTime;
    tryGenerateReport(goalId, loopIndex, result, goal);
    return false;
  }

  // Track curiosity goal loop count
  if (ctx.deps.curiosityEngine) {
    const currentGoal = await ctx.deps.stateManager.loadGoal(goalId);
    if (currentGoal?.origin === "curiosity") {
      ctx.deps.curiosityEngine.incrementLoopCount(goalId);
    }
  }

  // Transfer Detection (every 5 iterations, suggestion-only)
  const transferCount = incrementTransferCounter();
  if (ctx.deps.knowledgeTransfer && transferCount % 5 === 0) {
    try {
      const candidates = await ctx.deps.knowledgeTransfer.detectTransferOpportunities(goalId);
      if (candidates.length > 0) {
        result.transfer_candidates = candidates;
      }
    } catch {
      // non-fatal
    }
  }

  return true;
}
