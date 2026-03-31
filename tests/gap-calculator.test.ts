import { describe, it, expect } from "vitest";
import {
  computeRawGap,
  normalizeGap,
  applyConfidenceWeight,
  calculateDimensionGap,
  calculateGapVector,
  aggregateGaps,
} from "../src/drive/gap-calculator.js";
import type { Threshold } from "../src/types/core.js";
import type { Dimension } from "../src/types/goal.js";

// ─── computeRawGap ───

describe("computeRawGap", () => {
  describe("min(N) threshold", () => {
    const threshold: Threshold = { type: "min", value: 200 };

    it("returns 0 when current >= threshold", () => {
      expect(computeRawGap(200, threshold)).toBe(0);
      expect(computeRawGap(300, threshold)).toBe(0);
    });

    it("returns positive gap when current < threshold", () => {
      expect(computeRawGap(120, threshold)).toBe(80);
    });

    it("returns threshold as max gap when current is null", () => {
      expect(computeRawGap(null, threshold)).toBe(200);
    });
  });

  describe("max(N) threshold", () => {
    const threshold: Threshold = { type: "max", value: 0.05 };

    it("returns 0 when current <= threshold", () => {
      expect(computeRawGap(0.05, threshold)).toBe(0);
      expect(computeRawGap(0.01, threshold)).toBe(0);
    });

    it("returns positive gap when current > threshold", () => {
      expect(computeRawGap(0.08, threshold)).toBeCloseTo(0.03);
    });

    it("returns threshold as max gap when current is null", () => {
      expect(computeRawGap(null, threshold)).toBe(0.05);
    });
  });

  describe("range(low, high) threshold", () => {
    const threshold: Threshold = { type: "range", low: 36.0, high: 37.0 };

    it("returns 0 when current is within range", () => {
      expect(computeRawGap(36.5, threshold)).toBe(0);
      expect(computeRawGap(36.0, threshold)).toBe(0);
      expect(computeRawGap(37.0, threshold)).toBe(0);
    });

    it("returns gap when below range", () => {
      expect(computeRawGap(35.5, threshold)).toBeCloseTo(0.5);
    });

    it("returns gap when above range", () => {
      expect(computeRawGap(37.5, threshold)).toBeCloseTo(0.5);
    });

    it("returns full range span when current is null", () => {
      expect(computeRawGap(null, threshold)).toBe(1.0);
    });
  });

  describe("present threshold", () => {
    const threshold: Threshold = { type: "present" };

    it("returns 0 for truthy values", () => {
      expect(computeRawGap(true, threshold)).toBe(0);
      expect(computeRawGap("yes", threshold)).toBe(0);
      expect(computeRawGap(1, threshold)).toBe(0);
    });

    it("returns 1 for falsy values", () => {
      expect(computeRawGap(false, threshold)).toBe(1);
      expect(computeRawGap("", threshold)).toBe(1);
      expect(computeRawGap(0, threshold)).toBe(1);
    });

    it("returns 1 when current is null", () => {
      expect(computeRawGap(null, threshold)).toBe(1);
    });
  });

  describe("match(value) threshold", () => {
    const threshold: Threshold = { type: "match", value: "approved" };

    it("returns 0 when current matches", () => {
      expect(computeRawGap("approved", threshold)).toBe(0);
    });

    it("returns 1 when current does not match", () => {
      expect(computeRawGap("pending", threshold)).toBe(1);
    });

    it("returns 1 when current is null", () => {
      expect(computeRawGap(null, threshold)).toBe(1);
    });

    it("works with numeric match (exact integer match value)", () => {
      const numThreshold: Threshold = { type: "match", value: 42 };
      // 42 is a number, so: gap = max(0, 1 - 42) = 0 (clamped)
      expect(computeRawGap(42, numThreshold)).toBe(0);
      // 41 is a number, so: gap = max(0, 1 - 41) = 0 (clamped)
      expect(computeRawGap(41, numThreshold)).toBe(0);
    });

    it("numeric 1.0 (fully matched) → gap = 0", () => {
      const threshold: Threshold = { type: "match", value: "export function greet" };
      expect(computeRawGap(1.0, threshold)).toBe(0);
    });

    it("numeric 0.0 (not matched at all) → gap = 1", () => {
      const threshold: Threshold = { type: "match", value: "export function greet" };
      expect(computeRawGap(0.0, threshold)).toBe(1);
    });

    it("numeric 0.7 (partial match score) → gap = 0.3", () => {
      const threshold: Threshold = { type: "match", value: "export function greet" };
      expect(computeRawGap(0.7, threshold)).toBeCloseTo(0.3);
    });

    it("string match → gap = 0 (existing behavior preserved)", () => {
      const threshold: Threshold = { type: "match", value: "approved" };
      expect(computeRawGap("approved", threshold)).toBe(0);
    });

    it("string mismatch → gap = 1 (existing behavior preserved)", () => {
      const threshold: Threshold = { type: "match", value: "approved" };
      expect(computeRawGap("pending", threshold)).toBe(1);
    });

    it("works with boolean match", () => {
      const boolThreshold: Threshold = { type: "match", value: true };
      expect(computeRawGap(true, boolThreshold)).toBe(0);
      expect(computeRawGap(false, boolThreshold)).toBe(1);
    });
  });
});

