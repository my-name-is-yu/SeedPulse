/**
 * Phase 3 layer executors: Cron and GoalTrigger.
 * Extracted to keep schedule-engine.ts under 500 lines.
 */
import {
  ScheduleResultSchema,
  type ScheduleEntry,
  type ScheduleResult,
  type ReflectionJobKind,
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
import { detectChange } from "../change-detector.js";
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

interface LayerDeps {
  baseDir?: string;
  dataSourceRegistry?: Map<string, IDataSourceAdapter> | DataSourceRegistry;
  llmClient?: ILLMClient;
  notificationDispatcher?: { dispatch(report: Record<string, unknown>): Promise<any> };
  coreLoop?: { run(goalId: string, options?: { maxIterations?: number }): Promise<any> };
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
  /** Callback for probe to update baseline_results on the owning entry. */
  updateBaseline?: (entryId: string, value: unknown, windowSize: number) => void;
}

async function getAdapter(
  sourceId: string,
  registry: Map<string, IDataSourceAdapter> | DataSourceRegistry | undefined
): Promise<IDataSourceAdapter | undefined> {
  if (!registry) return undefined;
  if (registry instanceof Map) return registry.get(sourceId);
  try {
    return (registry as DataSourceRegistry).getSource(sourceId);
  } catch {
    return undefined;
  }
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
  deps: LayerDeps,
  tier: DreamTier
): Promise<DreamReport | null> {
  if (!deps.baseDir) {
    return null;
  }

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

async function executeReflectionCron(
  entry: ScheduleEntry,
  deps: LayerDeps,
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

export async function executeCron(entry: ScheduleEntry, deps: LayerDeps): Promise<ScheduleResult> {
  const firedAt = new Date().toISOString();
  const start = Date.now();
  const cfg = entry.cron;

  if (!cfg) {
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: 0,
      error_message: "No cron config",
      fired_at: firedAt,
      failure_kind: "permanent",
    });
  }

  // Check daily budget
  if ((entry.tokens_used_today ?? 0) >= entry.max_tokens_per_day) {
    deps.logger.info(`Cron "${entry.name}" skipped: daily budget exceeded`);
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "skipped",
      duration_ms: 0,
      error_message: "daily budget exceeded",
      fired_at: firedAt,
    });
  }

  try {
    if (cfg.job_kind === "reflection") {
      if (!cfg.reflection_kind) {
        return ScheduleResultSchema.parse({
          entry_id: entry.id,
          status: "error",
          duration_ms: 0,
          error_message: "Reflection cron is missing reflection_kind",
          fired_at: firedAt,
          failure_kind: "permanent",
        });
      }
      return executeReflectionCron(entry, deps, firedAt, start, cfg.reflection_kind);
    }

    if (cfg.job_kind === "soil_publish") {
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

    // Gather context from data sources
    const contextMap: Record<string, string> = {};
    for (const sourceId of cfg.context_sources) {
      const adapter = await getAdapter(sourceId, deps.dataSourceRegistry);
      if (adapter) {
        try {
          const result = await adapter.query({
            timeout_ms: 10000,
            dimension_name: sourceId,
          } as Parameters<typeof adapter.query>[0]);
          contextMap[sourceId] = JSON.stringify(result.value ?? result.raw);
        } catch (err) {
          deps.logger.warn(`Cron "${entry.name}" context source "${sourceId}" failed: ${err instanceof Error ? err.message : String(err)}`);
          contextMap[sourceId] = "";
        }
      } else {
        deps.logger.warn(`Cron "${entry.name}" context source "${sourceId}" not found`);
        contextMap[sourceId] = "";
      }
    }

    // Interpolate prompt template
    let prompt = cfg.prompt_template;
    for (const [key, value] of Object.entries(contextMap)) {
      prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    // Call LLM
    let tokensUsed = 0;
    let outputSummary: string | undefined;

    if (deps.llmClient) {
      const llmResponse = await deps.llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { model_tier: "light", max_tokens: cfg.max_tokens }
      );
      tokensUsed = (llmResponse.usage?.input_tokens ?? 0) + (llmResponse.usage?.output_tokens ?? 0);
      outputSummary = llmResponse.content;
    }

    // Report output via ReportingEngine
    // output_format "report" intentionally skips notificationDispatcher — 
    // report output is delivered only through ReportingEngine
    if (cfg.output_format === "report" || cfg.output_format === "both") {
      if (deps.reportingEngine) {
        await deps.reportingEngine.generateNotification("schedule_report", {
          entry_name: entry.name,
          entry_id: entry.id,
          output: outputSummary,
          report_type: cfg.report_type || "schedule_cron",
        });
      } else {
        deps.logger.warn('ReportingEngine not available for output_format report');
      }
    }

    // Dispatch notification if configured
    if ((cfg.output_format === "notification" || cfg.output_format === "both") && deps.notificationDispatcher) {
      try {
        await deps.notificationDispatcher.dispatch({
          report_type: "schedule_report_ready",
          entry_id: entry.id,
          entry_name: entry.name,
          output_summary: outputSummary,
        });
      } catch (err) {
        deps.logger.warn(`Cron "${entry.name}" notification dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "ok",
      duration_ms: Date.now() - start,
      fired_at: firedAt,
      tokens_used: tokensUsed,
      output_summary: outputSummary,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger.error(`Cron "${entry.name}" failed: ${msg}`);
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

export async function executeGoalTrigger(entry: ScheduleEntry, deps: LayerDeps): Promise<ScheduleResult> {
  const firedAt = new Date().toISOString();
  const start = Date.now();
  const cfg = entry.goal_trigger;

  if (!cfg) {
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: 0,
      error_message: "No goal_trigger config",
      fired_at: firedAt,
      failure_kind: "permanent",
    });
  }

  // Check daily budget
  if ((entry.tokens_used_today ?? 0) >= entry.max_tokens_per_day) {
    deps.logger.info(`GoalTrigger "${entry.name}" skipped: daily budget exceeded`);
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "skipped",
      duration_ms: 0,
      error_message: "daily budget exceeded",
      fired_at: firedAt,
    });
  }

  // Check if goal is already active
  if (cfg.skip_if_active && deps.stateManager) {
    try {
      const goal = await deps.stateManager.loadGoal(cfg.goal_id);
      if (goal && goal.status === "active") {
        deps.logger.info(`GoalTrigger "${entry.name}" skipped: goal ${cfg.goal_id} is already active`);
        return ScheduleResultSchema.parse({
          entry_id: entry.id,
          status: "skipped",
          duration_ms: 0,
          error_message: `goal ${cfg.goal_id} is already active`,
          fired_at: firedAt,
        });
      }
    } catch (err) {
      deps.logger.warn(`GoalTrigger "${entry.name}" could not check goal state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!deps.coreLoop) {
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: 0,
      error_message: "No coreLoop provided",
      fired_at: firedAt,
      failure_kind: "permanent",
    });
  }

  try {
    const result = await deps.coreLoop.run(cfg.goal_id, { maxIterations: cfg.max_iterations });
    const tokensUsed = result?.tokensUsed ?? 0;
    if (result) {
      deps.logger.info(`GoalTrigger "${entry.name}" completed: status=${result.finalStatus}, iterations=${result.totalIterations}`);
    }

    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "ok",
      duration_ms: Date.now() - start,
      fired_at: firedAt,
      goal_id: cfg.goal_id,
      tokens_used: tokensUsed,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger.error(`GoalTrigger "${entry.name}" failed: ${msg}`);
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

export async function executeProbe(entry: ScheduleEntry, deps: LayerDeps): Promise<ScheduleResult> {
  const firedAt = new Date().toISOString();
  const start = Date.now();
  const cfg = entry.probe;

  if (!cfg) {
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: 0,
      error_message: "No probe config",
      fired_at: firedAt,
      failure_kind: "permanent",
    });
  }

  // Look up data source adapter
  const adapter = await getAdapter(cfg.data_source_id, deps.dataSourceRegistry);
  if (!adapter) {
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: 0,
      error_message: `Data source not found: ${cfg.data_source_id}`,
      fired_at: firedAt,
      failure_kind: "permanent",
    });
  }

  try {
    const dimensionName = cfg.probe_dimension
      ?? (typeof cfg.query_params.dimension_name === "string" ? cfg.query_params.dimension_name : undefined)
      ?? cfg.data_source_id;

    // Execute probe query
    const queryResult = await adapter.query({
      timeout_ms: 10000,
      ...cfg.query_params,
      dimension_name: dimensionName,
    } as Parameters<typeof adapter.query>[0]);

    const currentValue = queryResult.value ?? queryResult.raw;

    // Detect change
    const { changed, details } = detectChange(
      cfg.change_detector.mode,
      currentValue,
      entry.baseline_results,
      cfg.change_detector.threshold_value
    );

    deps.logger.info(`Probe "${entry.name}": ${details}`);

    let tokensUsed = 0;
    let outputSummary: string | undefined;

    // Optional LLM analysis on change
    if (changed && cfg.llm_on_change && deps.llmClient) {
      const prompt = cfg.llm_prompt_template
        ? cfg.llm_prompt_template.replace("{{result}}", JSON.stringify(currentValue))
        : `A scheduled probe detected a change. Current result: ${JSON.stringify(currentValue)}. Previous baselines: ${JSON.stringify(entry.baseline_results.slice(-3))}. Is this change significant? Respond concisely.`;

      try {
        const llmResponse = await deps.llmClient.sendMessage(
          [{ role: "user", content: prompt }],
          { model_tier: "light" }
        );
        tokensUsed = (llmResponse.usage?.input_tokens ?? 0) + (llmResponse.usage?.output_tokens ?? 0);
        outputSummary = llmResponse.content;
      } catch (err) {
        deps.logger.warn(`Probe "${entry.name}" LLM analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Update baseline_results via callback
    if (deps.updateBaseline) {
      deps.updateBaseline(entry.id, currentValue, cfg.change_detector.baseline_window);
    }

    // Dispatch change notification
    if (changed && deps.notificationDispatcher) {
      try {
        await deps.notificationDispatcher.dispatch({
          report_type: "schedule_change",
          entry_id: entry.id,
          entry_name: entry.name,
          details,
          output_summary: outputSummary,
        });
      } catch (err) {
        deps.logger.warn(`Probe "${entry.name}" notification dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "ok",
      duration_ms: Date.now() - start,
      fired_at: firedAt,
      tokens_used: tokensUsed,
      change_detected: changed,
      output_summary: outputSummary,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger.error(`Probe "${entry.name}" failed: ${msg}`);
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
