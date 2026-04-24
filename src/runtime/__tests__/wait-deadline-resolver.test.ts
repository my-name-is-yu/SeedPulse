import * as fs from "node:fs";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { StateManager } from "../../base/state/state-manager.js";
import { WaitDeadlineResolver, clampIntervalToNextWaitDeadline } from "../daemon/wait-deadline-resolver.js";
import { makeTempDir } from "../../../tests/helpers/temp-dir.js";

let tempDir: string;
let stateManager: StateManager;

beforeEach(() => {
  tempDir = makeTempDir("pulseed-wait-deadline-");
  stateManager = new StateManager(tempDir);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function makeActiveWaitStrategy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "wait-1",
    goal_id: "goal-1",
    target_dimensions: ["quality"],
    primary_dimension: "quality",
    hypothesis: "Wait for external job completion",
    expected_effect: [],
    resource_estimate: {
      sessions: 0,
      duration: { value: 0, unit: "hours" },
      llm_calls: null,
    },
    state: "active",
    allocation: 1,
    created_at: "2026-04-24T12:00:00.000Z",
    started_at: "2026-04-24T12:00:00.000Z",
    completed_at: null,
    gap_snapshot_at_start: 0.5,
    tasks_generated: [],
    effectiveness_score: null,
    consecutive_stall_count: 0,
    wait_reason: "External job is still running",
    wait_until: "2026-04-24T12:10:00.000Z",
    measurement_plan: "Check the output file",
    fallback_strategy_id: null,
    ...overrides,
  };
}

describe("WaitDeadlineResolver", () => {
  it("resolves next_observe_at from durable wait metadata", async () => {
    await stateManager.writeRaw("strategies/goal-1/portfolio.json", {
      goal_id: "goal-1",
      strategies: [makeActiveWaitStrategy()],
      rebalance_interval: { value: 1, unit: "hours" },
      last_rebalanced_at: "2026-04-24T12:00:00.000Z",
    });
    await stateManager.writeRaw("strategies/goal-1/wait-meta/wait-1.json", {
      schema_version: 1,
      wait_until: "2026-04-24T12:10:00.000Z",
      conditions: [{ type: "time_until", until: "2026-04-24T12:03:00.000Z" }],
      resume_plan: { action: "complete_wait" },
    });

    const resolution = await new WaitDeadlineResolver(stateManager).resolve(["goal-1"]);

    expect(resolution.next_observe_at).toBe("2026-04-24T12:03:00.000Z");
    expect(resolution.waiting_goals).toEqual([
      expect.objectContaining({
        goal_id: "goal-1",
        strategy_id: "wait-1",
        next_observe_at: "2026-04-24T12:03:00.000Z",
      }),
    ]);
  });

  it("falls back to wait_until when legacy wait metadata has no conditions", async () => {
    await stateManager.writeRaw("strategies/goal-1/portfolio.json", {
      goal_id: "goal-1",
      strategies: [makeActiveWaitStrategy()],
      rebalance_interval: { value: 1, unit: "hours" },
      last_rebalanced_at: "2026-04-24T12:00:00.000Z",
    });
    await stateManager.writeRaw("strategies/goal-1/wait-meta/wait-1.json", {
      wait_until: "2026-04-24T12:10:00.000Z",
    });

    const resolution = await new WaitDeadlineResolver(stateManager).resolve(["goal-1"]);

    expect(resolution.next_observe_at).toBe("2026-04-24T12:10:00.000Z");
  });

  it("does not throw and falls back to wait_until when wait metadata is malformed", async () => {
    await stateManager.writeRaw("strategies/goal-1/portfolio.json", {
      goal_id: "goal-1",
      strategies: [makeActiveWaitStrategy()],
      rebalance_interval: { value: 1, unit: "hours" },
      last_rebalanced_at: "2026-04-24T12:00:00.000Z",
    });
    await stateManager.writeRaw("strategies/goal-1/wait-meta/wait-1.json", {
      schema_version: 1,
      wait_until: "2026-04-24T12:10:00.000Z",
      conditions: [{ type: "metric_threshold", metric: "quality", operator: "gte" }],
      resume_plan: { action: "complete_wait" },
    });

    const resolution = await new WaitDeadlineResolver(stateManager).resolve(["goal-1"]);

    expect(resolution.next_observe_at).toBe("2026-04-24T12:10:00.000Z");
    expect(resolution.waiting_goals).toEqual([
      expect.objectContaining({
        goal_id: "goal-1",
        strategy_id: "wait-1",
        next_observe_at: "2026-04-24T12:10:00.000Z",
      }),
    ]);
  });

  it("lets durable next_observe_at postpone an original wait_until after re-wait", async () => {
    await stateManager.writeRaw("strategies/goal-1/portfolio.json", {
      goal_id: "goal-1",
      strategies: [makeActiveWaitStrategy()],
      rebalance_interval: { value: 1, unit: "hours" },
      last_rebalanced_at: "2026-04-24T12:00:00.000Z",
    });
    await stateManager.writeRaw("strategies/goal-1/wait-meta/wait-1.json", {
      schema_version: 1,
      wait_until: "2026-04-24T12:10:00.000Z",
      conditions: [{ type: "time_until", until: "2026-04-24T12:10:00.000Z" }],
      next_observe_at: "2026-04-24T12:30:00.000Z",
      resume_plan: { action: "complete_wait" },
    });

    const resolution = await new WaitDeadlineResolver(stateManager).resolve(["goal-1"]);

    expect(resolution.next_observe_at).toBe("2026-04-24T12:30:00.000Z");
  });

  it("clamps interval so daemon sleep cannot overshoot the next wait deadline", () => {
    const clamped = clampIntervalToNextWaitDeadline(
      300_000,
      "2026-04-24T12:01:00.000Z",
      Date.parse("2026-04-24T12:00:00.000Z")
    );

    expect(clamped).toBe(60_000);
  });
});
