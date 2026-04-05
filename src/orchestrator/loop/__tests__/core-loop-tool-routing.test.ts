/**
 * core-loop-tool-routing.test.ts
 *
 * Integration tests for Phase B ToolExecutor routing paths in CoreLoop phases.
 *
 * Phase 2: observeAndReload() routes through toolExecutor.execute("observe-goal")
 *   when toolExecutor is present, with fallback to direct engine.observe().
 *
 * buildLoopToolContext: helper that constructs a ToolCallContext with
 *   preApproved: true, reads trustBalance from trustManager.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { observeAndReload, buildLoopToolContext } from "../core-loop-phases.js";
import type { PhaseCtx } from "../core-loop-phases.js";
import type { Goal } from "../../../base/types/goal.js";

// ─── Helpers ───

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-routing-1",
    title: "Routing Test Goal",
    description: "Test goal for tool routing",
    dimensions: [
      {
        name: "coverage",
        threshold: { type: "min" as const, value: 80 },
        current_value: 50,
        confidence: 0.7,
        weight: 1.0,
        last_updated: new Date().toISOString(),
        observation_method: { type: "llm" as const },
      },
    ],
    gap_aggregation: "max",
    uncertainty_weight: 1.0,
    status: "active",
    origin: "general",
    children_ids: [],
    deadline: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeSuccessToolResult() {
  return {
    success: true,
    data: null,
    summary: "Observation completed",
    durationMs: 10,
  };
}

function makeFailureToolResult(error = "Tool failed") {
  return {
    success: false,
    data: null,
    summary: "Observation failed",
    error,
    durationMs: 5,
  };
}

function makeObservationEngine() {
  return {
    observe: vi.fn().mockResolvedValue(undefined),
    getDataSources: vi.fn().mockReturnValue([]),
  };
}

function makeStateManager(reloadedGoal: Goal | null = null) {
  return {
    loadGoal: vi.fn().mockResolvedValue(reloadedGoal),
    saveGoal: vi.fn().mockResolvedValue(undefined),
    appendGapHistoryEntry: vi.fn().mockResolvedValue(undefined),
    loadGapHistory: vi.fn().mockResolvedValue([]),
  };
}

function makeToolExecutor(result = makeSuccessToolResult()) {
  return {
    execute: vi.fn().mockResolvedValue(result),
  };
}

function makeTrustManager(balance = 42) {
  return {
    getBalance: vi.fn().mockResolvedValue({ balance }),
  };
}

function makePhaseCtx(overrides: {
  toolExecutor?: PhaseCtx["toolExecutor"];
  stateManagerOverrides?: Record<string, unknown>;
  trustManagerOverride?: unknown;
  observationEngineOverride?: unknown;
} = {}): PhaseCtx {
  const stateManager = {
    ...makeStateManager(),
    ...overrides.stateManagerOverrides,
  };

  const observationEngine = overrides.observationEngineOverride ?? makeObservationEngine();

  return {
    deps: {
      stateManager,
      observationEngine,
      satisficingJudge: {
        isGoalComplete: vi.fn().mockReturnValue({
          is_complete: false,
          blocking_dimensions: [],
          low_confidence_dimensions: [],
          needs_verification_task: false,
          checked_at: new Date().toISOString(),
        }),
        judgeTreeCompletion: vi.fn(),
      },
      trustManager: overrides.trustManagerOverride ?? undefined,
    } as unknown as PhaseCtx["deps"],
    config: {
      maxIterations: 10,
      adapterType: "test-adapter",
    } as unknown as PhaseCtx["config"],
    logger: undefined,
    toolExecutor: overrides.toolExecutor,
  };
}

// ─── Tests ───

describe("CoreLoop Phase B — ToolExecutor routing", () => {

  describe("Phase 2: observeAndReload with ToolExecutor", () => {
    it("calls toolExecutor.execute('observe-goal') when toolExecutor is present", async () => {
      const goal = makeGoal();
      const toolExecutor = makeToolExecutor();
      const reloadedGoal = makeGoal({ id: "goal-routing-1", title: "Reloaded" });
      const ctx = makePhaseCtx({
        toolExecutor: toolExecutor as unknown as PhaseCtx["toolExecutor"],
        stateManagerOverrides: {
          loadGoal: vi.fn().mockResolvedValue(reloadedGoal),
        },
      });

      await observeAndReload(ctx, "goal-routing-1", goal, 0);

      expect(toolExecutor.execute).toHaveBeenCalledTimes(1);
      expect(toolExecutor.execute).toHaveBeenCalledWith(
        "observe-goal",
        expect.objectContaining({ goal_id: "goal-routing-1" }),
        expect.any(Object)
      );
    });

    it("passes correct goal_id to observe-goal tool", async () => {
      const goal = makeGoal({ id: "my-special-goal" });
      const toolExecutor = makeToolExecutor();
      const ctx = makePhaseCtx({
        toolExecutor: toolExecutor as unknown as PhaseCtx["toolExecutor"],
        stateManagerOverrides: {
          loadGoal: vi.fn().mockResolvedValue(goal),
        },
      });

      await observeAndReload(ctx, "my-special-goal", goal, 0);

      const [, input] = toolExecutor.execute.mock.calls[0];
      expect((input as { goal_id: string }).goal_id).toBe("my-special-goal");
    });

    it("reloads goal from stateManager after successful observation", async () => {
      const goal = makeGoal();
      const reloadedGoal = makeGoal({ title: "Updated After Observation" });
      const stateManager = makeStateManager(reloadedGoal);
      const toolExecutor = makeToolExecutor(makeSuccessToolResult());
      const ctx = makePhaseCtx({
        toolExecutor: toolExecutor as unknown as PhaseCtx["toolExecutor"],
        stateManagerOverrides: stateManager,
      });

      const result = await observeAndReload(ctx, "goal-routing-1", goal, 0);

      expect(stateManager.loadGoal).toHaveBeenCalledWith("goal-routing-1");
      expect(result.title).toBe("Updated After Observation");
    });

    it("falls back to direct engine.observe() when tool returns failure", async () => {
      const goal = makeGoal();
      const observationEngine = makeObservationEngine();
      const stateManager = makeStateManager(goal);
      const toolExecutor = makeToolExecutor(makeFailureToolResult("Observe tool unavailable"));
      const ctx = makePhaseCtx({
        toolExecutor: toolExecutor as unknown as PhaseCtx["toolExecutor"],
        stateManagerOverrides: stateManager,
        observationEngineOverride: observationEngine,
      });

      await observeAndReload(ctx, "goal-routing-1", goal, 0);

      // Tool was tried first
      expect(toolExecutor.execute).toHaveBeenCalledTimes(1);
      // Direct engine.observe() was called as fallback
      expect(observationEngine.observe).toHaveBeenCalledWith("goal-routing-1", []);
    });

    it("falls back to direct engine.observe() when toolExecutor is absent", async () => {
      const goal = makeGoal();
      const observationEngine = makeObservationEngine();
      const ctx = makePhaseCtx({
        toolExecutor: undefined,
        observationEngineOverride: observationEngine,
        stateManagerOverrides: { loadGoal: vi.fn().mockResolvedValue(goal) },
      });

      await observeAndReload(ctx, "goal-routing-1", goal, 0);

      expect(observationEngine.observe).toHaveBeenCalledWith("goal-routing-1", []);
    });

    it("returns original goal when reloaded goal is null after tool success", async () => {
      const goal = makeGoal();
      const toolExecutor = makeToolExecutor(makeSuccessToolResult());
      const ctx = makePhaseCtx({
        toolExecutor: toolExecutor as unknown as PhaseCtx["toolExecutor"],
        stateManagerOverrides: {
          loadGoal: vi.fn().mockResolvedValue(null),
        },
      });

      const result = await observeAndReload(ctx, "goal-routing-1", goal, 0);

      expect(result).toBe(goal);
    });

    it("falls back to direct path when toolExecutor.execute throws", async () => {
      const goal = makeGoal();
      const observationEngine = makeObservationEngine();
      const throwingExecutor = {
        execute: vi.fn().mockRejectedValue(new Error("executor exploded")),
      };
      const ctx = makePhaseCtx({
        toolExecutor: throwingExecutor as unknown as PhaseCtx["toolExecutor"],
        observationEngineOverride: observationEngine,
        stateManagerOverrides: { loadGoal: vi.fn().mockResolvedValue(goal) },
      });

      // Should not throw — falls back gracefully
      await expect(observeAndReload(ctx, "goal-routing-1", goal, 0)).resolves.toBeDefined();
      expect(observationEngine.observe).toHaveBeenCalledWith("goal-routing-1", []);
    });
  });

  describe("buildLoopToolContext", () => {
    it("constructs ToolCallContext with preApproved: true", async () => {
      const ctx = makePhaseCtx();
      const toolCtx = await buildLoopToolContext(ctx, "goal-1");
      expect(toolCtx.preApproved).toBe(true);
    });

    it("includes goalId from parameter", async () => {
      const ctx = makePhaseCtx();
      const toolCtx = await buildLoopToolContext(ctx, "my-goal-id");
      expect(toolCtx.goalId).toBe("my-goal-id");
    });

    it("reads trustBalance from trustManager", async () => {
      const trustManager = makeTrustManager(75);
      const ctx = makePhaseCtx({
        trustManagerOverride: trustManager,
      });

      const toolCtx = await buildLoopToolContext(ctx, "goal-1");

      expect(trustManager.getBalance).toHaveBeenCalledWith("goal-1");
      expect(toolCtx.trustBalance).toBe(75);
    });

    it("defaults trustBalance to 0 when trustManager unavailable", async () => {
      const ctx = makePhaseCtx({ trustManagerOverride: undefined });
      const toolCtx = await buildLoopToolContext(ctx, "goal-1");
      expect(toolCtx.trustBalance).toBe(0);
    });

    it("defaults trustBalance to 0 when trustManager.getBalance throws", async () => {
      const brokenTrustManager = {
        getBalance: vi.fn().mockRejectedValue(new Error("trust DB down")),
      };
      const ctx = makePhaseCtx({ trustManagerOverride: brokenTrustManager });

      const toolCtx = await buildLoopToolContext(ctx, "goal-1");
      expect(toolCtx.trustBalance).toBe(0);
    });

    it("includes a cwd in the context", async () => {
      const ctx = makePhaseCtx();
      const toolCtx = await buildLoopToolContext(ctx, "goal-1");
      expect(typeof toolCtx.cwd).toBe("string");
      expect(toolCtx.cwd.length).toBeGreaterThan(0);
    });

    it("includes an approvalFn that returns false", async () => {
      const ctx = makePhaseCtx();
      const toolCtx = await buildLoopToolContext(ctx, "goal-1");
      expect(typeof toolCtx.approvalFn).toBe("function");
      const result = await toolCtx.approvalFn({} as never);
      expect(result).toBe(false);
    });
  });
});
