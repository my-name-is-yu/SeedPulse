import {
  ScheduleResultSchema,
  type ReflectionJobKind,
  type ScheduleEntry,
  type ScheduleResult,
} from "../types/schedule.js";
import type { IDataSourceAdapter } from "../../platform/observation/data-source-adapter.js";
import type { DataSourceRegistry } from "../../platform/observation/data-source-adapter.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { HookManager } from "../hook-manager.js";
import type { Logger } from "../logger.js";
import type { MemoryLifecycleManager } from "../../platform/knowledge/memory/memory-lifecycle.js";
import type { KnowledgeManager } from "../../platform/knowledge/knowledge-manager.js";
import { lintAgentMemory } from "../../platform/knowledge/knowledge-manager-lint.js";
import {
  runDreamConsolidation,
  runEveningCatchup,
  runMorningPlanning,
  runWeeklyReview,
} from "../../reflection/index.js";
import { DreamAnalyzer } from "../../platform/dream/dream-analyzer.js";
import { DreamConsolidator, type DreamLegacyConsolidationReport } from "../../platform/dream/dream-consolidator.js";
import { createRuntimeDreamSoilSyncService } from "../../platform/dream/dream-soil-sync.js";
import type { DreamReport, DreamTier } from "../../platform/dream/dream-types.js";
import { publishSoilSnapshots } from "../../platform/soil/index.js";

export interface ReflectionCronDeps {
  baseDir?: string;
  dataSourceRegistry?: Map<string, IDataSourceAdapter> | DataSourceRegistry;
  llmClient?: ILLMClient;
  notificationDispatcher?: { dispatch(report: Record<string, unknown>): Promise<any> };
  stateManager?: StateManager;
  reportingEngine?: { generateNotification(type: string, context: Record<string, unknown>): Promise<any> };
  hookManager?: HookManager;
  memoryLifecycle?: MemoryLifecycleManager;
  knowledgeManager?: KnowledgeManager;
  logger: {
    info: (msg: string, ctx?: Record<string, unknown>) => void;
    warn: (msg: string, ctx?: Record<string, unknown>) => void;
    error: (msg: string, ctx?: Record<string, unknown>) => void;
  };
}

export async function executeReflectionCronJob(
  entry: ScheduleEntry,
  deps: ReflectionCronDeps,
  firedAt: string,
  start: number,
  kind: ReflectionJobKind,
): Promise<ScheduleResult> {
  if (!deps.baseDir || !deps.stateManager) {
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: 0,
      error_message: "Reflection cron requires baseDir and stateManager",
      fired_at: firedAt,
      failure_kind: "permanent",
    });
  }

  try {
    let report: Record<string, unknown>;
    let tokensUsed = 0;
    const recordTokens = (tokens: number) => {
      tokensUsed += tokens;
    };

    switch (kind) {
      case "morning_planning":
        if (!deps.llmClient) throw new Error("Reflection cron requires llmClient for morning_planning");
        report = await runMorningPlanning({
          stateManager: deps.stateManager,
          llmClient: withTokenAccountingClient(deps.llmClient, recordTokens),
          baseDir: deps.baseDir,
          notificationDispatcher: deps.notificationDispatcher,
          hookManager: deps.hookManager,
        }) as unknown as Record<string, unknown>;
        break;
      case "evening_catchup":
        if (!deps.llmClient) throw new Error("Reflection cron requires llmClient for evening_catchup");
        report = await runEveningCatchup({
          stateManager: deps.stateManager,
          llmClient: withTokenAccountingClient(deps.llmClient, recordTokens),
          baseDir: deps.baseDir,
          notificationDispatcher: deps.notificationDispatcher,
          hookManager: deps.hookManager,
        }) as unknown as Record<string, unknown>;
        break;
      case "weekly_review":
        if (!deps.llmClient) throw new Error("Reflection cron requires llmClient for weekly_review");
        report = await runWeeklyReview({
          stateManager: deps.stateManager,
          llmClient: withTokenAccountingClient(deps.llmClient, recordTokens),
          baseDir: deps.baseDir,
          notificationDispatcher: deps.notificationDispatcher,
        }) as unknown as Record<string, unknown>;
        break;
      case "dream_consolidation":
        {
          const analyzer = new DreamAnalyzer({
            baseDir: deps.baseDir,
            llmClient: deps.llmClient,
            logger: deps.logger as Logger,
          });
          await analyzer.runDeep();
        }
        {
          const platformReport = await runPlatformDreamConsolidation(deps, "deep");
          report = (legacyReportFromPlatformDream(platformReport) ?? await runDreamConsolidation({
            stateManager: deps.stateManager,
            memoryLifecycle: deps.memoryLifecycle,
            knowledgeManager: deps.knowledgeManager,
            baseDir: deps.baseDir,
          })) as unknown as Record<string, unknown>;
        }
        break;
    }

    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "ok",
      duration_ms: Date.now() - start,
      fired_at: firedAt,
      tokens_used: tokensUsed,
      output_summary: summarizeReflection(kind, report),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger.error(`Cron "${entry.name}" reflection failed: ${msg}`);
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: Date.now() - start,
      error_message: msg,
      fired_at: firedAt,
      failure_kind: "transient",
    });
  }
}

