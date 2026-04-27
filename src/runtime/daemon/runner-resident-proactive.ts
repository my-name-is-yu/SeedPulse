import { PulSeedEventSchema } from "../../base/types/drive.js";
import { runProactiveMaintenance } from "./maintenance.js";
import type { DaemonRunnerResidentContext } from "./runner-resident-shared.js";
import { persistResidentActivity } from "./runner-resident-shared.js";
import {
  runResidentCuriosityCycle,
  runScheduledGoalReview,
  triggerResidentGoalDiscovery,
  triggerResidentInvestigation,
} from "./runner-resident-curiosity.js";
import {
  triggerIdleResidentMaintenance,
} from "./runner-resident-dream.js";

export async function triggerResidentPreemptiveCheck(
  context: Pick<
    DaemonRunnerResidentContext,
    "stateManager" | "driveSystem" | "currentGoalIds" | "refreshOperationalState" | "supervisor" | "abortSleep" | "saveDaemonState" | "state" | "logger"
  >,
  details?: Record<string, unknown>,
): Promise<void> {
  const goalId =
    typeof details?.["goal_id"] === "string" ? details["goal_id"].trim() : "";

  if (!goalId) {
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: "proactive_tick",
      summary: "Resident preemptive check skipped because no goal_id was provided.",
    });
    return;
  }

  try {
    const goal = await context.stateManager.loadGoal(goalId).catch(() => null);
    if (!goal) {
      await persistResidentActivity(context, {
        kind: "skipped",
        trigger: "proactive_tick",
        summary: `Resident preemptive check skipped because goal "${goalId}" was not found.`,
        goal_id: goalId,
      });
      return;
    }

    await context.driveSystem.writeEvent(
      PulSeedEventSchema.parse({
        type: "external",
        source: "resident-proactive",
        timestamp: new Date().toISOString(),
        data: {
          event_type: "preemptive_check",
          goal_id: goalId,
          requested_by: "resident-daemon",
        },
      }),
    );
    if (!context.currentGoalIds.includes(goalId)) {
      context.currentGoalIds.push(goalId);
    }
    context.refreshOperationalState();
    context.supervisor?.activateGoal(goalId);
    context.abortSleep();
    await persistResidentActivity(context, {
      kind: "observation",
      trigger: "proactive_tick",
      summary: `Resident preemptive check queued an observation wake-up for goal "${goalId}".`,
      goal_id: goalId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.logger.warn("Resident preemptive check failed", { error: message, goal_id: goalId });
    await persistResidentActivity(context, {
      kind: "error",
      trigger: "proactive_tick",
      summary: `Resident preemptive check failed: ${message}`,
      goal_id: goalId || undefined,
    });
  }
}

export async function proactiveTick(
  context: Pick<
    DaemonRunnerResidentContext,
    "config" | "llmClient" | "state" | "logger" | "saveDaemonState" | "curiosityEngine" | "stateManager" | "goalNegotiator" | "currentGoalIds" | "supervisor" | "refreshOperationalState" | "abortSleep" | "baseDir" | "scheduleEngine" | "knowledgeManager" | "memoryLifecycle" | "driveSystem"
  >,
  lastProactiveTickAt: number,
  setLastProactiveTickAt: (value: number) => void,
  lastGoalReviewAt: number,
  setLastGoalReviewAt: (value: number) => void,
): Promise<void> {
  if (!context.config.proactive_mode) {
    return;
  }

  if (await runScheduledGoalReview(context, lastGoalReviewAt, setLastGoalReviewAt)) {
    return;
  }

  const curiosityTriggered = await runResidentCuriosityCycle(context, {
    activityTrigger: "proactive_tick",
    skipWhenNoTriggers: true,
  });
  if (curiosityTriggered) {
    return;
  }

  const result = await runProactiveMaintenance({
    config: context.config,
    llmClient: context.llmClient,
    state: context.state,
    lastProactiveTickAt,
    logger: context.logger,
  });
  setLastProactiveTickAt(result.lastProactiveTickAt);
  if (!result.decision) {
    return;
  }

  if (result.decision.action === "sleep") {
    await persistResidentActivity(context, {
      kind: "sleep",
      trigger: "proactive_tick",
      summary: "Resident proactive tick stayed idle.",
    });
    await triggerIdleResidentMaintenance(context);
    return;
  }

  if (result.decision.action === "suggest_goal") {
    await triggerResidentGoalDiscovery(context, result.decision.details);
    return;
  }

  if (result.decision.action === "investigate") {
    await triggerResidentInvestigation(context, result.decision.details);
    return;
  }

  if (result.decision.action === "preemptive_check") {
    await triggerResidentPreemptiveCheck(context, result.decision.details);
    return;
  }

  await persistResidentActivity(context, {
    kind: "skipped",
    trigger: "proactive_tick",
    summary: `Resident proactive tick requested ${result.decision.action}, but no resident executor is wired for it yet.`,
  });
}
