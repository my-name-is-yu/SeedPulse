/**
 * Heuristic categorization of action types to expected effect latency.
 * Used to auto-suggest wait_until durations for WaitStrategy.
 */

// Map task categories to expected effect duration in hours
const LATENCY_DEFAULTS: Record<string, number> = {
  deploy: 1,          // deployments take ~1 hour to show effects
  marketing: 72,      // marketing campaigns need ~3 days
  documentation: 24,  // docs take ~1 day to impact metrics
  training: 48,       // model training effects visible in ~2 days
  infrastructure: 4,  // infra changes show effects in ~4 hours
  default: 12,        // conservative default: 12 hours
};

export interface EffectLatencyEstimate {
  actionType: string;
  estimatedHours: number;
  confidence: "high" | "medium" | "low";
  suggestedWaitUntil: string; // ISO datetime
}

export function estimateEffectLatency(
  actionType: string,
  startTime?: string
): EffectLatencyEstimate {
  const normalizedType = actionType.toLowerCase().trim();
  const hours = LATENCY_DEFAULTS[normalizedType] ?? LATENCY_DEFAULTS["default"];
  const confidence = normalizedType in LATENCY_DEFAULTS ? "high" as const : "low" as const;

  const start = startTime ? new Date(startTime) : new Date();
  const waitUntil = new Date(start.getTime() + hours * 60 * 60 * 1000);

  return {
    actionType: normalizedType,
    estimatedHours: hours,
    confidence,
    suggestedWaitUntil: waitUntil.toISOString(),
  };
}

/** Register custom latency for an action type (for plugins/extensions). */
export function registerLatencyDefault(actionType: string, hours: number): void {
  LATENCY_DEFAULTS[actionType.toLowerCase().trim()] = hours;
}
