import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { StateManager } from "../../base/state/state-manager.js";
import { ChatSessionCatalog } from "../../interface/chat/chat-session-store.js";
import { normalizeAgentLoopSessionState } from "../../orchestrator/execution/agent-loop/agent-loop-session-state.js";
import type { ProcessSessionManager, ProcessSessionSnapshot } from "../../tools/system/ProcessSessionTool/ProcessSessionTool.js";
import {
  BackgroundRunSchema,
  RuntimeSessionRegistrySnapshotSchema,
  type BackgroundRun,
  type BackgroundRunFilter,
  type BackgroundRunStatus,
  type RuntimeArtifactRef,
  type RuntimeSession,
  type RuntimeSessionFilter,
  type RuntimeSessionRef,
  type RuntimeSessionRegistrySnapshot,
  type RuntimeSessionRegistryWarning,
  type RuntimeSessionStatus,
} from "./types.js";

interface RuntimeSessionRegistryDeps {
  stateManager: StateManager;
  stateBaseDir?: string;
  processSessionManager?: Pick<ProcessSessionManager, "list">;
  now?: () => Date;
  isPidAlive?: (pid: number) => boolean | "unknown";
}

interface SupervisorStateLike {
  workers?: unknown;
  updatedAt?: unknown;
}

const PROCESS_SESSION_DIR = path.join("runtime", "process-sessions");

export class RuntimeSessionRegistry {
  private readonly stateManager: StateManager;
  private readonly stateBaseDir: string;
  private readonly chatCatalog: ChatSessionCatalog;
  private readonly processSessionManager?: Pick<ProcessSessionManager, "list">;
  private readonly now: () => Date;
  private readonly isPidAlive: (pid: number) => boolean | "unknown";

  constructor(deps: RuntimeSessionRegistryDeps) {
    this.stateManager = deps.stateManager;
    this.stateBaseDir = deps.stateBaseDir ?? deps.stateManager.getBaseDir();
    this.chatCatalog = new ChatSessionCatalog(this.stateManager);
    this.processSessionManager = deps.processSessionManager;
    this.now = deps.now ?? (() => new Date());
    this.isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  }

  async snapshot(): Promise<RuntimeSessionRegistrySnapshot> {
    const generatedAt = this.now().toISOString();
    const sessions: RuntimeSession[] = [];
    const backgroundRuns: BackgroundRun[] = [];
    const warnings: RuntimeSessionRegistryWarning[] = [];

    await this.projectChatAndAgentSessions(sessions, backgroundRuns, warnings);
    await this.projectSupervisorState(sessions, backgroundRuns, warnings);
    await this.projectProcessSessions(backgroundRuns, warnings);

    sessions.sort(compareByUpdatedAtThenId);
    backgroundRuns.sort(compareByUpdatedAtThenId);

    return RuntimeSessionRegistrySnapshotSchema.parse({
      schema_version: "runtime-session-registry-v1",
      generated_at: generatedAt,
      sessions,
      background_runs: backgroundRuns,
      warnings,
    });
  }

  async listSessions(filter: RuntimeSessionFilter = {}): Promise<RuntimeSession[]> {
    return filterSessions((await this.snapshot()).sessions, filter);
  }

  async listRuns(filter: BackgroundRunFilter = {}): Promise<BackgroundRun[]> {
    return filterRuns((await this.snapshot()).background_runs, filter);
  }

  async getSession(id: string): Promise<RuntimeSession | null> {
    return (await this.snapshot()).sessions.find((session) => session.id === id) ?? null;
  }

  async getRun(id: string): Promise<BackgroundRun | null> {
    return (await this.snapshot()).background_runs.find((run) => run.id === id) ?? null;
  }

