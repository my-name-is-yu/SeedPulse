import * as fs from "node:fs";
import * as path from "node:path";
import { lintAgentMemory } from "../../platform/knowledge/knowledge-manager-lint.js";
import { DreamAnalyzer } from "../../platform/dream/dream-analyzer.js";
import { DreamConsolidator, type DreamLegacyConsolidationReport } from "../../platform/dream/dream-consolidator.js";
import { DreamScheduleSuggestionStore } from "../../platform/dream/dream-schedule-suggestions.js";
import { createRuntimeDreamSoilSyncService } from "../../platform/dream/dream-soil-sync.js";
import type { DreamReport, DreamRunReport, DreamTier } from "../../platform/dream/dream-types.js";
import { runDreamConsolidation } from "../../reflection/dream-consolidation.js";
import type { DaemonRunnerResidentContext } from "./runner-resident-shared.js";
import { persistResidentActivity } from "./runner-resident-shared.js";

export async function tryApplyPendingDreamSuggestion(
  context: Pick<DaemonRunnerResidentContext, "baseDir" | "scheduleEngine">,
): Promise<{
  suggestion: { id: string; name?: string; reason?: string };
  entry: { id: string };
  duplicate: boolean;
} | null> {
  const dreamStore = new DreamScheduleSuggestionStore(context.baseDir);
  const pendingSuggestion = (await dreamStore.list()).find((suggestion) => suggestion.status === "pending");
  if (!pendingSuggestion || !context.scheduleEngine) {
    return null;
  }

  return dreamStore.applySuggestion(pendingSuggestion.id, context.scheduleEngine);
}

export async function runDreamAnalysis(
  context: Pick<DaemonRunnerResidentContext, "baseDir" | "llmClient" | "logger">,
  tier: DreamTier,
): Promise<DreamRunReport> {
  const analyzer = new DreamAnalyzer({
    baseDir: context.baseDir,
    llmClient: context.llmClient,
    logger: context.logger,
  });
  return analyzer.run({ tier });
}

