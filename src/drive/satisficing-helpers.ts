import type { Dimension } from "../types/goal.js";

// ─── Pure Helper: aggregateValues ───

/**
 * Aggregate an array of numeric values using the specified strategy.
 *
 * @param values - Numeric values to aggregate.
 * @param aggregation - Strategy: "min" | "avg" | "max" | "all_required".
 * @param thresholds - For "all_required": fulfillment ratios are already computed (values = ratios).
 * @returns Aggregated value, or 0 if values array is empty.
 */
export function aggregateValues(
  values: number[],
  aggregation: "min" | "avg" | "max" | "all_required",
  thresholds?: number[]
): number {
  if (values.length === 0) return 0;

  switch (aggregation) {
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "avg": {
      const sum = values.reduce((acc, v) => acc + v, 0);
      return sum / values.length;
    }
    case "all_required":
      // values are fulfillment ratios (0..1); return the minimum ratio
      // (parent is "complete" only if all ratios = 1.0, expressed as min)
      return Math.min(...values);
  }
}

// ─── Helpers ───

export function toNumber(value: number | string | boolean | null): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

export function isTruthy(value: number | string | boolean | null): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  return false;
}

export function toNumberOrNull(value: number | string | boolean | null): number | null {
  if (value === null) return null;
  return toNumber(value);
}

/**
 * Extract a representative numeric threshold value for the DimensionSatisfaction schema.
 * Returns null for "present" (no numeric threshold).
 */
export function getNumericThresholdValue(dim: Dimension): number | null {
  const { threshold } = dim;
  switch (threshold.type) {
    case "min":
      return threshold.value;
    case "max":
      return threshold.value;
    case "range":
      return threshold.high; // use upper bound as representative
    case "present":
      return null;
    case "match":
      return typeof threshold.value === "number" ? threshold.value : null;
  }
}

/**
 * Returns the numeric threshold for adjustment proposals.
 * Only applicable to numeric thresholds (min/max/range).
 */
export function getNumericThresholdValueForProposal(dim: Dimension): number | null {
  const { threshold } = dim;
  switch (threshold.type) {
    case "min":
      return threshold.value;
    case "max":
      return threshold.value;
    case "range":
      return threshold.high;
    case "present":
    case "match":
      return null; // adjustment not meaningful for binary thresholds
  }
}

/**
 * Compute the value that fully satisfies the threshold (for propagation).
 */
export function getSatisfiedValue(dim: Dimension): number | string | boolean | null {
  const { threshold } = dim;
  switch (threshold.type) {
    case "min":
      return threshold.value;
    case "max":
      return threshold.value;
    case "range":
      return (threshold.low + threshold.high) / 2;
    case "present":
      return true;
    case "match":
      return threshold.value;
  }
}
