import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { getInternalIdentityPrefix } from "../../base/config/identity-loader.js";
import { PulSeedEventSchema } from "../../base/types/drive.js";
import type { DaemonConfig, DaemonState } from "../../base/types/daemon.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { DriveSystem, GoalActivationSnapshot } from "../../platform/drive/drive-system.js";
import { createEnvelope } from "../types/envelope.js";
import type { Envelope } from "../types/envelope.js";
import type { CronScheduler } from "../cron-scheduler.js";
import type { ScheduleEngine } from "../schedule/engine.js";
import type { Logger } from "../logger.js";
import { ApprovalStore, OutboxStore, RuntimeHealthStore, createRuntimeStorePaths } from "../store/index.js";

export interface RuntimeMaintenanceLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface RuntimeStoreMaintenanceOptions {
  approvalRetentionMs?: number;
  outboxRetentionMs?: number;
  outboxMaxRecords?: number;
  claimRetentionMs?: number;
}

export interface RuntimeStoreMaintenanceReport {
  approvals: {
    removedPending: number;
    expiredPending: number;
    prunedResolved: number;
  };
  outbox: {
    pruned: number;
    retained: number;
  };
  health: {
    repaired: boolean;
    status: string | null;
  };
  claims: {
    pruned: number;
  };
}