  private async projectChatAndAgentSessions(
    sessions: RuntimeSession[],
    backgroundRuns: BackgroundRun[],
    warnings: RuntimeSessionRegistryWarning[],
  ): Promise<void> {
    let chatSessions;
    try {
      chatSessions = await this.chatCatalog.listSessions();
    } catch (error) {
      warnings.push({
        code: "source_unavailable",
        source: sourceRef("chat_session", null, null, null, null),
        message: `Failed to list chat sessions: ${messageFromError(error)}`,
      });
      return;
    }

    const linkedAgentStatePaths = new Set<string>();
    for (const chat of chatSessions) {
      const conversationId = conversationSessionId(chat.id);
      const chatSource = sourceRef(
        "chat_session",
        chat.id,
        null,
        path.join("chat", "sessions", `${chat.id}.json`),
        chat.updatedAt,
      );

      sessions.push({
        schema_version: "runtime-session-v1",
        id: conversationId,
        kind: "conversation",
        parent_session_id: null,
        title: chat.title,
        workspace: chat.cwd,
        status: "idle",
        created_at: chat.createdAt,
        updated_at: chat.updatedAt,
        last_event_at: chat.updatedAt,
        transcript_ref: chatSource,
        state_ref: null,
        reply_target: null,
        resumable: true,
        attachable: false,
        source_refs: [chatSource],
      });

      if (chat.agentLoopStatePath && chat.agentLoopStatus !== "missing") {
        linkedAgentStatePaths.add(chat.agentLoopStatePath);
        const agentProjection = await this.projectAgentSession(chat, conversationId, chatSource, warnings);
        sessions.push(agentProjection.session);
        backgroundRuns.push(agentProjection.run);
      }
    }

    await this.projectOrphanAgentSessions(linkedAgentStatePaths, sessions, backgroundRuns, warnings);
  }

  private async projectAgentSession(
    chat: Awaited<ReturnType<ChatSessionCatalog["listSessions"]>>[number],
    conversationId: string,
    chatSource: RuntimeSessionRef,
    warnings: RuntimeSessionRegistryWarning[],
  ): Promise<{ session: RuntimeSession; run: BackgroundRun }> {
    const stateRef = sourceRef(
      "agentloop_state",
      null,
      null,
      chat.agentLoopStatePath,
      null,
    );
    let agentLoopSessionId: string | null = null;
    let traceId: string | null = null;
    let stateUpdatedAt: string | null = null;
    let normalizedStatus = chat.agentLoopStatus;

    try {
      const raw = await this.stateManager.readRaw(chat.agentLoopStatePath!);
      const state = normalizeAgentLoopSessionState(raw);
      if (state) {
        agentLoopSessionId = state.sessionId;
        traceId = state.traceId;
        stateUpdatedAt = state.updatedAt;
        normalizedStatus = state.status;
      } else {
        warnings.push({
          code: "source_parse_failed",
          source: stateRef,
          message: `AgentLoop state could not be normalized: ${chat.agentLoopStatePath}`,
        });
      }
    } catch (error) {
      warnings.push({
        code: "source_parse_failed",
        source: stateRef,
        message: `Failed to read AgentLoop state ${chat.agentLoopStatePath}: ${messageFromError(error)}`,
      });
    }

    const stableAgentId = agentLoopSessionId ?? path.basename(chat.agentLoopStatePath!, ".state.json");
    const sessionId = agentSessionId(stableAgentId);
    const updatedAt = stateUpdatedAt ?? chat.updatedAt;
    const agentStateRef = { ...stateRef, id: agentLoopSessionId, updated_at: stateUpdatedAt };
    const traceRef = traceId
      ? sourceRef("agentloop_trace", traceId, null, null, stateUpdatedAt)
      : null;
    const sourceRefs = [chatSource, agentStateRef, ...(traceRef ? [traceRef] : [])];

    return {
      session: {
        schema_version: "runtime-session-v1",
        id: sessionId,
        kind: "agent",
        parent_session_id: conversationId,
        title: chat.title ?? stableAgentId,
        workspace: chat.cwd,
        status: agentStatusToSessionStatus(normalizedStatus),
        created_at: chat.createdAt,
        updated_at: updatedAt,
        last_event_at: updatedAt,
        transcript_ref: null,
        state_ref: agentStateRef,
        reply_target: null,
        resumable: chat.agentLoopResumable,
        attachable: false,
        source_refs: sourceRefs,
      },
      run: BackgroundRunSchema.parse({
        schema_version: "background-run-v1",
        id: agentRunId(stableAgentId),
        kind: "agent_run",
        parent_session_id: conversationId,
        child_session_id: sessionId,
        process_session_id: null,
        status: agentStatusToRunStatus(normalizedStatus),
        notify_policy: "done_only",
        title: chat.title ?? stableAgentId,
        workspace: chat.cwd,
        created_at: chat.createdAt,
        started_at: chat.createdAt,
        updated_at: updatedAt,
        completed_at: normalizedStatus === "completed" || normalizedStatus === "failed" ? updatedAt : null,
        summary: null,
        error: normalizedStatus === "failed" ? "AgentLoop session failed." : null,
        artifacts: [],
        source_refs: sourceRefs,
      }),
    };
  }

