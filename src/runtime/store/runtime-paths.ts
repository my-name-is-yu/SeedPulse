import { createHash } from "node:crypto";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { getPulseedDirPath } from "../../base/utils/paths.js";

export interface RuntimeStorePaths {
  rootDir: string;
  leaderDir: string;
  leaderPath: string;
  inboxDir: string;
  claimsDir: string;
  completedDir: string;
  completedByIdempotencyDir: string;
  completedByMessageDir: string;
  approvalsDir: string;
  approvalsPendingDir: string;
  approvalsResolvedDir: string;
  outboxDir: string;
  backgroundRunsDir: string;
  leasesDir: string;
  goalLeasesDir: string;
  dlqDir: string;
  healthDir: string;
  daemonHealthPath: string;
  componentsHealthPath: string;
  inboxBucketDir(dateKey: string): string;
  inboxRecordPath(dateKey: string, messageId: string): string;
  approvalPendingPath(approvalId: string): string;
  approvalResolvedPath(approvalId: string): string;
  outboxRecordPath(seq: number): string;
  backgroundRunPath(runId: string): string;
  goalLeasePath(goalId: string): string;
  completedByIdempotencyPath(idempotencyKey: string): string;
  completedByMessagePath(messageId: string): string;
  dlqPath(dateKey: string): string;
}

function recordFileName(recordId: string): string {
  return `${recordId}.json`;
}

function outboxFileName(seq: number): string {
  return `${String(seq).padStart(12, "0")}.json`;
}

export function encodeRuntimePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function hashedRecordFileName(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex");
  return `${digest}.json`;
}

export function resolveRuntimeRootPath(runtimeRoot?: string): string {
  return runtimeRoot ? path.resolve(runtimeRoot) : path.join(getPulseedDirPath(), "runtime");
}

export function runtimeDateKey(timestamp: number | Date = Date.now()): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return date.toISOString().slice(0, 10);
}

export function createRuntimeStorePaths(runtimeRoot?: string): RuntimeStorePaths {
  const rootDir = resolveRuntimeRootPath(runtimeRoot);
  const leaderDir = path.join(rootDir, "leader");
  const inboxDir = path.join(rootDir, "inbox");
  const claimsDir = path.join(rootDir, "claims");
  const completedDir = path.join(rootDir, "completed");
  const completedByIdempotencyDir = path.join(completedDir, "by-idempotency");
  const completedByMessageDir = path.join(completedDir, "by-message");
  const approvalsDir = path.join(rootDir, "approvals");
  const approvalsPendingDir = path.join(approvalsDir, "pending");
  const approvalsResolvedDir = path.join(approvalsDir, "resolved");
  const outboxDir = path.join(rootDir, "outbox");
  const backgroundRunsDir = path.join(rootDir, "background-runs");
  const leasesDir = path.join(rootDir, "leases");
  const goalLeasesDir = path.join(leasesDir, "goal");
  const dlqDir = path.join(rootDir, "dlq");
  const healthDir = path.join(rootDir, "health");

  return {
    rootDir,
    leaderDir,
    leaderPath: path.join(leaderDir, "leader.json"),
    inboxDir,
    claimsDir,
    completedDir,
    completedByIdempotencyDir,
    completedByMessageDir,
    approvalsDir,
    approvalsPendingDir,
    approvalsResolvedDir,
    outboxDir,
    backgroundRunsDir,
    leasesDir,
    goalLeasesDir,
    dlqDir,
    healthDir,
    daemonHealthPath: path.join(healthDir, "daemon.json"),
    componentsHealthPath: path.join(healthDir, "components.json"),
    inboxBucketDir(dateKey: string) {
      return path.join(inboxDir, dateKey);
    },
    inboxRecordPath(dateKey: string, messageId: string) {
      return path.join(inboxDir, dateKey, recordFileName(messageId));
    },
    approvalPendingPath(approvalId: string) {
      return path.join(approvalsPendingDir, recordFileName(approvalId));
    },
    approvalResolvedPath(approvalId: string) {
      return path.join(approvalsResolvedDir, recordFileName(approvalId));
    },
    outboxRecordPath(seq: number) {
      return path.join(outboxDir, outboxFileName(seq));
    },
    backgroundRunPath(runId: string) {
      return path.join(backgroundRunsDir, recordFileName(encodeRuntimePathSegment(runId)));
    },
    goalLeasePath(goalId: string) {
      return path.join(goalLeasesDir, `${encodeRuntimePathSegment(goalId)}.json`);
    },
    completedByIdempotencyPath(idempotencyKey: string) {
      return path.join(completedByIdempotencyDir, hashedRecordFileName(idempotencyKey));
    },
    completedByMessagePath(messageId: string) {
      return path.join(completedByMessageDir, recordFileName(messageId));
    },
    dlqPath(dateKey: string) {
      return path.join(dlqDir, `${dateKey}.jsonl`);
    },
  };
}

export async function ensureRuntimeStorePaths(paths: RuntimeStorePaths): Promise<void> {
  await Promise.all(
    [
      paths.rootDir,
      paths.leaderDir,
      paths.inboxDir,
      paths.claimsDir,
      paths.completedDir,
      paths.completedByIdempotencyDir,
      paths.completedByMessageDir,
      paths.approvalsDir,
      paths.approvalsPendingDir,
      paths.approvalsResolvedDir,
      paths.outboxDir,
      paths.backgroundRunsDir,
      paths.leasesDir,
      paths.goalLeasesDir,
      paths.dlqDir,
      paths.healthDir,
    ].map((dir) => fsp.mkdir(dir, { recursive: true }))
  );
}
