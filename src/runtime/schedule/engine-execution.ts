import { randomUUID } from "node:crypto";
import {
  ScheduleResultSchema,
  type ScheduleEntry,
  type ScheduleFailureKind,
  type ScheduleRetryPolicy,
  type ScheduleRetryState,
  type ScheduleResult,
} from "../types/schedule.js";
import type { ScheduleRunHistoryInput, ScheduleRunReason } from "./history.js";
import { executeHeartbeatEntry } from "./engine-heartbeat.js";
import { computeNextFireAt } from "./engine-mutations.js";

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

export interface ScheduleExecutionHost {
  entries: ScheduleEntry[];
  logger: {
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
    error(message: string, context?: Record<string, unknown>): void;
  };
  withScheduleFileLock<T>(work: () => Promise<T>): Promise<T>;
  refreshEntriesForMutation(): Promise<void>;
  writeEntriesAndProject(): Promise<void>;
  captureExecutionSideEffects(entryId: string): Pick<ScheduleEntry, "baseline_results"> | null;
  applyExecutionSideEffects(entryId: string, sideEffects: Pick<ScheduleEntry, "baseline_results"> | null): void;
  recordHistory(record: ScheduleRunHistoryInput): Promise<void>;
  executeEntry(entry: ScheduleEntry): Promise<ScheduleResult>;
  executeProbe(entry: ScheduleEntry): Promise<ScheduleResult>;
  executeCron(entry: ScheduleEntry): Promise<ScheduleResult>;
  executeGoalTrigger(entry: ScheduleEntry): Promise<ScheduleResult>;
  checkEscalation(entry: ScheduleEntry, result: ScheduleResult): Promise<ScheduleResult | null>;
  executeEscalationTargetGoal(goalId: string): Promise<ScheduleResult>;
  executeEscalationTargetEntry(entryId: string): Promise<ScheduleResult | null>;
  dispatchNotification(payload: Record<string, unknown>): Promise<void>;
}

export function getDueEntriesFromEngine(entries: ScheduleEntry[]): ScheduleEntry[] {
  return getDueEntryDescriptors(entries).map((descriptor) => descriptor.entry);
}

export async function runEntryNowForEngine(
  host: ScheduleExecutionHost,
  entryId: string,
  options: RunScheduleNowOptions = {}
): Promise<RunScheduleNowResult | null> {
  const entry = await host.withScheduleFileLock(async () => {
    await host.refreshEntriesForMutation();
    return host.entries.find((candidate) => candidate.id === entryId) ?? null;
  });
  if (!entry) return null;

  const scheduledFor = new Date().toISOString();
  const immediateEntry = { ...entry, enabled: true, next_fire_at: scheduledFor };
  const executedResult = await host.executeEntry(immediateEntry);
  const sideEffects = entry.layer === "probe" ? host.captureExecutionSideEffects(entry.id) : null;
  const applied = await host.withScheduleFileLock(async () => {
    await host.refreshEntriesForMutation();
    const outcome = await applyExecutionOutcome(host, entry.id, executedResult, scheduledFor, {
      preserveEnabled: options.preserveEnabled ?? true,
    });
    if (outcome) {
      host.applyExecutionSideEffects(entry.id, sideEffects);
      await host.writeEntriesAndProject();
    }
    return outcome;
  });

  let finalResult = executedResult;
  if (options.allowEscalation && applied?.entry) {
    const escalationResult = await host.checkEscalation(applied.entry, executedResult);
    if (escalationResult !== null) finalResult = escalationResult;
  }

  if (applied) {
    await host.recordHistory({
      entry_id: applied.entry?.id ?? entry.id,
      entry_name: applied.entry?.name ?? entry.name,
      layer: entry.layer,
      result: { ...finalResult, failure_kind: applied.failureKind },
      reason: "manual_run",
      attempt: applied.attempt,
      scheduled_for: scheduledFor,
      started_at: applied.startedAt,
      finished_at: applied.finishedAt,
      retry_at: applied.retryAt,
      failure_kind: applied.failureKind,
    });
  }

  return { entry: applied?.entry ?? null, result: finalResult, reason: "manual_run" };
}

