import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { ProcessSessionSnapshot } from "../../tools/system/ProcessSessionTool/ProcessSessionTool.js";
import { BackgroundRunSchema, type BackgroundRun, type BackgroundRunFilter, type BackgroundRunStatus, type RuntimeArtifactRef, type RuntimeSession, type RuntimeSessionFilter, type RuntimeSessionRef, type RuntimeSessionStatus } from "./types.js";

export function filterSessions(sessions: RuntimeSession[], filter: RuntimeSessionFilter): RuntimeSession[] {
  return sessions.filter((session) => {
    if (filter.kind && session.kind !== filter.kind) return false;
    if (filter.status && session.status !== filter.status) return false;
    if (filter.activeOnly && session.status !== "active") return false;
    return true;
  });
}

export function filterRuns(runs: BackgroundRun[], filter: BackgroundRunFilter): BackgroundRun[] {
  return runs.filter((run) => {
    if (filter.kind && run.kind !== filter.kind) return false;
    if (filter.status && run.status !== filter.status) return false;
    if (filter.activeOnly && run.status !== "queued" && run.status !== "running") return false;
    if (filter.attentionOnly && run.status !== "failed" && run.status !== "timed_out" && run.status !== "lost") return false;
    return true;
  });
}

export function mergeLedgerRunWithProjection(ledgerRun: BackgroundRun, projectedRun: BackgroundRun | undefined): BackgroundRun {
  if (!projectedRun) return ledgerRun;
  if (!isActiveRunStatus(ledgerRun.status) || isActiveRunStatus(projectedRun.status)) {
    return ledgerRun;
  }

  return BackgroundRunSchema.parse({
    ...ledgerRun,
    status: projectedRun.status,
    updated_at: projectedRun.updated_at ?? ledgerRun.updated_at,
    completed_at: projectedRun.completed_at ?? ledgerRun.completed_at,
    error: projectedRun.error ?? ledgerRun.error,
    source_refs: [...ledgerRun.source_refs, ...projectedRun.source_refs],
  });
}

export function coreLoopSessionFromLedgerRun(run: BackgroundRun): RuntimeSession {
  const stateRef = run.source_refs.find((ref) => ref.kind === "supervisor_state") ?? null;
  const createdAt = run.started_at ?? run.created_at;
  return {
    schema_version: "runtime-session-v1",
    id: run.child_session_id!,
    kind: "coreloop",
    parent_session_id: run.parent_session_id,
    title: run.title ?? run.id,
    workspace: run.workspace,
    status: coreLoopSessionStatusFromRunStatus(run.status),
    created_at: createdAt,
    updated_at: run.updated_at,
    last_event_at: run.updated_at,
    transcript_ref: null,
    state_ref: stateRef,
    reply_target: null,
    resumable: false,
    attachable: isActiveRunStatus(run.status),
    source_refs: run.source_refs,
  };
}

export function coreLoopSessionStatusFromRunStatus(status: BackgroundRunStatus): RuntimeSessionStatus {
  if (status === "queued" || status === "running") return "active";
  if (status === "lost") return "lost";
  if (status === "unknown") return "unknown";
  return "ended";
}

export function isActiveRunStatus(status: BackgroundRunStatus): boolean {
  return status === "queued" || status === "running";
}

export function sourceRef(
  kind: RuntimeSessionRef["kind"],
  id: string | null,
  absolutePath: string | null,
  relativePath: string | null,
  updatedAt: string | null,
): RuntimeSessionRef {
  return {
    kind,
    id,
    path: absolutePath,
    relative_path: relativePath,
    updated_at: updatedAt,
  };
}

export function agentStatusToSessionStatus(status: string): RuntimeSessionStatus {
  if (status === "running") return "active";
  if (status === "completed" || status === "failed") return "ended";
  return "unknown";
}

export function agentStatusToRunStatus(status: string): BackgroundRunStatus {
  if (status === "running") return "running";
  if (status === "completed") return "succeeded";
  if (status === "failed") return "failed";
  return "unknown";
}

export function conversationSessionId(id: string): string {
  return `session:conversation:${id}`;
}

export function agentSessionId(id: string): string {
  return `session:agent:${id}`;
}

export function agentRunId(id: string): string {
  return `run:agent:${id}`;
}

