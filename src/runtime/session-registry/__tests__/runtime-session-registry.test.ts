import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateManager } from "../../../base/state/state-manager.js";
import {
  RuntimeSessionRegistry,
  RuntimeSessionRegistrySnapshotSchema,
} from "../index.js";
import type { ProcessSessionSnapshot } from "../../../tools/system/ProcessSessionTool/ProcessSessionTool.js";
import { BackgroundRunLedger } from "../../store/background-run-store.js";

describe("RuntimeSessionRegistry", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-runtime-session-registry-"));
    stateManager = new StateManager(tmpDir, undefined, { walEnabled: false });
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("joins agent sessions to their owning conversation through agentLoopStatePath", async () => {
    await stateManager.writeRaw("chat/sessions/chat-a.json", {
      id: "chat-a",
      cwd: "/repo",
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:10:00.000Z",
      title: "Issue 742",
      messages: [],
      agentLoopStatePath: "chat/agentloop/agent-state.state.json",
      agentLoopStatus: "running",
      agentLoopResumable: true,
      agentLoopUpdatedAt: "2026-04-25T00:11:00.000Z",
    });
    await stateManager.writeRaw("chat/agentloop/agent-state.state.json", makeAgentState({
      sessionId: "native-session-b",
      updatedAt: "2026-04-25T00:12:00.000Z",
      status: "running",
    }));

    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();

    const conversation = snapshot.sessions.find((session) => session.id === "session:conversation:chat-a");
    const agent = snapshot.sessions.find((session) => session.id === "session:agent:native-session-b");
    const run = snapshot.background_runs.find((candidate) => candidate.id === "run:agent:native-session-b");

    expect(conversation).toMatchObject({
      kind: "conversation",
      resumable: true,
    });
    expect(agent).toMatchObject({
      kind: "agent",
      parent_session_id: "session:conversation:chat-a",
      state_ref: expect.objectContaining({
        relative_path: "chat/agentloop/agent-state.state.json",
      }),
    });
    expect(run).toMatchObject({
      kind: "agent_run",
      parent_session_id: "session:conversation:chat-a",
      child_session_id: "session:agent:native-session-b",
      status: "running",
    });
  });

  it("does not report a running process sidecar with a dead pid as running", async () => {
    await stateManager.writeRaw("runtime/process-sessions/proc-dead.json", makeProcessSnapshot({
      session_id: "proc-dead",
      pid: 999_999,
      running: true,
    }));

    const snapshot = await new RuntimeSessionRegistry({
      stateManager,
      isPidAlive: () => false,
    }).snapshot();

    expect(snapshot.background_runs).toContainEqual(expect.objectContaining({
      id: "run:process:proc-dead",
      status: "lost",
      process_session_id: "proc-dead",
    }));
    expect(snapshot.warnings).toContainEqual(expect.objectContaining({
      code: "dead_process_sidecar",
    }));
  });

  it("keeps orphan agent-loop state with a missing parent join warning", async () => {
    await stateManager.writeRaw("chat/agentloop/orphan.state.json", makeAgentState({
      sessionId: "orphan-agent",
      updatedAt: "2026-04-25T00:12:00.000Z",
      status: "running",
    }));

    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();

    expect(snapshot.sessions).toContainEqual(expect.objectContaining({
      id: "session:agent:orphan-agent",
      kind: "agent",
      parent_session_id: null,
      status: "active",
    }));
    expect(snapshot.warnings).toContainEqual(expect.objectContaining({
      code: "missing_parent_join",
    }));
  });

  it("prefers durable terminal process state over an in-memory running snapshot", async () => {
    const runningSnapshot = makeProcessSnapshot({
      session_id: "proc-terminal",
      pid: process.pid,
      running: true,
      exitCode: null,
    });
    await stateManager.writeRaw("runtime/process-sessions/proc-terminal.json", {
      ...runningSnapshot,
      running: false,
      exitCode: 0,
      exitedAt: "2026-04-25T01:00:00.000Z",
    });

    const snapshot = await new RuntimeSessionRegistry({
      stateManager,
      processSessionManager: {
        list: () => [runningSnapshot],
      },
    }).snapshot();

    expect(snapshot.background_runs).toContainEqual(expect.objectContaining({
      id: "run:process:proc-terminal",
      status: "succeeded",
      completed_at: "2026-04-25T01:00:00.000Z",
    }));
  });

  it("projects durable pinned reply targets after restart without in-memory active routing", async () => {
    const ledger = new BackgroundRunLedger(path.join(tmpDir, "runtime"));
    await ledger.ensureReady();
    await ledger.create({
      id: "run:agent:restart-safe",
      kind: "agent_run",
      notify_policy: "done_only",
      reply_target_source: "pinned_run",
      pinned_reply_target: {
        channel: "slack",
        target_id: "C123",
        thread_id: "1700000000.000200",
      },
      parent_session_id: "session:conversation:chat-a",
      title: "Restart safe",
      workspace: "/repo",
      created_at: "2026-04-25T00:00:00.000Z",
    });
    await ledger.terminal("run:agent:restart-safe", {
      status: "succeeded",
      completed_at: "2026-04-25T00:10:00.000Z",
      summary: "completed after restart",
    });

    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();

    expect(snapshot.background_runs).toContainEqual(expect.objectContaining({
      id: "run:agent:restart-safe",
      status: "succeeded",
      reply_target_source: "pinned_run",
      pinned_reply_target: expect.objectContaining({
        channel: "slack",
        target_id: "C123",
        thread_id: "1700000000.000200",
      }),
      summary: "completed after restart",
    }));
  });

  it("lets durable ledger records beat synthetic process projections with the same run id", async () => {
    await stateManager.writeRaw("runtime/process-sessions/proc-ledger.json", makeProcessSnapshot({
      session_id: "proc-ledger",
      running: true,
      pid: process.pid,
      label: "synthetic process",
    }));

    const ledger = new BackgroundRunLedger(path.join(tmpDir, "runtime"));
    await ledger.ensureReady();
    await ledger.create({
      id: "run:process:proc-ledger",
      kind: "process_run",
      notify_policy: "silent",
      reply_target_source: "none",
      process_session_id: "proc-ledger",
      title: "durable process",
      workspace: "/repo",
      created_at: "2026-04-25T00:00:00.000Z",
      started_at: "2026-04-25T00:00:00.000Z",
      status: "running",
    });
    await ledger.terminal("run:process:proc-ledger", {
      status: "failed",
      completed_at: "2026-04-25T00:30:00.000Z",
      error: "durable failure",
    });

    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();
    const run = snapshot.background_runs.find((candidate) => candidate.id === "run:process:proc-ledger");

    expect(run).toMatchObject({
      id: "run:process:proc-ledger",
      kind: "process_run",
      status: "failed",
      title: "durable process",
      error: "durable failure",
      reply_target_source: "none",
    });
    expect(snapshot.background_runs.filter((candidate) => candidate.id === "run:process:proc-ledger")).toHaveLength(1);
  });

  it("does not let a stale running ledger record hide a dead process sidecar", async () => {
    await stateManager.writeRaw("runtime/process-sessions/proc-stale-ledger.json", makeProcessSnapshot({
      session_id: "proc-stale-ledger",
      running: true,
      pid: 999_999,
      label: "stale ledger process",
    }));

    const ledger = new BackgroundRunLedger(path.join(tmpDir, "runtime"));
    await ledger.ensureReady();
    await ledger.create({
      id: "run:process:proc-stale-ledger",
      kind: "process_run",
      notify_policy: "silent",
      reply_target_source: "none",
      process_session_id: "proc-stale-ledger",
      title: "durable running process",
      workspace: "/repo",
      created_at: "2026-04-25T00:00:00.000Z",
      started_at: "2026-04-25T00:00:00.000Z",
      status: "running",
    });

    const snapshot = await new RuntimeSessionRegistry({
      stateManager,
      isPidAlive: () => false,
    }).snapshot();
    const run = snapshot.background_runs.find((candidate) => candidate.id === "run:process:proc-stale-ledger");

    expect(run).toMatchObject({
      id: "run:process:proc-stale-ledger",
      status: "lost",
      title: "durable running process",
      process_session_id: "proc-stale-ledger",
    });
    expect(snapshot.warnings).toContainEqual(expect.objectContaining({
      code: "dead_process_sidecar",
    }));
  });

  it("projects active supervisor workers from the legacy root supervisor-state path", async () => {
    await stateManager.writeRaw("supervisor-state.json", {
      workers: [
        {
          workerId: "worker-1",
          goalId: "goal-a",
          startedAt: Date.parse("2026-04-25T00:00:00.000Z"),
          iterations: 2,
        },
      ],
      crashCounts: {},
      suspendedGoals: [],
      updatedAt: Date.parse("2026-04-25T00:30:00.000Z"),
    });

    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();

    expect(snapshot.sessions).toContainEqual(expect.objectContaining({
      id: "session:coreloop:worker-1",
      kind: "coreloop",
      status: "active",
      attachable: true,
    }));
    expect(snapshot.background_runs).toContainEqual(expect.objectContaining({
      id: "run:coreloop:worker-1",
      kind: "coreloop_run",
      status: "running",
    }));
  });

  it("does not project idle supervisor workers as active CoreLoop runs", async () => {
    await stateManager.writeRaw("supervisor-state.json", {
      workers: [
        {
          workerId: "idle-worker",
          goalId: null,
          startedAt: Date.parse("2026-04-25T00:00:00.000Z"),
          iterations: 0,
        },
      ],
      crashCounts: {},
      suspendedGoals: [],
      updatedAt: Date.parse("2026-04-25T00:30:00.000Z"),
    });

    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();

    expect(snapshot.sessions.some((session) => session.id === "session:coreloop:idle-worker")).toBe(false);
    expect(snapshot.background_runs.some((run) => run.id === "run:coreloop:idle-worker")).toBe(false);
  });

  it("does not report an unconfirmed stopped process sidecar as succeeded", async () => {
    await stateManager.writeRaw("runtime/process-sessions/proc-stopped.json", makeProcessSnapshot({
      session_id: "proc-stopped",
      running: false,
      exitCode: null,
      signal: null,
    }));

    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();

    expect(snapshot.background_runs).toContainEqual(expect.objectContaining({
      id: "run:process:proc-stopped",
      status: "lost",
    }));
    expect(snapshot.warnings).toContainEqual(expect.objectContaining({
      code: "stale_source",
    }));
  });

  it("returns a schema-valid registry snapshot", async () => {
    await stateManager.writeRaw("chat/sessions/chat-a.json", {
      id: "chat-a",
      cwd: "/repo",
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:10:00.000Z",
      messages: [],
    });

    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();

    expect(() => RuntimeSessionRegistrySnapshotSchema.parse(snapshot)).not.toThrow();
  });
});