// ─── normalizeGap ───

describe("normalizeGap", () => {
  it("normalizes min gap (doc example: 80/200 = 0.40)", () => {
    const t: Threshold = { type: "min", value: 200 };
    expect(normalizeGap(80, t, 120)).toBeCloseTo(0.4);
  });

  it("normalizes max gap (doc example: 0.03/0.05 = 0.60)", () => {
    const t: Threshold = { type: "max", value: 0.05 };
    expect(normalizeGap(0.03, t, 0.08)).toBeCloseTo(0.6);
  });

  it("normalizes range gap with cap at 1.0 (doc example: 0.5/0.5 = 1.0)", () => {
    const t: Threshold = { type: "range", low: 36.0, high: 37.0 };
    // half width = 0.5, raw_gap = 0.5, normalized = 0.5/0.5 = 1.0
    expect(normalizeGap(0.5, t, 35.5)).toBeCloseTo(1.0);
  });

  it("caps range gap at 1.0 for large deviations", () => {
    const t: Threshold = { type: "range", low: 36.0, high: 37.0 };
    // raw_gap = 2.0, half_width = 0.5, result = min(1.0, 4.0) = 1.0
    expect(normalizeGap(2.0, t, 34.0)).toBe(1.0);
  });

  it("returns 1.0 for null current_value", () => {
    const t: Threshold = { type: "min", value: 100 };
    expect(normalizeGap(100, t, null)).toBe(1.0);
  });

  it("handles zero threshold for min", () => {
    const t: Threshold = { type: "min", value: 0 };
    expect(normalizeGap(0, t, 0)).toBe(0.0);
    expect(normalizeGap(5, t, -5)).toBe(1.0);
  });

  it("handles zero threshold for max", () => {
    const t: Threshold = { type: "max", value: 0 };
    expect(normalizeGap(0, t, 0)).toBe(0.0);
    expect(normalizeGap(0.5, t, 0.5)).toBe(0.5);
    expect(normalizeGap(2.0, t, 2.0)).toBe(1.0);
  });

  it("handles zero-width range", () => {
    const t: Threshold = { type: "range", low: 5, high: 5 };
    expect(normalizeGap(0, t, 5)).toBe(0.0);
    expect(normalizeGap(1, t, 4)).toBe(1.0);
  });

  it("passes through present gap", () => {
    const t: Threshold = { type: "present" };
    expect(normalizeGap(0, t, true)).toBe(0);
    expect(normalizeGap(1, t, false)).toBe(1);
  });

  it("passes through match gap", () => {
    const t: Threshold = { type: "match", value: "ok" };
    expect(normalizeGap(0, t, "ok")).toBe(0);
    expect(normalizeGap(1, t, "bad")).toBe(1);
  });
});

// ─── applyConfidenceWeight ───

