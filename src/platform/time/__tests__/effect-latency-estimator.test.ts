import { describe, it, expect, beforeEach } from "vitest";
import {
  estimateEffectLatency,
  registerLatencyDefault,
} from "../effect-latency-estimator.js";

describe("estimateEffectLatency", () => {
  it("returns correct hours for known action types", () => {
    const result = estimateEffectLatency("deploy");
    expect(result.actionType).toBe("deploy");
    expect(result.estimatedHours).toBe(1);
    expect(result.confidence).toBe("high");
  });

  it("returns 72h for marketing", () => {
    const result = estimateEffectLatency("marketing");
    expect(result.estimatedHours).toBe(72);
    expect(result.confidence).toBe("high");
  });

  it("returns 24h for documentation", () => {
    const result = estimateEffectLatency("documentation");
    expect(result.estimatedHours).toBe(24);
    expect(result.confidence).toBe("high");
  });

  it("returns 48h for training", () => {
    const result = estimateEffectLatency("training");
    expect(result.estimatedHours).toBe(48);
    expect(result.confidence).toBe("high");
  });

  it("returns 4h for infrastructure", () => {
    const result = estimateEffectLatency("infrastructure");
    expect(result.estimatedHours).toBe(4);
    expect(result.confidence).toBe("high");
  });

  it("returns 12h default for unknown action types", () => {
    const result = estimateEffectLatency("unknown_action_xyz");
    expect(result.estimatedHours).toBe(12);
    expect(result.confidence).toBe("low");
    expect(result.actionType).toBe("unknown_action_xyz");
  });

  it("normalizes action type to lowercase", () => {
    const result = estimateEffectLatency("DEPLOY");
    expect(result.actionType).toBe("deploy");
    expect(result.estimatedHours).toBe(1);
    expect(result.confidence).toBe("high");
  });

  it("trims whitespace from action type", () => {
    const result = estimateEffectLatency("  deploy  ");
    expect(result.actionType).toBe("deploy");
    expect(result.estimatedHours).toBe(1);
  });

  it("computes suggestedWaitUntil from provided startTime", () => {
    const start = "2026-01-01T00:00:00.000Z";
    const result = estimateEffectLatency("deploy", start);
    // deploy = 1 hour => 2026-01-01T01:00:00.000Z
    expect(result.suggestedWaitUntil).toBe("2026-01-01T01:00:00.000Z");
  });

  it("computes suggestedWaitUntil from current time when startTime not provided", () => {
    const before = Date.now();
    const result = estimateEffectLatency("deploy");
    const after = Date.now();
    const waitMs = new Date(result.suggestedWaitUntil).getTime();
    // deploy = 1 hour
    const oneHourMs = 1 * 60 * 60 * 1000;
    expect(waitMs).toBeGreaterThanOrEqual(before + oneHourMs);
    expect(waitMs).toBeLessThanOrEqual(after + oneHourMs);
  });
});

describe("registerLatencyDefault", () => {
  it("registers a custom action type and returns it on next call", () => {
    registerLatencyDefault("custom_action", 99);
    const result = estimateEffectLatency("custom_action");
    expect(result.estimatedHours).toBe(99);
    expect(result.confidence).toBe("high");
  });

  it("overwrites an existing entry", () => {
    registerLatencyDefault("deploy", 5);
    const result = estimateEffectLatency("deploy");
    expect(result.estimatedHours).toBe(5);
    // restore original value for other tests
    registerLatencyDefault("deploy", 1);
  });

  it("normalizes the registered key to lowercase", () => {
    registerLatencyDefault("MY_ACTION", 33);
    const result = estimateEffectLatency("my_action");
    expect(result.estimatedHours).toBe(33);
  });
});
