import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ActionLogger, ActionLogEntry } from '../../src/learning/logger.js';

const TEST_DIR = join(tmpdir(), `motive-logger-test-${Date.now()}`);
const LOG_PATH = join(TEST_DIR, 'log.jsonl');

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('ActionLogger', () => {
  describe('createEntry', () => {
    it('creates entry with all fields when before/after states provided', () => {
      const logger = new ActionLogger(LOG_PATH);
      const entry = logger.createEntry({
        sessionId: 'sess-001',
        goalId: 'goal-001',
        stateBefore: { progress: 0.3, quality_score: 0.5 },
        action: { tool: 'Write', target: 'src/auth/jwt.ts' },
        stateAfter: { progress: 0.35, quality_score: 0.5 },
        outcome: 'success',
      });

      expect(entry.session_id).toBe('sess-001');
      expect(entry.goal_id).toBe('goal-001');
      expect(entry.action.tool).toBe('Write');
      expect(entry.action.target).toBe('src/auth/jwt.ts');
      expect(entry.outcome).toBe('success');
      expect(entry.state_before).toEqual({ progress: 0.3, quality_score: 0.5 });
      expect(entry.state_after).toEqual({ progress: 0.35, quality_score: 0.5 });
      expect(entry.timestamp).toBeTruthy();
    });

    it('computes state_delta correctly', () => {
      const logger = new ActionLogger(LOG_PATH);
      const entry = logger.createEntry({
        sessionId: 'sess-001',
        stateBefore: { progress: 0.3, quality_score: 0.5 },
        action: { tool: 'Write' },
        stateAfter: { progress: 0.35, quality_score: 0.5 },
        outcome: 'success',
      });

      expect(entry.state_delta).toEqual({ progress: expect.closeTo(0.05, 10) });
      // quality_score unchanged — should not appear in delta
      expect(entry.state_delta?.quality_score).toBeUndefined();
    });

    it('returns empty state_delta when values are unchanged', () => {
      const logger = new ActionLogger(LOG_PATH);
      const entry = logger.createEntry({
        sessionId: 'sess-001',
        stateBefore: { progress: 0.5 },
        action: { tool: 'Read' },
        stateAfter: { progress: 0.5 },
        outcome: 'skipped',
      });

      expect(entry.state_delta).toBeUndefined();
    });

    it('omits state_delta when before/after are missing', () => {
      const logger = new ActionLogger(LOG_PATH);
      const entry = logger.createEntry({
        sessionId: 'sess-002',
        action: { tool: 'Bash' },
        outcome: 'failure',
      });

      expect(entry.state_before).toBeUndefined();
      expect(entry.state_after).toBeUndefined();
      expect(entry.state_delta).toBeUndefined();
      expect(entry.goal_id).toBeUndefined();
    });

    it('omits state_delta when only before is provided', () => {
      const logger = new ActionLogger(LOG_PATH);
      const entry = logger.createEntry({
        sessionId: 'sess-003',
        stateBefore: { progress: 0.4 },
        action: { tool: 'Read' },
        outcome: 'success',
      });

      expect(entry.state_delta).toBeUndefined();
    });
  });

  describe('append and readRecent', () => {
    it('appends entries and reads them back', () => {
      const logger = new ActionLogger(LOG_PATH);
      const e1 = logger.createEntry({
        sessionId: 'sess-001',
        action: { tool: 'Write', target: 'foo.ts' },
        outcome: 'success',
      });
      const e2 = logger.createEntry({
        sessionId: 'sess-001',
        action: { tool: 'Bash' },
        outcome: 'failure',
      });

      logger.append(e1);
      logger.append(e2);

      const recent = logger.readRecent();
      expect(recent).toHaveLength(2);
      expect(recent[0].action.tool).toBe('Write');
      expect(recent[1].action.tool).toBe('Bash');
    });

    it('returns empty array when log file does not exist', () => {
      const logger = new ActionLogger(join(TEST_DIR, 'nonexistent.jsonl'));
      expect(logger.readRecent()).toEqual([]);
    });

    it('respects the limit parameter', () => {
      const logger = new ActionLogger(LOG_PATH);
      for (let i = 0; i < 10; i++) {
        logger.append(
          logger.createEntry({
            sessionId: 'sess-001',
            action: { tool: `Tool${i}` },
            outcome: 'success',
          }),
        );
      }

      const recent = logger.readRecent(3);
      expect(recent).toHaveLength(3);
      // Should be the last 3 entries
      expect(recent[2].action.tool).toBe('Tool9');
    });

    it('creates parent directory if it does not exist', () => {
      const deepPath = join(TEST_DIR, 'deep', 'nested', 'log.jsonl');
      const logger = new ActionLogger(deepPath);
      const entry = logger.createEntry({
        sessionId: 'sess-001',
        action: { tool: 'Write' },
        outcome: 'success',
      });
      logger.append(entry);
      expect(existsSync(deepPath)).toBe(true);
    });

    it('parses valid ActionLogEntry schema', () => {
      const logger = new ActionLogger(LOG_PATH);
      const entry = logger.createEntry({
        sessionId: 'sess-xyz',
        goalId: 'goal-abc',
        stateBefore: { progress: 0.1 },
        action: { tool: 'Edit', target: 'main.ts' },
        stateAfter: { progress: 0.2 },
        outcome: 'success',
      });
      logger.append(entry);

      const parsed = logger.readRecent(1);
      expect(ActionLogEntry.safeParse(parsed[0]).success).toBe(true);
    });
  });
});