describe("applyConfidenceWeight", () => {
  it("returns unchanged gap when confidence = 1.0", () => {
    expect(applyConfidenceWeight(0.5, 1.0, 1.0, false)).toBeCloseTo(0.5);
  });

  it("multiplies by 1.5 when confidence = 0.5, weight = 1.0", () => {
    // 0.5 * (1 + (1 - 0.5) * 1.0) = 0.5 * 1.5 = 0.75
    expect(applyConfidenceWeight(0.5, 0.5, 1.0, false)).toBeCloseTo(0.75);
  });

  it("multiplies by 2.0 when confidence = 0.0, weight = 1.0", () => {
    // 0.4 * (1 + 1 * 1.0) = 0.4 * 2.0 = 0.8
    expect(applyConfidenceWeight(0.4, 0.0, 1.0, false)).toBeCloseTo(0.8);
  });

  it("uses custom uncertainty_weight", () => {
    // 0.5 * (1 + (1 - 0.0) * 0.5) = 0.5 * 1.5 = 0.75
    expect(applyConfidenceWeight(0.5, 0.0, 0.5, false)).toBeCloseTo(0.75);
  });

  it("does NOT apply weighting when current_value is null", () => {
    // Even with low confidence, null values should not be amplified
    expect(applyConfidenceWeight(1.0, 0.0, 1.0, true)).toBe(1.0);
  });

  it("returns 0 when normalized gap is 0 (already achieved)", () => {
    expect(applyConfidenceWeight(0, 0.3, 1.0, false)).toBe(0);
  });
});

// ─── calculateDimensionGap (full pipeline) ───

describe("calculateDimensionGap", () => {
  it("calculates full pipeline for min threshold (doc example: monthly revenue)", () => {
    // monthly revenue: min(200), current=120, confidence=0.98
    const result = calculateDimensionGap({
      name: "monthly_revenue",
      current_value: 120,
      threshold: { type: "min", value: 200 },
      confidence: 0.98,
      uncertainty_weight: null,
    });

    expect(result.dimension_name).toBe("monthly_revenue");
    expect(result.raw_gap).toBe(80);
    expect(result.normalized_gap).toBeCloseTo(0.4);
    // weighted: 0.4 * (1 + (1 - 0.98) * 1.0) = 0.4 * 1.02 = 0.408
    expect(result.normalized_weighted_gap).toBeCloseTo(0.408);
    expect(result.confidence).toBe(0.98);
  });

  it("calculates full pipeline for max threshold (doc example: churn rate)", () => {
    // churn rate: max(0.05), current=0.08, confidence=0.95
    const result = calculateDimensionGap({
      name: "churn_rate",
      current_value: 0.08,
      threshold: { type: "max", value: 0.05 },
      confidence: 0.95,
      uncertainty_weight: null,
    });

    expect(result.raw_gap).toBeCloseTo(0.03);
    expect(result.normalized_gap).toBeCloseTo(0.6);
    // weighted: 0.6 * (1 + 0.05 * 1.0) = 0.6 * 1.05 = 0.63
    expect(result.normalized_weighted_gap).toBeCloseTo(0.63);
  });

  it("handles null current_value (max gap, no confidence weighting)", () => {
    const result = calculateDimensionGap({
      name: "unknown_dim",
      current_value: null,
      threshold: { type: "min", value: 200 },
      confidence: 0.0,
      uncertainty_weight: null,
    });

    expect(result.raw_gap).toBe(200);
    expect(result.normalized_gap).toBe(1.0);
    // null: no confidence weighting applied
    expect(result.normalized_weighted_gap).toBe(1.0);
  });

  it("returns 0 for achieved dimension", () => {
    const result = calculateDimensionGap({
      name: "achieved",
      current_value: 200,
      threshold: { type: "min", value: 200 },
      confidence: 0.95,
      uncertainty_weight: null,
    });

    expect(result.raw_gap).toBe(0);
    expect(result.normalized_gap).toBe(0);
    expect(result.normalized_weighted_gap).toBe(0);
  });

  it("uses per-dimension uncertainty_weight when provided", () => {
    const result = calculateDimensionGap(
      {
        name: "custom_weight",
        current_value: 50,
        threshold: { type: "min", value: 100 },
        confidence: 0.5,
        uncertainty_weight: 2.0, // per-dimension override
      },
      1.0 // global weight (should be ignored)
    );

    // raw_gap = 50, normalized = 0.5
    // weighted: 0.5 * (1 + (1 - 0.5) * 2.0) = 0.5 * 2.0 = 1.0
    expect(result.normalized_weighted_gap).toBeCloseTo(1.0);
    expect(result.uncertainty_weight).toBe(2.0);
  });

  it("uses global uncertainty_weight when per-dimension is null", () => {
    const result = calculateDimensionGap(
      {
        name: "global_weight",
        current_value: 50,
        threshold: { type: "min", value: 100 },
        confidence: 0.5,
        uncertainty_weight: null,
      },
      0.5 // global weight
    );

    // weighted: 0.5 * (1 + 0.5 * 0.5) = 0.5 * 1.25 = 0.625
    expect(result.normalized_weighted_gap).toBeCloseTo(0.625);
    expect(result.uncertainty_weight).toBe(0.5);
  });

  it("handles present threshold", () => {
    const missing = calculateDimensionGap({
      name: "config_file",
      current_value: false,
      threshold: { type: "present" },
      confidence: 0.9,
      uncertainty_weight: null,
    });
    expect(missing.raw_gap).toBe(1);
    expect(missing.normalized_gap).toBe(1);

    const present = calculateDimensionGap({
      name: "config_file",
      current_value: true,
      threshold: { type: "present" },
      confidence: 0.9,
      uncertainty_weight: null,
    });
    expect(present.raw_gap).toBe(0);
    expect(present.normalized_gap).toBe(0);
    expect(present.normalized_weighted_gap).toBe(0);
  });

  it("handles match threshold with numeric observation score (LLM/DataSource)", () => {
    // LLM observation returns 0-1 score: gap = 1 - score
    const fullMatch = calculateDimensionGap({
      name: "greet_func",
      current_value: 1.0,
      threshold: { type: "match", value: "export function greet" },
      confidence: 0.9,
      uncertainty_weight: null,
    });
    expect(fullMatch.raw_gap).toBe(0);
    expect(fullMatch.normalized_gap).toBe(0);
    expect(fullMatch.normalized_weighted_gap).toBe(0);

    const noMatch = calculateDimensionGap({
      name: "greet_func",
      current_value: 0.0,
      threshold: { type: "match", value: "export function greet" },
      confidence: 0.9,
      uncertainty_weight: null,
    });
    expect(noMatch.raw_gap).toBe(1);
    expect(noMatch.normalized_gap).toBe(1);

    const partialMatch = calculateDimensionGap({
      name: "greet_func",
      current_value: 0.7,
      threshold: { type: "match", value: "export function greet" },
      confidence: 1.0,
      uncertainty_weight: null,
    });
    expect(partialMatch.raw_gap).toBeCloseTo(0.3);
    expect(partialMatch.normalized_gap).toBeCloseTo(0.3);
    expect(partialMatch.normalized_weighted_gap).toBeCloseTo(0.3);
  });

  it("handles match threshold", () => {
    const matched = calculateDimensionGap({
      name: "status",
      current_value: "approved",
      threshold: { type: "match", value: "approved" },
      confidence: 0.7,
      uncertainty_weight: null,
    });
    expect(matched.raw_gap).toBe(0);
    expect(matched.normalized_weighted_gap).toBe(0);

    const unmatched = calculateDimensionGap({
      name: "status",
      current_value: "pending",
      threshold: { type: "match", value: "approved" },
      confidence: 0.7,
      uncertainty_weight: null,
    });
    expect(unmatched.raw_gap).toBe(1);
    expect(unmatched.normalized_gap).toBe(1);
    // weighted: 1.0 * (1 + 0.3 * 1.0) = 1.3, clamped to 1.0
    expect(unmatched.normalized_weighted_gap).toBeCloseTo(1.0);
  });
});

