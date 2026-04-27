import * as path from "node:path";
import type { StateManager } from "../../base/state/state-manager.js";
import {
  type ScheduleFailureKind,
  type ScheduleEntry,
  type ScheduleEntryInput,
  type ScheduleResult,
} from "../types/schedule.js";
import { executeCron, executeGoalTrigger, executeProbe } from "./engine-layers.js";
import {
  ScheduleHistoryStore,
  type ScheduleRunHistoryRecord,
  type ScheduleRunReason,
} from "./history.js";
import type { IDataSourceAdapter } from "../../platform/observation/data-source-adapter.js";
import type { DataSourceRegistry } from "../../platform/observation/data-source-adapter.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { HookManager } from "../hook-manager.js";
import type { MemoryLifecycleManager } from "../../platform/knowledge/memory/memory-lifecycle.js";
import type { KnowledgeManager } from "../../platform/knowledge/knowledge-manager.js";
import { projectSchedulesToSoil, rebuildSoilIndex } from "../../platform/soil/index.js";
import { hasConfiguredSoilPublishProvider } from "../../platform/soil/publish/index.js";
import { buildSchedulePresetEntry } from "./presets.js";
import type { IScheduleSource } from "./source.js";
import { ScheduleEntryStore } from "./entry-store.js";
import {
  addEntryForEngine,
  addEntryInMemory,
  removeEntryForEngine,
  syncExternalSourcesForEngine,
  type ScheduleEntryUpdateInput,
  updateEntryForEngine,
} from "./engine-mutations.js";
import {
  checkEscalationForEngine,
  executeEntryForEngine,
  executeEscalationTargetEntryForEngine,
  executeEscalationTargetGoalForEngine,
  getDueEntriesFromEngine,
  runEntryNowForEngine,
  tickEngine,
  type RunScheduleNowOptions,
  type RunScheduleNowResult,
} from "./engine-execution.js";

export type { ScheduleEntryUpdateInput } from "./engine-mutations.js";
export type { RunScheduleNowOptions, RunScheduleNowResult } from "./engine-execution.js";

interface ScheduleEngineDeps {
  baseDir: string;
  logger?: {
    info: (message: string, context?: Record<string, unknown>) => void;
    warn: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
  dataSourceRegistry?: Map<string, IDataSourceAdapter> | DataSourceRegistry;
  llmClient?: ILLMClient;
  // Intentionally loose: schedule notifications are lightweight payloads and do not go through
  // the full Report pipeline (which requires Report schema fields like id, goal_id, generated_at).
  // Using Record<string,unknown> here allows ScheduleEngine to dispatch without constructing
  // a full Report object. Full Report integration deferred to Phase 4.
  notificationDispatcher?: { dispatch(report: Record<string, unknown>): Promise<any> };
  coreLoop?: { run(goalId: string, options?: { maxIterations?: number }): Promise<any> };
  stateManager?: StateManager;
  reportingEngine?: { generateNotification(type: string, context: Record<string, unknown>): Promise<any> };
  hookManager?: HookManager;
  memoryLifecycle?: MemoryLifecycleManager;
  knowledgeManager?: KnowledgeManager;
}

const noopLogger = {
  info: (_msg: string, _ctx?: Record<string, unknown>) => {},
  warn: (_msg: string, _ctx?: Record<string, unknown>) => {},
  error: (_msg: string, _ctx?: Record<string, unknown>) => {},
};

export class ScheduleEngine {
  private entries: ScheduleEntry[] = [];
  private baseDir: string;
  private logger: NonNullable<ScheduleEngineDeps["logger"]>;
  private dataSourceRegistry?: Map<string, IDataSourceAdapter> | DataSourceRegistry;
  private llmClient?: ILLMClient;
  private notificationDispatcher?: { dispatch(report: Record<string, unknown>): Promise<any> };
  private coreLoop?: { run(goalId: string, options?: { maxIterations?: number }): Promise<any> };
  private stateManager?: StateManager;
  private reportingEngine?: { generateNotification(type: string, context: Record<string, unknown>): Promise<any> };
  private hookManager?: HookManager;
  private memoryLifecycle?: MemoryLifecycleManager;
  private knowledgeManager?: KnowledgeManager;
  private historyStore: ScheduleHistoryStore;
  private readonly entryStore: ScheduleEntryStore;