function makeAgentState(overrides: Partial<{
  sessionId: string;
  status: "running" | "completed" | "failed";
  updatedAt: string;
}> = {}) {
  return {
    sessionId: overrides.sessionId ?? "agent-session",
    traceId: "trace-1",
    turnId: "turn-1",
    goalId: "goal-1",
    cwd: "/repo",
    modelRef: "native:test",
    messages: [],
    modelTurns: 1,
    toolCalls: 0,
    compactions: 0,
    completionValidationAttempts: 0,
    calledTools: [],
    lastToolLoopSignature: null,
    repeatedToolLoopCount: 0,
    finalText: "",
    status: overrides.status ?? "running",
    updatedAt: overrides.updatedAt ?? "2026-04-25T00:01:00.000Z",
  };
}

function makeProcessSnapshot(overrides: Partial<ProcessSessionSnapshot> = {}): ProcessSessionSnapshot {
  return {
    session_id: overrides.session_id ?? "proc-1",
    label: overrides.label ?? "training",
    command: overrides.command ?? "node",
    args: overrides.args ?? ["train.js"],
    cwd: overrides.cwd ?? "/repo",
    pid: overrides.pid ?? 12345,
    running: overrides.running ?? true,
    exitCode: overrides.exitCode ?? null,
    signal: overrides.signal ?? null,
    startedAt: overrides.startedAt ?? "2026-04-25T00:00:00.000Z",
    ...(overrides.exitedAt ? { exitedAt: overrides.exitedAt } : {}),
    bufferedChars: overrides.bufferedChars ?? 0,
    metadataRelativePath: overrides.metadataRelativePath ?? `runtime/process-sessions/${overrides.session_id ?? "proc-1"}.json`,
    artifactRefs: overrides.artifactRefs ?? [],
  };
}
