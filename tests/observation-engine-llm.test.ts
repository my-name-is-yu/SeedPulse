import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ObservationEngine } from "../src/observation-engine.js";
import { StateManager } from "../src/state-manager.js";
import { GapCalculator } from "../src/gap-calculator.js";
import type { Goal } from "../src/types/goal.js";
import type { ObservationMethod } from "../src/types/core.js";
import type { ILLMClient } from "../src/llm-client.js";
import type { IDataSourceAdapter } from "../src/data-source-adapter.js";
import type { DataSourceConfig } from "../src/types/data-source.js";

// ─── Helpers ───

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-obs-llm-test-"));
}

const defaultMethod: ObservationMethod = {
  type: "llm_review",
  source: "test-runner",
  schedule: null,
  endpoint: null,
  confidence_tier: "independent_review",
};

const selfReportMethod: ObservationMethod = {
  type: "manual",
  source: "self",
  schedule: null,
  endpoint: null,
  confidence_tier: "self_report",
};

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    parent_id: null,
    node_type: "goal",
    title: "Test Goal",
    description: overrides.description ?? "Improve code quality to 80%",
    status: "active",
    dimensions: overrides.dimensions ?? [
      {
        name: "code_quality",
        label: "Code Quality",
        current_value: 0.5,
        threshold: { type: "min", value: 0.8 },
        confidence: 0.3,
        observation_method: defaultMethod,
        last_updated: now,
        history: [],
        weight: 1.0,
        uncertainty_weight: null,
        state_integrity: "ok",
      },
    ],
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: [],
    children_ids: [],
    target_date: null,
    origin: null,
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeDsConfig(overrides: Partial<DataSourceConfig> = {}): DataSourceConfig {
  return {
    id: "mock-ds",
    name: "Mock Data Source",
    type: "file",
    connection: { path: "/tmp/mock.json" },
    enabled: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockDataSource(
  overrides: Partial<IDataSourceAdapter> = {},
  supportedDimensions: string[] = ["code_quality"]
): IDataSourceAdapter {
  return {
    sourceId: "mock-ds",
    sourceType: "file",
    config: makeDsConfig(),
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({
      value: 0.85,
      raw: { metrics: { quality: 0.85 } },
      timestamp: new Date().toISOString(),
      source_id: "mock-ds",
    }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(true),
    getSupportedDimensions: vi.fn().mockReturnValue(supportedDimensions),
    ...overrides,
  };
}

function createMockLLMClient(
  score: number = 0.75,
  reason: string = "test reason"
): ILLMClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({
      content: JSON.stringify({ score, reason }),
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: "end_turn",
    }),
    parseJSON: vi.fn().mockReturnValue({ score, reason }),
  };
}

// ─── Tests ───

describe("ObservationEngine LLM observation", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Test 1: observeWithLLM returns independent_review observation ───

  describe("observeWithLLM", () => {
    it("returns an independent_review observation entry", async () => {
      const mockLLMClient = createMockLLMClient(0.75, "Good progress");
      const engine = new ObservationEngine(stateManager, [], mockLLMClient);

      const goal = makeGoal({ id: "goal-llm-1" });
      stateManager.saveGoal(goal);

      const entry = await engine.observeWithLLM(
        "goal-llm-1",
        "code_quality",
        "Improve code quality to 80%",
        "Code Quality",
        "min 0.8 (80%)"
      );

      expect(entry.layer).toBe("independent_review");
      expect(entry.extracted_value).toBe(0.75);
      expect(entry.confidence).toBeGreaterThanOrEqual(0.50);
      expect(entry.confidence).toBeLessThanOrEqual(0.84);
      expect(entry.method.type).toBe("llm_review");
    });

    it("clamps confidence to independent_review range [0.50, 0.84]", async () => {
      // Even if score is at boundary values, confidence should be clamped
      const mockLLMClientHigh = createMockLLMClient(0.99, "Excellent");
      const engineHigh = new ObservationEngine(stateManager, [], mockLLMClientHigh);

      const goal = makeGoal({ id: "goal-clamp-high" });
      stateManager.saveGoal(goal);

      const entryHigh = await engineHigh.observeWithLLM(
        "goal-clamp-high",
        "code_quality",
        "Test goal",
        "Code Quality",
        "min 0.8"
      );
      expect(entryHigh.confidence).toBeLessThanOrEqual(0.84);
    });

    it("sets method.confidence_tier to independent_review", async () => {
      const mockLLMClient = createMockLLMClient(0.6, "Moderate progress");
      const engine = new ObservationEngine(stateManager, [], mockLLMClient);

      const goal = makeGoal({ id: "goal-tier" });
      stateManager.saveGoal(goal);

      const entry = await engine.observeWithLLM(
        "goal-tier",
        "code_quality",
        "Improve quality",
        "Code Quality",
        "min 0.8"
      );

      expect(entry.method.confidence_tier).toBe("independent_review");
    });
  });

  // ─── Test 2: observe() uses LLM fallback when no DataSource ───

  describe("observe() with LLM fallback (no DataSource)", () => {
    it("uses LLM observation (independent_review) when no DataSource and llmClient available", async () => {
      const mockLLMClient = createMockLLMClient(0.72, "LLM observed value");
      const engine = new ObservationEngine(stateManager, [], mockLLMClient);

      const goal = makeGoal({ id: "goal-llm-fallback" });
      stateManager.saveGoal(goal);

      await engine.observe("goal-llm-fallback", [defaultMethod]);

      const updatedGoal = stateManager.loadGoal("goal-llm-fallback");
      expect(updatedGoal).not.toBeNull();

      // Check the observation log for the layer used
      const log = engine.getObservationLog("goal-llm-fallback");
      expect(log.entries.length).toBeGreaterThan(0);

      const lastEntry = log.entries[log.entries.length - 1]!;
      expect(lastEntry.layer).toBe("independent_review");
      expect(lastEntry.goal_id).toBe("goal-llm-fallback");
    });

    it("LLM sendMessage is called when no DataSource available", async () => {
      const mockLLMClient = createMockLLMClient(0.65, "progress noted");
      const engine = new ObservationEngine(stateManager, [], mockLLMClient);

      const goal = makeGoal({ id: "goal-llm-called" });
      stateManager.saveGoal(goal);

      await engine.observe("goal-llm-called", [defaultMethod]);

      expect(mockLLMClient.sendMessage).toHaveBeenCalled();
    });
  });

  // ─── Test 3: DataSource takes priority over LLM ───

  describe("observe() uses DataSource over LLM when DataSource available", () => {
    it("DataSource is queried when it supports the dimension", async () => {
      const mockLLMClient = createMockLLMClient(0.5, "LLM result");
      const mockDs = makeMockDataSource({}, ["code_quality"]);
      const engine = new ObservationEngine(stateManager, [mockDs], mockLLMClient);

      const goal = makeGoal({ id: "goal-ds-priority" });
      stateManager.saveGoal(goal);

      await engine.observe("goal-ds-priority", [defaultMethod]);

      // DataSource query should have been called
      expect(mockDs.query).toHaveBeenCalled();
    });

    it("LLM is NOT called when DataSource handles the dimension", async () => {
      const mockLLMClient = createMockLLMClient(0.5, "LLM result");
      const mockDs = makeMockDataSource({}, ["code_quality"]);
      const engine = new ObservationEngine(stateManager, [mockDs], mockLLMClient);

      const goal = makeGoal({ id: "goal-ds-no-llm" });
      stateManager.saveGoal(goal);

      await engine.observe("goal-ds-no-llm", [defaultMethod]);

      // LLM should NOT have been called
      expect(mockLLMClient.sendMessage).not.toHaveBeenCalled();
    });

    it("observation layer is mechanical when DataSource is used", async () => {
      const mockLLMClient = createMockLLMClient(0.5, "LLM result");
      const mockDs = makeMockDataSource({}, ["code_quality"]);
      const engine = new ObservationEngine(stateManager, [mockDs], mockLLMClient);

      const goal = makeGoal({ id: "goal-mechanical-layer" });
      stateManager.saveGoal(goal);

      await engine.observe("goal-mechanical-layer", [defaultMethod]);

      const log = engine.getObservationLog("goal-mechanical-layer");
      expect(log.entries.length).toBeGreaterThan(0);

      const lastEntry = log.entries[log.entries.length - 1]!;
      expect(lastEntry.layer).toBe("mechanical");
    });
  });

  // ─── Test 4: Falls back to self_report when no DataSource and no LLM ───

  describe("observe() falls back to self_report when no DataSource and no llmClient", () => {
    it("uses self_report layer when neither DataSource nor LLM is available", async () => {
      const engine = new ObservationEngine(stateManager); // no dataSources, no llmClient

      const goal = makeGoal({ id: "goal-self-report" });
      stateManager.saveGoal(goal);

      // observe() is currently synchronous but may become async — use await for compatibility
      await Promise.resolve(engine.observe("goal-self-report", [selfReportMethod]));

      const log = engine.getObservationLog("goal-self-report");
      expect(log.entries.length).toBeGreaterThan(0);

      const lastEntry = log.entries[log.entries.length - 1]!;
      expect(lastEntry.layer).toBe("self_report");
    });

    it("self_report layer preserves the stored current_value", async () => {
      const engine = new ObservationEngine(stateManager);

      const goal = makeGoal({
        id: "goal-self-report-value",
        dimensions: [
          {
            name: "code_quality",
            label: "Code Quality",
            current_value: 0.42,
            threshold: { type: "min", value: 0.8 },
            confidence: 0.3,
            observation_method: selfReportMethod,
            last_updated: new Date().toISOString(),
            history: [],
            weight: 1.0,
            uncertainty_weight: null,
            state_integrity: "ok",
          },
        ],
      });
      stateManager.saveGoal(goal);

      await Promise.resolve(engine.observe("goal-self-report-value", [selfReportMethod]));

      const updatedGoal = stateManager.loadGoal("goal-self-report-value");
      expect(updatedGoal).not.toBeNull();
      const dim = updatedGoal!.dimensions.find((d) => d.name === "code_quality");
      expect(dim).not.toBeNull();
      expect(dim!.current_value).toBe(0.42); // value preserved
    });
  });

  // ─── Test 5: Integration — LLM observation score used in gap calculation ───

  describe("Integration: LLM observation score flows into GapCalculator", () => {
    it("gap reflects the LLM-observed score", async () => {
      // LLM returns score = 0.72, threshold min = 0.8 → gap should be non-zero
      const mockLLMClient = createMockLLMClient(0.72, "72% quality achieved");
      const engine = new ObservationEngine(stateManager, [], mockLLMClient);

      const goal = makeGoal({
        id: "goal-gap-integration",
        dimensions: [
          {
            name: "code_quality",
            label: "Code Quality",
            current_value: 0.5, // initial value — will be updated by LLM observation
            threshold: { type: "min", value: 0.8 },
            confidence: 0.3,
            observation_method: defaultMethod,
            last_updated: new Date().toISOString(),
            history: [],
            weight: 1.0,
            uncertainty_weight: null,
            state_integrity: "ok",
          },
        ],
      });
      stateManager.saveGoal(goal);

      // Perform LLM observation
      await engine.observeWithLLM(
        "goal-gap-integration",
        "code_quality",
        "Improve code quality to 80%",
        "Code Quality",
        "min 0.8"
      );

      // Load updated goal
      const updatedGoal = stateManager.loadGoal("goal-gap-integration");
      expect(updatedGoal).not.toBeNull();

      const dim = updatedGoal!.dimensions.find((d) => d.name === "code_quality");
      expect(dim).not.toBeNull();

      // Compute gap: current_value should now be 0.72 (from LLM), threshold.min = 0.8
      // raw gap = max(0, 0.8 - 0.72) = 0.08
      const { computeRawGap } = await import("../src/gap-calculator.js");
      const rawGap = computeRawGap(dim!.current_value, dim!.threshold);

      // Gap should reflect the LLM score (0.72), not the initial value (0.5)
      // raw gap for LLM score: max(0, 0.8 - 0.72) = 0.08
      expect(dim!.current_value).toBe(0.72);
      expect(rawGap).toBeCloseTo(0.08, 5);
    });

    it("gap is zero when LLM reports score meets the threshold", async () => {
      // LLM returns score = 0.9, threshold min = 0.8 → gap should be zero
      const mockLLMClient = createMockLLMClient(0.9, "90% quality achieved");
      const engine = new ObservationEngine(stateManager, [], mockLLMClient);

      const goal = makeGoal({
        id: "goal-gap-zero",
        dimensions: [
          {
            name: "code_quality",
            label: "Code Quality",
            current_value: 0.3,
            threshold: { type: "min", value: 0.8 },
            confidence: 0.3,
            observation_method: defaultMethod,
            last_updated: new Date().toISOString(),
            history: [],
            weight: 1.0,
            uncertainty_weight: null,
            state_integrity: "ok",
          },
        ],
      });
      stateManager.saveGoal(goal);

      await engine.observeWithLLM(
        "goal-gap-zero",
        "code_quality",
        "Improve code quality to 80%",
        "Code Quality",
        "min 0.8"
      );

      const updatedGoal = stateManager.loadGoal("goal-gap-zero");
      const dim = updatedGoal!.dimensions.find((d) => d.name === "code_quality");
      expect(dim).not.toBeNull();

      const { computeRawGap } = await import("../src/gap-calculator.js");
      const rawGap = computeRawGap(dim!.current_value, dim!.threshold);

      expect(dim!.current_value).toBe(0.9);
      expect(rawGap).toBe(0); // 0.9 >= 0.8, so no gap
    });
  });
});
