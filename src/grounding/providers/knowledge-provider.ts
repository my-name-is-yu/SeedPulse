import type { GroundingKnowledgeResult, GroundingProvider } from "../contracts.js";
import { makeSection, makeSource } from "./helpers.js";

export const knowledgeQueryProvider: GroundingProvider = {
  key: "knowledge_query",
  kind: "dynamic",
  async build(context) {
    const query = context.request.query ?? context.request.userMessage;
    if (!query?.trim()) {
      return null;
    }
    const soilHitCount = Number(context.runtime.get("soil_hit_count") ?? 0);
    if (soilHitCount > 0 && !context.request.knowledgeContext?.trim()) {
      return null;
    }

    let result: GroundingKnowledgeResult | null = null;
    if (context.request.knowledgeContext?.trim()) {
      result = {
        retrievalId: "knowledge:prefetched",
        items: [
          {
            id: "knowledge:prefetched",
            content: context.request.knowledgeContext.trim(),
            source: "request.knowledgeContext",
          },
        ],
      };
    } else if (context.request.knowledgeQuery) {
      result = await context.request.knowledgeQuery({
        query,
        goalId: context.request.goalId,
        limit: context.profile.budgets.maxKnowledgeHits,
      });
    }

    const items = result?.items ?? [];
    context.runtime.set("knowledge_hit_count", items.length);
    return makeSection(
      "knowledge_query",
      items.length > 0
        ? items.slice(0, context.profile.budgets.maxKnowledgeHits).map((item) => `- ${item.content}`).join("\n")
        : "No broader knowledge results.",
      [
        makeSource("knowledge_query", "knowledge query", {
          type: items.length > 0 ? "tool" : "none",
          trusted: true,
          accepted: true,
          retrievalId: items.length > 0 ? result?.retrievalId ?? "knowledge:query" : "none:knowledge_query",
          metadata: result?.warnings ? { warnings: result.warnings } : undefined,
        }),
      ],
    );
  },
};
