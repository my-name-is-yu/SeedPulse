import type { ToolCallContext } from "../../tools/types.js";
import { SoilQueryTool } from "../../tools/query/SoilQueryTool/SoilQueryTool.js";
import type { GroundingProvider, GroundingSoilResult } from "../contracts.js";
import { makeSection, makeSource, soilRootFromHome, resolveHomeDir } from "./helpers.js";

function buildToolContext(cwd: string, goalId?: string): ToolCallContext {
  return {
    cwd,
    goalId: goalId ?? "grounding",
    trustBalance: 0,
    preApproved: true,
    approvalFn: async () => false,
  };
}

function shouldQuerySoil(query: string | undefined): query is string {
  return Boolean(query && query.trim().length >= 8);
}

export const soilKnowledgeProvider: GroundingProvider = {
  key: "soil_knowledge",
  kind: "dynamic",
  async build(context) {
    const query = context.request.query ?? context.request.userMessage;
    if (!shouldQuerySoil(query)) {
      return null;
    }

    let result: GroundingSoilResult | null = null;
    if (context.request.soilQuery) {
      result = await context.request.soilQuery({
        query,
        rootDir: context.request.workspaceRoot ?? process.cwd(),
        limit: context.profile.budgets.maxKnowledgeHits,
      });
    } else {
      const homeDir = resolveHomeDir(context.request.homeDir ?? context.deps.stateManager?.getBaseDir?.());
      const tool = new SoilQueryTool();
      const toolResult = await tool.call({
        query,
        rootDir: soilRootFromHome(homeDir),
        limit: context.profile.budgets.maxKnowledgeHits,
      }, buildToolContext(context.request.workspaceRoot ?? process.cwd(), context.request.goalId));
      if (toolResult.success) {
        const data = toolResult.data as {
          retrievalSource: "sqlite" | "index" | "manifest";
          warnings: string[];
          hits: Array<{ soilId: string; title: string; summary?: string | null; snippet?: string; score?: number }>;
        };
        result = {
          retrievalSource: data.retrievalSource,
          warnings: data.warnings,
          hits: data.hits,
        };
      }
    }

    const hits = result?.hits ?? [];
    context.runtime.set("soil_hit_count", hits.length);
    const lines = hits.slice(0, context.profile.budgets.maxKnowledgeHits).map((hit) => {
      const detail = [hit.summary, hit.snippet].filter(Boolean).join(" | ");
      return `- ${hit.title} (${hit.soilId})${detail ? `: ${detail}` : ""}`;
    });
    const warnings = result?.warnings ?? [];
    const content = [
      lines.length > 0 ? lines.join("\n") : "No relevant Soil knowledge found.",
      warnings.length > 0 ? `Warnings: ${warnings.join("; ")}` : "",
    ].filter(Boolean).join("\n");

    return makeSection(
      "soil_knowledge",
      content,
      [
        makeSource("soil_knowledge", "soil_query", {
          type: lines.length > 0 ? "tool" : "none",
          trusted: true,
          accepted: true,
          retrievalId: lines.length > 0 ? `soil:${result?.retrievalSource ?? "unknown"}` : "none:soil_knowledge",
          metadata: { warnings },
        }),
      ],
    );
  },
};
