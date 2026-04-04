import { describe, expect, it } from "vitest";

import {
  applyConfidenceWeight,
  computeRawGap,
  normalizeGap,
} from "../../src/platform/drive/gap-calculator.js";
import { formatOperationError } from "../../src/cli/utils.js";
import {
  buildThreshold,
  deduplicateDimensionKeys,
  findBestDimensionMatch,
} from "../../src/orchestrator/goal/goal-validation.js";

describe("test_example", () => {
  describe("buildThreshold", () => {
    it("builds numeric and range thresholds with defaults for invalid values", () => {
      expect(buildThreshold("min", 10)).toEqual({ type: "min", value: 10 });
      expect(buildThreshold("max", "not-a-number")).toEqual({ type: "max", value: 100 });
      expect(buildThreshold("range", [5, 15])).toEqual({ type: "range", low: 5, high: 15 });
      expect(buildThreshold("range", 20)).toEqual({ type: "range", low: 0, high: 20 });
    });

    it("builds presence and match thresholds with safe fallbacks", () => {
      expect(buildThreshold("present", false)).toEqual({ type: "present" });
      expect(buildThreshold("match", "done")).toEqual({ type: "match", value: "done" });
      expect(buildThreshold("match", ["bad-input"])).toEqual({ type: "match", value: "" });
    });
  });

  describe("deduplicateDimensionKeys", () => {
    it("preserves dimensions while suffixing duplicate names", () => {
      const dimensions = [
        {
          name: "coverage",
          label: "Coverage",
          threshold_type: "min" as const,
          threshold_value: 90,
          observation_method_hint: "ci",
        },
        {
          name: "coverage",
          label: "Coverage duplicate",
          threshold_type: "min" as const,
          threshold_value: 95,
          observation_method_hint: "report",
        },
        {
          name: "coverage",
          label: "Coverage third",
          threshold_type: "min" as const,
          threshold_value: 99,
          observation_method_hint: "dashboard",
        },
      ];

      const result = deduplicateDimensionKeys(dimensions);

      expect(result.map((dimension) => dimension.name)).toEqual([
        "coverage",
        "coverage_2",
        "coverage_3",
      ]);
      expect(result).toHaveLength(3);
    });
  });

  describe("findBestDimensionMatch", () => {
    it("returns the best candidate when token overlap is strong enough", () => {
      expect(
        findBestDimensionMatch("test_coverage_percent", [
          "deployment_frequency",
          "test_coverage",
          "bug_count",
        ])
      ).toBe("test_coverage");
    });

    it("returns null when overlap does not meet the threshold", () => {
      expect(
        findBestDimensionMatch("revenue_growth", ["growth_rate", "burn_down", "qa_status"])
      ).toBeNull();
    });
  });

  describe("computeRawGap", () => {
    it("computes expected raw gaps for different threshold types", () => {
      expect(computeRawGap(60, { type: "min", value: 80 })).toBe(20);
      expect(computeRawGap(15, { type: "max", value: 10 })).toBe(5);
      expect(computeRawGap(25, { type: "range", low: 10, high: 20 })).toBe(5);
      expect(computeRawGap("", { type: "present" })).toBe(1);
      expect(computeRawGap("done", { type: "match", value: "done" })).toBe(0);
    });

    it("treats null current values as maximum gap sentinels", () => {
      expect(computeRawGap(null, { type: "min", value: 7 })).toBe(7);
      expect(computeRawGap(null, { type: "max", value: 0 })).toBe(1);
      expect(computeRawGap(null, { type: "range", low: 2, high: 8 })).toBe(6);
    });
  });

  describe("normalizeGap", () => {
    it("normalizes numeric raw gaps and caps range gaps", () => {
      expect(normalizeGap(20, { type: "min", value: 80 }, 60)).toBe(0.25);
      expect(normalizeGap(5, { type: "max", value: 10 }, 15)).toBe(0.5);
      expect(normalizeGap(10, { type: "range", low: 10, high: 20 }, 25)).toBe(1);
    });

    it("handles zero-denominator and null-value edge cases", () => {
      expect(normalizeGap(3, { type: "min", value: 0 }, 1)).toBe(1);
      expect(normalizeGap(0.4, { type: "max", value: 0 }, 0.4)).toBe(0.4);
      expect(normalizeGap(999, { type: "match", value: "ok" }, null)).toBe(1);
    });
  });

  describe("applyConfidenceWeight", () => {
    it("inflates normalized gaps based on low confidence", () => {
      expect(applyConfidenceWeight(0.5, 0.25, 2, false)).toBe(1.25);
    });

    it("skips weighting for null-backed values", () => {
      expect(applyConfidenceWeight(1, 0.1, 5, true)).toBe(1);
    });
  });

  describe("formatOperationError", () => {
    it("formats both Error instances and unknown values", () => {
      expect(formatOperationError("goal add", new TypeError("bad input"))).toBe(
        'Operation "goal add" failed. Original error: TypeError: bad input'
      );
      expect(formatOperationError("run", "timeout")).toBe(
        'Operation "run" failed. Original error: timeout'
      );
    });
  });
});
