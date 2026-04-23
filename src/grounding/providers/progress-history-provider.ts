import type { GroundingProvider } from "../contracts.js";
import { makeSection, makeSource } from "./helpers.js";

export const progressHistoryProvider: GroundingProvider = {
  key: "progress_history",
  kind: "dynamic",
  async build(context) {
    const stateManager = context.deps.stateManager;
    const goalId = context.request.goalId;
    if (!stateManager || !goalId) {
      return null;
    }

    const entries = await stateManager.loadGapHistory(goalId);
    const limited = entries.slice(-context.profile.budgets.maxProgressEntries);
    const lines = limited.map((entry) => {
      const gaps = entry.gap_vector
        .slice(0, 3)
        .map((gap) => `${gap.dimension_name}=${gap.normalized_weighted_gap.toFixed(2)}`)
        .join(", ");
      return `- iteration ${entry.iteration} @ ${entry.timestamp}: ${gaps || "no dimensions"}`;
    });

    return makeSection(
      "progress_history",
      lines.length > 0 ? lines.join("\n") : "No progress history available.",
      [
        makeSource("progress_history", "gap history", {
          type: lines.length > 0 ? "state" : "none",
          trusted: true,
          accepted: true,
          retrievalId: lines.length > 0 ? `progress:${goalId}` : "none:progress_history",
        }),
      ],
    );
  },
};
