import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LearningPipeline } from "../src/learning-pipeline.js";
import { StateManager } from "../src/state-manager.js";
import { VectorIndex } from "../src/vector-index.js";
import { MockEmbeddingClient } from "../src/embedding-client.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import type {
  StructuralFeedback,
  StructuralFeedbackType,
} from "../src/types/learning.js";

// ─── Helpers ───

function makeFeedback(
  overrides: Partial<StructuralFeedback> & {
    feedbackType: StructuralFeedbackType;
  }
): StructuralFeedback {
  return {
    id: `fb_${Math.random().toString(36).slice(2)}`,
    goalId: "goal-1",
    iterationId: "iter-1",
    feedbackType: overrides.feedbackType,
    expected: { score: 0.8 },
    actual: { score: 0.6 },
    delta: -0.2,
    timestamp: new Date().toISOString(),
    context: { dimension: "test_coverage" },
    ...overrides,
  };
}

/** Build N feedback entries of the same type with given deltas */
function makeFeedbacks(
  goalId: string,
  feedbackType: StructuralFeedbackType,
  deltas: number[]
): StructuralFeedback[] {
  return deltas.map((delta, i) => ({
    id: `fb_${i}`,
    goalId,
    iterationId: `iter-${i}`,
    feedbackType,
    expected: {},
    actual: {},
    delta,
    timestamp: new Date(Date.now() + i * 1000).toISOString(),
    context: { dimension: `dim_${i}` },
  }));
}

// ─── Tests ───