// ─── calculateGapVector ───

describe("calculateGapVector", () => {
  it("calculates gaps for all dimensions of a goal", () => {
    const now = new Date().toISOString();
    const dimensions: Dimension[] = [
      {
        name: "revenue",
        label: "Monthly Revenue",
        current_value: 120,
        threshold: { type: "min", value: 200 },
        confidence: 0.98,
        observation_method: {
          type: "mechanical",
          source: "db",
          schedule: null,
          endpoint: null,
          confidence_tier: "mechanical",
        },
        last_updated: now,
        history: [],
        weight: 1.0,
        uncertainty_weight: null,
      },
      {
        name: "churn",
        label: "Churn Rate",
        current_value: 0.08,
        threshold: { type: "max", value: 0.05 },
        confidence: 0.95,
        observation_method: {
          type: "api_query",
          source: "crm",
          schedule: null,
          endpoint: null,
          confidence_tier: "mechanical",
        },
        last_updated: now,
        history: [],
        weight: 1.0,
        uncertainty_weight: null,
      },
    ];

    const vector = calculateGapVector("goal-1", dimensions, 1.0);
    expect(vector.goal_id).toBe("goal-1");
    expect(vector.gaps).toHaveLength(2);
    expect(vector.gaps[0].dimension_name).toBe("revenue");
    expect(vector.gaps[1].dimension_name).toBe("churn");
    expect(vector.gaps[0].normalized_gap).toBeCloseTo(0.4);
    expect(vector.gaps[1].normalized_gap).toBeCloseTo(0.6);
    expect(vector.timestamp).toBeTruthy();
  });

  it("passes global uncertainty_weight to all dimensions", () => {
    const now = new Date().toISOString();
    const dimensions: Dimension[] = [
      {
        name: "dim1",
        label: "D1",
        current_value: 50,
        threshold: { type: "min", value: 100 },
        confidence: 0.5,
        observation_method: {
          type: "manual",
          source: "user",
          schedule: null,
          endpoint: null,
          confidence_tier: "self_report",
        },
        last_updated: now,
        history: [],
        weight: 1.0,
        uncertainty_weight: null,
      },
    ];

    const vector = calculateGapVector("g", dimensions, 2.0);
    // weighted: 0.5 * (1 + 0.5 * 2.0) = 0.5 * 2.0 = 1.0
    expect(vector.gaps[0].normalized_weighted_gap).toBeCloseTo(1.0);
  });
});

