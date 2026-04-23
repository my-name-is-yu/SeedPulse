import type { Goal } from "../../base/types/goal.js";
import type { GroundingProvider } from "../contracts.js";
import { makeSection, makeSource } from "./helpers.js";

function formatGoal(goalId: string, goal: Goal): string {
  const loopStatus = goal.loop_status && goal.loop_status !== "idle" ? ` [${goal.loop_status}]` : "";
  return `- ${goal.title} (${goalId})${loopStatus} - status: ${goal.status}`;
}

export const goalStateProvider: GroundingProvider = {
  key: "goal_state",
  kind: "dynamic",
  async build(context) {
    const stateManager = context.deps.stateManager;
    if (!stateManager) {
      return null;
    }

    const ids = await stateManager.listGoalIds();
    const focusedIds = context.request.goalId && ids.includes(context.request.goalId)
      ? [context.request.goalId, ...ids.filter((id) => id !== context.request.goalId)]
      : ids;
    const limitedIds = focusedIds.slice(0, context.profile.budgets.maxGoalCount);
    const goals = await Promise.all(limitedIds.map(async (id) => await stateManager.loadGoal(id)));
    const lines = goals
      .map((goal, index) => (goal ? formatGoal(limitedIds[index]!, goal) : null))
      .filter((line): line is string => Boolean(line));
    const content = lines.length > 0 ? lines.join("\n") : "No goals configured yet.";

    return makeSection(
      "goal_state",
      content,
      [
        makeSource("goal_state", "stateManager.listGoalIds", {
          type: lines.length > 0 ? "state" : "none",
          trusted: true,
          accepted: true,
          retrievalId: lines.length > 0 ? `goals:${limitedIds.join(",")}` : "none:goal_state",
        }),
      ],
      { title: "Current Goals" },
    );
  },
};