describe("LearningPipeline Phase 2 — Structural Feedback", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let pipeline: LearningPipeline;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "motiva-learning-p2-test-")
    );
    stateManager = new StateManager(tmpDir);
    const mockEmbeddingClient = new MockEmbeddingClient(4);
    const vectorIndex = new VectorIndex(
      path.join(tmpDir, "vector-index.json"),
      mockEmbeddingClient
    );
    const llm = createMockLLMClient([]);
    pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── 1. recordStructuralFeedback() ───

  describe("recordStructuralFeedback()", () => {
    it("stores feedback and retrieves it for observation_accuracy type", () => {
      const fb = makeFeedback({ feedbackType: "observation_accuracy" });
      pipeline.recordStructuralFeedback(fb);
      const stored = pipeline.getStructuralFeedback("goal-1");
      expect(stored).toHaveLength(1);
      expect(stored[0]!.feedbackType).toBe("observation_accuracy");
      expect(stored[0]!.id).toBe(fb.id);
    });

    it("stores feedback for strategy_selection type", () => {
      const fb = makeFeedback({ feedbackType: "strategy_selection" });
      pipeline.recordStructuralFeedback(fb);
      const stored = pipeline.getStructuralFeedback("goal-1");
      expect(stored[0]!.feedbackType).toBe("strategy_selection");
    });

    it("stores feedback for scope_sizing type", () => {
      const fb = makeFeedback({ feedbackType: "scope_sizing" });
      pipeline.recordStructuralFeedback(fb);
      const stored = pipeline.getStructuralFeedback("goal-1");
      expect(stored[0]!.feedbackType).toBe("scope_sizing");
    });

    it("stores feedback for task_generation type", () => {
      const fb = makeFeedback({ feedbackType: "task_generation" });
      pipeline.recordStructuralFeedback(fb);
      const stored = pipeline.getStructuralFeedback("goal-1");
      expect(stored[0]!.feedbackType).toBe("task_generation");
    });

    it("accumulates multiple feedback entries for the same goal", () => {
      for (let i = 0; i < 3; i++) {
        pipeline.recordStructuralFeedback(
          makeFeedback({
            id: `fb_${i}`,
            feedbackType: "observation_accuracy",
            delta: -0.1 * (i + 1),
          })
        );
      }
      const stored = pipeline.getStructuralFeedback("goal-1");
      expect(stored).toHaveLength(3);
    });

    it("stores feedback for different goals independently", () => {
      pipeline.recordStructuralFeedback(
        makeFeedback({ goalId: "goal-A", feedbackType: "scope_sizing" })
      );
      pipeline.recordStructuralFeedback(
        makeFeedback({ goalId: "goal-B", feedbackType: "task_generation" })
      );
      expect(pipeline.getStructuralFeedback("goal-A")).toHaveLength(1);
      expect(pipeline.getStructuralFeedback("goal-B")).toHaveLength(1);
    });

    it("throws on invalid feedbackType (Zod validation)", () => {
      const bad = {
        ...makeFeedback({ feedbackType: "observation_accuracy" }),
        feedbackType: "invalid_type",
      };
      expect(() =>
        pipeline.recordStructuralFeedback(bad as unknown as StructuralFeedback)
      ).toThrow();
    });

    it("throws when delta is out of range [-1, 1]", () => {
      const bad = makeFeedback({
        feedbackType: "observation_accuracy",
        delta: 2.0,
      });
      expect(() => pipeline.recordStructuralFeedback(bad)).toThrow();
    });

    it("throws when required fields are missing", () => {
      const bad = { feedbackType: "scope_sizing" };
      expect(() =>
        pipeline.recordStructuralFeedback(bad as unknown as StructuralFeedback)
      ).toThrow();
    });
  });

  // ─── 2. aggregateFeedback() ───

  describe("aggregateFeedback()", () => {
    it("returns empty array when no feedback exists", () => {
      const result = pipeline.aggregateFeedback("goal-1");
      expect(result).toEqual([]);
    });

    it("computes correct averageDelta for a single type", () => {
      const deltas = [-0.4, -0.2, 0.0, 0.2];
      for (const fb of makeFeedbacks("goal-1", "observation_accuracy", deltas)) {
        pipeline.recordStructuralFeedback(fb);
      }
      const result = pipeline.aggregateFeedback("goal-1", "observation_accuracy");
      expect(result).toHaveLength(1);
      expect(result[0]!.feedbackType).toBe("observation_accuracy");
      expect(result[0]!.totalCount).toBe(4);
      expect(result[0]!.averageDelta).toBeCloseTo(-0.1, 5);
    });

    it("returns aggregations for all 4 types when no filter", () => {
      const types: StructuralFeedbackType[] = [
        "observation_accuracy",
        "strategy_selection",
        "scope_sizing",
        "task_generation",
      ];
      for (const t of types) {
        for (const fb of makeFeedbacks("goal-1", t, [-0.2, -0.1, 0.1])) {
          pipeline.recordStructuralFeedback(fb);
        }
      }
      const result = pipeline.aggregateFeedback("goal-1");
      expect(result).toHaveLength(4);
      const resultTypes = result.map((r) => r.feedbackType).sort();
      expect(resultTypes).toEqual([...types].sort());
    });

    it("filters by type when feedbackType is provided", () => {
      for (const fb of makeFeedbacks("goal-1", "scope_sizing", [-0.3, -0.1])) {
        pipeline.recordStructuralFeedback(fb);
      }
      for (const fb of makeFeedbacks("goal-1", "task_generation", [0.1, 0.2])) {
        pipeline.recordStructuralFeedback(fb);
      }
      const result = pipeline.aggregateFeedback("goal-1", "scope_sizing");
      expect(result).toHaveLength(1);
      expect(result[0]!.feedbackType).toBe("scope_sizing");
    });

    it("detects improving trend when recent deltas are higher than previous", () => {
      // 10 old entries with delta -0.5, 10 new entries with delta 0.3
      const old = Array(10).fill(-0.5) as number[];
      const recent = Array(10).fill(0.3) as number[];
      const allDeltas = [...old, ...recent];
      let t = Date.now() - allDeltas.length * 1000;
      const entries: StructuralFeedback[] = allDeltas.map((delta, i) => ({
        id: `fb_${i}`,
        goalId: "goal-1",
        iterationId: `iter-${i}`,
        feedbackType: "strategy_selection" as const,
        expected: {},
        actual: {},
        delta,
        timestamp: new Date(t + i * 1000).toISOString(),
        context: {},
      }));
      for (const fb of entries) {
        pipeline.recordStructuralFeedback(fb);
      }
      const result = pipeline.aggregateFeedback("goal-1", "strategy_selection");
      expect(result[0]!.recentTrend).toBe("improving");
    });

    it("detects degrading trend when recent deltas are lower than previous", () => {
      const old = Array(10).fill(0.4) as number[];
      const recent = Array(10).fill(-0.4) as number[];
      const allDeltas = [...old, ...recent];
      let t = Date.now() - allDeltas.length * 1000;
      const entries: StructuralFeedback[] = allDeltas.map((delta, i) => ({
        id: `fb_${i}`,
        goalId: "goal-1",
        iterationId: `iter-${i}`,
        feedbackType: "scope_sizing" as const,
        expected: {},
        actual: {},
        delta,
        timestamp: new Date(t + i * 1000).toISOString(),
        context: {},
      }));
      for (const fb of entries) {
        pipeline.recordStructuralFeedback(fb);
      }
      const result = pipeline.aggregateFeedback("goal-1", "scope_sizing");
      expect(result[0]!.recentTrend).toBe("degrading");
    });

    it("detects stable trend when recent and previous deltas are similar", () => {
      const allDeltas = Array(20).fill(0.0) as number[];
      let t = Date.now() - allDeltas.length * 1000;
      const entries: StructuralFeedback[] = allDeltas.map((delta, i) => ({
        id: `fb_${i}`,
        goalId: "goal-1",
        iterationId: `iter-${i}`,
        feedbackType: "task_generation" as const,
        expected: {},
        actual: {},
        delta,
        timestamp: new Date(t + i * 1000).toISOString(),
        context: {},
      }));
      for (const fb of entries) {
        pipeline.recordStructuralFeedback(fb);
      }
      const result = pipeline.aggregateFeedback("goal-1", "task_generation");
      expect(result[0]!.recentTrend).toBe("stable");
    });

    it("returns stable trend when fewer than 20 total entries", () => {
      // Only 5 entries — not enough for trend comparison
      for (const fb of makeFeedbacks("goal-1", "observation_accuracy", [-0.3, -0.1, 0.0, 0.1, 0.2])) {
        pipeline.recordStructuralFeedback(fb);
      }
      const result = pipeline.aggregateFeedback("goal-1", "observation_accuracy");
      expect(result[0]!.recentTrend).toBe("stable");
    });

    it("identifies worst area as the context key with lowest average delta", () => {
      const entries: StructuralFeedback[] = [
        {
          id: "fb_1",
          goalId: "goal-1",
          iterationId: "iter-1",
          feedbackType: "observation_accuracy",
          expected: {},
          actual: {},
          delta: -0.8,
          timestamp: new Date().toISOString(),
          context: { dimension: "accuracy" },
        },
        {
          id: "fb_2",
          goalId: "goal-1",
          iterationId: "iter-2",
          feedbackType: "observation_accuracy",
          expected: {},
          actual: {},
          delta: 0.5,
          timestamp: new Date().toISOString(),
          context: { dimension: "speed" },
        },
      ];
      for (const fb of entries) {
        pipeline.recordStructuralFeedback(fb);
      }
      const result = pipeline.aggregateFeedback("goal-1", "observation_accuracy");
      // "dimension" key has entries; the dimension with lower delta wins
      expect(result[0]!.worstArea).toBe("dimension");
    });

    it("returns worstArea as unknown when context is empty", () => {
      const fb: StructuralFeedback = {
        id: "fb_1",
        goalId: "goal-1",
        iterationId: "iter-1",
        feedbackType: "scope_sizing",
        expected: {},
        actual: {},
        delta: -0.5,
        timestamp: new Date().toISOString(),
        context: {},
      };
      pipeline.recordStructuralFeedback(fb);
      const result = pipeline.aggregateFeedback("goal-1", "scope_sizing");
      // Falls back to iterationId as area key
      expect(result[0]!.worstArea).toBeTruthy();
    });
  });

  // ─── 3. autoTuneParameters() ───

  describe("autoTuneParameters()", () => {
    it("returns empty array when no feedback exists", () => {
      expect(pipeline.autoTuneParameters("goal-1")).toEqual([]);
    });

    it("returns empty when feedback count is below 5 threshold", () => {
      for (const fb of makeFeedbacks("goal-1", "observation_accuracy", [-0.3, -0.2, -0.1, -0.4])) {
        pipeline.recordStructuralFeedback(fb);
      }
      expect(pipeline.autoTuneParameters("goal-1")).toEqual([]);
    });

    it("returns empty when confidence is below 0.6 (mixed deltas)", () => {
      // 10 entries: 5 positive + 5 negative => avgDelta=0 (>=0), sameSign=positive=5/10=0.5 < 0.6
      const deltas = [-0.5, -0.5, -0.5, -0.5, -0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
      for (const fb of makeFeedbacks("goal-1", "scope_sizing", deltas)) {
        pipeline.recordStructuralFeedback(fb);
      }
      const result = pipeline.autoTuneParameters("goal-1");
      expect(result).toEqual([]);
    });

    it("suggests confidence threshold increase for observation_accuracy with negative avgDelta", () => {
      const deltas = [-0.4, -0.3, -0.4, -0.3, -0.4];
      for (const fb of makeFeedbacks("goal-1", "observation_accuracy", deltas)) {
        pipeline.recordStructuralFeedback(fb);
      }
      const result = pipeline.autoTuneParameters("goal-1");
      expect(result).toHaveLength(1);
      expect(result[0]!.feedbackType).toBe("observation_accuracy");
      expect(result[0]!.parameterName).toBe("min_confidence_threshold");
      expect(result[0]!.suggestedValue).toBeGreaterThan(result[0]!.currentValue);
      expect(result[0]!.basedOnFeedbackCount).toBe(5);
    });

    it("suggests confidence threshold decrease for observation_accuracy with positive avgDelta", () => {
      const deltas = [0.4, 0.3, 0.4, 0.3, 0.4];
      for (const fb of makeFeedbacks("goal-1", "observation_accuracy", deltas)) {
        pipeline.recordStructuralFeedback(fb);
      }
      const result = pipeline.autoTuneParameters("goal-1");
      expect(result).toHaveLength(1);
      expect(result[0]!.suggestedValue).toBeLessThan(result[0]!.currentValue);
    });

    it("suggests strategy weight changes for strategy_selection with negative avgDelta", () => {
      const deltas = [-0.5, -0.4, -0.5, -0.4, -0.5];
      for (const fb of makeFeedbacks("goal-1", "strategy_selection", deltas)) {
        pipeline.recordStructuralFeedback(fb);
      }
      const result = pipeline.autoTuneParameters("goal-1");
      expect(result).toHaveLength(1);
      expect(result[0]!.parameterName).toBe("strategy_exploitation_weight");
      expect(result[0]!.suggestedValue).toBeLessThan(0.5); // exploration mode
    });

    it("suggests task granularity reduction for scope_sizing with negative avgDelta", () => {
      const deltas = [-0.6, -0.5, -0.6, -0.5, -0.6];
      for (const fb of makeFeedbacks("goal-1", "scope_sizing", deltas)) {
        pipeline.recordStructuralFeedback(fb);
      }
      const result = pipeline.autoTuneParameters("goal-1");
      expect(result).toHaveLength(1);
      expect(result[0]!.parameterName).toBe("task_granularity_multiplier");
      expect(result[0]!.suggestedValue).toBeLessThan(1.0);
    });

    it("suggests template reuse reduction for task_generation with negative avgDelta", () => {
      const deltas = [-0.7, -0.6, -0.7, -0.6, -0.7];
      for (const fb of makeFeedbacks("goal-1", "task_generation", deltas)) {
        pipeline.recordStructuralFeedback(fb);
      }
      const result = pipeline.autoTuneParameters("goal-1");
      expect(result).toHaveLength(1);
      expect(result[0]!.parameterName).toBe("task_template_reuse_weight");
      expect(result[0]!.suggestedValue).toBeLessThan(0.5);
    });

    it("returns suggestions for multiple types when all have enough feedback", () => {
      const types: StructuralFeedbackType[] = [
        "observation_accuracy",
        "strategy_selection",
        "scope_sizing",
        "task_generation",
      ];
      for (const t of types) {
        for (const fb of makeFeedbacks("goal-1", t, [-0.4, -0.3, -0.4, -0.3, -0.4])) {
          pipeline.recordStructuralFeedback(fb);
        }
      }
      const result = pipeline.autoTuneParameters("goal-1");
      expect(result).toHaveLength(4);
    });

    it("includes confidence >= 0.6 in returned ParameterTuning", () => {
      const deltas = [-0.4, -0.3, -0.4, -0.3, -0.4];
      for (const fb of makeFeedbacks("goal-1", "scope_sizing", deltas)) {
        pipeline.recordStructuralFeedback(fb);
      }
      const result = pipeline.autoTuneParameters("goal-1");
      expect(result[0]!.confidence).toBeGreaterThanOrEqual(0.6);
    });

    it("includes basedOnFeedbackCount equal to number of entries", () => {
      const deltas = [-0.4, -0.3, -0.4, -0.3, -0.4, -0.2];
      for (const fb of makeFeedbacks("goal-1", "task_generation", deltas)) {
        pipeline.recordStructuralFeedback(fb);
      }
      const result = pipeline.autoTuneParameters("goal-1");
      expect(result[0]!.basedOnFeedbackCount).toBe(6);
    });
  });

  // ─── 4. Edge Cases ───

  describe("Edge cases", () => {
    it("getStructuralFeedback returns empty array for unknown goal", () => {
      expect(pipeline.getStructuralFeedback("nonexistent-goal")).toEqual([]);
    });

    it("aggregateFeedback with a single entry yields stable trend", () => {
      pipeline.recordStructuralFeedback(
        makeFeedback({ feedbackType: "observation_accuracy", delta: -0.5 })
      );
      const result = pipeline.aggregateFeedback("goal-1", "observation_accuracy");
      expect(result).toHaveLength(1);
      expect(result[0]!.recentTrend).toBe("stable");
      expect(result[0]!.totalCount).toBe(1);
    });

    it("autoTuneParameters with only one type having >= 5 entries returns only that suggestion", () => {
      // 5 entries for scope_sizing
      for (const fb of makeFeedbacks("goal-1", "scope_sizing", [-0.4, -0.3, -0.4, -0.3, -0.4])) {
        pipeline.recordStructuralFeedback(fb);
      }
      // 3 entries for task_generation (below threshold)
      for (const fb of makeFeedbacks("goal-1", "task_generation", [-0.3, -0.2, -0.1])) {
        pipeline.recordStructuralFeedback(fb);
      }
      const result = pipeline.autoTuneParameters("goal-1");
      expect(result).toHaveLength(1);
      expect(result[0]!.feedbackType).toBe("scope_sizing");
    });

    it("aggregateFeedback returns empty array when filtered type has no entries", () => {
      pipeline.recordStructuralFeedback(
        makeFeedback({ feedbackType: "scope_sizing", delta: -0.3 })
      );
      const result = pipeline.aggregateFeedback("goal-1", "observation_accuracy");
      expect(result).toEqual([]);
    });

    it("recordStructuralFeedback persists across separate getStructuralFeedback calls", () => {
      pipeline.recordStructuralFeedback(
        makeFeedback({ id: "fb_persist", feedbackType: "task_generation" })
      );
      const first = pipeline.getStructuralFeedback("goal-1");
      const second = pipeline.getStructuralFeedback("goal-1");
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(first[0]!.id).toBe("fb_persist");
    });
  });
});
