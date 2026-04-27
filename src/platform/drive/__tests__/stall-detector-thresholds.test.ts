import { describe, expect, it } from "vitest";
import { DEFAULT_CHARACTER_CONFIG } from "../../../base/types/character.js";
import {
  computeTimeThreshold,
  getAdjustedN,
  isZeroProgress,
} from "../stall-detector/thresholds.js";

describe("stall-detector threshold helpers", () => {
  it("computes adjusted N for known and unknown categories", () => {
    expect(getAdjustedN(DEFAULT_CHARACTER_CONFIG)).toBe(5);
    expect(getAdjustedN(DEFAULT_CHARACTER_CONFIG, "immediate")).toBe(6);
    expect(getAdjustedN(DEFAULT_CHARACTER_CONFIG, "unknown")).toBe(5);
  });

  it("detects zero-progress only for high flat gaps", () => {
    expect(isZeroProgress([{ normalized_gap: 0.95 }, { normalized_gap: 0.955 }, { normalized_gap: 0.951 }])).toBe(true);
    expect(isZeroProgress([{ normalized_gap: 0.95 }, { normalized_gap: 0.8 }, { normalized_gap: 0.95 }])).toBe(false);
    expect(isZeroProgress([{ normalized_gap: 0.95 }, { normalized_gap: 0.951 }])).toBe(false);
  });

  it("computes time thresholds from estimates and task categories", () => {
    expect(computeTimeThreshold({ value: 90, unit: "minutes" })).toBe(3);
    expect(computeTimeThreshold({ value: 2, unit: "days" })).toBe(96);
    expect(computeTimeThreshold(null, "research")).toBe(4);
    expect(computeTimeThreshold(undefined, "unknown")).toBe(3);
    expect(computeTimeThreshold({ value: 2, unit: "mystery" })).toBe(4);
  });
});