  constructor(deps: ScheduleEngineDeps) {
    this.baseDir = deps.baseDir;
    this.logger = deps.logger ?? noopLogger;
    this.dataSourceRegistry = deps.dataSourceRegistry;
    this.llmClient = deps.llmClient;
    this.notificationDispatcher = deps.notificationDispatcher;
    this.coreLoop = deps.coreLoop;
    this.stateManager = deps.stateManager;
    this.reportingEngine = deps.reportingEngine;
    this.hookManager = deps.hookManager;
    this.memoryLifecycle = deps.memoryLifecycle;
    this.knowledgeManager = deps.knowledgeManager;
    this.historyStore = new ScheduleHistoryStore(this.baseDir);
    this.entryStore = new ScheduleEntryStore(this.baseDir, this.logger, async (entries) => {
      this.entries = entries;
      await this.projectCurrentSchedulesToSoil();
    });
  }

  // ─── Persistence ───

  async loadEntries(): Promise<ScheduleEntry[]> {
    this.entries = await this.readEntriesFromDisk();
    await this.projectCurrentSchedulesToSoil();
    return this.entries;
  }

  private async readEntriesFromDisk(): Promise<ScheduleEntry[]> {
    return this.entryStore.readEntries();
  }

  async saveEntries(): Promise<void> {
    await this.entryStore.saveEntries(this.entries);
  }

  private async writeEntriesAndProject(): Promise<void> {
    await this.entryStore.saveEntries(this.entries);
  }

  private async refreshEntriesForMutation(): Promise<void> {
    this.entries = await this.readEntriesFromDisk();
  }

  private captureExecutionSideEffects(entryId: string): Pick<ScheduleEntry, "baseline_results"> | null {
    const entry = this.entries.find((candidate) => candidate.id === entryId);
    return entry ? { baseline_results: entry.baseline_results } : null;
  }

  private applyExecutionSideEffects(
    entryId: string,
    sideEffects: Pick<ScheduleEntry, "baseline_results"> | null
  ): void {
    if (!sideEffects) return;
    const idx = this.entries.findIndex((candidate) => candidate.id === entryId);
    if (idx === -1) return;
    this.entries[idx] = {
      ...this.entries[idx]!,
      baseline_results: sideEffects.baseline_results,
    };
  }

  private async withScheduleMutation<T>(mutate: () => Promise<T>): Promise<T> {
    return this.withScheduleFileLock(async () => {
      const previousEntries = this.entries;
      await this.refreshEntriesForMutation();
      try {
        const result = await mutate();
        await this.saveEntries();
        return result;
      } catch (error) {
        this.entries = previousEntries;
        throw error;
      }
    });
  }

  private async withScheduleFileLock<T>(work: () => Promise<T>): Promise<T> {
    return this.entryStore.withLock(work);
  }

  async ensureSoilPublishSchedule(): Promise<ScheduleEntry | null> {
    return this.withScheduleMutation(async () => {
      const configured = await hasConfiguredSoilPublishProvider({ baseDir: this.baseDir });
      if (!configured) {
        return null;
      }
      const existing = this.entries.find((entry) =>
        entry.layer === "cron" &&
        (entry.cron?.job_kind === "soil_publish" || entry.metadata?.preset_key === "soil_publish")
      );
      if (existing) {
        return existing;
      }
      return this.addEntryInMemory(buildSchedulePresetEntry({ preset: "soil_publish" }));
    });
  }

