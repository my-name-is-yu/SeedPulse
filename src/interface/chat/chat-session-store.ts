import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { type Dirent } from "node:fs";
import { StateError } from "../../base/utils/errors.js";
import type { StateManager } from "../../base/state/state-manager.js";
import { ChatSessionSchema, type ChatSession } from "./chat-history.js";
import { normalizeAgentLoopSessionState, type AgentLoopSessionState } from "../../orchestrator/execution/agent-loop/agent-loop-session-state.js";

const CHAT_SESSION_DIR = path.join("chat", "sessions");
const CHAT_AGENTLOOP_DIR = path.join("chat", "agentloop");
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type ChatSessionAgentLoopStatus = "missing" | "running" | "completed" | "failed";

export interface ChatSessionCatalogEntry {
  id: string;
  cwd: string;
  title: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  agentLoopStatePath: string | null;
  agentLoopStatus: ChatSessionAgentLoopStatus;
  agentLoopResumable: boolean;
}

export interface LoadedChatSession {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  title: string | null;
  messages: ChatSession["messages"];
  compactionSummary?: string;
  agentLoopStatePath: string | null;
  agentLoopStatus: ChatSessionAgentLoopStatus;
  agentLoopResumable: boolean;
  agentLoopUpdatedAt?: string | null;
  agentLoop?: ChatSession["agentLoop"];
  usage?: ChatSession["usage"];
  [key: string]: unknown;
}

export interface ChatSessionCleanupOptions {
  dryRun?: boolean;
  activeSessionId?: string;
  olderThanMs?: number;
  now?: number;
}

export interface ChatSessionListOptions {
  cwd?: string;
}

export interface ChatSessionCleanupReport {
  dryRun: boolean;
  olderThanMs: number;
  activeSessionId: string | null;
  totalSessions: number;
  retainedSessionIds: string[];
  removedSessionIds: string[];
  removedAgentLoopStatePaths: string[];
}

export class ChatSessionSelectorError extends StateError {
  constructor(
    message: string,
    public readonly selector: string,
    public readonly kind: "not_found" | "ambiguous",
    public readonly matches: string[] = [],
  ) {
    super(message);
    this.name = "ChatSessionSelectorError";
  }
}

interface SessionRecord {
  session: LoadedChatSession;
  filePath: string;
  activityAtMs: number;
  fileMtimeMs: number;
}

interface AgentLoopDiscovery {
  statePath: string | null;
  status: ChatSessionAgentLoopStatus;
  resumable: boolean;
  updatedAt: string | null;
}

