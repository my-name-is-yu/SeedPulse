import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../../base/utils/json-io.js";
import type { Logger } from "../../runtime/logger.js";
import { upsertDreamActivationArtifacts, loadDreamActivationArtifacts } from "./dream-activation-artifacts.js";
import { consolidateDreamEventWorkflows, loadDreamWorkflowRecords } from "./dream-event-workflows.js";
import type { DreamSoilSyncService } from "./dream-soil-sync.js";
import { DEFAULT_DREAM_CONFIG } from "./dream-config.js";
import {
  collectBacklogMetrics,
  countAgentMemoryEntries,
  countEventLines,
  countFilesNamed,
  countGoalDirs,
  countGoalPairs,
  countJsonFiles,
  countJsonlLines,
  countLearnedPatterns,
  countTrustDomains,
  countVerificationArtifacts,
} from "./dream-consolidator/fs-metrics.js";
import {
  ConsolidationCategoryResultSchema,
  DreamActivationArtifactSchema,
  DreamOperationalReportSchema,
  DreamReportSchema,
  type DreamActivationArtifact,
  type ConsolidationCategoryResult,
  type DreamLogConfig,
  type DreamOperationalReport,
  type DreamReport,
  type DreamTier,
} from "./dream-types.js";

type DreamConsolidationCategory =
  | "memory"
  | "agentMemory"
  | "crossGoalTransfer"
  | "decisionHistory"
  | "stallHistory"
  | "sessionData"
  | "iterationLogs"
  | "gapHistory"
  | "observationLogs"
  | "reports"
  | "trustScores"
  | "strategyHistory"
  | "verificationArtifacts"
  | "archive"
  | "legacyReflectionCompatibility"
  | "knowledgeOptimization";

const LIGHT_CATEGORIES: DreamConsolidationCategory[] = [
  "memory",
  "agentMemory",
  "knowledgeOptimization",
];

const DEEP_CATEGORIES: DreamConsolidationCategory[] = [
  "memory",
  "agentMemory",
  "crossGoalTransfer",
  "decisionHistory",
  "stallHistory",
  "sessionData",
  "iterationLogs",
  "gapHistory",
  "observationLogs",
  "reports",
  "trustScores",
  "strategyHistory",
  "verificationArtifacts",
  "archive",
  "legacyReflectionCompatibility",
  "knowledgeOptimization",
];

interface DreamConsolidationPassInput {
  category: DreamConsolidationCategory;
  tier: DreamTier;
}

interface DreamConsolidationPassResult {
  metrics: Record<string, number>;
  warnings?: string[];
  activationArtifacts?: DreamActivationArtifact[];
}

interface DreamConsolidationPass {
  category: DreamConsolidationCategory;
  run(input: DreamConsolidationPassInput): Promise<DreamConsolidationPassResult>;
}

type CategoryCollector = (tier: DreamTier) => Promise<DreamConsolidationPassResult>;

interface ActivationArtifactInput {
  type: DreamActivationArtifact["type"];
  source: string;
  summary: string;
  payload?: Record<string, unknown>;
  evidenceRefs?: string[];
  confidence: number;
  scope?: DreamActivationArtifact["scope"];
}

export interface DreamLegacyConsolidationReport {
  goals_consolidated: number;
  entries_compressed: number;
  stale_entries_found: number;
  revalidation_tasks_created: number;
}

export interface DreamLegacyConsolidationService {
  run(input: { baseDir: string }): Promise<DreamLegacyConsolidationReport>;
}

export interface DreamMemoryQualityReport {
  findings: number;
  contradictionsFound: number;
  stalenessFound: number;
  redundancyFound: number;
  repairsApplied: number;
  entriesFlagged: number;
}

export interface DreamMemoryQualityService {
  run(input: {
    baseDir: string;
    autoRepair: boolean;
    minAutoRepairConfidence: number;
  }): Promise<DreamMemoryQualityReport>;
}

interface DreamConsolidatorDeps {
  baseDir: string;
  logger?: Logger;
  config?: Partial<DreamLogConfig["consolidation"]>;
  syncService?: DreamSoilSyncService;
  legacyConsolidationService?: DreamLegacyConsolidationService;
  memoryQualityService?: DreamMemoryQualityService;
}

export interface DreamConsolidatorRunOptions {
  tier?: DreamTier;
}

export class DreamConsolidator {
  private readonly logger?: Logger;
  private readonly config: DreamLogConfig["consolidation"];
  private readonly passRegistry: Map<DreamConsolidationCategory, DreamConsolidationPass>;
  private activationArtifactsWritten = 0;

