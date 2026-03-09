import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Goal, MotiveState } from '../state/models.js';

export interface CuriosityResult {
  activated: boolean;
  reason: 'idle' | 'anomaly' | 'retry' | null;
  suggestedGoals: ExplorationGoal[];
}

export interface ExplorationGoal {
  title: string;
  description: string;
  type: 'opportunity';
  source: 'curiosity_idle' | 'curiosity_anomaly' | 'curiosity_retry';
}

interface Anomaly {
  description: string;
  deviation: number;
}

interface FailurePattern {
  area: string;
  last_failed_at: string;
  failure_count: number;
  retry_eligible: boolean;
}

interface PatternsFile {
  failure_patterns?: FailurePattern[];
}

export class CuriosityEngine {
  private readonly patternsPath: string;

  constructor(workdir = '.') {
    this.patternsPath = join(workdir, '.motive', 'patterns.json');
  }

  /**
   * Check if curiosity should activate and generate exploration goals.
   * Returns activated=true when all goals are completed/paused/abandoned or
   * there are no active goals, and retry-eligible failures exist.
   */
  checkActivation(state: MotiveState, goals: Goal[]): CuriosityResult {
    const budget = state.meta_motivation.exploration_budget;
    const anomalyThreshold = state.meta_motivation.activation_conditions.anomaly_threshold;
    const retryAfterHours = state.meta_motivation.activation_conditions.retry_failed_after_hours;

    const activeGoals = goals.filter(g => g.status === 'active');
    const isIdle = activeGoals.length === 0;

    const suggestedGoals: ExplorationGoal[] = [];
    let reason: CuriosityResult['reason'] = null;

    if (isIdle) {
      const idleGoals = this.exploreFromPatterns(state);
      if (idleGoals.length > 0) {
        reason = 'idle';
        suggestedGoals.push(...idleGoals);
      }
    }

    // Anomaly detection (placeholder — always empty for now)
    const anomalies = this.detectAnomalies(state, anomalyThreshold);
    if (anomalies.length > 0 && reason === null) {
      reason = 'anomaly';
      for (const anomaly of anomalies) {
        suggestedGoals.push({
          title: `Investigate anomaly: ${anomaly.description}`,
          description: `Detected deviation of ${anomaly.deviation.toFixed(2)} in recent actions. Investigate root cause.`,
          type: 'opportunity',
          source: 'curiosity_anomaly',
        });
      }
    }

    // Retry-eligible failures
    const retryGoals = this.findRetryableFailures(state, retryAfterHours);
    if (retryGoals.length > 0) {
      if (reason === null) reason = 'retry';
      suggestedGoals.push(...retryGoals);
    }

    const limited = suggestedGoals.slice(0, budget);

    return {
      activated: limited.length > 0,
      reason: limited.length > 0 ? reason : null,
      suggestedGoals: limited,
    };
  }

  /**
   * Generate exploration goals from discovered patterns when idle.
   * Returns empty array until pattern-analyzer integration is built.
   */
  private exploreFromPatterns(_state: MotiveState): ExplorationGoal[] {
    // Requires pattern-analyzer integration — deferred to future phase.
    return [];
  }

  /**
   * Find failure areas in .motive/patterns.json that are eligible for retry.
   * A failure is eligible when retry_eligible=true and last_failed_at is older
   * than retryAfterHours.
   */
  private findRetryableFailures(
    _state: MotiveState,
    retryAfterHours: number,
  ): ExplorationGoal[] {
    if (!existsSync(this.patternsPath)) {
      return [];
    }

    let patterns: PatternsFile;
    try {
      patterns = JSON.parse(readFileSync(this.patternsPath, 'utf-8')) as PatternsFile;
    } catch {
      return [];
    }

    if (!Array.isArray(patterns.failure_patterns)) {
      return [];
    }

    const now = Date.now();
    const retryMs = retryAfterHours * 60 * 60 * 1000;

    const eligible = patterns.failure_patterns.filter((fp) => {
      if (!fp.retry_eligible) return false;
      const age = now - new Date(fp.last_failed_at).getTime();
      return age >= retryMs;
    });

    return eligible.map((fp) => ({
      title: `Retry: ${fp.area}`,
      description: `Previous failures in "${fp.area}" (count: ${fp.failure_count}). Sufficient time has passed — retry is now eligible.`,
      type: 'opportunity' as const,
      source: 'curiosity_retry' as const,
    }));
  }

  /**
   * Detect anomalies in recent actions.
   * Placeholder — returns empty array until log analysis is integrated.
   */
  private detectAnomalies(_state: MotiveState, _threshold: number): Anomaly[] {
    return [];
  }
}
