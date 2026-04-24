import type { LoopResult } from "../../orchestrator/loop/core-loop.js";
import type { ProgressEvent } from "../../orchestrator/loop/core-loop.js";
import type { GoalCycleScheduleSnapshotEntry } from "./maintenance.js";
import { errorMessage } from "./runner-errors.js";
import { getDueWaitGoalIds } from "./wait-deadline-resolver.js";

const MAX_IDLE_SLEEP_MS = 5_000;

export type GoalCycleRunnerContext = any;

function buildLoopCompletePayload(goalId: string, result: LoopResult): Record<string, unknown> {
  const lastIteration = result.iterations.at(-1);
  return {
    goalId,
    iterations: result.totalIterations,
    gap: lastIteration?.gapAggregate,
    status: result.finalStatus,
    wait: lastIteration?.waitExpiryOutcome
      ? {
          strategyId: lastIteration.waitStrategyId,
          status: lastIteration.waitExpiryOutcome.status,
          details: lastIteration.waitExpiryOutcome.details,
          approvalId: lastIteration.waitApprovalId,
          observeOnly: lastIteration.waitObserveOnly ?? false,
        }
      : undefined,
  };
}

function buildDaemonStatusPayload(context: GoalCycleRunnerContext): Record<string, unknown> {
  return {
    status: context.state.status,
    activeGoals: context.state.active_goals,
    loopCount: context.state.loop_count,
    lastLoopAt: context.state.last_loop_at,
    waitingGoals: context.state.waiting_goals ?? [],
    nextObserveAt: context.state.next_observe_at ?? null,
    lastObserveAt: context.state.last_observe_at ?? null,
    lastWaitReason: context.state.last_wait_reason ?? null,
    approvalPendingCount: context.state.approval_pending_count ?? 0,
  };
}

function applyWaitDeadlineStatus(context: GoalCycleRunnerContext, waitDeadlines: unknown): void {
  const resolution = waitDeadlines as {
    next_observe_at?: string | null;
    waiting_goals?: Array<{ wait_reason?: string; approval_pending?: boolean }>;
  } | null | undefined;
  const waitingGoals = Array.isArray(resolution?.waiting_goals) ? resolution.waiting_goals : [];
  context.state.waiting_goals = waitingGoals;
  context.state.next_observe_at = resolution?.next_observe_at ?? null;
  context.state.last_wait_reason = waitingGoals[0]?.wait_reason ?? null;
  context.state.approval_pending_count = waitingGoals.filter((goal) =>
    goal.approval_pending === true
      || (typeof goal.wait_reason === "string" && goal.wait_reason.toLowerCase().includes("approval"))
  ).length;
}

function buildLoopErrorPayload(goalId: string, error: unknown, context: GoalCycleRunnerContext): Record<string, unknown> {
  const message = errorMessage(error);
  return {
    goalId,
    error: message,
    message,
    status: "error",
    crashCount: context.state?.crash_count,
    maxRetries: context.config?.crash_recovery?.max_retries,
  };
}

export async function runDaemonGoalCycleLoop(context: GoalCycleRunnerContext): Promise<void> {
  while (context.running && !context.shuttingDown) {
    try {
      const goalIds = [...context.currentGoalIds];
      context.refreshOperationalState();
      const cycleSnapshot = await context.collectGoalCycleSnapshot(goalIds);
      const waitDeadlines = await context.resolveWaitDeadlines?.(goalIds);
      if (waitDeadlines) {
        applyWaitDeadlineStatus(context, waitDeadlines);
      }
      const scheduledActiveGoals = await context.determineActiveGoals(goalIds, cycleSnapshot);
      const dueWaitGoalIds = waitDeadlines ? getDueWaitGoalIds(waitDeadlines) : [];
      const activeGoals = [...new Set([...scheduledActiveGoals, ...dueWaitGoalIds])];
      await context.maybeRefreshProviderRuntime(activeGoals.length);

      if (activeGoals.length === 0) {
        context.logger.info("No goals need activation this cycle", { checked: goalIds.length });
      }

      for (const goalId of activeGoals) {
        if (!context.running) break;

        context.logger.info(`Running loop for goal: ${goalId}`);

        try {
          const iterationsPerCycle = context.config.iterations_per_cycle ?? 1;
          const result: LoopResult = await context.coreLoop.run(goalId, {
            maxIterations: iterationsPerCycle,
            onProgress: (event: ProgressEvent) => {
              if (!context.eventServer) return;
              void context.eventServer.broadcast?.("progress", {
                goalId,
                ...event,
              });
            },
          });
          context.state.loop_count++;
          context.currentLoopIndex = context.state.loop_count;
          context.state.last_loop_at = new Date().toISOString();
          context.logger.info(`Loop completed for goal: ${goalId}`, {
            status: result.finalStatus,
            iterations: result.totalIterations,
          });
          if (context.eventServer) {
            const goal = await context.stateManager.loadGoal(goalId).catch(() => null);
            const lastIteration = result.iterations.at(-1);
            if (lastIteration?.waitObserveOnly) {
              context.state.last_observe_at = new Date().toISOString();
              void context.eventServer.broadcast?.("wait_status", {
                goalId,
                strategyId: lastIteration.waitStrategyId,
                outcome: lastIteration.waitExpiryOutcome,
                approvalId: lastIteration.waitApprovalId,
                skipReason: lastIteration.skipReason,
              });
            }
            void context.eventServer.broadcast?.("iteration_complete", {
              goalId,
              loopCount: context.state.loop_count,
              status: goal?.status ?? "unknown",
            });
            void context.eventServer.broadcast?.("loop_complete", buildLoopCompletePayload(goalId, result));
          }
          await context.broadcastGoalUpdated(goalId, result.finalStatus);
        } catch (err) {
          if (context.eventServer) {
            void context.eventServer.broadcast?.("loop_error", buildLoopErrorPayload(goalId, err, context));
          }
          context.handleLoopError(goalId, err);
        }

        if (!context.running) break;
      }

      context.refreshOperationalState();
      await context.saveDaemonState();
      if (context.eventServer) {
        void context.eventServer.broadcast?.("daemon_status", buildDaemonStatusPayload(context));
      }

      await context.processCronTasks();
      await context.processScheduleEntries();

      if (context.state.loop_count > 0 && context.state.loop_count % 100 === 0) {
        await context.expireCronTasks();
      }

      if (context.running) {
        await context.proactiveTick();
      }

      if (context.running) {
        await context.runRuntimeStoreMaintenance();
      }

      if (activeGoals.length > 0) {
        context.consecutiveIdleCycles = 0;
      } else {
        context.consecutiveIdleCycles++;
      }

      if (context.running) {
        const baseIntervalMs = context.getNextInterval(goalIds);
        const maxGapScore = await context.getMaxGapScore(goalIds, cycleSnapshot);
        const intervalMs = context.calculateAdaptiveInterval(
          baseIntervalMs,
          activeGoals.length,
          maxGapScore,
          context.consecutiveIdleCycles,
        );
        const idleAwareIntervalMs =
          activeGoals.length === 0 ? Math.min(intervalMs, MAX_IDLE_SLEEP_MS) : intervalMs;
        const sleepIntervalMs = waitDeadlines
          ? context.clampIntervalToWaitDeadline(idleAwareIntervalMs, waitDeadlines)
          : idleAwareIntervalMs;
        context.logger.info(`Sleeping for ${sleepIntervalMs}ms until next check`);
        await context.sleep(sleepIntervalMs);
      }
    } catch (err) {
      await context.handleCriticalError(err);
    }
  }

  await context.cleanup();
}