export async function executeSoilPublishCronJob(
  entry: ScheduleEntry,
  deps: Pick<ReflectionCronDeps, "baseDir">,
  firedAt: string,
  start: number
): Promise<ScheduleResult> {
  if (!deps.baseDir) {
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: 0,
      error_message: "Soil publish cron requires baseDir",
      fired_at: firedAt,
      failure_kind: "permanent",
    });
  }
  const result = await publishSoilSnapshots({ baseDir: deps.baseDir, provider: "all" });
  const pageResults = result.providers.flatMap((provider) => provider.pages);
  const errors = pageResults.filter((page) => page.status === "error");
  const published = pageResults.filter((page) => page.status === "published");
  const skipped = pageResults.filter((page) => page.status === "skipped");
  return ScheduleResultSchema.parse({
    entry_id: entry.id,
    status: errors.length > 0 ? "error" : "ok",
    duration_ms: Date.now() - start,
    error_message: errors.length > 0 ? `${errors.length} Soil publish page(s) failed` : undefined,
    fired_at: firedAt,
    failure_kind: errors.length > 0 ? "transient" : undefined,
    output_summary: `Soil publish completed: ${published.length} published, ${skipped.length} skipped, ${errors.length} errors`,
  });
}

function summarizeReflection(kind: ReflectionJobKind, report: Record<string, unknown>): string {
  switch (kind) {
    case "morning_planning":
      return `Morning planning completed (${report["goals_reviewed"] ?? 0} goals reviewed)`;
    case "evening_catchup":
      return `Evening catch-up completed (${report["goals_reviewed"] ?? 0} goals reviewed)`;
    case "weekly_review":
      return `Weekly review completed (${report["goals_reviewed"] ?? 0} goals reviewed)`;
    case "dream_consolidation":
      return `Dream consolidation completed (${report["goals_consolidated"] ?? 0} goals consolidated)`;
  }
}

function withTokenAccountingClient(
  llmClient: ILLMClient,
  recordTokens: (tokens: number) => void
): ILLMClient {
  return {
    async sendMessage(messages, options) {
      const response = await llmClient.sendMessage(messages, options);
      recordTokens((response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0));
      return response;
    },
    async sendMessageStream(messages, options, handlers) {
      if (!llmClient.sendMessageStream) {
        return llmClient.sendMessage(messages, options);
      }
      const response = await llmClient.sendMessageStream(messages, options, handlers);
      recordTokens((response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0));
      return response;
    },
    parseJSON: ((content: string, schema: unknown, options?: unknown) => {
      if (options === undefined) {
        return llmClient.parseJSON(content as never, schema as never);
      }
      return llmClient.parseJSON(content as never, schema as never, options as never);
    }) as ILLMClient["parseJSON"],
    supportsToolCalling() {
      return llmClient.supportsToolCalling?.() ?? true;
    },
  };
}

async function runPlatformDreamConsolidation(
  deps: ReflectionCronDeps,
  tier: DreamTier
): Promise<DreamReport | null> {
  if (!deps.baseDir) return null;
  try {
    const consolidator = new DreamConsolidator({
      baseDir: deps.baseDir,
      logger: deps.logger as Logger,
      syncService: createRuntimeDreamSoilSyncService(),
      memoryQualityService: deps.knowledgeManager && deps.llmClient
        ? {
            run: async (input) => {
              const result = await lintAgentMemory({
                km: deps.knowledgeManager!,
                llmCall: async (prompt) => {
                  const response = await deps.llmClient!.sendMessage(
                    [{ role: "user", content: prompt }],
                    { max_tokens: 2000, model_tier: "light" }
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
      legacyConsolidationService: tier === "deep" && deps.stateManager
        ? {
            run: () => runDreamConsolidation({
              stateManager: deps.stateManager!,
              memoryLifecycle: deps.memoryLifecycle,
              knowledgeManager: deps.knowledgeManager,
              baseDir: deps.baseDir!,
            }),
          }
        : undefined,
    });
    return await consolidator.run({ tier });
  } catch (error) {
    deps.logger.warn("Platform Dream consolidation failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function legacyReportFromPlatformDream(report: DreamReport | null): DreamLegacyConsolidationReport | null {
  const category = report?.categories.find((result) => result.category === "legacyReflectionCompatibility");
  if (!category || category.status !== "completed") return null;
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
