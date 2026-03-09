import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PatternAnalyzer, PatternStore } from '../../src/learning/pattern-analyzer.js';
import type { ActionLogEntry } from '../../src/learning/logger.js';

const TEST_DIR = join(tmpdir(), `motive-patterns-test-${Date.now()}`);
const PATTERNS_PATH = join(TEST_DIR, 'patterns.json');

function makeEntry(
  tool: string,
  outcome: 'success' | 'failure' | 'skipped',
  delta?: Record<string, number>,
  hoursAgo = 0,
): ActionLogEntry {
  const ts = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
  return {
    timestamp: ts,
    session_id: 'sess-001',
    action: { tool },
    outcome,
    ...(delta ? { state_delta: delta } : {}),
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('PatternAnalyzer', () => {
  describe('analyze', () => {
    it('returns empty store for empty entries', () => {
      const analyzer = new PatternAnalyzer(PATTERNS_PATH);
      const store = analyzer.analyze([]);
      expect(store.patterns).toEqual([]);
      expect(store.failure_areas).toEqual([]);
    });

    it('groups entries by tool and outcome category', () => {
      const analyzer = new PatternAnalyzer(PATTERNS_PATH);
      const entries: ActionLogEntry[] = [
        makeEntry('Write', 'success', { progress: 0.05 }),
        makeEntry('Write', 'success', { progress: 0.10 }),
        makeEntry('Write', 'failure'),
        makeEntry('Bash', 'success', { progress: 0.02 }),
      ];

      const store = analyzer.analyze(entries);
      expect(store.patterns.length).toBe(3); // Write:success, Write:non-success, Bash:success

      const writeSuccess = store.patterns.find(p => p.context === 'Write:success');
      expect(writeSuccess).toBeDefined();
      expect(writeSuccess!.sample_count).toBe(2);
      expect(writeSuccess!.success_rate).toBe(1.0);
      expect(writeSuccess!.avg_state_delta).toBeCloseTo(0.075, 5);
    });

    it('computes success_rate correctly in mixed group', () => {
      const analyzer = new PatternAnalyzer(PATTERNS_PATH);
      // non-success group gets skipped + failure entries
      const entries: ActionLogEntry[] = [
        makeEntry('Edit', 'failure'),
        makeEntry('Edit', 'failure'),
        makeEntry('Edit', 'skipped'),
      ];

      const store = analyzer.analyze(entries);
      const editNonSuccess = store.patterns.find(p => p.context === 'Edit:non-success');
      expect(editNonSuccess).toBeDefined();
      expect(editNonSuccess!.success_rate).toBe(0);
      expect(editNonSuccess!.sample_count).toBe(3);
    });

    it('sets avg_state_delta to 0 when no deltas present', () => {
      const analyzer = new PatternAnalyzer(PATTERNS_PATH);
      const entries: ActionLogEntry[] = [
        makeEntry('Read', 'success'),
        makeEntry('Read', 'success'),
      ];

      const store = analyzer.analyze(entries);
      const readSuccess = store.patterns.find(p => p.context === 'Read:success');
      expect(readSuccess!.avg_state_delta).toBe(0);
    });

    it('builds failure_areas from failed entries', () => {
      const analyzer = new PatternAnalyzer(PATTERNS_PATH);
      const entries: ActionLogEntry[] = [
        makeEntry('Write', 'failure'),
        makeEntry('Write', 'failure'),
        makeEntry('Bash', 'failure'),
        makeEntry('Read', 'success'),
      ];

      const store = analyzer.analyze(entries);
      const writeArea = store.failure_areas.find(fa => fa.area === 'Write');
      expect(writeArea).toBeDefined();
      expect(writeArea!.failure_count).toBe(2);
      expect(writeArea!.retry_eligible).toBe(true);

      const bashArea = store.failure_areas.find(fa => fa.area === 'Bash');
      expect(bashArea!.failure_count).toBe(1);

      // success entries should not appear in failure_areas
      const readArea = store.failure_areas.find(fa => fa.area === 'Read');
      expect(readArea).toBeUndefined();
    });

    it('tracks most recent timestamp per failure area', () => {
      const analyzer = new PatternAnalyzer(PATTERNS_PATH);
      const old = makeEntry('Write', 'failure', undefined, 10);   // 10 hours ago
      const recent = makeEntry('Write', 'failure', undefined, 1);  // 1 hour ago

      const store = analyzer.analyze([old, recent]);
      const writeArea = store.failure_areas.find(fa => fa.area === 'Write')!;
      expect(writeArea.last_attempted).toBe(recent.timestamp);
    });
  });

  describe('load and save', () => {
    it('returns empty store when file does not exist', () => {
      const analyzer = new PatternAnalyzer(PATTERNS_PATH);
      const store = analyzer.load();
      expect(store.patterns).toEqual([]);
      expect(store.failure_areas).toEqual([]);
    });

    it('round-trips a PatternStore via save/load', () => {
      const analyzer = new PatternAnalyzer(PATTERNS_PATH);
      const original: PatternStore = {
        patterns: [
          { context: 'Write:success', avg_state_delta: 0.05, success_rate: 0.9, sample_count: 20 },
        ],
        failure_areas: [
          { area: '型定義の不整合', failure_count: 3, last_attempted: '2026-03-08T00:00:00.000Z', retry_eligible: true },
        ],
      };

      analyzer.save(original);
      const loaded = analyzer.load();

      expect(loaded.patterns).toHaveLength(1);
      expect(loaded.patterns[0].context).toBe('Write:success');
      expect(loaded.patterns[0].avg_state_delta).toBe(0.05);
      expect(loaded.failure_areas[0].area).toBe('型定義の不整合');
      expect(loaded.failure_areas[0].failure_count).toBe(3);
    });

    it('save performs atomic write (file is valid after save)', () => {
      const analyzer = new PatternAnalyzer(PATTERNS_PATH);
      const store: PatternStore = { patterns: [], failure_areas: [] };
      analyzer.save(store);
      // Should not throw; file exists and parses correctly
      expect(() => analyzer.load()).not.toThrow();
    });
  });

  describe('findRetryableFailures', () => {
    it('returns failures whose last_attempted is older than retryAfterHours', () => {
      const analyzer = new PatternAnalyzer(PATTERNS_PATH);
      const store: PatternStore = {
        patterns: [],
        failure_areas: [
          {
            area: 'OldFailure',
            failure_count: 2,
            last_attempted: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(), // 30h ago
            retry_eligible: true,
          },
          {
            area: 'RecentFailure',
            failure_count: 1,
            last_attempted: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // 1h ago
            retry_eligible: true,
          },
        ],
      };
      analyzer.save(store);

      const retryable = analyzer.findRetryableFailures(24);
      expect(retryable).toHaveLength(1);
      expect(retryable[0].area).toBe('OldFailure');
    });

    it('excludes failures where retry_eligible is false', () => {
      const analyzer = new PatternAnalyzer(PATTERNS_PATH);
      const store: PatternStore = {
        patterns: [],
        failure_areas: [
          {
            area: 'Blocked',
            failure_count: 5,
            last_attempted: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
            retry_eligible: false,
          },
        ],
      };
      analyzer.save(store);

      const retryable = analyzer.findRetryableFailures(24);
      expect(retryable).toHaveLength(0);
    });

    it('returns empty array when no patterns file exists', () => {
      const analyzer = new PatternAnalyzer(join(TEST_DIR, 'no-file.json'));
      const retryable = analyzer.findRetryableFailures(24);
      expect(retryable).toEqual([]);
    });

    it('returns all eligible failures when all are older than threshold', () => {
      const analyzer = new PatternAnalyzer(PATTERNS_PATH);
      const store: PatternStore = {
        patterns: [],
        failure_areas: [
          {
            area: 'A',
            failure_count: 1,
            last_attempted: new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString(),
            retry_eligible: true,
          },
          {
            area: 'B',
            failure_count: 2,
            last_attempted: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
            retry_eligible: true,
          },
        ],
      };
      analyzer.save(store);

      const retryable = analyzer.findRetryableFailures(24);
      expect(retryable).toHaveLength(2);
    });
  });
});