function buildNormalizedAgentLoopMetadata(agentLoop: AgentLoopDiscovery): ChatSession["agentLoop"] | undefined {
  if (!agentLoop.statePath && agentLoop.status === "missing" && !agentLoop.resumable && !agentLoop.updatedAt) {
    return undefined;
  }

  return {
    ...(agentLoop.statePath ? { statePath: agentLoop.statePath } : {}),
    ...(agentLoop.status !== "missing" ? { status: agentLoop.status } : {}),
    ...(agentLoop.resumable ? { resumable: true } : {}),
    ...(agentLoop.updatedAt ? { updatedAt: agentLoop.updatedAt } : {}),
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeTitle(value: unknown): string | null {
  const title = optionalString(value);
  return title ? title.trim() : null;
}

function parseTime(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function resolvePathWithinBaseDir(baseDir: string, candidate: string | null | undefined): { relative: string; absolute: string } | null {
  const trimmed = candidate?.trim();
  if (!trimmed) return null;

  const absolute = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(baseDir, trimmed);
  const root = path.resolve(baseDir);
  const relative = path.relative(root, absolute);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return { absolute, relative: relative === "" ? "." : relative };
  }
  return null;
}

function sessionToAgentLoopStatePath(session: ChatSession, baseDir: string): string | null {
  const topLevelPath = optionalString(session.agentLoopStatePath);
  if (topLevelPath) {
    const resolved = resolvePathWithinBaseDir(baseDir, topLevelPath);
    if (resolved) return resolved.relative;
  }

  const nestedPath = optionalString(session.agentLoop?.statePath);
  if (nestedPath) {
    const resolved = resolvePathWithinBaseDir(baseDir, nestedPath);
    if (resolved) return resolved.relative;
  }

  return path.join(CHAT_AGENTLOOP_DIR, `${session.id}.state.json`);
}

function extractSessionActivityAtMs(session: { createdAt: string; updatedAt?: string | null; agentLoopUpdatedAt?: string | null }, fileMtimeMs: number): number {
  const metadataActivity = Math.max(parseTime(session.updatedAt), parseTime(session.createdAt), parseTime(session.agentLoopUpdatedAt));
  return metadataActivity === Number.NEGATIVE_INFINITY ? fileMtimeMs : metadataActivity;
}

async function readFileMtimeMs(filePath: string, fallbackMs: number): Promise<number> {
  try {
    return (await fsp.stat(filePath)).mtimeMs;
  } catch {
    return fallbackMs;
  }
}

function normalizeAgentLoopStatus(
  session: ChatSession,
  agentLoopState: AgentLoopSessionState | null,
): AgentLoopDiscovery {
  const statePath = session.agentLoopStatePath ?? session.agentLoop?.statePath ?? null;
  const topLevelStatePath = optionalString(session.agentLoopStatePath);
  const nestedStatePath = optionalString(session.agentLoop?.statePath);
  const allowNestedMetadata = !topLevelStatePath || topLevelStatePath === nestedStatePath;
  const metadataStatus = session.agentLoopStatus ?? (allowNestedMetadata ? session.agentLoop?.status ?? null : null);
  const resumableMetadata = session.agentLoopResumable ?? (allowNestedMetadata ? session.agentLoop?.resumable ?? null : null);
  const metadataUpdatedAt = session.agentLoopUpdatedAt ?? (allowNestedMetadata ? session.agentLoop?.updatedAt ?? null : null);

  if (agentLoopState) {
    const status = agentLoopState.status;
    return {
      statePath,
      status,
      resumable: status !== "completed",
      updatedAt: agentLoopState.updatedAt,
    };
  }

  if (metadataStatus) {
    return {
      statePath,
      status: metadataStatus,
      resumable: resumableMetadata ?? metadataStatus !== "completed",
      updatedAt: metadataUpdatedAt,
    };
  }

  return {
    statePath,
    status: "missing",
    resumable: resumableMetadata ?? false,
    updatedAt: metadataUpdatedAt,
  };
}

async function loadAgentLoopState(
  stateManager: StateManager,
  baseDir: string,
  session: ChatSession,
): Promise<AgentLoopDiscovery> {
  const statePaths: string[] = [];
  const topLevelPath = resolvePathWithinBaseDir(baseDir, optionalString(session.agentLoopStatePath));
  const nestedPath = !topLevelPath
    ? resolvePathWithinBaseDir(baseDir, optionalString(session.agentLoop?.statePath))
    : null;

  for (const resolved of [topLevelPath, nestedPath]) {
    if (resolved && !statePaths.includes(resolved.relative)) statePaths.push(resolved.relative);
  }

  const discoveredPath = sessionToAgentLoopStatePath(session, baseDir);
  if (discoveredPath && !statePaths.includes(discoveredPath)) statePaths.push(discoveredPath);

  let loadedState: AgentLoopSessionState | null = null;
  let loadedPath: string | null = null;
  for (const relativePath of statePaths) {
    const raw = await stateManager.readRaw(relativePath);
    const normalized = normalizeAgentLoopSessionState(raw);
    if (normalized) {
      loadedState = normalized;
      loadedPath = relativePath;
      break;
    }
  }

  const discovery = normalizeAgentLoopStatus(session, loadedState);
  return {
    statePath: loadedPath ?? discovery.statePath,
    status: discovery.status,
    resumable: loadedState ? loadedState.status !== "completed" : discovery.resumable,
    updatedAt: loadedState?.updatedAt ?? discovery.updatedAt,
  };
}

function normalizeSessionRecord(session: LoadedChatSession, filePath: string, fileMtimeMs: number, agentLoop: AgentLoopDiscovery): SessionRecord {
  const normalizedAgentLoop = buildNormalizedAgentLoopMetadata(agentLoop);
  return {
    session: {
      ...session,
      title: normalizeTitle(session.title),
      agentLoopStatePath: agentLoop.statePath,
      agentLoopStatus: agentLoop.status,
      agentLoopResumable: agentLoop.resumable,
      agentLoopUpdatedAt: agentLoop.updatedAt,
      ...(normalizedAgentLoop ? { agentLoop: normalizedAgentLoop } : { agentLoop: undefined }),
    },
    filePath,
    activityAtMs: extractSessionActivityAtMs(session, fileMtimeMs),
    fileMtimeMs,
  };
}

async function readSessionRecordWithMetadata(
  stateManager: StateManager,
  baseDir: string,
  sessionId: string,
  fallbackFileMtimeMs: number = Date.now(),
): Promise<SessionRecord | null> {
  const relativePath = path.join(CHAT_SESSION_DIR, `${sessionId}.json`);
  const raw = await stateManager.readRaw(relativePath);
  if (raw === null) return null;

  const parsed = ChatSessionSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
    throw new ChatSessionSelectorError(
      `Invalid chat session record for "${sessionId}" at ${relativePath}: ${issues}`,
      sessionId,
      "not_found",
    );
  }

  const filePath = path.join(baseDir, relativePath);
  const fileMtimeMs = await readFileMtimeMs(filePath, fallbackFileMtimeMs);
  const discovery = await loadAgentLoopState(stateManager, baseDir, parsed.data);
  const session: LoadedChatSession = {
    id: parsed.data.id,
    cwd: parsed.data.cwd,
    createdAt: parsed.data.createdAt,
    updatedAt: parsed.data.updatedAt ?? parsed.data.createdAt,
    title: normalizeTitle(parsed.data.title),
    messages: [...parsed.data.messages],
    ...(parsed.data.compactionSummary ? { compactionSummary: parsed.data.compactionSummary } : {}),
    agentLoopStatePath: discovery.statePath,
    agentLoopStatus: discovery.status,
    agentLoopResumable: discovery.resumable,
    agentLoopUpdatedAt: discovery.updatedAt,
    ...(parsed.data.agentLoop ? { agentLoop: parsed.data.agentLoop } : {}),
    ...(parsed.data.usage ? { usage: parsed.data.usage } : {}),
  };

  return normalizeSessionRecord(session, filePath, fileMtimeMs, discovery);
}

function buildCatalogEntry(record: SessionRecord): ChatSessionCatalogEntry {
  const { session } = record;
  return {
    id: session.id,
    cwd: session.cwd,
    title: session.title,
    messageCount: session.messages.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    agentLoopStatePath: session.agentLoopStatePath,
    agentLoopStatus: session.agentLoopStatus,
    agentLoopResumable: session.agentLoopResumable,
  };
}

function toPersistedSession(session: LoadedChatSession): ChatSession {
  return {
    id: session.id,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: [...session.messages],
    ...(session.compactionSummary ? { compactionSummary: session.compactionSummary } : {}),
    ...(session.title !== null ? { title: session.title } : {}),
    ...(session.agentLoopStatePath !== null ? { agentLoopStatePath: session.agentLoopStatePath } : {}),
    ...(session.agentLoopStatus === "running" || session.agentLoopStatus === "completed" || session.agentLoopStatus === "failed"
      ? { agentLoopStatus: session.agentLoopStatus }
      : {}),
    ...(session.agentLoopResumable ? { agentLoopResumable: true } : {}),
    ...(session.agentLoopUpdatedAt !== null && session.agentLoopUpdatedAt !== undefined
      ? { agentLoopUpdatedAt: session.agentLoopUpdatedAt }
      : {}),
    ...(session.agentLoop ? { agentLoop: session.agentLoop } : {}),
    ...(session.usage ? { usage: session.usage } : {}),
  };
}

export class ChatSessionCatalog {
  constructor(private readonly stateManager: StateManager) {}

  private get baseDir(): string {
    return this.stateManager.getBaseDir();
  }

  private sessionRelativePath(sessionId: string): string {
    return path.join(CHAT_SESSION_DIR, `${sessionId}.json`);
  }

  private sessionAbsolutePath(sessionId: string): string {
    return path.join(this.baseDir, this.sessionRelativePath(sessionId));
  }

  private async readSessionRecord(sessionId: string): Promise<LoadedChatSession | null> {
    const record = await readSessionRecordWithMetadata(this.stateManager, this.baseDir, sessionId);
    return record?.session ?? null;
  }

  private async listSessionRecords(): Promise<SessionRecord[]> {
    const dir = path.join(this.baseDir, CHAT_SESSION_DIR);
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const records: SessionRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const sessionId = entry.name.slice(0, -".json".length);
      try {
        const record = await readSessionRecordWithMetadata(this.stateManager, this.baseDir, sessionId);
        if (record) records.push(record);
      } catch {
        continue;
      }
    }

    records.sort((left, right) => {
      if (right.activityAtMs !== left.activityAtMs) return right.activityAtMs - left.activityAtMs;
      if (right.fileMtimeMs !== left.fileMtimeMs) return right.fileMtimeMs - left.fileMtimeMs;
      return left.session.id.localeCompare(right.session.id);
    });

    return records;
  }

  async loadSession(sessionId: string): Promise<LoadedChatSession | null> {
    return this.readSessionRecord(sessionId);
  }

  async listSessions(options: ChatSessionListOptions = {}): Promise<ChatSessionCatalogEntry[]> {
    const records = await this.listSessionRecords();
    const cwd = options.cwd?.trim();
    const catalogEntries = records.map(buildCatalogEntry);
    return cwd ? catalogEntries.filter((entry) => entry.cwd === cwd) : catalogEntries;
  }

  async latestSession(options: ChatSessionListOptions = {}): Promise<ChatSessionCatalogEntry | null> {
    const sessions = await this.listSessions(options);
    return sessions[0] ?? null;
  }

  async resolveSelector(selector: string): Promise<ChatSessionCatalogEntry> {
    const normalizedSelector = selector.trim();
    if (!normalizedSelector) {
      throw new ChatSessionSelectorError("Chat session selector cannot be empty.", selector, "not_found");
    }

    const sessions = await this.listSessions();

    const exactId = sessions.find((session) => session.id === normalizedSelector);
    if (exactId) return exactId;

    const exactTitleMatches = sessions.filter((session) => session.title === normalizedSelector);
    if (exactTitleMatches.length === 1) return exactTitleMatches[0];
    if (exactTitleMatches.length > 1) {
      throw new ChatSessionSelectorError(
        `Ambiguous chat session title "${normalizedSelector}" matches ${exactTitleMatches.length} sessions.`,
        selector,
        "ambiguous",
        exactTitleMatches.map((session) => session.id),
      );
    }

    const prefixMatches = sessions.filter((session) => session.id.startsWith(normalizedSelector));
    if (prefixMatches.length === 1) return prefixMatches[0];
    if (prefixMatches.length > 1) {
      throw new ChatSessionSelectorError(
        `Ambiguous chat session id prefix "${normalizedSelector}" matches ${prefixMatches.length} sessions.`,
        selector,
        "ambiguous",
        prefixMatches.map((session) => session.id),
      );
    }

    throw new ChatSessionSelectorError(
      `No chat session matched selector "${normalizedSelector}".`,
      selector,
      "not_found",
    );
  }

  async loadSessionBySelector(selector: string): Promise<LoadedChatSession | null> {
    const resolved = await this.resolveSelector(selector);
    return this.loadSession(resolved.id);
  }

  async renameSession(selector: string, title: string | null): Promise<LoadedChatSession> {
    const resolved = await this.resolveSelector(selector);
    const session = await this.loadSession(resolved.id);
    if (!session) {
      throw new ChatSessionSelectorError(
        `Chat session "${resolved.id}" disappeared before it could be renamed.`,
        selector,
        "not_found",
      );
    }

    const normalizedTitle = normalizeTitle(title);
    const updatedAt = new Date().toISOString();
    const persisted = toPersistedSession(session);
    const { title: _existingTitle, ...withoutTitle } = persisted;
    const updated: ChatSession = {
      ...(normalizedTitle !== null ? persisted : withoutTitle),
      ...(normalizedTitle !== null ? { title: normalizedTitle } : {}),
      updatedAt,
    };
    await this.stateManager.writeRaw(this.sessionRelativePath(session.id), updated);
    return {
      id: session.id,
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt,
      title: normalizedTitle,
      messages: [...session.messages],
      ...(session.compactionSummary ? { compactionSummary: session.compactionSummary } : {}),
      agentLoopStatePath: session.agentLoopStatePath,
      agentLoopStatus: session.agentLoopStatus,
      agentLoopResumable: session.agentLoopResumable,
      ...(session.agentLoop ? { agentLoop: session.agentLoop } : {}),
    };
  }

  async cleanupSessions(options: ChatSessionCleanupOptions = {}): Promise<ChatSessionCleanupReport> {
    const dryRun = options.dryRun ?? true;
    const activeSessionId = options.activeSessionId?.trim() || null;
    const olderThanMs = options.olderThanMs ?? DEFAULT_SESSION_TTL_MS;
    const now = options.now ?? Date.now();
    const threshold = now - olderThanMs;
    const sessions = await this.listSessionRecords();
    const retainedSessionIds: string[] = [];
    const removedSessionIds: string[] = [];
    const removedAgentLoopStatePaths: string[] = [];

    for (const record of sessions) {
      const protectedSession = activeSessionId !== null && record.session.id === activeSessionId;
      const isOld = record.activityAtMs < threshold;
      if (!protectedSession && isOld) {
        removedSessionIds.push(record.session.id);
        const statePath = record.session.agentLoopStatePath ?? path.join(CHAT_AGENTLOOP_DIR, `${record.session.id}.state.json`);
        if (statePath) removedAgentLoopStatePaths.push(statePath);
        continue;
      }
      retainedSessionIds.push(record.session.id);
    }

    if (!dryRun) {
      for (const sessionId of removedSessionIds) {
        await fsp.rm(this.sessionAbsolutePath(sessionId), { force: true });
      }

      for (const relativeStatePath of removedAgentLoopStatePaths) {
        const resolved = resolvePathWithinBaseDir(this.baseDir, relativeStatePath);
        if (!resolved) continue;
        await fsp.rm(resolved.absolute, { force: true });
      }
    }

    return {
      dryRun,
      olderThanMs,
      activeSessionId,
      totalSessions: sessions.length,
      retainedSessionIds,
      removedSessionIds,
      removedAgentLoopStatePaths: [...new Set(removedAgentLoopStatePaths)],
    };
  }
}
