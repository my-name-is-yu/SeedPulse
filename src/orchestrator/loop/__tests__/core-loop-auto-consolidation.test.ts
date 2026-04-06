import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import {
  CoreLoop,
} from "../core-loop.js";
import { StateManager } from "../../../base/state/state-manager.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { makeGoal } from "../../../../tests/helpers/fixtures.js";

// ─── Helpers ───

function makeCompletedIteration() {
  return {
    loopIndex: 0,
    goalId: "goal-1",
    gapAggregate: 0,
    driveScores: [],
    taskResult: {
      task: { id: "task-1", primary_dimension: "dim1" },
      verificationResult: { verdict: "pass" },
      action: "completed",
    },
    stallDetected: false,
    stallReport: null,
    pivotOccurred: false,
    completionJudgment: {
      is_complete: true,
      blocking_dimensions: [],
      low_confidence_dimensions: [],
      needs_verification_task: false,
      checked_at: new Date().toISOString(),
    },
    elapsedMs: 1,
    error: null,
  };
}

function makeMinimalDeps(stateManager: StateManager) {
  return {
    stateManager,
    observationEngine: {} as any,
    gapCalculator: {} as any,
    driveScorer: {} as any,
    taskLifecycle: {} as any,
    satisficingJudge: {} as any,
    stallDetector: { resetEscalation: vi.fn() } as any,
    strategyManager: {} as any,
    reportingEngine: {
      generateExecutionSummary: vi.fn().mockReturnValue({ type: "execution_summary" }),
      saveReport: vi.fn(),
    } as any,
    driveSystem: {} as any,
    adapterRegistry: { listAdapters: () => ["mock"] } as any,
    learningPipeline: {
      checkPeriodicReview: vi.fn().mockResolvedValue(undefined),
      onGoalCompleted: vi.fn().mockResolvedValue(undefined),
      getCapabilityFailures: vi.fn().mockReturnValue([]),
      incrementTransferCounter: vi.fn(),
    } as any,
  };
}

// ─── Tests ───

describe("CoreLoop auto-consolidation", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("calls autoConsolidate on goal completion when enabled (default)", async () => {
    await stateManager.saveGoal(makeGoal());

    const autoConsolidate = vi.fn().mockResolvedValue({ consolidated: false });
    const knowledgeManager = { autoConsolidate } as any;

    const deps = { ...makeMinimalDeps(stateManager), knowledgeManager };
    const loop = new CoreLoop(deps, { maxIterations: 1, delayBetweenLoopsMs: 0 });
    vi.spyOn(loop, "runOneIteration").mockResolvedValueOnce(makeCompletedIteration() as any);

    const result = await loop.run("goal-1");

    expect(result.finalStatus).toBe("completed");
    expect(autoConsolidate).toHaveBeenCalledOnce();
    expect(autoConsolidate).toHaveBeenCalledWith({ rawThreshold: 20 });
  });

  it("skips autoConsolidate when autoConsolidateOnComplete is false", async () => {
    await stateManager.saveGoal(makeGoal());

    const autoConsolidate = vi.fn().mockResolvedValue({ consolidated: false });
    const knowledgeManager = { autoConsolidate } as any;

    const deps = { ...makeMinimalDeps(stateManager), knowledgeManager };
    const loop = new CoreLoop(deps, {
      maxIterations: 1,
      delayBetweenLoopsMs: 0,
      autoConsolidateOnComplete: false,
    });
    vi.spyOn(loop, "runOneIteration").mockResolvedValueOnce(makeCompletedIteration() as any);

    const result = await loop.run("goal-1");

    expect(result.finalStatus).toBe("completed");
    expect(autoConsolidate).not.toHaveBeenCalled();
  });

  it("is non-fatal when autoConsolidate throws", async () => {
    await stateManager.saveGoal(makeGoal());

    const autoConsolidate = vi.fn().mockRejectedValue(new Error("Unexpected failure"));
    const knowledgeManager = { autoConsolidate } as any;

    const deps = { ...makeMinimalDeps(stateManager), knowledgeManager };
    const loop = new CoreLoop(deps, { maxIterations: 1, delayBetweenLoopsMs: 0 });
    vi.spyOn(loop, "runOneIteration").mockResolvedValueOnce(makeCompletedIteration() as any);

    // Should not throw — consolidation failure must never crash the loop
    const result = await loop.run("goal-1");
    expect(result.finalStatus).toBe("completed");
  });

  it("passes consolidationRawThreshold from config to autoConsolidate", async () => {
    await stateManager.saveGoal(makeGoal());

    const autoConsolidate = vi.fn().mockResolvedValue({ consolidated: false });
    const knowledgeManager = { autoConsolidate } as any;

    const deps = { ...makeMinimalDeps(stateManager), knowledgeManager };
    const loop = new CoreLoop(deps, {
      maxIterations: 1,
      delayBetweenLoopsMs: 0,
      consolidationRawThreshold: 50,
    });
    vi.spyOn(loop, "runOneIteration").mockResolvedValueOnce(makeCompletedIteration() as any);

    await loop.run("goal-1");

    expect(autoConsolidate).toHaveBeenCalledWith({ rawThreshold: 50 });
  });

  it("does not call autoConsolidate when goal does not complete (max_iterations)", async () => {
    await stateManager.saveGoal(makeGoal());

    const autoConsolidate = vi.fn().mockResolvedValue({ consolidated: false });
    const knowledgeManager = { autoConsolidate } as any;

    const notCompleted = {
      ...makeCompletedIteration(),
      completionJudgment: {
        is_complete: false,
        blocking_dimensions: ["dim1"],
        low_confidence_dimensions: [],
        needs_verification_task: false,
        checked_at: new Date().toISOString(),
      },
    };

    const deps = { ...makeMinimalDeps(stateManager), knowledgeManager };
    const loop = new CoreLoop(deps, { maxIterations: 1, delayBetweenLoopsMs: 0 });
    vi.spyOn(loop, "runOneIteration").mockResolvedValue(notCompleted as any);

    const result = await loop.run("goal-1");

    expect(result.finalStatus).toBe("max_iterations");
    expect(autoConsolidate).not.toHaveBeenCalled();
  });
});
