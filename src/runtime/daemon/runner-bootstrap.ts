import * as path from "node:path";
import { ApprovalStore, OutboxStore, RuntimeHealthStore, createRuntimeStorePaths } from "../store/index.js";
import { LeaderLockManager } from "../leader-lock-manager.js";
import { GoalLeaseManager } from "../goal-lease-manager.js";
import { JournalBackedQueue } from "../queue/journal-backed-queue.js";
import { QueueClaimSweeper } from "../queue/queue-claim-sweeper.js";
import { ApprovalBroker } from "../approval-broker.js";
import { RuntimeOwnershipCoordinator } from "./runtime-ownership.js";
import type { Logger } from "../logger.js";
import { DaemonStateSchema, type DaemonConfig, type DaemonState } from "../../base/types/daemon.js";

const RUNTIME_JOURNAL_MAX_ATTEMPTS = 1_000;
export const RUNTIME_LEADER_LEASE_MS = 30_000;
export const RUNTIME_LEADER_HEARTBEAT_MS = 10_000;

export function resolveRuntimeRoot(baseDir: string, config: DaemonConfig): string {
  const configuredRoot = config.runtime_root;
  if (!configuredRoot || configuredRoot.trim() === "") {
    return path.join(baseDir, "runtime");
  }
  return path.isAbsolute(configuredRoot)
    ? configuredRoot
    : path.resolve(baseDir, configuredRoot);
}

export function createRuntimeWiring(
  baseDir: string,
  runtimeRoot: string,
  logger: Logger,
  onLeadershipLost: (reason: string) => void
) {
  const runtimePaths = createRuntimeStorePaths(runtimeRoot);
  const approvalStore = new ApprovalStore(runtimePaths);
  const outboxStore = new OutboxStore(runtimePaths);
  const runtimeHealthStore = new RuntimeHealthStore(runtimePaths);
  const leaderLockManager = new LeaderLockManager(runtimeRoot);
  const goalLeaseManager = new GoalLeaseManager(runtimeRoot);
  const approvalBroker = new ApprovalBroker({
    store: approvalStore,
    logger,
  });
  const journalQueue = new JournalBackedQueue({
    journalPath: path.join(runtimeRoot, "queue.json"),
    maxAttempts: RUNTIME_JOURNAL_MAX_ATTEMPTS,
  });
  const queueClaimSweeper = new QueueClaimSweeper({
    queue: journalQueue,
  });
  const runtimeOwnership = new RuntimeOwnershipCoordinator({
    baseDir,
    runtimeRoot,
    logger,
    approvalStore,
    outboxStore,
    runtimeHealthStore,
    leaderLockManager,
    onLeadershipLost,
  });

  return {
    approvalStore,
    outboxStore,
    runtimeHealthStore,
    leaderLockManager,
    goalLeaseManager,
    approvalBroker,
    journalQueue,
    queueClaimSweeper,
    runtimeOwnership,
  };
}

export function createInitialDaemonState(runtimeRoot: string): DaemonState {
  return DaemonStateSchema.parse({
    pid: process.pid,
    started_at: new Date().toISOString(),
    last_loop_at: null,
    loop_count: 0,
    active_goals: [],
    status: "stopped",
    runtime_root: runtimeRoot,
    crash_count: 0,
    last_error: null,
    last_resident_at: null,
    resident_activity: null,
  });
}