export function coreLoopSessionId(id: string): string {
  return `session:coreloop:${id}`;
}

export function coreLoopRunId(id: string): string {
  return `run:coreloop:${id}`;
}

export function processRunId(id: string): string {
  return `run:process:${id}`;
}

export function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function compareByUpdatedAtThenId<T extends { id: string; updated_at: string | null }>(left: T, right: T): number {
  const leftTime = parseTime(left.updated_at);
  const rightTime = parseTime(right.updated_at);
  if (rightTime !== leftTime) return rightTime - leftTime;
  return left.id.localeCompare(right.id);
}

export function parseTime(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function numberToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

export function normalizeProcessSnapshot(value: unknown): ProcessSessionSnapshot | null {
  if (!isObject(value)) return null;
  const sessionId = stringField(value, "session_id");
  const command = stringField(value, "command");
  const cwd = stringField(value, "cwd");
  const startedAt = stringField(value, "startedAt");
  const args = Array.isArray(value["args"]) ? value["args"].filter((arg): arg is string => typeof arg === "string") : null;
  if (!sessionId || !command || !cwd || !startedAt || !args) return null;
  const exitCode = typeof value["exitCode"] === "number" ? value["exitCode"] : null;
  const signal = typeof value["signal"] === "string" ? value["signal"] as NodeJS.Signals : null;
  const artifactRefs = Array.isArray(value["artifactRefs"]) ? value["artifactRefs"].filter((ref): ref is string => typeof ref === "string") : undefined;
  return {
    session_id: sessionId,
    ...(typeof value["label"] === "string" ? { label: value["label"] } : {}),
    command,
    args,
    cwd,
    ...(typeof value["goal_id"] === "string" ? { goal_id: value["goal_id"] } : {}),
    ...(typeof value["task_id"] === "string" ? { task_id: value["task_id"] } : {}),
    ...(typeof value["strategy_id"] === "string" ? { strategy_id: value["strategy_id"] } : {}),
    ...(typeof value["pid"] === "number" ? { pid: value["pid"] } : {}),
    running: value["running"] === true,
    exitCode,
    signal,
    startedAt,
    ...(typeof value["exitedAt"] === "string" ? { exitedAt: value["exitedAt"] } : {}),
    bufferedChars: typeof value["bufferedChars"] === "number" ? value["bufferedChars"] : 0,
    ...(typeof value["metadataPath"] === "string" ? { metadataPath: value["metadataPath"] } : {}),
    ...(typeof value["metadataRelativePath"] === "string" ? { metadataRelativePath: value["metadataRelativePath"] } : {}),
    ...(artifactRefs ? { artifactRefs } : {}),
  };
}

export function chooseProcessSnapshot(
  live: ProcessSessionSnapshot | undefined,
  sidecar: ProcessSessionSnapshot | undefined,
): ProcessSessionSnapshot | null {
  if (sidecar && (sidecar.exitedAt || sidecar.exitCode !== null || sidecar.signal || sidecar.running === false)) {
    return sidecar;
  }
  return live ?? sidecar ?? null;
}

export function processArtifacts(snapshot: ProcessSessionSnapshot): RuntimeArtifactRef[] {
  return (snapshot.artifactRefs ?? []).map((artifactPath) => ({
    label: path.basename(artifactPath),
    path: artifactPath,
    url: null,
    kind: classifyArtifact(artifactPath),
  }));
}

export function classifyArtifact(artifactPath: string): RuntimeArtifactRef["kind"] {
  const basename = path.basename(artifactPath).toLowerCase();
  if (basename.endsWith(".log") || basename.includes("log")) return "log";
  if (basename.endsWith(".json") && (basename.includes("metric") || basename.includes("score"))) return "metrics";
  if (basename.endsWith(".md") || basename.endsWith(".txt")) return "report";
  if (basename.endsWith(".diff") || basename.endsWith(".patch")) return "diff";
  return "other";
}

export function relativeToBase(baseDir: string, maybePath: string | null): string | null {
  if (!maybePath) return null;
  if (!path.isAbsolute(maybePath)) return maybePath;
  const relative = path.relative(baseDir, maybePath);
  return relative.startsWith("..") || path.isAbsolute(relative) ? null : relative;
}

export function defaultIsPidAlive(pid: number): boolean | "unknown" {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return "unknown";
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
