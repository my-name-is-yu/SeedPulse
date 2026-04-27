import type { CharacterConfig } from "../../../base/types/character.js";

const BASE_FEEDBACK_CATEGORY_N: Record<string, number> = {
  immediate: 6,
  medium_term: 5,
  long_term: 10,
};

const BASE_DEFAULT_N = 5;
const DEFAULT_DURATION_HOURS_BY_CATEGORY: Record<string, number> = {
  coding: 2,
  implementation: 2,
  research: 4,
  investigation: 4,
};
const DEFAULT_DURATION_HOURS_FALLBACK = 3;
const ZERO_PROGRESS_WINDOW = 3;
const ZERO_PROGRESS_GAP_FLOOR = 0.9;
const ZERO_PROGRESS_MAX_VARIANCE = 0.01;

export function getAdjustedN(characterConfig: CharacterConfig, category?: string): number {
  const multiplier = 0.75 + characterConfig.stall_flexibility * 0.25;
  const base = category
    ? (BASE_FEEDBACK_CATEGORY_N[category] ?? BASE_DEFAULT_N)
    : BASE_DEFAULT_N;
  return Math.round(base * multiplier);
}

export function isZeroProgress(gapHistory: Array<{ normalized_gap: number }>): boolean {
  if (gapHistory.length < ZERO_PROGRESS_WINDOW) {
    return false;
  }
  const recent = gapHistory.slice(-ZERO_PROGRESS_WINDOW);
  const gaps = recent.map((entry) => entry.normalized_gap);
  if (!gaps.every((gap) => gap >= ZERO_PROGRESS_GAP_FLOOR)) {
    return false;
  }
  return Math.max(...gaps) - Math.min(...gaps) < ZERO_PROGRESS_MAX_VARIANCE;
}

export function computeTimeThreshold(
  estimatedDuration: { value: number; unit: string } | null | undefined,
  taskCategory?: string
): number {
  if (estimatedDuration) {
    return durationToHours(estimatedDuration) * 2;
  }
  if (taskCategory) {
    const defaultHours = DEFAULT_DURATION_HOURS_BY_CATEGORY[taskCategory];
    if (defaultHours !== undefined) {
      return defaultHours;
    }
  }
  return DEFAULT_DURATION_HOURS_FALLBACK;
}

function durationToHours(duration: { value: number; unit: string }): number {
  switch (duration.unit) {
    case "minutes":
      return duration.value / 60;
    case "hours":
      return duration.value;
    case "days":
      return duration.value * 24;
    case "weeks":
      return duration.value * 24 * 7;
    default:
      return duration.value;
  }
}

