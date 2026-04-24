import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import {
  parseStrategy,
  parseStrategies,
  normalizeWaitMetadata,
  PortfolioSchema,
  StrategySchema,
  WaitMetadataSchema,
  WaitStrategySchema,
} from "../../../base/types/strategy.js";
import { isWaitStrategy } from "../portfolio-allocation.js";
import { StateManager } from "../../../base/state/state-manager.js";
import { StrategyManager } from "../strategy-manager.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

// ─── Fixtures ───

function makeBaseStrategyData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "strategy-1",
    goal_id: "goal-1",
    target_dimensions: ["dimension_a"],
    primary_dimension: "dimension_a",
    hypothesis: "Increase output by focusing on key metrics",
    expected_effect: [{ dimension: "dimension_a", direction: "increase", magnitude: "medium" }],
    resource_estimate: { sessions: 5, duration: { value: 7, unit: "days" }, llm_calls: null },
    state: "candidate",
    allocation: 0,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    gap_snapshot_at_start: null,
    tasks_generated: [],
    effectiveness_score: null,
    consecutive_stall_count: 0,
    ...overrides,
  };
}

function makeWaitStrategyData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return makeBaseStrategyData({
    id: "wait-strategy-1",
    wait_reason: "Waiting for external data to stabilize",
    wait_until: "2026-04-14T00:00:00.000Z",
    measurement_plan: "Check metrics after wait period ends",
    fallback_strategy_id: null,
    ...overrides,
  });
}

// ─── parseStrategy() tests ───

describe("parseStrategy()", () => {
  it("returns WaitStrategy when wait-specific fields are present", () => {
    const data = makeWaitStrategyData();
    const result = parseStrategy(data);

    expect(result).toMatchObject({
      id: "wait-strategy-1",
      wait_reason: "Waiting for external data to stabilize",
      wait_until: "2026-04-14T00:00:00.000Z",
      measurement_plan: "Check metrics after wait period ends",
      fallback_strategy_id: null,
    });
  });

  it("preserves all 4 WaitStrategy extension fields", () => {
    const data = makeWaitStrategyData({
      fallback_strategy_id: "fallback-123",
    });
    const result = parseStrategy(data);

    expect((result as { wait_reason: string }).wait_reason).toBe("Waiting for external data to stabilize");
    expect((result as { wait_until: string }).wait_until).toBe("2026-04-14T00:00:00.000Z");
    expect((result as { measurement_plan: string }).measurement_plan).toBe("Check metrics after wait period ends");
    expect((result as { fallback_strategy_id: string }).fallback_strategy_id).toBe("fallback-123");
  });

  it("returns base Strategy when no wait-specific fields are present", () => {
    const data = makeBaseStrategyData();
    const result = parseStrategy(data);

    expect(result).toMatchObject({ id: "strategy-1", hypothesis: "Increase output by focusing on key metrics" });
    expect((result as Record<string, unknown>)["wait_reason"]).toBeUndefined();
    expect((result as Record<string, unknown>)["wait_until"]).toBeUndefined();
  });
});

// ─── parseStrategies() tests ───

describe("parseStrategies()", () => {
  it("parses mixed array of base and wait strategies", () => {
    const data = [makeBaseStrategyData(), makeWaitStrategyData()];
    const results = parseStrategies(data);

    expect(results).toHaveLength(2);
    expect((results[1] as Record<string, unknown>)["wait_reason"]).toBe("Waiting for external data to stabilize");
  });
});

// ─── PortfolioSchema round-trip test ───

describe("PortfolioSchema", () => {
  it("preserves WaitStrategy fields after parse", () => {
    const portfolioData = {
      goal_id: "goal-1",
      strategies: [makeWaitStrategyData()],
      rebalance_interval: { value: 7, unit: "days" },
      last_rebalanced_at: new Date().toISOString(),
    };

    const parsed = PortfolioSchema.parse(portfolioData);
    const strategy = parsed.strategies[0];

    expect((strategy as Record<string, unknown>)["wait_reason"]).toBe("Waiting for external data to stabilize");
    expect((strategy as Record<string, unknown>)["wait_until"]).toBe("2026-04-14T00:00:00.000Z");
    expect((strategy as Record<string, unknown>)["measurement_plan"]).toBe("Check metrics after wait period ends");
  });

  it("isWaitStrategy returns true after PortfolioSchema round-trip", () => {
    const portfolioData = {
      goal_id: "goal-1",
      strategies: [makeWaitStrategyData()],
      rebalance_interval: { value: 7, unit: "days" },
      last_rebalanced_at: new Date().toISOString(),
    };

    const parsed = PortfolioSchema.parse(portfolioData);
    const strategy = parsed.strategies[0]!;

    expect(isWaitStrategy(strategy as Record<string, unknown>)).toBe(true);
  });
});

