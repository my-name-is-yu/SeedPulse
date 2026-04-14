import { CronExpressionParser } from "cron-parser";
import * as path from "node:path";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { writeJsonFileAtomic, readJsonFileOrNull } from "../../base/utils/json-io.js";
import type { StateManager } from "../../base/state/state-manager.js";
import {
  ScheduleEntrySchema,
  ScheduleEntryListSchema,
  ScheduleResultSchema,
  type ScheduleFailureKind,
  type CronConfig,
  type EscalationConfig,
  type GoalTriggerConfig,
  type HeartbeatConfig,
  type ProbeConfig,
  type ScheduleEntry,
  type ScheduleEntryInput,
  type ScheduleRetryPolicy,
  type ScheduleRetryState,
  type ScheduleResult,
  type ScheduleTriggerInput,
} from "../types/schedule.js";
import {
  CronConfigSchema,
  GoalTriggerConfigSchema,
  HeartbeatConfigSchema,
  ProbeConfigSchema,
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
import { ExternalScheduleEntrySchema, type ExternalScheduleEntry, type IScheduleSource } from "./source.js";

const SCHEDULES_FILE = "schedules.json";
const DEFAULT_RETRY_POLICY: ScheduleRetryPolicy = {
  enabled: true,
  initial_delay_ms: 30_000,
  max_delay_ms: 15 * 60 * 1000,
  multiplier: 2,
  jitter_factor: 0.2,
  max_attempts: 3,
  max_retry_window_ms: 24 * 60 * 60 * 1000,
  retryable_failure_kinds: ["transient"],
};

interface DueEntryDescriptor {
  entry: ScheduleEntry;
  reason: ScheduleRunReason;
  scheduledFor: string | null;
}

export interface RunScheduleNowOptions {
  preserveEnabled?: boolean;
  allowEscalation?: boolean;
}

export interface RunScheduleNowResult {
  entry: ScheduleEntry | null;
  result: ScheduleResult;
  reason: ScheduleRunReason;
}

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

export type ScheduleEntryUpdateInput = Partial<{
  name: string;
  enabled: boolean;
  trigger: ScheduleTriggerInput;
  heartbeat: HeartbeatConfig;
  probe: ProbeConfig;
  cron: CronConfig;
  goal_trigger: GoalTriggerConfig;
  escalation: EscalationConfig | null;
  retry_policy: ScheduleRetryPolicy;
}>;

export class ScheduleEngine {
  private entries: ScheduleEntry[] = [];
  private baseDir: string;
  private schedulesPath: string;
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

  constructor(deps: ScheduleEngineDeps) {
    this.baseDir = deps.baseDir;
    this.schedulesPath = path.join(deps.baseDir, SCHEDULES_FILE);
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
  }

  // ─── Persistence ───

  async loadEntries(): Promise<ScheduleEntry[]> {
    const raw = await readJsonFileOrNull(this.schedulesPath);
    if (raw === null) {
      this.entries = [];
      return [];
    }
    const result = ScheduleEntryListSchema.safeParse(raw);
    this.entries = result.success ? result.data : [];
    await this.projectCurrentSchedulesToSoil();
    return this.entries;
  }

  async saveEntries(): Promise<void> {
    await writeJsonFileAtomic(this.schedulesPath, this.entries);
    await this.projectCurrentSchedulesToSoil();
  }

  async ensureSoilPublishSchedule(): Promise<ScheduleEntry | null> {
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
    return this.addEntry(buildSchedulePresetEntry({ preset: "soil_publish" }));
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
    const seenKeys = new Set<string>();
    const reconciledSourceIds = new Set<string>();
    const errors: Array<{ source_id: string; message: string }> = [];
    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (const source of sources) {
      try {
        const health = await source.healthCheck();
        if (!health.healthy) {
          errors.push({ source_id: source.id, message: health.error ?? "source is unhealthy" });
          continue;
        }

        const rawEntries = await source.fetchEntries();
        const sourceIdsFromFetchedEntries = new Set<string>([source.id]);
        let sourceHadEntryErrors = false;

        for (const raw of rawEntries) {
          const parsed = ExternalScheduleEntrySchema.safeParse(raw);
          if (!parsed.success) {
            sourceHadEntryErrors = true;
            skipped++;
            errors.push({ source_id: source.id, message: parsed.error.message });
            continue;
          }

          const external = parsed.data;
          sourceIdsFromFetchedEntries.add(external.source_id);
          const entryInput = this.buildExternalScheduleEntryInput(external);
          if (!entryInput) {
            sourceHadEntryErrors = true;
            skipped++;
            errors.push({ source_id: external.source_id, message: `missing ${external.layer} config for ${external.external_id}` });
            continue;
          }

          const key = this.externalEntryKey(external.source_id, external.external_id);
          seenKeys.add(key);
          const existingIndex = this.entries.findIndex((entry) =>
            entry.metadata?.source === "external" &&
            entry.metadata.external_source_id === external.source_id &&
            entry.metadata.external_id === external.external_id
          );

          if (existingIndex === -1) {
            this.entries.push(ScheduleEntrySchema.parse({
              ...entryInput,
              id: randomUUID(),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              last_fired_at: null,
              next_fire_at: this.computeNextFireAt(entryInput.trigger),
              consecutive_failures: 0,
              last_escalation_at: null,
              baseline_results: [],
              total_executions: 0,
              total_tokens_used: 0,
            }));
            added++;
            continue;
          }

          const existing = this.entries[existingIndex]!;
          const candidate = ScheduleEntrySchema.parse({
            ...existing,
            ...entryInput,
            id: existing.id,
            created_at: existing.created_at,
            updated_at: existing.updated_at,
            next_fire_at: JSON.stringify(existing.trigger) === JSON.stringify(entryInput.trigger)
              ? existing.next_fire_at
              : this.computeNextFireAt(entryInput.trigger),
          });
          if (JSON.stringify(existing) !== JSON.stringify(candidate)) {
            this.entries[existingIndex] = ScheduleEntrySchema.parse({
              ...candidate,
              updated_at: new Date().toISOString(),
            });
            updated++;
          }
        }

        if (!sourceHadEntryErrors) {
          for (const sourceId of sourceIdsFromFetchedEntries) {
            reconciledSourceIds.add(sourceId);
          }
        }
      } catch (error) {
        errors.push({ source_id: source.id, message: error instanceof Error ? error.message : String(error) });
      }
    }

    let disabled = 0;
    this.entries = this.entries.map((entry) => {
      if (
        entry.metadata?.source !== "external" ||
        !entry.enabled ||
        !entry.metadata.external_source_id ||
        !reconciledSourceIds.has(entry.metadata.external_source_id)
      ) {
        return entry;
      }

      const key = this.externalEntryKey(entry.metadata.external_source_id, entry.metadata.external_id ?? "");
      if (seenKeys.has(key)) {
        return entry;
      }

      disabled++;
      return ScheduleEntrySchema.parse({
        ...entry,
        enabled: false,
        updated_at: new Date().toISOString(),
      });
    });

    if (added > 0 || updated > 0 || disabled > 0) {
      await this.saveEntries();
    }

    return { added, updated, disabled, skipped, errors };
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
    const now = new Date().toISOString();
    const entry = ScheduleEntrySchema.parse({
      ...input,
      id: randomUUID(),
      created_at: now,
      updated_at: now,
      last_fired_at: null,
      next_fire_at: this.computeNextFireAt(input.trigger),
      consecutive_failures: 0,
      last_escalation_at: null,
      baseline_results: [],
      total_executions: 0,
      total_tokens_used: 0,
    });
    this.entries.push(entry);
    await this.saveEntries();
    return entry;
  }

  async removeEntry(id: string): Promise<boolean> {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length === before) return false;
    await this.saveEntries();
    return true;
  }

  async updateEntry(
    id: string,
    patch: ScheduleEntryUpdateInput
  ): Promise<ScheduleEntry | null> {
    const idx = this.entries.findIndex((entry) => entry.id === id);
    if (idx === -1) return null;

    const hasUpdatableFields =
      patch.name !== undefined ||
      patch.enabled !== undefined ||
      patch.trigger !== undefined ||
      patch.heartbeat !== undefined ||
      patch.probe !== undefined ||
      patch.cron !== undefined ||
      patch.goal_trigger !== undefined ||
      patch.escalation !== undefined ||
      patch.retry_policy !== undefined;

    if (!hasUpdatableFields) {
      throw new Error("No updatable fields provided");
    }

    const current = this.entries[idx]!;
    const layerConfigFields = [
      ["heartbeat", patch.heartbeat],
      ["probe", patch.probe],
      ["cron", patch.cron],
      ["goal_trigger", patch.goal_trigger],
    ] as const;

    for (const [field, value] of layerConfigFields) {
      if (value === undefined) continue;
      if (current.layer !== field) {
        throw new Error(`Cannot update ${field} config for ${current.layer} entry`);
      }
    }

    const nextEntry: ScheduleEntryInput = { ...current };

    if (patch.name !== undefined) nextEntry.name = patch.name;
    if (patch.enabled !== undefined) nextEntry.enabled = patch.enabled;
    if (patch.trigger !== undefined) nextEntry.trigger = patch.trigger;
    if (patch.heartbeat !== undefined) nextEntry.heartbeat = patch.heartbeat;
    if (patch.probe !== undefined) nextEntry.probe = patch.probe;
    if (patch.cron !== undefined) nextEntry.cron = patch.cron;
    if (patch.goal_trigger !== undefined) nextEntry.goal_trigger = patch.goal_trigger;
    if (patch.retry_policy !== undefined) nextEntry.retry_policy = patch.retry_policy;

    if (patch.escalation !== undefined) {
      if (patch.escalation === null) {
        delete nextEntry.escalation;
      } else {
        nextEntry.escalation = patch.escalation;
      }
    }

    if (patch.trigger !== undefined || (current.enabled === false && patch.enabled === true)) {
      nextEntry.next_fire_at = this.computeNextFireAt(nextEntry.trigger);
      nextEntry.retry_state = null;
    }

    nextEntry.updated_at = new Date().toISOString();

    const parsedEntry = ScheduleEntrySchema.parse(nextEntry);
    const previousEntries = this.entries;
    const nextEntries = [...this.entries];
    nextEntries[idx] = parsedEntry;
    this.entries = nextEntries;

    try {
      await this.saveEntries();
    } catch (error) {
      this.entries = previousEntries;
      throw error;
    }

    return parsedEntry;
  }

  // ─── Scheduling ───

  async getDueEntries(): Promise<ScheduleEntry[]> {
    return (await this.getDueEntryDescriptors()).map((descriptor) => descriptor.entry);
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
    const entry = this.entries.find((candidate) => candidate.id === entryId);
    if (!entry) {
      return null;
    }

    const scheduledFor = new Date().toISOString();
    const immediateEntry = {
      ...entry,
      enabled: true,
      next_fire_at: scheduledFor,
    };
    const executedResult = await this.executeEntry(immediateEntry);
    const applied = await this.applyExecutionOutcome(
      entry.id,
      executedResult,
      "manual_run",
      scheduledFor,
      { preserveEnabled: options.preserveEnabled ?? true }
    );

    let finalResult = executedResult;
    if (options.allowEscalation && applied?.entry) {
      const escalationResult = await this.checkEscalation(applied.entry, executedResult);
      if (escalationResult !== null) {
        finalResult = escalationResult;
      }
    }

    if (applied) {
      await this.saveEntries();
      await this.recordHistory({
        entry_id: applied.entry?.id ?? entry.id,
        entry_name: applied.entry?.name ?? entry.name,
        layer: entry.layer,
        result: {
          ...finalResult,
          failure_kind: applied.failureKind,
        },
        reason: "manual_run",
        attempt: applied.attempt,
        scheduled_for: scheduledFor,
        started_at: applied.startedAt,
        finished_at: applied.finishedAt,
        retry_at: applied.retryAt,
        failure_kind: applied.failureKind,
      });
    }

    return {
      entry: applied?.entry ?? null,
      result: finalResult,
      reason: "manual_run",
    };
  }

  private async getDueEntryDescriptors(): Promise<DueEntryDescriptor[]> {
    const now = Date.now();
    return this.entries.flatMap((entry) => {
      if (!entry.enabled) {
        return [] as DueEntryDescriptor[];
      }

      const retryState = entry.retry_state ?? null;
      if (retryState?.next_retry_at) {
        return new Date(retryState.next_retry_at).getTime() <= now
          ? ([{ entry, reason: "retry", scheduledFor: retryState.next_retry_at }] as DueEntryDescriptor[])
          : ([] as DueEntryDescriptor[]);
      }

      return new Date(entry.next_fire_at).getTime() <= now
        ? ([{ entry, reason: "cadence", scheduledFor: entry.next_fire_at }] as DueEntryDescriptor[])
        : ([] as DueEntryDescriptor[]);
    });
  }

  async tick(): Promise<ScheduleResult[]> {
    // Reset daily budget for entries whose budget_reset_at is null or in the past
    const nowMs = Date.now();
    let budgetReset = false;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      if (!e.budget_reset_at || new Date(e.budget_reset_at).getTime() <= nowMs) {
        this.entries[i] = {
          ...e,
          tokens_used_today: 0,
          budget_reset_at: new Date(nowMs + 24 * 60 * 60 * 1000).toISOString(),
        };
        budgetReset = true;
      }
    }

    if (budgetReset) {
      await this.saveEntries();
    }

    const due = await this.getDueEntryDescriptors();
    const results: ScheduleResult[] = [];

    for (const descriptor of due) {
      const executedResult = await this.executeEntry(descriptor.entry);
      const applied = await this.applyExecutionOutcome(
        descriptor.entry.id,
        executedResult,
        descriptor.reason,
        descriptor.scheduledFor
      );

      let finalResult = executedResult;
      if (applied?.entry) {
        const escalationResult = await this.checkEscalation(applied.entry, executedResult);
        if (escalationResult !== null) {
          finalResult = escalationResult;
        }
      }

      if (applied) {
        // Persist cadence/retry advancement before history side effects so a crash
        // cannot replay an already-fired entry from stale schedule state.
        await this.saveEntries();
        await this.recordHistory({
          entry_id: applied.entry?.id ?? descriptor.entry.id,
          entry_name: applied.entry?.name ?? descriptor.entry.name,
          layer: descriptor.entry.layer,
          result: {
            ...finalResult,
            failure_kind: applied.failureKind,
          },
          reason: descriptor.reason,
          attempt: applied.attempt,
          scheduled_for: descriptor.scheduledFor,
          started_at: applied.startedAt,
          finished_at: applied.finishedAt,
          retry_at: applied.retryAt,
          failure_kind: applied.failureKind,
        });
      }

      results.push(finalResult);
    }

    return results;
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

  private externalEntryKey(sourceId: string, externalId: string): string {
    return `${sourceId}:${externalId}`;
  }

  private buildExternalScheduleEntryInput(external: ExternalScheduleEntry): Omit<
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
  > | null {
    const base = {
      name: external.name,
      layer: external.layer,
      trigger: external.trigger.type === "cron"
        ? { type: "cron" as const, expression: external.trigger.expression!, timezone: "UTC" }
        : { type: "interval" as const, seconds: external.trigger.seconds!, jitter_factor: 0 },
      enabled: external.enabled,
      metadata: {
        source: "external" as const,
        external_source_id: external.source_id,
        external_id: external.external_id,
        dependency_hints: [],
        note: typeof external.metadata["note"] === "string" ? external.metadata["note"] : undefined,
      },
    };

    if (external.layer === "heartbeat") {
      const parsed = HeartbeatConfigSchema.safeParse(external.heartbeat ?? external.metadata["heartbeat"]);
      return parsed.success ? { ...base, heartbeat: parsed.data } : null;
    }
    if (external.layer === "probe") {
      const parsed = ProbeConfigSchema.safeParse(external.probe ?? external.metadata["probe"]);
      return parsed.success ? { ...base, probe: parsed.data } : null;
    }
    if (external.layer === "cron") {
      const parsed = CronConfigSchema.safeParse(external.cron ?? external.metadata["cron"]);
      return parsed.success ? { ...base, cron: parsed.data } : null;
    }

    const parsed = GoalTriggerConfigSchema.safeParse(external.goal_trigger ?? external.metadata["goal_trigger"]);
    return parsed.success ? { ...base, goal_trigger: parsed.data } : null;
  }

  private async executeEntry(entry: ScheduleEntry): Promise<ScheduleResult> {
    if (entry.layer === "heartbeat") {
      return this.executeHeartbeat(entry);
    }
    if (entry.layer === "probe") {
      return this.executeProbe(entry);
    }
    if (entry.layer === "cron") {
      return this.executeCron(entry);
    }
    if (entry.layer === "goal_trigger") {
      return this.executeGoalTrigger(entry);
    }

    this.logger.info(`Skipping unknown layer entry: ${entry.name} (layer=${entry.layer})`);
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "skipped",
      duration_ms: 0,
      fired_at: new Date().toISOString(),
    });
  }

  private normalizeRetryPolicy(entry: ScheduleEntry): ScheduleRetryPolicy {
    return {
      ...DEFAULT_RETRY_POLICY,
      ...(entry.retry_policy ?? {}),
    };
  }

  private classifyFailureKind(entry: ScheduleEntry, result: ScheduleResult): ScheduleFailureKind {
    if (result.failure_kind) {
      return result.failure_kind;
    }

    const message = `${result.error_message ?? ""}`.toLowerCase();
    const permanentHints = [
      "no cron config",
      "no heartbeat config",
      "no probe config",
      "no coreloop",
      "not found",
      "missing",
      "invalid",
      "unsupported",
      "cannot",
      "schema",
      "permission denied",
    ];
    if (permanentHints.some((hint) => message.includes(hint))) {
      return "permanent";
    }

    const transientHints = [
      "timeout",
      "timed out",
      "econnrefused",
      "econnreset",
      "etimedout",
      "eai_again",
      "enotfound",
      "network",
      "temporar",
      "unavailable",
      "rate limit",
      "busy",
      "abort",
    ];
    if (transientHints.some((hint) => message.includes(hint))) {
      return "transient";
    }

    return entry.layer === "goal_trigger" ? "permanent" : "transient";
  }

  private computeRetryDelay(policy: ScheduleRetryPolicy, attempt: number): number {
    const baseDelay = policy.initial_delay_ms * Math.pow(policy.multiplier, Math.max(0, attempt - 1));
    const cappedDelay = Math.min(baseDelay, policy.max_delay_ms);
    if (policy.jitter_factor <= 0) {
      return cappedDelay;
    }
    const jitter = cappedDelay * policy.jitter_factor * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(cappedDelay + jitter));
  }

  private async applyExecutionOutcome(
    entryId: string,
    result: ScheduleResult,
    _reason: ScheduleRunReason,
    scheduledFor: string | null,
    options: { preserveEnabled?: boolean } = {}
  ): Promise<{
    entry: ScheduleEntry | null;
    attempt: number;
    startedAt: string;
    finishedAt: string;
    retryAt: string | null;
    failureKind: ScheduleFailureKind;
  } | null> {
    const idx = this.entries.findIndex((candidate) => candidate.id === entryId);
    if (idx === -1) {
      return null;
    }

    const entry = this.entries[idx]!;
    const startedAt = scheduledFor ?? result.fired_at;
    const finishedAt = new Date().toISOString();
    const failureKind = this.classifyFailureKind(entry, result);
    const isFailure = result.status === "error" || result.status === "down";
    const retryPolicy = this.normalizeRetryPolicy(entry);
    const currentRetryState = entry.retry_state ?? null;
    let retryAt: string | null = null;
    let retryState: ScheduleRetryState | null = null;

    if (isFailure && retryPolicy.enabled && retryPolicy.retryable_failure_kinds.includes(failureKind)) {
      const attempts = (currentRetryState?.attempts ?? 0) + 1;
      const firstFailureAt = currentRetryState?.first_failure_at ?? result.fired_at;
      const windowElapsed = new Date(result.fired_at).getTime() - new Date(firstFailureAt).getTime();

      if (attempts <= retryPolicy.max_attempts && windowElapsed <= retryPolicy.max_retry_window_ms) {
        retryAt = new Date(Date.now() + this.computeRetryDelay(retryPolicy, attempts)).toISOString();
        retryState = {
          attempts,
          next_retry_at: retryAt,
          last_attempt_at: result.fired_at,
          first_failure_at: firstFailureAt,
          last_failure_kind: failureKind,
          last_error_message: result.error_message ?? null,
        };
      }
    }

    this.entries[idx] = {
      ...entry,
      enabled: options.preserveEnabled ? entry.enabled : true,
      last_fired_at: result.fired_at,
      next_fire_at: this.computeNextFireAt(entry.trigger),
      updated_at: new Date().toISOString(),
      total_executions: entry.total_executions + 1,
      total_tokens_used: entry.total_tokens_used + (result.tokens_used ?? 0),
      tokens_used_today: (entry.tokens_used_today ?? 0) + (result.tokens_used ?? 0),
      consecutive_failures: isFailure ? entry.consecutive_failures + 1 : 0,
      retry_state: retryState,
    };

    const updated = this.entries[idx]!;

    if (
      updated.escalation?.circuit_breaker_threshold &&
      updated.consecutive_failures >= updated.escalation.circuit_breaker_threshold
    ) {
      updated.enabled = false;
      this.logger.warn(
        `Entry "${updated.name}" disabled by circuit breaker (${updated.consecutive_failures}/${updated.escalation.circuit_breaker_threshold})`
      );
    }

    if (
      result.status === "down" &&
      updated.heartbeat &&
      updated.consecutive_failures >= updated.heartbeat.failure_threshold
    ) {
      this.logger.warn(
        `Entry "${updated.name}" reached failure threshold (${updated.consecutive_failures}/${updated.heartbeat.failure_threshold})`
      );
      if (updated.consecutive_failures === updated.heartbeat.failure_threshold) {
        await this.dispatchNotification({
          report_type: "schedule_heartbeat_failure",
          entry_id: updated.id,
          entry_name: updated.name,
          failure_threshold: updated.heartbeat.failure_threshold,
          consecutive_failures: updated.consecutive_failures,
          layer: updated.layer,
        });
      }
    }

    return {
      entry: updated,
      attempt: retryState?.attempts ?? 0,
      startedAt,
      finishedAt,
      retryAt,
      failureKind,
    };
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
    failure_kind: ScheduleFailureKind;
  }): Promise<void> {
    await this.historyStore.append({
      entry_id: input.entry_id,
      entry_name: input.entry_name,
      layer: input.layer,
      result: {
        ...input.result,
        failure_kind: input.failure_kind,
      },
      reason: input.reason,
      attempt: input.attempt,
      scheduled_for: input.scheduled_for,
      started_at: input.started_at,
      finished_at: input.finished_at,
      retry_at: input.retry_at,
      failure_kind: input.failure_kind,
    });
  }

  private async executeEscalationTargetEntry(targetEntryId: string): Promise<ScheduleResult | null> {
    const targetEntry = this.entries.find((candidate) => candidate.id === targetEntryId);
    if (!targetEntry) {
      this.logger.warn(`Escalation target entry not found: ${targetEntryId}`);
      return null;
    }

    const immediateEntry = {
      ...targetEntry,
      enabled: true,
      next_fire_at: new Date().toISOString(),
    };
    const result = await this.executeEntry(immediateEntry);
    const applied = await this.applyExecutionOutcome(
      targetEntryId,
      result,
      "escalation_target",
      immediateEntry.next_fire_at
    );
    if (applied) {
      await this.saveEntries();
      await this.recordHistory({
        entry_id: targetEntry.id,
        entry_name: targetEntry.name,
        layer: targetEntry.layer,
        result: {
          ...result,
          failure_kind: applied.failureKind,
        },
        reason: "escalation_target",
        attempt: applied.attempt,
        scheduled_for: immediateEntry.next_fire_at,
        started_at: applied.startedAt,
        finished_at: applied.finishedAt,
        retry_at: applied.retryAt,
        failure_kind: applied.failureKind,
      });
    }
    return result;
  }

  private async executeEscalationTargetGoal(goalId: string): Promise<ScheduleResult> {
    const now = new Date().toISOString();
    if (!this.coreLoop) {
      return ScheduleResultSchema.parse({
        entry_id: randomUUID(),
        status: "error",
        duration_ms: 0,
        fired_at: now,
        goal_id: goalId,
        error_message: "No coreLoop provided for escalation target goal",
        failure_kind: "permanent",
      });
    }

    const startedAt = Date.now();
    try {
      const result = await this.coreLoop.run(goalId);
      return ScheduleResultSchema.parse({
        entry_id: randomUUID(),
        status: "ok",
        duration_ms: Date.now() - startedAt,
        fired_at: now,
        goal_id: goalId,
        tokens_used: result?.tokensUsed ?? 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Escalation target goal "${goalId}" failed: ${message}`);
      return ScheduleResultSchema.parse({
        entry_id: randomUUID(),
        status: "error",
        duration_ms: Date.now() - startedAt,
        fired_at: now,
        goal_id: goalId,
        error_message: message,
        failure_kind: "transient",
      });
    }
  }

    // ─── Escalation logic ───

  private async checkEscalation(
    entry: ScheduleEntry,
    result: ScheduleResult
  ): Promise<ScheduleResult | null> {
    const esc = entry.escalation;
    if (!esc?.enabled) return null;

    const isFailure = result.status === "error" || result.status === "down";
    if (!isFailure) return null;

    const now = Date.now();

    // Check cooldown
    if (entry.last_escalation_at) {
      const lastEsc = new Date(entry.last_escalation_at).getTime();
      if (now - lastEsc < esc.cooldown_minutes * 60 * 1000) {
        this.logger.info(`Escalation for "${entry.name}" suppressed (cooldown)`);
        return null;
      }
    }

    // Rolling-window rate-limit: check escalation_timestamps within the last hour
    const hourAgo = now - 60 * 60 * 1000;
    const recentTimestamps = (entry.escalation_timestamps ?? []).filter(
      (ts) => new Date(ts).getTime() > hourAgo
    );
    if (recentTimestamps.length >= esc.max_per_hour) {
      this.logger.info(`Escalation for "${entry.name}" suppressed (max_per_hour=${esc.max_per_hour} reached)`);
      return null;
    }

    // Update last_escalation_at and rolling-window escalation_timestamps
    const nowIso = new Date(now).toISOString();
    const hourAgoForPrune = now - 60 * 60 * 1000;
    const idx = this.entries.findIndex((e) => e.id === entry.id);
    if (idx !== -1) {
      const prunedTimestamps = [
        ...(this.entries[idx].escalation_timestamps ?? []).filter(
          (ts) => new Date(ts).getTime() > hourAgoForPrune
        ),
        nowIso,
      ];
      this.entries[idx] = {
        ...this.entries[idx],
        last_escalation_at: nowIso,
        escalation_timestamps: prunedTimestamps,
      };
      await this.saveEntries();
    }

    // Dispatch escalation notification
    await this.dispatchNotification({
      report_type: "schedule_escalation",
      entry_id: entry.id,
      entry_name: entry.name,
      target_layer: esc.target_layer,
      target_entry_id: esc.target_entry_id,
      target_goal_id: esc.target_goal_id,
      consecutive_failures: entry.consecutive_failures,
    });

    this.logger.warn(
      `Escalating "${entry.name}" to ${esc.target_layer ?? "unknown"} (failures=${entry.consecutive_failures})`
    );

    // Execute target goal or target entry immediately so escalations take effect in the same tick.
    if (esc.target_goal_id) {
      await this.executeEscalationTargetGoal(esc.target_goal_id);
    }

    if (esc.target_entry_id) {
      await this.executeEscalationTargetEntry(esc.target_entry_id);
    }

    return ScheduleResultSchema.parse({
      ...result,
      status: "escalated",
      escalated_to: esc.target_goal_id ?? esc.target_entry_id ?? esc.target_layer ?? null,
    });
  }

  // ─── Notification dispatch ───

  private async dispatchNotification(payload: Record<string, unknown>): Promise<void> {
    if (!this.notificationDispatcher) return;
    try {
      await this.notificationDispatcher.dispatch(payload);
    } catch (err) {
      this.logger.warn(`Notification dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Heartbeat execution (Phase 1) ───

  private async executeHeartbeat(entry: ScheduleEntry): Promise<ScheduleResult> {
    const firedAt = new Date().toISOString();
    const start = Date.now();
    const cfg = entry.heartbeat;

    if (!cfg) {
      return ScheduleResultSchema.parse({
        entry_id: entry.id,
        status: "error",
        duration_ms: 0,
        error_message: "No heartbeat config",
        fired_at: firedAt,
        failure_kind: "permanent",
      });
    }

    try {
      const timeoutMs = cfg.timeout_ms;
      const config = cfg.check_config as Record<string, unknown>;

      switch (cfg.check_type) {
        case "http":
          await this.checkHttp(config.url as string, timeoutMs);
          break;
        case "tcp":
          await this.checkTcp(
            config.host as string,
            config.port as number,
            timeoutMs
          );
          break;
        case "process":
          this.checkProcess(config.pid as number);
          break;
        case "disk":
          await this.checkDisk(config.path as string);
          break;
        case "custom":
          await this.checkCustom(config.command as string, timeoutMs);
          break;
      }

      return ScheduleResultSchema.parse({
        entry_id: entry.id,
        status: "ok",
        duration_ms: Date.now() - start,
        fired_at: firedAt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Heartbeat "${entry.name}" failed: ${msg}`);
      return ScheduleResultSchema.parse({
        entry_id: entry.id,
        status: "down",
        duration_ms: Date.now() - start,
        error_message: msg,
        fired_at: firedAt,
        failure_kind: "transient",
      });
    }
  }

  // ─── Check implementations ───

  private async checkHttp(url: string, timeoutMs: number): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private checkTcp(host: string, port: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => {
        socket.destroy();
        resolve();
      });
      socket.setTimeout(timeoutMs);
      socket.on("timeout", () => {
        socket.destroy();
        reject(new Error(`TCP timeout after ${timeoutMs}ms`));
      });
      socket.on("error", (err) => {
        socket.destroy();
        reject(err);
      });
    });
  }

  private checkProcess(pid: number): void {
    process.kill(pid, 0); // throws if process doesn't exist
  }

  private checkCustom(command: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      exec(command, { timeout: timeoutMs }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async checkDisk(diskPath: string): Promise<void> {
    const { statfs } = await import("node:fs/promises");
    await statfs(diskPath); // throws if path doesn't exist
  }

  // ─── Schedule computation ───

  private computeNextFireAt(trigger: ScheduleTriggerInput): string {
    if (trigger.type === "cron") {
      const next = CronExpressionParser.parse(trigger.expression, { tz: trigger.timezone || "UTC" }).next();
      return next.toISOString() ?? new Date().toISOString();
    }
    let nextTime = new Date(Date.now() + trigger.seconds * 1000);
    if (trigger.jitter_factor && trigger.jitter_factor > 0) {
      const jitterMs = trigger.seconds * 1000 * trigger.jitter_factor * (Math.random() * 2 - 1);
      nextTime = new Date(nextTime.getTime() + jitterMs);
    }
    // Clamp to at least now + 1s to avoid past-scheduling from negative jitter
    const minTime = Date.now() + 1000;
    if (nextTime.getTime() < minTime) {
      nextTime = new Date(minTime);
    }
    return nextTime.toISOString();
  }
}