  private async projectOrphanAgentSessions(
    linkedAgentStatePaths: Set<string>,
    sessions: RuntimeSession[],
    backgroundRuns: BackgroundRun[],
    warnings: RuntimeSessionRegistryWarning[],
  ): Promise<void> {
    const dir = path.join(this.stateBaseDir, "chat", "agentloop");
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      warnings.push({
        code: "source_unavailable",
        source: sourceRef("agentloop_state", null, dir, path.join("chat", "agentloop"), null),
        message: `Failed to list AgentLoop state files: ${messageFromError(error)}`,
      });
      return;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".state.json")) continue;
      const relativePath = path.join("chat", "agentloop", entry.name);
      if (linkedAgentStatePaths.has(relativePath)) continue;
      const stateRef = sourceRef("agentloop_state", null, null, relativePath, null);
      try {
        const raw = await this.stateManager.readRaw(relativePath);
        const state = normalizeAgentLoopSessionState(raw);
        if (!state) {
          warnings.push({
            code: "source_parse_failed",
            source: stateRef,
            message: `AgentLoop state could not be normalized: ${relativePath}`,
          });
          continue;
        }
        const sessionId = agentSessionId(state.sessionId);
        const agentStateRef = { ...stateRef, id: state.sessionId, updated_at: state.updatedAt };
        warnings.push({
          code: "missing_parent_join",
          source: agentStateRef,
          message: `AgentLoop state ${relativePath} has no owning chat session agentLoopStatePath join.`,
        });
        sessions.push({
          schema_version: "runtime-session-v1",
          id: sessionId,
          kind: "agent",
          parent_session_id: null,
          title: state.taskId ?? state.goalId,
          workspace: state.cwd,
          status: agentStatusToSessionStatus(state.status),
          created_at: null,
          updated_at: state.updatedAt,
          last_event_at: state.updatedAt,
          transcript_ref: null,
          state_ref: agentStateRef,
          reply_target: null,
          resumable: state.status !== "completed",
          attachable: false,
          source_refs: [
            agentStateRef,
            sourceRef("agentloop_trace", state.traceId, null, null, state.updatedAt),
          ],
        });
        backgroundRuns.push(BackgroundRunSchema.parse({
          schema_version: "background-run-v1",
          id: agentRunId(state.sessionId),
          kind: "agent_run",
          parent_session_id: null,
          child_session_id: sessionId,
          process_session_id: null,
          status: agentStatusToRunStatus(state.status),
          notify_policy: "done_only",
          title: state.taskId ?? state.goalId,
          workspace: state.cwd,
          created_at: null,
          started_at: null,
          updated_at: state.updatedAt,
          completed_at: state.status === "completed" || state.status === "failed" ? state.updatedAt : null,
          summary: null,
          error: state.status === "failed" ? "AgentLoop session failed." : null,
          artifacts: [],
          source_refs: [agentStateRef],
        }));
      } catch (error) {
        warnings.push({
          code: "source_parse_failed",
          source: stateRef,
          message: `Failed to read AgentLoop state ${relativePath}: ${messageFromError(error)}`,
        });
      }
    }
  }

  private async projectSupervisorState(
    sessions: RuntimeSession[],
    backgroundRuns: BackgroundRun[],
    warnings: RuntimeSessionRegistryWarning[],
  ): Promise<void> {
    const relativePath = await this.findSupervisorStatePath();
    if (!relativePath) return;
    const source = sourceRef("supervisor_state", null, null, relativePath, null);
    let raw: unknown;
    try {
      raw = await this.stateManager.readRaw(relativePath);
    } catch (error) {
      warnings.push({
        code: "source_parse_failed",
        source,
        message: `Failed to read supervisor state: ${messageFromError(error)}`,
      });
      return;
    }
    if (!raw) return;

    const state = raw as SupervisorStateLike;
    const workers = Array.isArray(state.workers) ? state.workers : [];
    const updatedAt = numberToIso(state.updatedAt) ?? null;
    const supervisorSource = { ...source, updated_at: updatedAt };
    for (const worker of workers) {
      if (!isObject(worker)) continue;
      const workerId = stringField(worker, "workerId");
      if (!workerId) continue;
      const goalId = stringField(worker, "goalId");
      if (!goalId) continue;
      const startedAt = numberToIso(worker["startedAt"]) ?? updatedAt;
      const sessionId = coreLoopSessionId(workerId);
      const title = goalId ? `CoreLoop goal ${goalId}` : `CoreLoop worker ${workerId}`;
      sessions.push({
        schema_version: "runtime-session-v1",
        id: sessionId,
        kind: "coreloop",
        parent_session_id: null,
        title,
        workspace: null,
        status: "active",
        created_at: startedAt,
        updated_at: updatedAt,
        last_event_at: updatedAt,
        transcript_ref: null,
        state_ref: supervisorSource,
        reply_target: null,
        resumable: false,
        attachable: true,
        source_refs: [supervisorSource],
      });
      backgroundRuns.push(BackgroundRunSchema.parse({
        schema_version: "background-run-v1",
        id: coreLoopRunId(workerId),
        kind: "coreloop_run",
        parent_session_id: null,
        child_session_id: sessionId,
        process_session_id: null,
        status: "running",
        notify_policy: "state_changes",
        title,
        workspace: null,
        created_at: startedAt,
        started_at: startedAt,
        updated_at: updatedAt,
        completed_at: null,
        summary: null,
        error: null,
        artifacts: [],
        source_refs: [supervisorSource],
      }));
    }
  }

  private async projectProcessSessions(
    backgroundRuns: BackgroundRun[],
    warnings: RuntimeSessionRegistryWarning[],
  ): Promise<void> {
    const liveSnapshots = new Map<string, ProcessSessionSnapshot>();
    for (const snapshot of this.processSessionManager?.list(true) ?? []) {
      liveSnapshots.set(snapshot.session_id, snapshot);
    }

    const sidecars = await this.readProcessSidecars(warnings);
    const ids = new Set([...liveSnapshots.keys(), ...sidecars.map((snapshot) => snapshot.session_id)]);
    for (const id of ids) {
      const live = liveSnapshots.get(id);
      const sidecar = sidecars.find((snapshot) => snapshot.session_id === id);
      const snapshot = chooseProcessSnapshot(live, sidecar);
      if (!snapshot) continue;
      const status = this.processRunStatus(snapshot, Boolean(live), warnings);
      const processSource = sourceRef(
        "process_session",
        snapshot.session_id,
        snapshot.metadataPath ?? null,
        snapshot.metadataRelativePath ?? path.join(PROCESS_SESSION_DIR, `${snapshot.session_id}.json`),
        snapshot.exitedAt ?? snapshot.startedAt,
      );
      const artifacts = processArtifacts(snapshot);
      backgroundRuns.push(BackgroundRunSchema.parse({
        schema_version: "background-run-v1",
        id: processRunId(snapshot.session_id),
        kind: "process_run",
        parent_session_id: null,
        child_session_id: null,
        process_session_id: snapshot.session_id,
        status,
        notify_policy: "done_only",
        title: snapshot.label ?? `${snapshot.command} ${snapshot.args.join(" ")}`.trim(),
        workspace: snapshot.cwd,
        created_at: snapshot.startedAt,
        started_at: snapshot.startedAt,
        updated_at: snapshot.exitedAt ?? snapshot.startedAt,
        completed_at: status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost"
          ? snapshot.exitedAt ?? null
          : null,
        summary: null,
        error: status === "failed" ? `Process exited with code ${snapshot.exitCode}` : null,
        artifacts,
        source_refs: [
          processSource,
          ...artifacts.map((artifact) => sourceRef("artifact", artifact.label, artifact.path, relativeToBase(this.stateBaseDir, artifact.path), null)),
        ],
      }));
    }
  }

  private async readProcessSidecars(warnings: RuntimeSessionRegistryWarning[]): Promise<ProcessSessionSnapshot[]> {
    const dir = path.join(this.stateBaseDir, PROCESS_SESSION_DIR);
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      warnings.push({
        code: "source_unavailable",
        source: sourceRef("process_session", null, dir, PROCESS_SESSION_DIR, null),
        message: `Failed to list process session sidecars: ${messageFromError(error)}`,
      });
      return [];
    }

    const snapshots: ProcessSessionSnapshot[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const relativePath = path.join(PROCESS_SESSION_DIR, entry.name);
      try {
        const raw = await this.stateManager.readRaw(relativePath);
        const snapshot = normalizeProcessSnapshot(raw);
        if (snapshot) {
          snapshots.push(snapshot);
        } else {
          warnings.push({
            code: "source_parse_failed",
            source: sourceRef("process_session", entry.name.slice(0, -5), null, relativePath, null),
            message: `Process session sidecar could not be normalized: ${relativePath}`,
          });
        }
      } catch (error) {
        warnings.push({
          code: "source_parse_failed",
          source: sourceRef("process_session", entry.name.slice(0, -5), null, relativePath, null),
          message: `Failed to read process session sidecar ${relativePath}: ${messageFromError(error)}`,
        });
      }
    }
    return snapshots;
  }

  private async findSupervisorStatePath(): Promise<string | null> {
    for (const candidate of [
      path.join("runtime", "supervisor-state.json"),
      "supervisor-state.json",
    ]) {
      try {
        if (await fileExists(path.join(this.stateBaseDir, candidate))) return candidate;
      } catch {
        // Try the next legacy/current candidate.
      }
    }
    return null;
  }

  private processRunStatus(
    snapshot: ProcessSessionSnapshot,
    hasLiveSession: boolean,
    warnings: RuntimeSessionRegistryWarning[],
  ): BackgroundRunStatus {
    if (snapshot.exitedAt || snapshot.running === false || snapshot.exitCode !== null || snapshot.signal) {
      if (snapshot.exitCode === 0) return "succeeded";
      if (snapshot.exitCode !== null) return "failed";
      if (snapshot.signal) return "cancelled";
      if (snapshot.exitedAt) return "unknown";
      warnings.push({
        code: "stale_source",
        source: sourceRef("process_session", snapshot.session_id, snapshot.metadataPath ?? null, snapshot.metadataRelativePath ?? null, snapshot.startedAt),
        message: `Process session ${snapshot.session_id} is not running but has no terminal exit metadata.`,
      });
      return "lost";
    }
    if (!snapshot.running) return "unknown";
    if (hasLiveSession) return "running";
    if (typeof snapshot.pid !== "number") return "unknown";

    const alive = this.isPidAlive(snapshot.pid);
    if (alive === true) return "running";
    if (alive === false) {
      warnings.push({
        code: "dead_process_sidecar",
        source: sourceRef("process_session", snapshot.session_id, snapshot.metadataPath ?? null, snapshot.metadataRelativePath ?? null, snapshot.startedAt),
        message: `Process session ${snapshot.session_id} is marked running but PID ${snapshot.pid} is not alive.`,
      });
      return "lost";
    }
    return "unknown";
  }
}

