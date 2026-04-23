import type { GroundingProvider } from "../contracts.js";
import { makeSection, makeSource } from "./helpers.js";

export const lessonsProvider: GroundingProvider = {
  key: "lessons",
  kind: "dynamic",
  async build(context) {
    const query = context.request.query ?? context.request.userMessage;
    if (!query?.trim() || !context.request.lessonsQuery) {
      return null;
    }
    const result = await context.request.lessonsQuery({
      query,
      goalId: context.request.goalId,
      limit: context.profile.budgets.maxKnowledgeHits,
    });
    const items = result?.items ?? [];
    if (items.length === 0) {
      return makeSection("lessons", "No lesson snippets matched.", [
        makeSource("lessons", "lessons query", {
          type: "none",
          trusted: true,
          accepted: true,
          retrievalId: "none:lessons",
        }),
      ]);
    }
    return makeSection(
      "lessons",
      items.map((item) => `- ${item.content}`).join("\n"),
      [
        makeSource("lessons", "lessons query", {
          type: "derived",
          trusted: true,
          accepted: true,
          retrievalId: "lessons:query",
        }),
      ],
    );
  },
};
