import type { ResidentActivity } from "../../base/types/daemon.js";
import type { DaemonRunnerResidentContext } from "./runner-resident-shared.js";
import {
  gatherResidentWorkspaceContext,
  loadExistingGoalTitles,
  loadKnownGoals,
  persistResidentActivity,
  resolveResidentWorkspaceDir,
} from "./runner-resident-shared.js";

export async function triggerResidentGoalDiscovery(
  context: Pick<
    DaemonRunnerResidentContext,
    "goalNegotiator" | "currentGoalIds" | "config" | "supervisor" | "refreshOperationalState" | "abortSleep" | "logger"
  > &
    Pick<DaemonRunnerResidentContext, "saveDaemonState" | "state" | "stateManager">,
  details?: Record<string, unknown>,
): Promise<void> {
  if (!context.goalNegotiator) {
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: "proactive_tick",
      summary: "Resident discovery skipped because goal negotiation is unavailable.",
    });
    return;
  }

  if (context.currentGoalIds.length > 0) {
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: "proactive_tick",
      summary: "Resident discovery skipped because active goals are already running.",
    });
    return;
  }

  const hintedDescription =
    typeof details?.["description"] === "string" ? details["description"].trim() : "";
  const hintedTitle =
    typeof details?.["title"] === "string" ? details["title"].trim() : "";

  try {
    const workspaceDir = resolveResidentWorkspaceDir(context.config.workspace_path);
    const workspaceContext = gatherResidentWorkspaceContext(workspaceDir, hintedDescription);
    const existingTitles = await loadExistingGoalTitles(context);
    const suggestions = await context.goalNegotiator.suggestGoals(workspaceContext, {
      maxSuggestions: 1,
      existingGoals: existingTitles,
      repoPath: workspaceDir,
    });
    const suggestion = suggestions[0];
    const suggestionTitle = suggestion?.title ?? hintedTitle;
    const negotiationDescription = suggestion?.description ?? hintedDescription;

    if (!negotiationDescription) {
      await persistResidentActivity(context, {
        kind: "suggestion",
        trigger: "proactive_tick",
        summary: "Resident discovery ran but found no actionable goal to negotiate.",
        suggestion_title: suggestionTitle || undefined,
      });
      return;
    }

    const { goal } = await context.goalNegotiator.negotiate(negotiationDescription, {
      workspaceContext,
      timeoutMs: 30_000,
    });
    if (!context.currentGoalIds.includes(goal.id)) {
      context.currentGoalIds.push(goal.id);
    }
    context.refreshOperationalState();
    await persistResidentActivity(context, {
      kind: "negotiation",
      trigger: "proactive_tick",
      summary: `Resident discovery negotiated a new goal: ${suggestionTitle || goal.title}`,
      suggestion_title: suggestionTitle || goal.title,
      goal_id: goal.id,
    });
    context.supervisor?.activateGoal(goal.id);
    context.abortSleep();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.logger.warn("Resident discovery failed", { error: message });
    await persistResidentActivity(context, {
      kind: "error",
      trigger: "proactive_tick",
      summary: `Resident discovery failed: ${message}`,
    });
  }
}

export async function runResidentCuriosityCycle(
  context: Pick<
    DaemonRunnerResidentContext,
    "curiosityEngine" | "stateManager" | "saveDaemonState" | "state" | "logger"
  >,
  options?: {
    activityTrigger?: ResidentActivity["trigger"];
    focus?: string;
    reviewLabel?: string;
    skipWhenNoTriggers?: boolean;
  },
): Promise<boolean> {
  if (!context.curiosityEngine) {
    if (options?.skipWhenNoTriggers) {
      return false;
    }
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: options?.activityTrigger ?? "proactive_tick",
      summary: "Resident investigation skipped because curiosity wiring is unavailable.",
    });
    return true;
  }

  try {
    const goals = await loadKnownGoals(context);
    const triggers = await context.curiosityEngine.evaluateTriggers(goals);
    const focus = options?.focus?.trim() ?? "";

    if (triggers.length === 0) {
      if (options?.skipWhenNoTriggers) {
        return false;
      }
      await persistResidentActivity(context, {
        kind: "curiosity",
        trigger: options?.activityTrigger ?? "proactive_tick",
        summary: options?.reviewLabel
          ? `Resident ${options.reviewLabel} ran and found no curiosity triggers.`
          : `Resident investigation ran${focus ? ` for ${focus}` : ""} and found nothing actionable.`,
      });
      return true;
    }

    const proposals = await context.curiosityEngine.generateProposals(triggers, goals);
    if (proposals.length === 0) {
      await persistResidentActivity(context, {
        kind: "curiosity",
        trigger: options?.activityTrigger ?? "proactive_tick",
        summary: options?.reviewLabel
          ? `Resident ${options.reviewLabel} ran but produced no curiosity proposals.`
          : `Resident investigation ran${focus ? ` for ${focus}` : ""} but produced no curiosity proposals.`,
      });
      return true;
    }

    const proposal = proposals[0]!;
    await persistResidentActivity(context, {
      kind: "curiosity",
      trigger: options?.activityTrigger ?? "proactive_tick",
      summary: options?.reviewLabel
        ? `Resident ${options.reviewLabel} created ${proposals.length} curiosity proposal(s); next focus: ${proposal.proposed_goal.description}`
        : `Resident investigation created ${proposals.length} curiosity proposal(s); next focus: ${proposal.proposed_goal.description}`,
      suggestion_title: proposal.proposed_goal.description,
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.logger.warn("Resident investigation failed", { error: message });
    await persistResidentActivity(context, {
      kind: "error",
      trigger: options?.activityTrigger ?? "proactive_tick",
      summary: `Resident investigation failed: ${message}`,
    });
    return true;
  }
}

export async function triggerResidentInvestigation(
  context: Pick<DaemonRunnerResidentContext, "curiosityEngine" | "stateManager" | "saveDaemonState" | "state" | "logger">,
  details?: Record<string, unknown>,
): Promise<void> {
  const focus = typeof details?.["what"] === "string" ? details["what"].trim() : "";
  await runResidentCuriosityCycle(context, {
    activityTrigger: "proactive_tick",
    focus,
    skipWhenNoTriggers: false,
  });
}

export async function runScheduledGoalReview(
  context: Pick<DaemonRunnerResidentContext, "curiosityEngine" | "stateManager" | "saveDaemonState" | "state" | "logger" | "config">,
  lastGoalReviewAt: number,
  setLastGoalReviewAt: (value: number) => void,
): Promise<boolean> {
  if (!context.curiosityEngine || !context.config.proactive_mode) {
    return false;
  }
  const now = Date.now();
  if (now - lastGoalReviewAt < context.config.goal_review_interval_ms) {
    return false;
  }
  setLastGoalReviewAt(now);
  return runResidentCuriosityCycle(context, {
    activityTrigger: "schedule",
    reviewLabel: "goal review",
    skipWhenNoTriggers: false,
  });
}
