import { describe, it, expect, vi, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { LoopSupervisor } from "../executor/loop-supervisor.js";
import { EventBus } from "../queue/event-bus.js";
import { createEnvelope } from "../types/envelope.js";
import type { LoopResult } from "../../orchestrator/loop/core-loop.js";

function makeLoopResult(o: Partial<LoopResult> = {}): LoopResult {
  return { goalId: "g", totalIterations: 1, finalStatus: "completed", iterations: [],
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), ...o };
}

function makeSupervisor(coreLoopImpl?: () => Promise<LoopResult> | never, extra: Record<string, unknown> = {}) {
  const stateFile = path.join(os.tmpdir(), `sv-${Date.now()}-${Math.random()}.json`);
  const eventBus = new EventBus();
  const mockCoreLoop = { run: vi.fn().mockImplementation(coreLoopImpl ?? (() => Promise.resolve(makeLoopResult()))), stop: vi.fn() };
  const deps = {
    coreLoop: mockCoreLoop as any,
    eventBus,
    driveSystem: { shouldActivate: vi.fn(), prioritizeGoals: vi.fn(), startWatcher: vi.fn(), stopWatcher: vi.fn(), writeEvent: vi.fn() } as any,
    stateManager: { getBaseDir: vi.fn().mockReturnValue(os.tmpdir()) } as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    onEscalation: vi.fn(),
    ...extra,
  };
  const supervisor = new LoopSupervisor(deps, {
    concurrency: 2, pollIntervalMs: 20, maxCrashCount: 3,
    crashBackoffBaseMs: 50, stateFilePath: stateFile,
  });
  return { supervisor, deps, eventBus: deps.eventBus as EventBus, mockCoreLoop, stateFile, onEscalation: deps.onEscalation };
}

describe("LoopSupervisor", () => {
  // ─── 1. start() pushes goal_activated and workers pick them up ───

  it("start() calls coreLoop.run for initial goals", async () => {
    const { supervisor, mockCoreLoop } = makeSupervisor();
    await supervisor.start(["g1"]);
    await new Promise((r) => setTimeout(r, 80));
    await supervisor.shutdown();
    expect(mockCoreLoop.run).toHaveBeenCalledWith("g1", expect.anything());
  });

  // ─── 2. Goal Exclusivity: coalescing ───

  it("coalesces duplicate goal_activated via requestExtend (re-runs)", async () => {
    let callCount = 0;
    const eventBus = new EventBus();
    const { supervisor, mockCoreLoop } = makeSupervisor(async (goalId: string) => {
      callCount++;
      if (callCount === 1) {
        eventBus.push(createEnvelope({ type: "event", name: "goal_activated",
          source: "test", goal_id: "g1", payload: {}, priority: "normal" }));
        await new Promise((r) => setTimeout(r, 30));
      }
      return makeLoopResult({ goalId });
    }, { eventBus } as any);
    await supervisor.start(["g1"]);
    await new Promise((r) => setTimeout(r, 200));
    await supervisor.shutdown();
    expect(mockCoreLoop.run).toHaveBeenCalledTimes(2);
  });

  // ─── 3. Suspended goals are skipped ───

  it("suspended goals are not re-queued on subsequent polls", async () => {
    let callCount = 0;
    const onEscalation = vi.fn();
    const { supervisor, mockCoreLoop } = makeSupervisor(async () => {
      callCount++;
      throw new Error("crash");
    }, { onEscalation } as any);
    // maxCrashCount=3 — after 3 crashes, goal is suspended
    const sv = new LoopSupervisor(
      { ...(supervisor as any).deps, onEscalation, coreLoop: mockCoreLoop as any },
      { concurrency: 1, pollIntervalMs: 20, maxCrashCount: 2, crashBackoffBaseMs: 20,
        stateFilePath: path.join(os.tmpdir(), `sv-susp-${Date.now()}.json`) }
    );
    await sv.start(["g-susp"]);
    await new Promise((r) => setTimeout(r, 400));
    await sv.shutdown();
    expect(onEscalation).toHaveBeenCalledWith("g-susp", expect.any(Number), expect.any(String));
  });

  // ─── 4. Crash recovery re-queues under threshold ───

  it("re-queues goal after crash under threshold", async () => {
    let calls = 0;
    const { supervisor, mockCoreLoop } = makeSupervisor(async () => {
      calls++;
      if (calls === 1) throw new Error("first crash");
      return makeLoopResult();
    });
    // Override with tighter backoff
    const sv = new LoopSupervisor((supervisor as any).deps, {
      concurrency: 1, pollIntervalMs: 20, maxCrashCount: 3,
      crashBackoffBaseMs: 30, stateFilePath: path.join(os.tmpdir(), `sv-retry-${Date.now()}.json`),
    });
    await sv.start(["g-retry"]);
    await new Promise((r) => setTimeout(r, 300));
    await sv.shutdown();
    expect(mockCoreLoop.run.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // ─── 5. shutdown() ───

  it("shutdown() resolves after workers complete", async () => {
    const { supervisor } = makeSupervisor();
    await supervisor.start(["g1"]);
    await new Promise((r) => setTimeout(r, 40));
    await expect(supervisor.shutdown()).resolves.toBeUndefined();
  });

  it("shutdown() is safe without start()", async () => {
    const { supervisor } = makeSupervisor();
    await expect(supervisor.shutdown()).resolves.toBeUndefined();
  });

  // ─── 6. State persistence ───

  it("writes supervisor-state.json after execution", async () => {
    const { supervisor, stateFile } = makeSupervisor();
    await supervisor.start(["g1"]);
    await new Promise((r) => setTimeout(r, 100));
    await supervisor.shutdown();
    expect(fs.existsSync(stateFile)).toBe(true);
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(state).toHaveProperty("workers");
    expect(state).toHaveProperty("crashCounts");
    fs.rmSync(stateFile, { force: true });
  });

  // ─── 7. Concurrency limit ───

  it("runs at most N workers simultaneously", async () => {
    let concurrent = 0; let max = 0;
    const { supervisor } = makeSupervisor(async () => {
      concurrent++; max = Math.max(max, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
      return makeLoopResult();
    });
    const sv = new LoopSupervisor((supervisor as any).deps, {
      concurrency: 2, pollIntervalMs: 20, maxCrashCount: 3,
      crashBackoffBaseMs: 50, stateFilePath: path.join(os.tmpdir(), `sv-conc-${Date.now()}.json`),
    });
    await sv.start(["g1", "g2", "g3"]);
    await new Promise((r) => setTimeout(r, 200));
    await sv.shutdown();
    expect(max).toBeLessThanOrEqual(2);
  });
});