// ─── aggregateGaps ───

describe("aggregateGaps", () => {
  describe("max (bottleneck, default)", () => {
    it("returns the largest gap", () => {
      expect(aggregateGaps([0.4, 0.6, 0.2])).toBe(0.6);
    });

    it("returns 0 for empty array", () => {
      expect(aggregateGaps([])).toBe(0);
    });

    it("returns single value for single element", () => {
      expect(aggregateGaps([0.5])).toBe(0.5);
    });
  });

  describe("weighted_avg", () => {
    it("calculates weighted average", () => {
      // (0.4*2 + 0.6*1) / (2+1) = 1.4/3 = 0.467
      expect(
        aggregateGaps([0.4, 0.6], "weighted_avg", [2, 1])
      ).toBeCloseTo(0.467, 2);
    });

    it("uses uniform weights when not provided", () => {
      // (0.4 + 0.6) / 2 = 0.5
      expect(aggregateGaps([0.4, 0.6], "weighted_avg")).toBeCloseTo(0.5);
    });

    it("returns 0 when total weight is 0", () => {
      expect(aggregateGaps([0.5], "weighted_avg", [0])).toBe(0);
    });
  });

  describe("sum", () => {
    it("sums all gaps", () => {
      expect(aggregateGaps([0.4, 0.6, 0.2], "sum")).toBeCloseTo(1.2);
    });

    it("returns 0 for empty array", () => {
      expect(aggregateGaps([], "sum")).toBe(0);
    });
  });
});

// ─── Regression: gap never exceeds 1.0 ───

describe("gap normalization invariant: result always in [0,1]", () => {
  it("regression #65: current=0, threshold=60 (min), confidence=0 must not return 2.0", () => {
    // Before fix: normalizedGap=1.0, multiplier=2.0 => 2.0 (violated invariant)
    const result = calculateDimensionGap({
      name: "test_coverage",
      current_value: 0,
      threshold: { type: "min", value: 60 },
      confidence: 0.0,
      uncertainty_weight: null,
    });

    expect(result.normalized_gap).toBeCloseTo(1.0);
    expect(result.normalized_weighted_gap).toBeLessThanOrEqual(1.0);
    expect(result.normalized_weighted_gap).toBeCloseTo(1.0);
  });

  it("confidence weighting never pushes weighted gap above 1.0", () => {
    const cases = [
      { current: 0, threshold: 100, confidence: 0.0 },
      { current: 0, threshold: 60, confidence: 0.0 },
      { current: 10, threshold: 100, confidence: 0.1 },
    ];
    for (const c of cases) {
      const result = calculateDimensionGap({
        name: "dim",
        current_value: c.current,
        threshold: { type: "min", value: c.threshold },
        confidence: c.confidence,
        uncertainty_weight: null,
      });
      expect(result.normalized_weighted_gap).toBeLessThanOrEqual(1.0);
    }
  });
});

// ─── Edge Cases ───

