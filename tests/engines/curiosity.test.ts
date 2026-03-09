import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CuriosityEngine } from '../../src/engines/curiosity.js';
import { Goal, MotiveState } from '../../src/state/models.js';

const TEST_WORKDIR = join(process.cwd(), 'tmp-curiosity-test');
const MOTIVE_DIR = join(TEST_WORKDIR, '.motive');
const PATTERNS_PATH = join(MOTIVE_DIR, 'patterns.json');

function makeState(overrides: Partial<MotiveState> = {}): MotiveState {
  return MotiveState.parse({
    meta_motivation: {
      exploration_budget: 3,
      activation_conditions: {
        idle_threshold_seconds: 30,
        anomaly_threshold: 0.7,
        retry_failed_after_hours: 24,
      },
    },
    ...overrides,
  });
}

function makeActiveGoal(id = 'g1'): Goal {
  return Goal.parse({ id, title: 'Active goal', status: 'active' });
}

function makeCompletedGoal(id = 'g2'): Goal {
  return Goal.parse({ id, title: 'Completed goal', status: 'completed' });
}

describe('CuriosityEngine', () => {
  let engine: CuriosityEngine;

  beforeEach(() => {
    engine = new CuriosityEngine(TEST_WORKDIR);
  });

  afterEach(() => {
    if (existsSync(TEST_WORKDIR)) {
      rmSync(TEST_WORKDIR, { recursive: true, force: true });
    }
  });

  describe('checkActivation — no active goals (idle)', () => {
    it('returns activated=false and no suggestions when no goals at all and no patterns file', () => {
      const state = makeState();
      const result = engine.checkActivation(state, []);
      expect(result.activated).toBe(false);
      expect(result.reason).toBeNull();
      expect(result.suggestedGoals).toHaveLength(0);
    });

    it('returns activated=false when all goals are completed and no retry patterns exist', () => {
      const state = makeState();
      const goals = [makeCompletedGoal('g1'), makeCompletedGoal('g2')];
      const result = engine.checkActivation(state, goals);
      expect(result.activated).toBe(false);
      expect(result.suggestedGoals).toHaveLength(0);
    });
  });

  describe('checkActivation — active goals present', () => {
    it('returns activated=false when there are active goals', () => {
      const state = makeState();
      const goals = [makeActiveGoal('g1'), makeCompletedGoal('g2')];
      const result = engine.checkActivation(state, goals);
      // isIdle=false because at least one goal is active
      expect(result.activated).toBe(false);
    });

    it('returns activated=false even if patterns file exists when goals are active', () => {
      mkdirSync(MOTIVE_DIR, { recursive: true });
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      writeFileSync(
        PATTERNS_PATH,
        JSON.stringify({
          failure_patterns: [
            { area: 'auth', last_failed_at: twoHoursAgo, failure_count: 3, retry_eligible: true },
          ],
        }),
      );

      const state = makeState();
      const goals = [makeActiveGoal('g1')];
      const result = engine.checkActivation(state, goals);
      // retry goals are added but isIdle is false so reason stays null until retry branch
      // With one active goal, isIdle=false → exploreFromPatterns skipped,
      // anomaly detection empty, retry branch runs → suggestedGoals may appear
      // but the retry_after_hours=24 is not met (only 2 hours old) → none eligible
      expect(result.suggestedGoals).toHaveLength(0);
    });
  });

  describe('exploration budget limit', () => {
    it('caps suggested goals at exploration_budget', () => {
      // Create a patterns file with many retry-eligible failures
      mkdirSync(MOTIVE_DIR, { recursive: true });
      const thirtyHoursAgo = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
      const failurePatterns = Array.from({ length: 10 }, (_, i) => ({
        area: `area-${i}`,
        last_failed_at: thirtyHoursAgo,
        failure_count: 1,
        retry_eligible: true,
      }));
      writeFileSync(PATTERNS_PATH, JSON.stringify({ failure_patterns: failurePatterns }));

      const state = makeState(); // exploration_budget=3
      const result = engine.checkActivation(state, []);
      expect(result.suggestedGoals.length).toBeLessThanOrEqual(3);
    });

    it('respects a budget of 1', () => {
      mkdirSync(MOTIVE_DIR, { recursive: true });
      const thirtyHoursAgo = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
      writeFileSync(
        PATTERNS_PATH,
        JSON.stringify({
          failure_patterns: [
            { area: 'a', last_failed_at: thirtyHoursAgo, failure_count: 2, retry_eligible: true },
            { area: 'b', last_failed_at: thirtyHoursAgo, failure_count: 1, retry_eligible: true },
          ],
        }),
      );

      const state = makeState({
        meta_motivation: {
          exploration_budget: 1,
          activation_conditions: { idle_threshold_seconds: 30, anomaly_threshold: 0.7, retry_failed_after_hours: 24 },
          curiosity_targets: [],
        },
      } as Partial<MotiveState>);

      const result = engine.checkActivation(state, []);
      expect(result.suggestedGoals).toHaveLength(1);
    });
  });

  describe('findRetryableFailures', () => {
    it('returns retry goals when patterns file has eligible failures', () => {
      mkdirSync(MOTIVE_DIR, { recursive: true });
      const thirtyHoursAgo = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
      writeFileSync(
        PATTERNS_PATH,
        JSON.stringify({
          failure_patterns: [
            {
              area: 'database-migration',
              last_failed_at: thirtyHoursAgo,
              failure_count: 2,
              retry_eligible: true,
            },
          ],
        }),
      );

      const state = makeState();
      const result = engine.checkActivation(state, []);
      expect(result.activated).toBe(true);
      expect(result.reason).toBe('retry');
      expect(result.suggestedGoals).toHaveLength(1);
      expect(result.suggestedGoals[0].source).toBe('curiosity_retry');
      expect(result.suggestedGoals[0].type).toBe('opportunity');
      expect(result.suggestedGoals[0].title).toContain('database-migration');
    });

    it('excludes failures that are too recent', () => {
      mkdirSync(MOTIVE_DIR, { recursive: true });
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      writeFileSync(
        PATTERNS_PATH,
        JSON.stringify({
          failure_patterns: [
            { area: 'api', last_failed_at: oneHourAgo, failure_count: 1, retry_eligible: true },
          ],
        }),
      );

      const state = makeState(); // retry_failed_after_hours=24
      const result = engine.checkActivation(state, []);
      expect(result.suggestedGoals).toHaveLength(0);
    });

    it('excludes failures with retry_eligible=false', () => {
      mkdirSync(MOTIVE_DIR, { recursive: true });
      const thirtyHoursAgo = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
      writeFileSync(
        PATTERNS_PATH,
        JSON.stringify({
          failure_patterns: [
            { area: 'ci', last_failed_at: thirtyHoursAgo, failure_count: 5, retry_eligible: false },
          ],
        }),
      );

      const state = makeState();
      const result = engine.checkActivation(state, []);
      expect(result.suggestedGoals).toHaveLength(0);
    });

    it('returns empty when patterns file is absent', () => {
      const state = makeState();
      const result = engine.checkActivation(state, []);
      expect(result.suggestedGoals).toHaveLength(0);
    });

    it('returns empty when patterns file is malformed JSON', () => {
      mkdirSync(MOTIVE_DIR, { recursive: true });
      writeFileSync(PATTERNS_PATH, 'not valid json {{');
      const state = makeState();
      const result = engine.checkActivation(state, []);
      expect(result.suggestedGoals).toHaveLength(0);
    });
  });
});