const ProactiveResponseSchema = z.object({
  action: z.enum(["suggest_goal", "investigate", "preemptive_check", "sleep"]),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ProactiveDecision = z.infer<typeof ProactiveResponseSchema>;

export interface ProactiveMaintenanceResult {
  lastProactiveTickAt: number;
  decision: ProactiveDecision | null;
}

export type GoalCycleScheduleSnapshotEntry = GoalActivationSnapshot;

async function getGoalActivationSnapshotCompat(
  driveSystem: DriveSystem,
  goalId: string,
): Promise<GoalActivationSnapshot> {
  const candidate = driveSystem as DriveSystem & {
    getGoalActivationSnapshot?: (goalId: string) => Promise<GoalActivationSnapshot>;
  };

  if (typeof candidate.getGoalActivationSnapshot === "function") {
    return candidate.getGoalActivationSnapshot(goalId);
  }

  const [shouldActivate, schedule] = await Promise.all([
    driveSystem.shouldActivate(goalId),
    driveSystem.getSchedule(goalId),
  ]);
  return { goalId, shouldActivate, schedule };
}

export async function collectGoalCycleScheduleSnapshot(
  driveSystem: DriveSystem,
  goalIds: string[],
): Promise<GoalCycleScheduleSnapshotEntry[]> {
  const snapshot: GoalCycleScheduleSnapshotEntry[] = [];

  for (const goalId of goalIds) {
    snapshot.push(await getGoalActivationSnapshotCompat(driveSystem, goalId));
  }

  return snapshot;
}

export async function determineActiveGoalsForCycle(
  driveSystem: DriveSystem,
  goalIds: string[],
  snapshot: GoalCycleScheduleSnapshotEntry[] = [],
): Promise<string[]> {
  const eligibleIds: string[] = [];
  const scores = new Map<string, number>();
  const snapshotByGoalId = new Map(snapshot.map((entry) => [entry.goalId, entry]));

  for (const goalId of goalIds) {
    const entry =
      snapshotByGoalId.get(goalId)
      ?? await getGoalActivationSnapshotCompat(driveSystem, goalId);

    if (entry.shouldActivate) {
      eligibleIds.push(goalId);
      const nextCheckAt = entry.schedule ? new Date(entry.schedule.next_check_at).getTime() : 0;
      scores.set(goalId, -nextCheckAt);
    }
  }

  return driveSystem.prioritizeGoals(eligibleIds, scores);
}

export function getNextIntervalForGoals(config: DaemonConfig, goalIds: string[]): number {
  const goalIntervals = config.goal_intervals;
  if (!goalIntervals || goalIds.length === 0) {
    return config.check_interval_ms;
  }

  let minInterval = config.check_interval_ms;
  for (const goalId of goalIds) {
    const override = goalIntervals[goalId];
    if (override !== undefined && override < minInterval) {
      minInterval = override;
    }
  }
  return minInterval;
}

export async function processCronTasksForDaemon(params: {
  cronScheduler?: CronScheduler;
  logger: Logger;
  acceptRuntimeEnvelope: (envelope: Envelope) => boolean;
}): Promise<void> {
  const { cronScheduler, logger, acceptRuntimeEnvelope } = params;
  if (!cronScheduler) {
    return;
  }

  try {
    const dueTasks = await cronScheduler.getDueTasks();
    for (const task of dueTasks) {
      logger.info(`Cron task due: ${task.id} (type=${task.type})`, {
        cron: task.cron,
        type: task.type,
      });

      const envelope = createEnvelope({
        type: "event",
        name: "cron_task_due",
        source: "cron-scheduler",
        priority: "normal",
        payload: task,
        dedupe_key: `cron-${task.id}`,
      });
      acceptRuntimeEnvelope(envelope);
    }
  } catch (err) {
    logger.warn("Failed to process cron tasks", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function processScheduleEntriesForDaemon(params: {
  scheduleEngine?: ScheduleEngine;
  logger: Logger;
  acceptRuntimeEnvelope: (envelope: Envelope) => boolean;
}): Promise<void> {
  const { scheduleEngine, logger, acceptRuntimeEnvelope } = params;
  if (!scheduleEngine) {
    return;
  }

  try {
    const results = await scheduleEngine.tick();
    for (const result of results) {
      if (result.status === "error") {
        logger.warn(`Schedule entry ${result.entry_id} failed: ${result.error_message}`);
        continue;
      }

      const goalId = (result as Record<string, unknown>)["goal_id"] as string | undefined;
      if (!goalId) {
        logger.warn("schedule_activated envelope missing goal_id", {
          entry_id: (result as Record<string, unknown>)["entry_id"],
          layer: (result as Record<string, unknown>)["layer"],
        });
        continue;
      }

      const envelope = createEnvelope({
        type: "event",
        name: "schedule_activated",
        source: "schedule-engine",
        goal_id: goalId,
        priority: "normal",
        payload: result,
        dedupe_key: result.entry_id,
      });
      acceptRuntimeEnvelope(envelope);
    }
  } catch (err) {
    logger.error("Failed to process schedule entries", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function expireOldCronTasks(
  cronScheduler: CronScheduler | undefined,
  logger: Logger,
): Promise<void> {
  if (!cronScheduler) {
    return;
  }

  try {
    await cronScheduler.expireOldTasks();
    logger.debug("Expired old cron tasks");
  } catch (err) {
    logger.warn("Failed to expire cron tasks", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function pruneStaleFiles(
  dirPath: string,
  olderThanMs: number,
  now: number,
): Promise<number> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dirPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw err;
  }

  const threshold = now - olderThanMs;
  let pruned = 0;

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry);
    let stat: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      stat = await fsp.stat(fullPath);
    } catch {
      continue;
    }

    if (!stat.isFile()) {
      continue;
    }
    if (stat.mtimeMs >= threshold) {
      continue;
    }

    try {
      await fsp.unlink(fullPath);
      pruned += 1;
    } catch {
      // Best-effort cleanup.
    }
  }

  return pruned;
}

export async function runRuntimeStoreMaintenanceCycle(params: {
  runtimeRoot: string;
  approvalStore?: ApprovalStore;
  outboxStore?: OutboxStore;
  runtimeHealthStore?: RuntimeHealthStore;
  logger: RuntimeMaintenanceLogger;
  now?: number;
  options?: RuntimeStoreMaintenanceOptions;
}): Promise<RuntimeStoreMaintenanceReport> {
  const now = params.now ?? Date.now();
  const options = params.options ?? {};
  const runtimePaths = createRuntimeStorePaths(params.runtimeRoot);
  const approvalStore = params.approvalStore ?? new ApprovalStore(runtimePaths);
  const outboxStore = params.outboxStore ?? new OutboxStore(runtimePaths);
  const runtimeHealthStore =
    params.runtimeHealthStore ?? new RuntimeHealthStore(runtimePaths);

  const approvals = await approvalStore.reconcile(now);
  const prunedResolved = await approvalStore.pruneResolved(
    options.approvalRetentionMs ?? 30 * 24 * 60 * 60 * 1000,
    now,
  );
  const outbox = await outboxStore.prune({
    olderThanMs: options.outboxRetentionMs ?? 30 * 24 * 60 * 60 * 1000,
    maxRecords: options.outboxMaxRecords ?? 5_000,
    now,
  });
  const health = await runtimeHealthStore.reconcile(now);
  const claims = await pruneStaleFiles(
    runtimePaths.claimsDir,
    options.claimRetentionMs ?? 7 * 24 * 60 * 60 * 1000,
    now,
  );

  params.logger.info("Runtime store maintenance cycle completed", {
    approvals_removed_pending: approvals.removedPending,
    approvals_expired_pending: approvals.expiredPending,
    approvals_pruned_resolved: prunedResolved,
    outbox_pruned: outbox.pruned,
    outbox_retained: outbox.retained,
    claims_pruned: claims,
    health_status: health.status,
  });

  return {
    approvals: {
      ...approvals,
      prunedResolved,
    },
    outbox,
    health: {
      repaired: health.details?.["repaired"] === true,
      status: health.status,
    },
    claims: {
      pruned: claims,
    },
  };
}

export async function runProactiveMaintenance(params: {
  config: DaemonConfig;
  llmClient?: ILLMClient;
  state: DaemonState;
  lastProactiveTickAt: number;
  logger: Logger;
}): Promise<ProactiveMaintenanceResult> {
  const { config, llmClient, state, lastProactiveTickAt, logger } = params;
  if (!config.proactive_mode || !llmClient) {
    return { lastProactiveTickAt, decision: null };
  }
  if (Date.now() - lastProactiveTickAt < config.proactive_interval_ms) {
    return { lastProactiveTickAt, decision: null };
  }

  try {
    const goalSummaries = state.active_goals.length > 0
      ? state.active_goals.map((id) => `- ${id}`).join("\n")
      : "(no active goals)";

    const prompt = `${getInternalIdentityPrefix("proactive engine")} Given the current state of all goals:\n${goalSummaries}\n\nDecide what action to take:\n- "suggest_goal": A new goal should be created (provide title + description)\n- "investigate": Something needs investigation (provide what and why)\n- "preemptive_check": Run a pre-emptive observation (provide goal_id)\n- "sleep": Nothing needs attention right now\n\nRespond with JSON: { "action": "...", "details": { ... } }`;

    const response = await llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      { model_tier: "light" },
    );
    const parsed = ProactiveResponseSchema.safeParse(
      llmClient.parseJSON(response.content, ProactiveResponseSchema),
    );

    if (!parsed.success) {
      logger.warn("Proactive tick: failed to parse LLM response", {
        raw: response.content,
        error: parsed.error.message,
      });
      return { lastProactiveTickAt: Date.now(), decision: null };
    }

    const { action, details } = parsed.data;
    if (action === "sleep") {
      logger.debug("Proactive tick: LLM decided to sleep");
    } else {
      logger.info(`Proactive tick: action=${action}`, { details });
    }
    return {
      lastProactiveTickAt: Date.now(),
      decision: parsed.data,
    };
  } catch (err) {
    logger.warn("Proactive tick: LLM error (ignored)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      lastProactiveTickAt: Date.now(),
      decision: null,
    };
  }
}

export async function getMaxGapScoreForGoals(
  driveSystem: DriveSystem,
  goalIds: string[],
  snapshot: GoalCycleScheduleSnapshotEntry[] = [],
): Promise<number> {
  const snapshotByGoalId = new Map(snapshot.map((entry) => [entry.goalId, entry]));
  let max = 0;

  for (const goalId of goalIds) {
    const entry = snapshotByGoalId.get(goalId);

    if (entry) {
      const score = (entry.schedule as Record<string, unknown> | null)?.["last_gap_score"];
      if (typeof score === "number" && score > max) {
        max = score;
      }
      continue;
    }

    try {
      const fallbackEntry = await getGoalActivationSnapshotCompat(driveSystem, goalId);
      const schedule = fallbackEntry.schedule;
      const score = (schedule as Record<string, unknown>)["last_gap_score"];
      if (typeof score === "number" && score > max) {
        max = score;
      }
    } catch {
      // Non-fatal — just use 0 for this goal
    }
  }
  return max;
}

function getPersistedDaemonStateSnapshot(state: DaemonState): string {
  return JSON.stringify({
    status: state.status,
    active_goals: [...state.active_goals],
    loop_count: state.loop_count,
    last_loop_at: state.last_loop_at,
    interrupted_goals: state.interrupted_goals ? [...state.interrupted_goals] : undefined,
    last_resident_at: state.last_resident_at,
    resident_activity: state.resident_activity,
  });
}

export async function runSupervisorMaintenanceCycleForDaemon(params: {
  currentGoalIds: string[];
  driveSystem: DriveSystem;
  supervisor: { activateGoal(goalId: string): void } | null;
  processCronTasks: () => Promise<void>;
  processScheduleEntries: () => Promise<void>;
  proactiveTick: () => Promise<void>;
  runRuntimeStoreMaintenance?: () => Promise<void>;
  saveDaemonState: () => Promise<void>;
  eventServer?: { broadcast?(event: string, payload: Record<string, unknown>): void | Promise<void> };
  state: DaemonState;
}): Promise<void> {
  const snapshot = await collectGoalCycleScheduleSnapshot(
    params.driveSystem,
    [...params.currentGoalIds],
  );
  const activeGoals = await determineActiveGoalsForCycle(
    params.driveSystem,
    [...params.currentGoalIds],
    snapshot,
  );
  const stateBeforeMaintenance = getPersistedDaemonStateSnapshot(params.state);
  for (const goalId of activeGoals) {
    params.supervisor?.activateGoal(goalId);
  }

  await params.processCronTasks();
  await params.processScheduleEntries();
  await params.proactiveTick();
  await params.runRuntimeStoreMaintenance?.();
  if (getPersistedDaemonStateSnapshot(params.state) !== stateBeforeMaintenance) {
    await params.saveDaemonState();
  }

  if (params.eventServer) {
    void params.eventServer.broadcast?.("daemon_status", {
      status: params.state.status,
      activeGoals: params.state.active_goals,
      loopCount: params.state.loop_count,
      lastLoopAt: params.state.last_loop_at,
    });
  }
}

export async function writeChatMessageEvent(
  driveSystem: DriveSystem,
  goalId: string,
  message: string,
): Promise<void> {
  await driveSystem.writeEvent(
    PulSeedEventSchema.parse({
      type: "internal",
      source: "command-dispatcher",
      timestamp: new Date().toISOString(),
      data: {
        goal_id: goalId,
        kind: "chat_message",
        message,
      },
    }),
  );
}