describe("edge cases", () => {
  it("handles string current_value for numeric threshold", () => {
    const result = computeRawGap("50" as unknown as number, {
      type: "min",
      value: 100,
    });
    expect(result).toBe(50);
  });

  it("handles boolean current_value for numeric threshold", () => {
    const result = computeRawGap(true as unknown as number, {
      type: "min",
      value: 100,
    });
    // true -> 1, gap = 100 - 1 = 99
    expect(result).toBe(99);
  });

  it("handles very small numbers without floating point issues", () => {
    const result = calculateDimensionGap({
      name: "small",
      current_value: 0.0001,
      threshold: { type: "max", value: 0.0001 },
      confidence: 1.0,
      uncertainty_weight: null,
    });
    expect(result.raw_gap).toBe(0);
    expect(result.normalized_gap).toBe(0);
  });

  it("handles very large numbers", () => {
    const result = calculateDimensionGap({
      name: "large",
      current_value: 500000,
      threshold: { type: "min", value: 1000000 },
      confidence: 0.9,
      uncertainty_weight: null,
    });
    expect(result.raw_gap).toBe(500000);
    expect(result.normalized_gap).toBeCloseTo(0.5);
  });

  // ─── NaN / Infinity edge cases ───
  //
  // JavaScript's IEEE-754 arithmetic produces NaN and ±Infinity in many
  // realistic scenarios (e.g. sensor dropout, division by zero in upstream
  // calculations). The tests below document the *current* behaviour of
  // computeRawGap so that any future change is intentional.

  it("NaN current_value with min threshold: raw gap is NaN (does not silently zero out)", () => {
    // NaN propagates through numeric subtraction. Callers must sanitise inputs
    // before passing them to GapCalculator; this test pins the observable behaviour.
    const result = computeRawGap(NaN, { type: "min", value: 200 });
    // NaN is not equal to itself — use Number.isNaN to assert propagation.
    expect(Number.isNaN(result)).toBe(true);
  });

  it("Infinity current_value with min threshold: gap is 0 (threshold already exceeded)", () => {
    // Infinity >= any finite threshold, so the gap should be 0 (no deficit).
    const result = computeRawGap(Infinity, { type: "min", value: 200 });
    expect(result).toBe(0);
  });

  it("-Infinity current_value with max threshold: gap is 0 (floor at zero via Math.max)", () => {
    // -Infinity is below the max threshold, but computeRawGap uses
    // Math.max(0, current - threshold), so the result is clamped to 0.
    // This means -Infinity is treated as "no exceedance" — callers should
    // treat -Infinity as invalid/unobserved data rather than relying on this.
    const result = computeRawGap(-Infinity, { type: "max", value: 0.05 });
    expect(result).toBe(0);
  });

  it("doc example: full pipeline verification", () => {
    // From gap-calculation.md examples table:
    // Revenue: min(200), current=120 -> raw=80, norm=0.40
    // Churn: max(0.05), current=0.08 -> raw=0.03, norm=0.60
    // Temp: range(36.0, 37.0), current=35.5 -> raw=0.5, norm=1.00 (cap)
    // Config: present, exists -> raw=0, norm=0
    // Status: match("approved"), current="pending" -> raw=1, norm=1.00

    const dims = [
      {
        name: "revenue",
        current_value: 120,
        threshold: { type: "min" as const, value: 200 },
        confidence: 1.0,
        uncertainty_weight: null,
      },
      {
        name: "churn",
        current_value: 0.08,
        threshold: { type: "max" as const, value: 0.05 },
        confidence: 1.0,
        uncertainty_weight: null,
      },
      {
        name: "temp",
        current_value: 35.5,
        threshold: { type: "range" as const, low: 36.0, high: 37.0 },
        confidence: 1.0,
        uncertainty_weight: null,
      },
      {
        name: "config",
        current_value: true,
        threshold: { type: "present" as const },
        confidence: 1.0,
        uncertainty_weight: null,
      },
      {
        name: "status",
        current_value: "pending",
        threshold: { type: "match" as const, value: "approved" },
        confidence: 1.0,
        uncertainty_weight: null,
      },
    ];

    const results = dims.map((d) => calculateDimensionGap(d));

    expect(results[0].normalized_gap).toBeCloseTo(0.4);
    expect(results[1].normalized_gap).toBeCloseTo(0.6);
    expect(results[2].normalized_gap).toBeCloseTo(1.0);
    expect(results[3].normalized_gap).toBe(0);
    expect(results[4].normalized_gap).toBe(1.0);

    // With confidence=1.0, weighted gaps should equal normalized gaps
    expect(results[0].normalized_weighted_gap).toBeCloseTo(0.4);
    expect(results[1].normalized_weighted_gap).toBeCloseTo(0.6);
  });
});