  constructor(private readonly deps: DreamConsolidatorDeps) {
    this.logger = deps.logger;
    this.config = {
      ...DEFAULT_DREAM_CONFIG.consolidation,
      ...deps.config,
    };
    this.passRegistry = this.buildPassRegistry();
  }

  async run(options: DreamConsolidatorRunOptions = {}): Promise<DreamReport> {
    this.activationArtifactsWritten = 0;
    const tier = options.tier ?? "deep";
    const categories = tier === "light" ? LIGHT_CATEGORIES : DEEP_CATEGORIES;
    const results: ConsolidationCategoryResult[] = [];

    for (const category of categories) {
      results.push(await this.runCategory(category, tier));
    }

    const failed = results.filter((result) => result.status === "failed").length;
    const partial = failed > 0;
    const status = failed === results.length ? "failed" : partial ? "partial" : "completed";
    const timestamp = new Date().toISOString();
    const operational = await this.buildOperationalReport(timestamp, results);
    const report = DreamReportSchema.parse({
      timestamp,
      tier,
      status,
      categories: results,
      operational,
      summary: this.buildSummary(tier, results, status),
    });

    await this.persistReport(report);
    return report;
  }

  private async runCategory(
    category: DreamConsolidationCategory,
    tier: DreamTier
  ): Promise<ConsolidationCategoryResult> {
    if (!this.isEnabled(category)) {
      return ConsolidationCategoryResultSchema.parse({
        category,
        status: "skipped",
        metrics: {},
        warnings: ["category disabled"],
        errors: [],
      });
    }

    try {
      const pass = this.passRegistry.get(category);
      if (!pass) {
        throw new Error(`No Dream consolidation pass registered for ${category}`);
      }
      const result = await pass.run({ category, tier });
      if (result.activationArtifacts?.length) {
        await upsertDreamActivationArtifacts(this.deps.baseDir, result.activationArtifacts);
        this.activationArtifactsWritten += result.activationArtifacts.length;
      }
      return ConsolidationCategoryResultSchema.parse({
        category,
        status: "completed",
        metrics: result.metrics,
        warnings: result.warnings ?? [],
        errors: [],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn("Dream consolidation category failed", { category, error: message });
      return ConsolidationCategoryResultSchema.parse({
        category,
        status: "failed",
        metrics: {},
        warnings: [],
        errors: [message],
      });
    }
  }

  private isEnabled(category: DreamConsolidationCategory): boolean {
    const value = this.config[category];
    return typeof value === "object" && value !== null && "enabled" in value
      ? Boolean(value.enabled)
      : true;
  }

  private buildPassRegistry(): Map<DreamConsolidationCategory, DreamConsolidationPass> {
    const categories: DreamConsolidationCategory[] = [
      ...new Set([...LIGHT_CATEGORIES, ...DEEP_CATEGORIES]),
    ];
    return new Map(categories.map((category) => [
      category,
      {
        category,
        run: (input) => this.collectCategoryResult(input.category, input.tier),
      },
    ]));
  }

  private async collectCategoryResult(
    category: DreamConsolidationCategory,
    tier: DreamTier
  ): Promise<DreamConsolidationPassResult> {
    const collectors: Record<DreamConsolidationCategory, CategoryCollector> = {
      memory: async (tier) => ({ metrics: {
          goalsConsidered: await countGoalDirs(this.deps.baseDir, tier),
          latentFactsExtracted: 0,
          lessonsDistilled: 0,
          archivalItemsCollected: 0,
        } }),
      agentMemory: async () => ({ metrics: {
          agentMemoryEntriesScanned: await countAgentMemoryEntries(this.deps.baseDir),
          ...(await this.collectDreamSoilSyncMetrics()),
          autoAppliedConsolidations: 0,
          duplicatesMerged: 0,
        } }),
      crossGoalTransfer: () => this.collectCrossGoalTransferResult(),
      decisionHistory: () => this.collectDecisionHistoryResult(),
      stallHistory: () => this.collectStallHistoryResult(),
      sessionData: async () => ({ metrics: {
          sessionsScanned: await countJsonlLines(this.deps.baseDir, path.join("dream", "session-logs.jsonl")),
          coldSessionsArchived: 0,
          bundlesCreated: 0,
          indexEntriesUpdated: 0,
        } }),
      iterationLogs: async () => ({ metrics: {
          iterationLogsScanned: await countFilesNamed(this.deps.baseDir, "iteration-logs.jsonl"),
          rotatedLogSegments: 0,
          archivedCompletedGoalLogs: 0,
          indexEntriesUpdated: 0,
        } }),
      gapHistory: async () => ({ metrics: {
          goalsAnalyzed: await countFilesNamed(this.deps.baseDir, "gap-history.json"),
          dimensionsModeled: 0,
          falseProgressCasesDetected: 0,
          archetypesEmitted: 0,
        } }),
      observationLogs: async () => ({ metrics: {
          observationsScanned: await countFilesNamed(this.deps.baseDir, "observations.json"),
          flakyMethodsDetected: 0,
          driftAlertsProduced: 0,
        } }),
      reports: async () => ({ metrics: {
          reportsScanned: await countJsonFiles(path.join(this.deps.baseDir, "dream", "reports")),
          sequencesExtracted: 0,
          summaryReportsCreated: 0,
          lowSignalReportsCleanedUp: 0,
        } }),
      trustScores: async () => ({ metrics: {
          trustDomainsAnalyzed: await countTrustDomains(this.deps.baseDir),
          overrideEventsReplayed: 0,
          oscillationsDetected: 0,
          recalibrationRecommendations: 0,
        } }),
      strategyHistory: () => this.collectStrategyHistoryResult(),
      verificationArtifacts: () => this.collectVerificationArtifactsResult(),
      archive: async () => ({ metrics: {
          archivesScanned: await countJsonFiles(path.join(this.deps.baseDir, "archive")),
          postmortemLessonsExtracted: 0,
          solvedBeforeEntriesAdded: 0,
          reusableTemplatesEmitted: 0,
        } }),
      legacyReflectionCompatibility: () => this.collectLegacyReflectionCompatibilityResult(),
      knowledgeOptimization: (tier) => this.collectKnowledgeOptimizationResult(tier),
    };
    return collectors[category](tier);
  }

  private artifactId(parts: string[]): string {
    const hash = createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 16);
    return `dream-artifact:${hash}`;
  }

  private buildActivationArtifact(input: {
    type: DreamActivationArtifact["type"];
    source: string;
    summary: string;
    payload?: Record<string, unknown>;
    evidenceRefs?: string[];
    confidence: number;
    scope?: DreamActivationArtifact["scope"];
  }): DreamActivationArtifact {
    const now = new Date().toISOString();
    return DreamActivationArtifactSchema.parse({
      artifact_id: this.artifactId([input.type, input.source, JSON.stringify(input.scope ?? {})]),
      type: input.type,
      source: input.source,
      scope: input.scope ?? {},
      summary: input.summary,
      payload: input.payload ?? {},
      evidence_refs: input.evidenceRefs ?? [],
      confidence: input.confidence,
      valid_from: now,
      valid_to: null,
    });
  }

  private activationArtifactIf(enabled: boolean, input: ActivationArtifactInput): DreamActivationArtifact[] {
    return enabled ? [this.buildActivationArtifact(input)] : [];
  }

  private async collectStallHistoryResult(): Promise<DreamConsolidationPassResult> {
    const eventMetrics = await this.collectDreamEventWorkflowMetrics();
    const workflows = await loadDreamWorkflowRecords(this.deps.baseDir);
    const stallWorkflows = workflows.filter((workflow) => workflow.type === "stall_recovery");
    const activationArtifacts = this.activationArtifactIf(
      stallWorkflows.length > 0,
      {
          type: "workflow_hint_pack",
          source: "stallHistory",
          summary: `${stallWorkflows.length} stall recovery workflow(s) available`,
          payload: {
            workflow_ids: stallWorkflows.map((workflow) => workflow.workflow_id),
          },
          evidenceRefs: stallWorkflows.flatMap((workflow) => workflow.evidence_refs).slice(0, 20),
          confidence: Math.max(...stallWorkflows.map((workflow) => workflow.confidence), 0.5),
        }
    );
    return {
      metrics: {
        ...eventMetrics,
        stallEventsScanned: await countEventLines(this.deps.baseDir, "StallDetected"),
        recurringLoopsDetected: stallWorkflows.filter((workflow) => workflow.failure_count > 1).length,
        precursorsExtracted: stallWorkflows.length,
        activationArtifactsEmitted: activationArtifacts.length,
      },
      activationArtifacts,
    };
  }

  private async collectVerificationArtifactsResult(): Promise<DreamConsolidationPassResult> {
    const eventMetrics = await this.collectDreamEventWorkflowMetrics();
    const workflows = await loadDreamWorkflowRecords(this.deps.baseDir);
    const verificationWorkflows = workflows.filter((workflow) => workflow.type === "verification_recovery");
    const activationArtifacts = this.activationArtifactIf(
      verificationWorkflows.length > 0,
      {
          type: "verification_recovery_pack",
          source: "verificationArtifacts",
          summary: `${verificationWorkflows.length} verification recovery workflow(s) available`,
          payload: {
            workflow_ids: verificationWorkflows.map((workflow) => workflow.workflow_id),
          },
          evidenceRefs: verificationWorkflows.flatMap((workflow) => workflow.evidence_refs).slice(0, 20),
          confidence: Math.max(...verificationWorkflows.map((workflow) => workflow.confidence), 0.5),
        }
    );
    return {
      metrics: {
        ...eventMetrics,
        artifactsScanned: await countVerificationArtifacts(this.deps.baseDir),
        criterionFailurePatternsDetected: verificationWorkflows.filter((workflow) => workflow.failure_count > 0).length,
        verdictDistributionsComputed: verificationWorkflows.length,
        activationArtifactsEmitted: activationArtifacts.length,
      },
      activationArtifacts,
    };
  }

  private async collectDecisionHistoryResult(): Promise<DreamConsolidationPassResult> {
    const raw = await readJsonFileOrNull(path.join(this.deps.baseDir, "dream", "decision-heuristics.json"));
    const heuristics = typeof raw === "object" && raw !== null && Array.isArray((raw as { heuristics?: unknown[] }).heuristics)
      ? (raw as { heuristics: unknown[] }).heuristics
      : [];
    const activationArtifacts = this.activationArtifactIf(
      heuristics.length > 0,
      {
          type: "decision_heuristic_pack",
          source: "decisionHistory",
          summary: `${heuristics.length} decision heuristic(s) available`,
          payload: { heuristic_count: heuristics.length },
          confidence: 0.65,
        }
    );
    return {
      metrics: {
        decisionRecordsScanned: await countFilesNamed(this.deps.baseDir, "decision-history.json"),
        heuristicsAvailable: heuristics.length,
        clustersBuilt: heuristics.length > 0 ? 1 : 0,
        pivotCausesPromoted: 0,
        staleSuggestionsFlagged: 0,
        activationArtifactsEmitted: activationArtifacts.length,
      },
      activationArtifacts,
    };
  }

  private async collectStrategyHistoryResult(): Promise<DreamConsolidationPassResult> {
    const raw = await readJsonFileOrNull(path.join(this.deps.baseDir, "strategy-templates.json"));
    const templates = Array.isArray(raw) ? raw : [];
    const activationArtifacts = this.activationArtifactIf(
      templates.length > 0,
      {
          type: "pattern_hint_pack",
          source: "strategyHistory",
          summary: `${templates.length} strategy template(s) available`,
          payload: { template_count: templates.length },
          confidence: 0.65,
        }
    );
    return {
      metrics: {
        timelinesReconstructed: await countFilesNamed(this.deps.baseDir, "strategy-history.json"),
        strategyTemplatesAvailable: templates.length,
        successfulPivotLaddersFound: templates.length,
        wastefulStrategyFamiliesFlagged: 0,
        activationArtifactsEmitted: activationArtifacts.length,
      },
      activationArtifacts,
    };
  }

  private async collectCrossGoalTransferResult(): Promise<DreamConsolidationPassResult> {
    const learnedPatterns = await countLearnedPatterns(this.deps.baseDir);
    const activationArtifacts = this.activationArtifactIf(
      learnedPatterns > 0,
      {
          type: "semantic_context_pack",
          source: "crossGoalTransfer",
          summary: `${learnedPatterns} learned pattern(s) available for cross-goal transfer`,
          payload: { learned_pattern_count: learnedPatterns },
          confidence: 0.6,
        }
    );
    return {
      metrics: {
        goalPairsScanned: Math.max(0, await countGoalPairs(this.deps.baseDir)),
        candidatesFound: learnedPatterns,
        transfersApplied: 0,
        transfersRejected: 0,
        activationArtifactsEmitted: activationArtifacts.length,
      },
      activationArtifacts,
    };
  }

  private async collectLegacyReflectionCompatibilityResult(): Promise<DreamConsolidationPassResult> {
    if (!this.deps.legacyConsolidationService) {
      return {
        metrics: {
          legacyGoalsConsolidated: 0,
          legacyEntriesCompressed: 0,
          legacyStaleEntriesFound: 0,
          legacyRevalidationTasksCreated: 0,
        },
        warnings: ["legacy compatibility service unavailable"],
      };
    }
    const report = await this.deps.legacyConsolidationService.run({ baseDir: this.deps.baseDir });
    return {
      metrics: {
        legacyGoalsConsolidated: report.goals_consolidated,
        legacyEntriesCompressed: report.entries_compressed,
        legacyStaleEntriesFound: report.stale_entries_found,
        legacyRevalidationTasksCreated: report.revalidation_tasks_created,
      },
    };
  }

  private async collectKnowledgeOptimizationResult(_tier: DreamTier): Promise<DreamConsolidationPassResult> {
    const config = this.config.knowledgeOptimization;
    const baseMetrics = {
      revalidationTasksGenerated: 0,
      contradictionsFound: 0,
      stalenessFound: 0,
      redundantEntriesFound: 0,
      graphEdgesInferred: 0,
      redundantEntriesMerged: 0,
      memoryQualityFindings: 0,
      memoryQualityRepairsApplied: 0,
      memoryQualityEntriesFlagged: 0,
      activationArtifactsEmitted: 0,
    };

    if (!this.deps.memoryQualityService) {
      return {
        metrics: baseMetrics,
        warnings: ["memory quality service unavailable"],
      };
    }

    const quality = await this.deps.memoryQualityService.run({
      baseDir: this.deps.baseDir,
      autoRepair: config.autoRepairAgentMemory,
      minAutoRepairConfidence: config.minAutoRepairConfidence,
    });
    const activationArtifacts = this.activationArtifactIf(
      quality.findings > 0,
      {
          type: "knowledge_gap_pack",
          source: "knowledgeOptimization",
          summary: `${quality.findings} memory quality issue(s) found`,
          payload: {
            contradictions_found: quality.contradictionsFound,
            staleness_found: quality.stalenessFound,
            redundancy_found: quality.redundancyFound,
            repairs_applied: quality.repairsApplied,
            entries_flagged: quality.entriesFlagged,
          },
          confidence: quality.repairsApplied > 0 ? 0.85 : 0.7,
        }
    );

    return {
      metrics: {
        ...baseMetrics,
        revalidationTasksGenerated: quality.stalenessFound,
        contradictionsFound: quality.contradictionsFound,
        stalenessFound: quality.stalenessFound,
        redundantEntriesFound: quality.redundancyFound,
        redundantEntriesMerged: quality.redundancyFound,
        memoryQualityFindings: quality.findings,
        memoryQualityRepairsApplied: quality.repairsApplied,
        memoryQualityEntriesFlagged: quality.entriesFlagged,
        activationArtifactsEmitted: activationArtifacts.length,
      },
      activationArtifacts,
    };
  }

  private buildSummary(
    tier: DreamTier,
    results: ConsolidationCategoryResult[],
    status: DreamReport["status"]
  ): string {
    const completed = results.filter((result) => result.status === "completed").length;
    const failed = results.filter((result) => result.status === "failed").length;
    return `Dream consolidation (${tier}) ${status}: ${completed} categories completed, ${failed} failed.`;
  }

  private async buildOperationalReport(
    timestamp: string,
    results: ConsolidationCategoryResult[]
  ): Promise<DreamOperationalReport> {
    const backlog = await collectBacklogMetrics(this.deps.baseDir);
    const workflows = await loadDreamWorkflowRecords(this.deps.baseDir);
    const activationArtifacts = await loadDreamActivationArtifacts(this.deps.baseDir);
    const failures = this.collectOperationalFailures(results);
    const metricSum = (key: string) => this.sumMetric(results, key);
    const legacy = this.findLegacyMetrics(results);
    const laggingSources = this.collectLaggingSources(backlog);
    const hasNoBacklog = laggingSources.length === 0;

    return DreamOperationalReportSchema.parse({
      run_id: `dream-${timestamp.replaceAll(":", "-")}`,
      watermarks: {
        advanced: metricSum("eventWorkflowWatermarksAdvanced"),
        unchanged: hasNoBacklog ? 1 : 0,
        lagging_sources: laggingSources,
      },
      consolidation: {
        records_created: metricSum("soilSyncRecordsWritten"),
        records_updated: metricSum("soilSyncChangedSearchMaterial"),
        records_superseded: metricSum("soilSyncRecordsSuperseded"),
        tombstones_written: metricSum("soilSyncTombstonesWritten"),
        artifacts_created: this.activationArtifactsWritten,
      },
      backlog,
      artifact_growth: {
        workflows: workflows.length,
        activation_artifacts: activationArtifacts.length,
      },
      failures,
      legacy_reflection: {
        goals_consolidated: legacy["legacyGoalsConsolidated"] ?? 0,
        entries_compressed: legacy["legacyEntriesCompressed"] ?? 0,
        stale_entries_found: legacy["legacyStaleEntriesFound"] ?? 0,
        revalidation_tasks_created: legacy["legacyRevalidationTasksCreated"] ?? 0,
      },
    });
  }

  private collectOperationalFailures(results: ConsolidationCategoryResult[]): Array<{
    category: string;
    source_ref: null;
    reason: string;
  }> {
    return results.flatMap((result) =>
      result.errors.map((error) => ({
        category: result.category,
        source_ref: null,
        reason: error,
      }))
    );
  }

  private sumMetric(results: ConsolidationCategoryResult[], key: string): number {
    return results.reduce((sum, result) => sum + (result.metrics[key] ?? 0), 0);
  }

  private findLegacyMetrics(results: ConsolidationCategoryResult[]): Record<string, number> {
    return results.find((result) => result.category === "legacyReflectionCompatibility")?.metrics ?? {};
  }

  private collectLaggingSources(backlog: DreamOperationalReport["backlog"]): string[] {
    return [
      ...(backlog.iteration_lines_pending > 0 ? ["iteration"] : []),
      ...(backlog.event_lines_pending > 0 ? ["event"] : []),
      ...(backlog.importance_entries_pending > 0 ? ["importance"] : []),
    ];
  }

  private async persistReport(report: DreamReport): Promise<void> {
    const reportsDir = path.join(this.deps.baseDir, "dream", "reports");
    await fsp.mkdir(reportsDir, { recursive: true });
    const safeTimestamp = report.timestamp.replaceAll(":", "-");
    await writeJsonFileAtomic(path.join(reportsDir, `${safeTimestamp}.json`), report);
  }

  private async collectDreamSoilSyncMetrics(): Promise<Record<string, number>> {
    await this.collectDreamEventWorkflowMetrics();
    if (!this.deps.syncService) {
      return {
        soilSyncRecordsWritten: 0,
        soilSyncChunksWritten: 0,
        soilSyncTombstonesWritten: 0,
      };
    }
    let report;
    try {
      report = await this.deps.syncService.syncFromCurrentDreamState({ baseDir: this.deps.baseDir });
    } catch (error) {
      this.logger?.warn("Dream Soil sync failed", { error: error instanceof Error ? error.message : String(error) });
      return {
        soilSyncFailures: 1,
        soilSyncRecordsWritten: 0,
        soilSyncChunksWritten: 0,
        soilSyncTombstonesWritten: 0,
      };
    }
    return {
      soilSyncAgentMemoryEntries: report.agentMemoryEntries,
      soilSyncLearnedPatterns: report.learnedPatterns,
      soilSyncWorkflowRecords: report.workflowRecords,
      soilSyncPreviousRecords: report.previousRecords,
      soilSyncRecordsWritten: report.recordsWritten,
      soilSyncRecordsSuperseded: report.recordsSuperseded,
      soilSyncChunksWritten: report.chunksWritten,
      soilSyncTombstonesWritten: report.tombstonesWritten,
      soilSyncChangedSearchMaterial: report.recordsWithChangedSearchMaterial,
      soilSyncQueueReindexRecordIds: report.queueReindexRecordIds,
    };
  }

  private eventWorkflowMetricsPromise: Promise<Record<string, number>> | null = null;

  private async collectDreamEventWorkflowMetrics(): Promise<Record<string, number>> {
    this.eventWorkflowMetricsPromise ??= consolidateDreamEventWorkflows(this.deps.baseDir)
      .then((report) => ({
        eventWorkflowEventsScanned: report.eventsScanned,
        eventWorkflowMalformedEvents: report.malformedEvents,
        eventWorkflowCandidates: report.workflowCandidates,
        eventWorkflowRecordsWritten: report.workflowsWritten,
        eventWorkflowWatermarksAdvanced: report.eventWatermarksAdvanced,
      }))
      .catch((error) => {
        this.logger?.warn("Dream event workflow consolidation failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          eventWorkflowFailures: 1,
          eventWorkflowEventsScanned: 0,
          eventWorkflowCandidates: 0,
          eventWorkflowRecordsWritten: 0,
        };
      });
    return this.eventWorkflowMetricsPromise;
  }

}