export async function tickEngine(host: ScheduleExecutionHost): Promise<ScheduleResult[]> {
  const due = await host.withScheduleFileLock(async () => {
    await host.refreshEntriesForMutation();
    const nowMs = Date.now();
    let budgetReset = false;
    for (let i = 0; i < host.entries.length; i++) {
      const e = host.entries[i]!;
      if (!e.budget_reset_at || new Date(e.budget_reset_at).getTime() <= nowMs) {
        host.entries[i] = {
          ...e,
          tokens_used_today: 0,
          budget_reset_at: new Date(nowMs + 24 * 60 * 60 * 1000).toISOString(),
        };
        budgetReset = true;
      }
    }
    if (budgetReset) {
      await host.writeEntriesAndProject();
    }
    return getDueEntryDescriptors(host.entries);
  });

  const results: ScheduleResult[] = [];
  for (const descriptor of due) {
    const executedResult = await host.executeEntry(descriptor.entry);
    const sideEffects = descriptor.entry.layer === "probe"
      ? host.captureExecutionSideEffects(descriptor.entry.id)
      : null;
    const applied = await host.withScheduleFileLock(async () => {
      await host.refreshEntriesForMutation();
      const outcome = await applyExecutionOutcome(host, descriptor.entry.id, executedResult, descriptor.scheduledFor);
      if (outcome) {
        host.applyExecutionSideEffects(descriptor.entry.id, sideEffects);
        await host.writeEntriesAndProject();
      }
      return outcome;
    });

    let finalResult = executedResult;
    if (applied?.entry) {
      const escalationResult = await host.checkEscalation(applied.entry, executedResult);
      if (escalationResult !== null) finalResult = escalationResult;
    }

    if (applied) {
      await host.recordHistory({
        entry_id: applied.entry?.id ?? descriptor.entry.id,
        entry_name: applied.entry?.name ?? descriptor.entry.name,
        layer: descriptor.entry.layer,
        result: { ...finalResult, failure_kind: applied.failureKind },
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

export async function executeEntryForEngine(host: ScheduleExecutionHost, entry: ScheduleEntry): Promise<ScheduleResult> {
  if (entry.layer === "heartbeat") return executeHeartbeatEntry(entry, host.logger);
  if (entry.layer === "probe") return host.executeProbe(entry);
  if (entry.layer === "cron") return host.executeCron(entry);
  if (entry.layer === "goal_trigger") return host.executeGoalTrigger(entry);

  host.logger.info(`Skipping unknown layer entry: ${entry.name} (layer=${entry.layer})`);
  return ScheduleResultSchema.parse({
    entry_id: entry.id,
    status: "skipped",
    duration_ms: 0,
    fired_at: new Date().toISOString(),
  });
}

export async function executeEscalationTargetEntryForEngine(
  host: ScheduleExecutionHost,
  targetEntryId: string
): Promise<ScheduleResult | null> {
  const targetEntry = await host.withScheduleFileLock(async () => {
    await host.refreshEntriesForMutation();
    return host.entries.find((candidate) => candidate.id === targetEntryId) ?? null;
  });
  if (!targetEntry) {
    host.logger.warn(`Escalation target entry not found: ${targetEntryId}`);
    return null;
  }

  const immediateEntry = { ...targetEntry, enabled: true, next_fire_at: new Date().toISOString() };
  const result = await host.executeEntry(immediateEntry);
  const sideEffects = targetEntry.layer === "probe" ? host.captureExecutionSideEffects(targetEntry.id) : null;
  const applied = await host.withScheduleFileLock(async () => {
    await host.refreshEntriesForMutation();
    const outcome = await applyExecutionOutcome(host, targetEntryId, result, immediateEntry.next_fire_at);
    if (outcome) {
      host.applyExecutionSideEffects(targetEntryId, sideEffects);
      await host.writeEntriesAndProject();
    }
    return outcome;
  });
  if (applied) {
    await host.recordHistory({
      entry_id: targetEntry.id,
      entry_name: targetEntry.name,
      layer: targetEntry.layer,
      result: { ...result, failure_kind: applied.failureKind },
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

export async function executeEscalationTargetGoalForEngine(
  host: Pick<ScheduleExecutionHost, "logger"> & { coreLoop?: { run(goalId: string, options?: { maxIterations?: number }): Promise<any> } },
  goalId: string
): Promise<ScheduleResult> {
  const now = new Date().toISOString();
  if (!host.coreLoop) {
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
    const result = await host.coreLoop.run(goalId);
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
    host.logger.warn(`Escalation target goal "${goalId}" failed: ${message}`);
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

export async function checkEscalationForEngine(
  host: ScheduleExecutionHost,
  entry: ScheduleEntry,
  result: ScheduleResult
): Promise<ScheduleResult | null> {
  const isFailure = result.status === "error" || result.status === "down";
  if (!isFailure) return null;

  const escalationEntry = await host.withScheduleFileLock(async () => {
    await host.refreshEntriesForMutation();
    const idx = host.entries.findIndex((e) => e.id === entry.id);
    if (idx === -1) return null;

    const current = host.entries[idx]!;
    const esc = current.escalation;
    if (!esc?.enabled) return null;

    const now = Date.now();
    if (current.last_escalation_at) {
      const lastEsc = new Date(current.last_escalation_at).getTime();
      if (now - lastEsc < esc.cooldown_minutes * 60 * 1000) {
        host.logger.info(`Escalation for "${current.name}" suppressed (cooldown)`);
        return null;
      }
    }

    const hourAgo = now - 60 * 60 * 1000;
    const recentTimestamps = (current.escalation_timestamps ?? []).filter(
      (ts) => new Date(ts).getTime() > hourAgo
    );
    if (recentTimestamps.length >= esc.max_per_hour) {
      host.logger.info(`Escalation for "${current.name}" suppressed (max_per_hour=${esc.max_per_hour} reached)`);
      return null;
    }

    const nowIso = new Date(now).toISOString();
    host.entries[idx] = {
      ...current,
      last_escalation_at: nowIso,
      escalation_timestamps: [...recentTimestamps, nowIso],
    };
    await host.writeEntriesAndProject();
    return host.entries[idx]!;
  });

  if (!escalationEntry?.escalation) return null;
  const esc = escalationEntry.escalation;

  await host.dispatchNotification({
    report_type: "schedule_escalation",
    entry_id: escalationEntry.id,
    entry_name: escalationEntry.name,
    target_layer: esc.target_layer,
    target_entry_id: esc.target_entry_id,
    target_goal_id: esc.target_goal_id,
    consecutive_failures: escalationEntry.consecutive_failures,
  });

  host.logger.warn(
    `Escalating "${escalationEntry.name}" to ${esc.target_layer ?? "unknown"} (failures=${escalationEntry.consecutive_failures})`
  );

  if (esc.target_goal_id) await host.executeEscalationTargetGoal(esc.target_goal_id);
  if (esc.target_entry_id) await host.executeEscalationTargetEntry(esc.target_entry_id);

  return ScheduleResultSchema.parse({
    ...result,
    status: "escalated",
    escalated_to: esc.target_goal_id ?? esc.target_entry_id ?? esc.target_layer ?? null,
  });
}

function getDueEntryDescriptors(entries: ScheduleEntry[]): DueEntryDescriptor[] {
  const now = Date.now();
  return entries.flatMap((entry) => {
    if (!entry.enabled) return [] as DueEntryDescriptor[];
    const retryState = entry.retry_state ?? null;
    if (retryState?.next_retry_at) {
      return new Date(retryState.next_retry_at).getTime() <= now
        ? [{ entry, reason: "retry", scheduledFor: retryState.next_retry_at }]
        : [];
    }
    return new Date(entry.next_fire_at).getTime() <= now
      ? [{ entry, reason: "cadence", scheduledFor: entry.next_fire_at }]
      : [];
  });
}

function normalizeRetryPolicy(entry: ScheduleEntry): ScheduleRetryPolicy {
  return { ...DEFAULT_RETRY_POLICY, ...(entry.retry_policy ?? {}) };
}

function classifyFailureKind(entry: ScheduleEntry, result: ScheduleResult): ScheduleFailureKind {
  if (result.failure_kind) return result.failure_kind;
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
  if (permanentHints.some((hint) => message.includes(hint))) return "permanent";
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
  if (transientHints.some((hint) => message.includes(hint))) return "transient";
  return entry.layer === "goal_trigger" ? "permanent" : "transient";
}

function computeRetryDelay(policy: ScheduleRetryPolicy, attempt: number): number {
  const baseDelay = policy.initial_delay_ms * Math.pow(policy.multiplier, Math.max(0, attempt - 1));
  const cappedDelay = Math.min(baseDelay, policy.max_delay_ms);
  if (policy.jitter_factor <= 0) return cappedDelay;
  const jitter = cappedDelay * policy.jitter_factor * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(cappedDelay + jitter));
}

async function applyExecutionOutcome(
  host: ScheduleExecutionHost,
  entryId: string,
  result: ScheduleResult,
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
  const idx = host.entries.findIndex((candidate) => candidate.id === entryId);
  if (idx === -1) return null;

  const entry = host.entries[idx]!;
  const startedAt = scheduledFor ?? result.fired_at;
  const finishedAt = new Date().toISOString();
  const failureKind = classifyFailureKind(entry, result);
  const isFailure = result.status === "error" || result.status === "down";
  const retryPolicy = normalizeRetryPolicy(entry);
  const currentRetryState = entry.retry_state ?? null;
  let retryAt: string | null = null;
  let retryState: ScheduleRetryState | null = null;

  if (isFailure && retryPolicy.enabled && retryPolicy.retryable_failure_kinds.includes(failureKind)) {
    const attempts = (currentRetryState?.attempts ?? 0) + 1;
    const firstFailureAt = currentRetryState?.first_failure_at ?? result.fired_at;
    const windowElapsed = new Date(result.fired_at).getTime() - new Date(firstFailureAt).getTime();
    if (attempts <= retryPolicy.max_attempts && windowElapsed <= retryPolicy.max_retry_window_ms) {
      retryAt = new Date(Date.now() + computeRetryDelay(retryPolicy, attempts)).toISOString();
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

  host.entries[idx] = {
    ...entry,
    enabled: options.preserveEnabled ? entry.enabled : true,
    last_fired_at: result.fired_at,
    next_fire_at: computeNextFireAt(entry.trigger),
    updated_at: new Date().toISOString(),
    total_executions: entry.total_executions + 1,
    total_tokens_used: entry.total_tokens_used + (result.tokens_used ?? 0),
    tokens_used_today: (entry.tokens_used_today ?? 0) + (result.tokens_used ?? 0),
    consecutive_failures: isFailure ? entry.consecutive_failures + 1 : 0,
    retry_state: retryState,
  };

  const updated = host.entries[idx]!;
  if (
    updated.escalation?.circuit_breaker_threshold &&
    updated.consecutive_failures >= updated.escalation.circuit_breaker_threshold
  ) {
    updated.enabled = false;
    host.logger.warn(
      `Entry "${updated.name}" disabled by circuit breaker (${updated.consecutive_failures}/${updated.escalation.circuit_breaker_threshold})`
    );
  }

  if (
    result.status === "down" &&
    updated.heartbeat &&
    updated.consecutive_failures >= updated.heartbeat.failure_threshold
  ) {
    host.logger.warn(
      `Entry "${updated.name}" reached failure threshold (${updated.consecutive_failures}/${updated.heartbeat.failure_threshold})`
    );
    if (updated.consecutive_failures === updated.heartbeat.failure_threshold) {
      await host.dispatchNotification({
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