  private async projectCurrentSchedulesToSoil(): Promise<void> {
    try {
      await projectSchedulesToSoil({ entries: this.entries, baseDir: this.baseDir });
      await rebuildSoilIndex({ rootDir: path.join(this.baseDir, "soil") });
    } catch (error) {
      this.logger.warn("Failed to project schedules into Soil", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getEntries(): ScheduleEntry[] {
    return this.entries;
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  async syncExternalSources(sources: IScheduleSource[]): Promise<{
    added: number;
    updated: number;
    disabled: number;
    skipped: number;
    errors: Array<{ source_id: string; message: string }>;
  }> {
    return syncExternalSourcesForEngine(this.mutationHost(), sources);
  }

  // ─── Entry management ───

  async addEntry(
    input: Omit<
      ScheduleEntryInput,
      | "id"
      | "created_at"
      | "updated_at"
      | "last_fired_at"
      | "next_fire_at"
      | "consecutive_failures"
      | "last_escalation_at"
      | "baseline_results"
      | "total_executions"
      | "total_tokens_used"
      | "max_tokens_per_day"
      | "tokens_used_today"
      | "budget_reset_at"
      | "escalation_timestamps"
    >
  ): Promise<ScheduleEntry> {
    return addEntryForEngine(this.mutationHost(), input);
  }

  private addEntryInMemory(
    input: Omit<
      ScheduleEntryInput,
      | "id"
      | "created_at"
      | "updated_at"
      | "last_fired_at"
      | "next_fire_at"
      | "consecutive_failures"
      | "last_escalation_at"
      | "baseline_results"
      | "total_executions"
      | "total_tokens_used"
      | "max_tokens_per_day"
      | "tokens_used_today"
      | "budget_reset_at"
      | "escalation_timestamps"
    >
  ): ScheduleEntry {
    return addEntryInMemory(this.mutationHost(), input);
  }

  async removeEntry(id: string): Promise<boolean> {
    return removeEntryForEngine(this.mutationHost(), id);
  }

  async updateEntry(
    id: string,
    patch: ScheduleEntryUpdateInput
  ): Promise<ScheduleEntry | null> {
    return updateEntryForEngine(this.mutationHost(), id, patch);
  }

  // ─── Scheduling ───

  async getDueEntries(): Promise<ScheduleEntry[]> {
    return getDueEntriesFromEngine(this.entries);
  }

  async getRecentHistory(limit = 20, entryId?: string): Promise<ScheduleRunHistoryRecord[]> {
    const history = await this.historyStore.load();
    const filtered = entryId ? history.filter((record) => record.entry_id === entryId) : history;
    return filtered.slice(-limit);
  }

  async runEntryNow(
    entryId: string,
    options: RunScheduleNowOptions = {}
  ): Promise<RunScheduleNowResult | null> {
    return runEntryNowForEngine(this.executionHost(), entryId, options);
  }

  async tick(): Promise<ScheduleResult[]> {
    return tickEngine(this.executionHost());
  }

  // ─── Probe execution (Phase 2) ───

  async executeProbe(entry: ScheduleEntry): Promise<ScheduleResult> {
    return executeProbe(entry, {
      ...this.layerDeps(),
      updateBaseline: (entryId, value, windowSize) => {
        const idx = this.entries.findIndex((e) => e.id === entryId);
        if (idx !== -1) {
          const updated = [...this.entries[idx].baseline_results, value];
          this.entries[idx] = {
            ...this.entries[idx],
            baseline_results: updated.slice(-windowSize),
          };
        }
      },
    });
  }

  // ─── Cron execution (Phase 3) ───

  async executeCron(entry: ScheduleEntry): Promise<ScheduleResult> {
    return executeCron(entry, this.layerDeps());
  }

  // ─── GoalTrigger execution (Phase 3) ───

  async executeGoalTrigger(entry: ScheduleEntry): Promise<ScheduleResult> {
    return executeGoalTrigger(entry, this.layerDeps());
  }

  private layerDeps() {
    return {
      baseDir: this.baseDir,
      dataSourceRegistry: this.dataSourceRegistry,
      llmClient: this.llmClient,
      notificationDispatcher: this.notificationDispatcher,
      coreLoop: this.coreLoop,
      stateManager: this.stateManager,
      reportingEngine: this.reportingEngine,
      hookManager: this.hookManager,
      memoryLifecycle: this.memoryLifecycle,
      knowledgeManager: this.knowledgeManager,
      logger: this.logger,
    };
  }

  private async executeEntry(entry: ScheduleEntry): Promise<ScheduleResult> {
    return executeEntryForEngine(this.executionHost(), entry);
  }

  private async recordHistory(input: {
    entry_id: string;
    entry_name: string;
    layer: ScheduleEntry["layer"];
    result: ScheduleResult;
    reason: ScheduleRunReason;
    attempt: number;
    scheduled_for: string | null;
    started_at: string;
    finished_at: string;
    retry_at: string | null;
    failure_kind: ScheduleFailureKind | null;
  }): Promise<void> {
    await this.historyStore.append({
      entry_id: input.entry_id,
      entry_name: input.entry_name,
      layer: input.layer,
      result: {
        ...input.result,
        failure_kind: input.failure_kind ?? input.result.failure_kind ?? undefined,
      },
      reason: input.reason,
      attempt: input.attempt,
      scheduled_for: input.scheduled_for,
      started_at: input.started_at,
      finished_at: input.finished_at,
      retry_at: input.retry_at,
      failure_kind: input.failure_kind ?? input.result.failure_kind,
    });
  }

  private async executeEscalationTargetEntry(targetEntryId: string): Promise<ScheduleResult | null> {
    return executeEscalationTargetEntryForEngine(this.executionHost(), targetEntryId);
  }

  private async executeEscalationTargetGoal(goalId: string): Promise<ScheduleResult> {
    return executeEscalationTargetGoalForEngine({ logger: this.logger, coreLoop: this.coreLoop }, goalId);
  }

    // ─── Escalation logic ───

  private async checkEscalation(
    entry: ScheduleEntry,
    result: ScheduleResult
  ): Promise<ScheduleResult | null> {
    return checkEscalationForEngine(this.executionHost(), entry, result);
  }

  private async dispatchNotification(payload: Record<string, unknown>): Promise<void> {
    if (!this.notificationDispatcher) return;
    try {
      await this.notificationDispatcher.dispatch(payload);
    } catch (err) {
      this.logger.warn(`Notification dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private mutationHost() {
    const thisEngine = this;
    return {
      get entries() {
        return thisEngine.entries;
      },
      set entries(value: ScheduleEntry[]) {
        thisEngine.entries = value;
      },
      saveEntries: () => this.saveEntries(),
      refreshEntriesForMutation: () => this.refreshEntriesForMutation(),
      withScheduleMutation: <T>(mutate: () => Promise<T>) => this.withScheduleMutation(mutate),
    };
  }

  private executionHost() {
    const thisEngine = this;
    return {
      get entries() {
        return thisEngine.entries;
      },
      set entries(value: ScheduleEntry[]) {
        thisEngine.entries = value;
      },
      logger: this.logger,
      withScheduleFileLock: <T>(work: () => Promise<T>) => this.withScheduleFileLock(work),
      refreshEntriesForMutation: () => this.refreshEntriesForMutation(),
      writeEntriesAndProject: () => this.writeEntriesAndProject(),
      captureExecutionSideEffects: (entryId: string) => this.captureExecutionSideEffects(entryId),
      applyExecutionSideEffects: (entryId: string, sideEffects: Pick<ScheduleEntry, "baseline_results"> | null) =>
        this.applyExecutionSideEffects(entryId, sideEffects),
      recordHistory: (record: {
        entry_id: string;
        entry_name: string;
        layer: ScheduleEntry["layer"];
        result: ScheduleResult;
        reason: ScheduleRunReason;
        attempt?: number;
        scheduled_for?: string | null;
        started_at: string;
        finished_at: string;
        retry_at?: string | null;
        failure_kind?: ScheduleFailureKind | null;
      }) => this.recordHistory({
        ...record,
        attempt: record.attempt ?? 0,
        scheduled_for: record.scheduled_for ?? null,
        retry_at: record.retry_at ?? null,
        failure_kind: record.failure_kind ?? null,
      }),
      executeEntry: (entry: ScheduleEntry) => this.executeEntry(entry),
      executeProbe: (entry: ScheduleEntry) => this.executeProbe(entry),
      executeCron: (entry: ScheduleEntry) => this.executeCron(entry),
      executeGoalTrigger: (entry: ScheduleEntry) => this.executeGoalTrigger(entry),
      checkEscalation: (entry: ScheduleEntry, result: ScheduleResult) => this.checkEscalation(entry, result),
      executeEscalationTargetGoal: (goalId: string) => this.executeEscalationTargetGoal(goalId),
      executeEscalationTargetEntry: (entryId: string) => this.executeEscalationTargetEntry(entryId),
      dispatchNotification: (payload: Record<string, unknown>) => this.dispatchNotification(payload),
    };
  }
}
