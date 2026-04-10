import { describe, it, expect, vi, beforeEach } from "vitest";
import { GoalWorker } from "../executor/goal-worker.js";
import type { LoopResult } from "../../orchestrator/loop/core-loop.js";

function makeLoopResult(overrides: Partial<LoopResult> = {}): LoopResult {
  return {
    goalId: "test-goal",
    totalIterations: 3,
    finalStatus: "completed",
    iterations: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockCoreLoop(result: LoopResult | Error = makeLoopResult()) {
  return {
    run: result instanceof Error
      ? vi.fn().mockRejectedValue(result)
      : vi.fn().mockResolvedValue(result),
    stop: vi.fn(),
  };
}

describe("GoalWorker", () => {
  // ─── 1. Status transitions ───

  describe("status transitions", () => {
    it("starts idle before execution", () => {
      const coreLoop = makeMockCoreLoop();
      const worker = new GoalWorker(coreLoop as any);
      expect(worker.getStatus()).toBe("idle");
      expect(worker.isIdle()).toBe(true);
    });

    it("is running during execute, returns to idle after", async () => {
      let statusDuringRun: string | undefined;
      const coreLoop = {
        run: vi.fn().mockImplementation(async () => {
          statusDuringRun = worker.getStatus();
          return makeLoopResult();
        }),
        stop: vi.fn(),
      };
      const worker = new GoalWorker(coreLoop as any);
      await worker.execute("g1");
      expect(statusDuringRun).toBe("running");
      expect(worker.getStatus()).toBe("idle");
    });

    it("becomes crashed then idle after error, result.status === error", async () => {
      let statusDuringCrash: string | undefined;
      const coreLoop = {
        run: vi.fn().mockRejectedValue(new Error("boom")),
        stop: vi.fn(),
      };
      const worker = new GoalWorker(coreLoop as any);
      // Intercept status in finally (after crash, before idle reset)
      // We verify by checking result instead
      const result = await worker.execute("g1");
      expect(result.status).toBe("error");
      expect(result.error).toBe("boom");
      // After execute, status is idle (finally resets running→idle, but crash stays crashed)
      // Actually: finally only resets if status is still "running"; crash leaves status = "crashed"
      expect(worker.getStatus()).toBe("crashed");
    });
  });

  // ─── 2. WorkerResult mapping ───

  describe("execute() returns correct WorkerResult", () => {
    it("maps completed LoopResult to completed WorkerResult", async () => {
      const loopResult = makeLoopResult({ goalId: "g1", totalIterations: 5, finalStatus: "completed" });
      const worker = new GoalWorker(makeMockCoreLoop(loopResult) as any);
      const result = await worker.execute("g1");
      expect(result.goalId).toBe("g1");
      expect(result.status).toBe("completed");
      expect(result.totalIterations).toBe(5);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("maps stalled LoopResult to stalled WorkerResult", async () => {
      const loopResult = makeLoopResult({ finalStatus: "stalled" });
      const worker = new GoalWorker(makeMockCoreLoop(loopResult) as any);
      const result = await worker.execute("g1");
      expect(result.status).toBe("stalled");
    });

    it("returns error status and message on thrown error", async () => {
      const worker = new GoalWorker(makeMockCoreLoop(new Error("network failure")) as any);
      const result = await worker.execute("g1");
      expect(result.status).toBe("error");
      expect(result.error).toBe("network failure");
      expect(result.totalIterations).toBe(0);
    });

    it("does not convert a successful loop into worker error when onRunComplete throws", async () => {
      const loopResult = makeLoopResult({ goalId: "g1", totalIterations: 2, finalStatus: "completed" });
      const worker = new GoalWorker(
        makeMockCoreLoop(loopResult) as any,
        undefined,
        {
          onRunComplete: vi.fn().mockRejectedValue(new Error("state write failed")),
        }
      );

      const result = await worker.execute("g1");

      expect(result.status).toBe("completed");
      expect(result.totalIterations).toBe(2);
      expect(result.error).toBeUndefined();
    });
  });

  // ─── 3. requestExtend() ───

  describe("requestExtend()", () => {
    it("causes re-execution after current run completes", async () => {
      let callCount = 0;
      const coreLoop = {
        run: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            // Request extend during first run
            worker.requestExtend();
          }
          return makeLoopResult();
        }),
        stop: vi.fn(),
      };
      const worker = new GoalWorker(coreLoop as any);
      await worker.execute("g1");
      expect(callCount).toBe(2);
    });

    it("does not extend when not requested", async () => {
      const coreLoop = makeMockCoreLoop();
      const worker = new GoalWorker(coreLoop as any);
      await worker.execute("g1");
      expect(coreLoop.run).toHaveBeenCalledOnce();
    });
  });

  // ─── 4. Multiple sequential executions ───

  describe("multiple sequential executions", () => {
    it("executes correctly in sequence", async () => {
      const coreLoop = makeMockCoreLoop();
      const worker = new GoalWorker(coreLoop as any);
      const r1 = await worker.execute("g1");
      const r2 = await worker.execute("g2");
      expect(r1.status).toBe("completed");
      expect(r2.status).toBe("completed");
      expect(coreLoop.run).toHaveBeenCalledTimes(2);
    });

    it("resets to idle between executions", async () => {
      const coreLoop = makeMockCoreLoop();
      const worker = new GoalWorker(coreLoop as any);
      await worker.execute("g1");
      expect(worker.isIdle()).toBe(true);
      await worker.execute("g2");
      expect(worker.isIdle()).toBe(true);
    });
  });

  // ─── 5. Worker id uniqueness ───

  describe("worker id", () => {
    it("has a unique id per instance (crypto.randomUUID)", () => {
      const c = makeMockCoreLoop();
      const w1 = new GoalWorker(c as any);
      const w2 = new GoalWorker(c as any);
      expect(w1.id).toBeTruthy();
      expect(w2.id).toBeTruthy();
      expect(w1.id).not.toBe(w2.id);
    });

    it("id matches UUID format", () => {
      const w = new GoalWorker(makeMockCoreLoop() as any);
      expect(w.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });
  });
});
