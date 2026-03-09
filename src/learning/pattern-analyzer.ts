import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ActionLogEntry } from './logger.js';

export interface Pattern {
  context: string;
  avg_state_delta: number;
  success_rate: number;
  sample_count: number;
}

export interface FailureArea {
  area: string;
  failure_count: number;
  last_attempted: string;
  retry_eligible: boolean;
}

export interface PatternStore {
  patterns: Pattern[];
  failure_areas: FailureArea[];
}

const EMPTY_STORE: PatternStore = { patterns: [], failure_areas: [] };

/**
 * Groups entries by a context label (tool + outcome) and computes aggregate metrics.
 * Also tracks failure areas by tool name for retry eligibility.
 */
export class PatternAnalyzer {
  constructor(private patternsPath: string) {}

  analyze(entries: ActionLogEntry[]): PatternStore {
    if (entries.length === 0) return EMPTY_STORE;

    // Group entries by context key: "{tool}:{outcome_category}"
    const groups = new Map<string, ActionLogEntry[]>();
    for (const entry of entries) {
      const key = this.contextLabel(entry);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(entry);
    }

    const patterns: Pattern[] = [];
    for (const [context, group] of groups) {
      const successCount = group.filter(e => e.outcome === 'success').length;
      const success_rate = successCount / group.length;

      const allDeltas = group
        .map(e => e.state_delta ?? {})
        .flatMap(d => Object.values(d));

      const avg_state_delta =
        allDeltas.length > 0
          ? allDeltas.reduce((a, b) => a + b, 0) / allDeltas.length
          : 0;

      patterns.push({
        context,
        avg_state_delta,
        success_rate,
        sample_count: group.length,
      });
    }

    // Aggregate failure areas by tool
    const failureMap = new Map<string, { count: number; last_attempted: string }>();
    for (const entry of entries) {
      if (entry.outcome !== 'failure') continue;
      const area = entry.action.tool;
      const existing = failureMap.get(area);
      if (!existing) {
        failureMap.set(area, { count: 1, last_attempted: entry.timestamp });
      } else {
        existing.count += 1;
        if (entry.timestamp > existing.last_attempted) {
          existing.last_attempted = entry.timestamp;
        }
      }
    }

    const failure_areas: FailureArea[] = [];
    for (const [area, { count, last_attempted }] of failureMap) {
      failure_areas.push({
        area,
        failure_count: count,
        last_attempted,
        retry_eligible: true, // default; use findRetryableFailures for time-gated check
      });
    }

    return { patterns, failure_areas };
  }

  load(): PatternStore {
    if (!existsSync(this.patternsPath)) return { patterns: [], failure_areas: [] };
    try {
      const raw = readFileSync(this.patternsPath, 'utf-8');
      return JSON.parse(raw) as PatternStore;
    } catch {
      return { patterns: [], failure_areas: [] };
    }
  }

  save(store: PatternStore): void {
    mkdirSync(dirname(this.patternsPath), { recursive: true });
    const tmpPath = `${this.patternsPath}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
      renameSync(tmpPath, this.patternsPath);
    } catch (err) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // ignore cleanup error
      }
      throw err;
    }
  }

  findRetryableFailures(retryAfterHours: number): FailureArea[] {
    const store = this.load();
    const cutoff = new Date(Date.now() - retryAfterHours * 60 * 60 * 1000);

    return store.failure_areas.filter(fa => {
      const lastAttempted = new Date(fa.last_attempted);
      return fa.retry_eligible && lastAttempted < cutoff;
    });
  }

  private contextLabel(entry: ActionLogEntry): string {
    const outcomeCategory = entry.outcome === 'success' ? 'success' : 'non-success';
    return `${entry.action.tool}:${outcomeCategory}`;
  }
}