export function createRuntimeSessionRegistry(deps: RuntimeSessionRegistryDeps): RuntimeSessionRegistry {
  return new RuntimeSessionRegistry(deps);
}

function filterSessions(sessions: RuntimeSession[], filter: RuntimeSessionFilter): RuntimeSession[] {
  return sessions.filter((session) => {
    if (filter.kind && session.kind !== filter.kind) return false;
    if (filter.status && session.status !== filter.status) return false;
    if (filter.activeOnly && session.status !== "active") return false;
    return true;
  });
}

function filterRuns(runs: BackgroundRun[], filter: BackgroundRunFilter): BackgroundRun[] {
  return runs.filter((run) => {
    if (filter.kind && run.kind !== filter.kind) return false;
    if (filter.status && run.status !== filter.status) return false;
    if (filter.activeOnly && run.status !== "queued" && run.status !== "running") return false;
    if (filter.attentionOnly && run.status !== "failed" && run.status !== "timed_out" && run.status !== "lost") return false;
    return true;
  });
}

function sourceRef(
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

function agentStatusToSessionStatus(status: string): RuntimeSessionStatus {
  if (status === "running") return "active";
  if (status === "completed" || status === "failed") return "ended";
  return "unknown";
}

function agentStatusToRunStatus(status: string): BackgroundRunStatus {
  if (status === "running") return "running";
  if (status === "completed") return "succeeded";
  if (status === "failed") return "failed";
  return "unknown";
}

function conversationSessionId(id: string): string {
  return `session:conversation:${id}`;
}

function agentSessionId(id: string): string {
  return `session:agent:${id}`;
}

function agentRunId(id: string): string {
  return `run:agent:${id}`;
}

function coreLoopSessionId(id: string): string {
  return `session:coreloop:${id}`;
}

function coreLoopRunId(id: string): string {
  return `run:coreloop:${id}`;
}

function processRunId(id: string): string {
  return `run:process:${id}`;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareByUpdatedAtThenId<T extends { id: string; updated_at: string | null }>(left: T, right: T): number {
  const leftTime = parseTime(left.updated_at);
  const rightTime = parseTime(right.updated_at);
  if (rightTime !== leftTime) return rightTime - leftTime;
  return left.id.localeCompare(right.id);
}

function parseTime(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function numberToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function normalizeProcessSnapshot(value: unknown): ProcessSessionSnapshot | null {
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

function chooseProcessSnapshot(
  live: ProcessSessionSnapshot | undefined,
  sidecar: ProcessSessionSnapshot | undefined,
): ProcessSessionSnapshot | null {
  if (sidecar && (sidecar.exitedAt || sidecar.exitCode !== null || sidecar.signal || sidecar.running === false)) {
    return sidecar;
  }
  return live ?? sidecar ?? null;
}

function processArtifacts(snapshot: ProcessSessionSnapshot): RuntimeArtifactRef[] {
  return (snapshot.artifactRefs ?? []).map((artifactPath) => ({
    label: path.basename(artifactPath),
    path: artifactPath,
    url: null,
    kind: classifyArtifact(artifactPath),
  }));
}

function classifyArtifact(artifactPath: string): RuntimeArtifactRef["kind"] {
  const basename = path.basename(artifactPath).toLowerCase();
  if (basename.endsWith(".log") || basename.includes("log")) return "log";
  if (basename.endsWith(".json") && (basename.includes("metric") || basename.includes("score"))) return "metrics";
  if (basename.endsWith(".md") || basename.endsWith(".txt")) return "report";
  if (basename.endsWith(".diff") || basename.endsWith(".patch")) return "diff";
  return "other";
}

function relativeToBase(baseDir: string, maybePath: string | null): string | null {
  if (!maybePath) return null;
  if (!path.isAbsolute(maybePath)) return maybePath;
  const relative = path.relative(baseDir, maybePath);
  return relative.startsWith("..") || path.isAbsolute(relative) ? null : relative;
}

function defaultIsPidAlive(pid: number): boolean | "unknown" {
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