export async function runPlatformDreamConsolidation(
  context: Pick<
    DaemonRunnerResidentContext,
    "baseDir" | "logger" | "knowledgeManager" | "llmClient" | "memoryLifecycle" | "stateManager"
  >,
  tier: DreamTier,
): Promise<DreamReport | null> {
  try {
    const knowledgeManager = context.knowledgeManager;
    const llmClient = context.llmClient;
    const consolidator = new DreamConsolidator({
      baseDir: context.baseDir,
      logger: context.logger,
      syncService: createRuntimeDreamSoilSyncService(),
      memoryQualityService: knowledgeManager && llmClient
        ? {
            run: async (input) => {
              const result = await lintAgentMemory({
                km: knowledgeManager,
                llmCall: async (prompt) => {
                  const response = await llmClient.sendMessage(
                    [{ role: "user", content: prompt }],
                    { max_tokens: 2000, model_tier: "light" },
                  );
                  return response.content;
                },
                autoRepair: input.autoRepair,
                minAutoRepairConfidence: input.minAutoRepairConfidence,
              });
              return {
                findings: result.findings.length,
                contradictionsFound: result.findings.filter((finding) => finding.type === "contradiction").length,
                stalenessFound: result.findings.filter((finding) => finding.type === "staleness").length,
                redundancyFound: result.findings.filter((finding) => finding.type === "redundancy").length,
                repairsApplied: result.repairs_applied,
                entriesFlagged: result.entries_flagged,
              };
            },
          }
        : undefined,
      legacyConsolidationService: tier === "deep"
        ? {
            run: () => runDreamConsolidation({
              stateManager: context.stateManager,
              memoryLifecycle: context.memoryLifecycle,
              knowledgeManager: context.knowledgeManager,
              baseDir: context.baseDir,
            }),
          }
        : undefined,
    });
    return await consolidator.run({ tier });
  } catch (error) {
    context.logger.warn("Platform Dream consolidation failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function legacyReportFromPlatformDream(report: DreamReport | null): DreamLegacyConsolidationReport | null {
  const category = report?.categories.find((result) => result.category === "legacyReflectionCompatibility");
  if (!category || category.status !== "completed") {
    return null;
  }
  const legacy = report?.operational?.legacy_reflection;
  return legacy
    ? {
        goals_consolidated: legacy.goals_consolidated,
        entries_compressed: legacy.entries_compressed,
        stale_entries_found: legacy.stale_entries_found,
        revalidation_tasks_created: legacy.revalidation_tasks_created,
      }
    : null;
}

export async function triggerResidentDreamMaintenance(
  context: Pick<
    DaemonRunnerResidentContext,
    "baseDir" | "scheduleEngine" | "saveDaemonState" | "state" | "logger" | "knowledgeManager" | "llmClient" | "memoryLifecycle" | "stateManager"
  >,
  details?: Record<string, unknown>,
  tier: DreamTier = "deep",
): Promise<void> {
  try {
    const appliedBeforeAnalysis = await tryApplyPendingDreamSuggestion(context);
    if (appliedBeforeAnalysis) {
      await persistResidentActivity(context, {
        kind: "dream",
        trigger: "proactive_tick",
        summary: appliedBeforeAnalysis.duplicate
          ? `Resident dream linked pending suggestion "${appliedBeforeAnalysis.suggestion.name ?? appliedBeforeAnalysis.suggestion.id}" to existing schedule ${appliedBeforeAnalysis.entry.id}.`
          : `Resident dream applied pending suggestion "${appliedBeforeAnalysis.suggestion.name ?? appliedBeforeAnalysis.suggestion.id}" into schedule ${appliedBeforeAnalysis.entry.id}.`,
        suggestion_title: appliedBeforeAnalysis.suggestion.name ?? appliedBeforeAnalysis.suggestion.reason,
      });
      return;
    }

    const analysisReport = await runDreamAnalysis(context, tier);
    const appliedAfterAnalysis = tier === "deep" ? await tryApplyPendingDreamSuggestion(context) : null;
    const platformReport = await runPlatformDreamConsolidation(context, tier);
    const consolidationReport = tier === "deep"
      ? legacyReportFromPlatformDream(platformReport) ?? await runDreamConsolidation({
          stateManager: context.stateManager,
          memoryLifecycle: context.memoryLifecycle,
          knowledgeManager: context.knowledgeManager,
          baseDir: context.baseDir,
        })
      : null;
    const requestedGoalId =
      typeof details?.["goal_id"] === "string" ? details["goal_id"].trim() : "";
    const goalHint = requestedGoalId ? ` for ${requestedGoalId}` : "";

    await persistResidentActivity(context, {
      kind: "dream",
      trigger: "proactive_tick",
      summary: tier === "light"
        ? `Resident dream light analysis ran${goalHint}; processed ${analysisReport.goalsProcessed.length} goals, persisted ${analysisReport.patternsPersisted} patterns, and generated ${analysisReport.scheduleSuggestions} schedule suggestion(s).`
        : `Resident dream deep analysis ran${goalHint}; processed ${analysisReport.goalsProcessed.length} goals, persisted ${analysisReport.patternsPersisted} patterns, generated ${analysisReport.scheduleSuggestions} schedule suggestion(s), compressed ${consolidationReport?.entries_compressed ?? 0} entries, and created ${consolidationReport?.revalidation_tasks_created ?? 0} revalidation tasks${appliedAfterAnalysis ? ` while applying "${appliedAfterAnalysis.suggestion.name ?? appliedAfterAnalysis.suggestion.id}"` : ""}.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.logger.warn("Resident dream maintenance failed", { error: message });
    await persistResidentActivity(context, {
      kind: "error",
      trigger: "proactive_tick",
      summary: `Resident dream maintenance failed: ${message}`,
    });
  }
}

export async function triggerIdleResidentMaintenance(
  context: Pick<
    DaemonRunnerResidentContext,
    "currentGoalIds" | "baseDir" | "memoryLifecycle" | "knowledgeManager" | "llmClient" | "saveDaemonState" | "state" | "logger" | "scheduleEngine" | "stateManager"
  >,
): Promise<void> {
  if (context.currentGoalIds.length > 0) {
    return;
  }

  const dreamSuggestionPath = path.join(context.baseDir, "dream", "schedule-suggestions.json");
  const hasDreamSuggestionFile = fs.existsSync(dreamSuggestionPath);
  if (!hasDreamSuggestionFile && !context.memoryLifecycle && !context.knowledgeManager && !context.llmClient) {
    return;
  }

  await triggerResidentDreamMaintenance(context, undefined, "light");
}