// ─── Full persistence round-trip test ───

describe("WaitStrategy persistence round-trip", () => {
  const CANDIDATE_RESPONSE = `\`\`\`json
[
  {
    "hypothesis": "Increase output via focused sessions",
    "expected_effect": [{ "dimension": "output", "direction": "increase", "magnitude": "medium" }],
    "resource_estimate": { "sessions": 5, "duration": { "value": 7, "unit": "days" }, "llm_calls": null }
  }
]
\`\`\``;

  it("createWaitStrategy → save → reload → isWaitStrategy returns true", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE]);
    const manager = new StrategyManager(stateManager, mock);

    const waitStrategy = await manager.createWaitStrategy("goal-1", {
      hypothesis: "Wait for market conditions to improve",
      wait_reason: "External factor dependency",
      wait_until: "2026-04-14T00:00:00.000Z",
      measurement_plan: "Review metrics after wait",
      fallback_strategy_id: null,
      target_dimensions: ["revenue"],
      primary_dimension: "revenue",
    });

    // Verify the returned strategy has wait fields
    expect(isWaitStrategy(waitStrategy as Record<string, unknown>)).toBe(true);
    expect((waitStrategy as Record<string, unknown>)["wait_reason"]).toBe("External factor dependency");

    // Reload portfolio and verify fields are preserved
    const portfolio = await manager.getPortfolio("goal-1");
    expect(portfolio).not.toBeNull();
    const loaded = portfolio!.strategies.find((s) => s.id === waitStrategy.id);
    expect(loaded).toBeDefined();
    expect(isWaitStrategy(loaded as Record<string, unknown>)).toBe(true);
    expect((loaded as Record<string, unknown>)["wait_until"]).toBe("2026-04-14T00:00:00.000Z");

    const metadata = WaitMetadataSchema.parse(
      await stateManager.readRaw(`strategies/goal-1/wait-meta/${waitStrategy.id}.json`)
    );
    expect(metadata.wait_until).toBe("2026-04-14T00:00:00.000Z");
    expect(metadata.conditions).toEqual([
      { type: "time_until", until: "2026-04-14T00:00:00.000Z" },
    ]);
    expect(metadata.resume_plan).toEqual({ action: "complete_wait" });
  });

  it("normalizes legacy wait-meta sidecars into the durable wait metadata contract", async () => {
    const waitStrategy = WaitStrategySchema.parse(makeWaitStrategyData({
      wait_until: "2026-04-14T00:00:00.000Z",
      fallback_strategy_id: "fallback-1",
    }));

    const metadata = normalizeWaitMetadata(waitStrategy, {
      wait_until: "2026-04-14T00:00:00.000Z",
    });

    expect(metadata.schema_version).toBe(1);
    expect(metadata.conditions).toEqual([
      { type: "time_until", until: "2026-04-14T00:00:00.000Z" },
    ]);
    expect(metadata.resume_plan).toEqual({
      action: "activate_fallback",
      strategy_id: "fallback-1",
    });
  });

  it("WaitStrategy fields preserved after updateState (terminated)", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE]);
    const manager = new StrategyManager(stateManager, mock);

    const waitStrategy = await manager.createWaitStrategy("goal-1", {
      hypothesis: "Wait for seasonal demand",
      wait_reason: "Seasonal pattern",
      wait_until: "2026-05-01T00:00:00.000Z",
      measurement_plan: "Analyze demand post-season",
      fallback_strategy_id: null,
      target_dimensions: ["demand"],
      primary_dimension: "demand",
    });

    await manager.activateMultiple("goal-1", [waitStrategy.id]);
    await manager.updateState(waitStrategy.id, "terminated");

    // Check history preserves wait fields
    const history = await manager.getStrategyHistory("goal-1");
    const terminated = history.find((s) => s.id === waitStrategy.id);
    expect(terminated).toBeDefined();
    expect(isWaitStrategy(terminated as Record<string, unknown>)).toBe(true);
    expect((terminated as Record<string, unknown>)["wait_reason"]).toBe("Seasonal pattern");
  });
});
