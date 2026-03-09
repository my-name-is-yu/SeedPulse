import { describe, it, expect, beforeEach } from 'vitest';
import { TrustManager } from '../../src/collaboration/trust.js';
import { TrustBalance } from '../../src/state/models.js';

describe('TrustManager', () => {
  let manager: TrustManager;
  let baseTrust: TrustBalance;

  beforeEach(() => {
    manager = new TrustManager();
    baseTrust = TrustBalance.parse({ global: 0.7, per_goal: { 'goal-1': 0.5 } });
  });

  describe('updateOnSuccess', () => {
    it('increments global trust by 0.05', () => {
      const result = manager.updateOnSuccess(baseTrust);
      expect(result.global).toBeCloseTo(0.75, 5);
    });

    it('does not mutate the original trust object', () => {
      manager.updateOnSuccess(baseTrust);
      expect(baseTrust.global).toBe(0.7);
    });

    it('increments per-goal trust when goalId matches existing key', () => {
      const result = manager.updateOnSuccess(baseTrust, 'goal-1');
      expect(result.per_goal['goal-1']).toBeCloseTo(0.55, 5);
    });

    it('does not add per-goal entry for unknown goalId', () => {
      const result = manager.updateOnSuccess(baseTrust, 'goal-unknown');
      expect('goal-unknown' in result.per_goal).toBe(false);
    });

    it('clamps global trust at 1.0', () => {
      const highTrust = TrustBalance.parse({ global: 0.98 });
      const result = manager.updateOnSuccess(highTrust);
      expect(result.global).toBe(1.0);
    });
  });

  describe('updateOnFailure', () => {
    it('decrements global trust by 0.15', () => {
      const result = manager.updateOnFailure(baseTrust);
      expect(result.global).toBeCloseTo(0.55, 5);
    });

    it('does not mutate the original trust object', () => {
      manager.updateOnFailure(baseTrust);
      expect(baseTrust.global).toBe(0.7);
    });

    it('decrements per-goal trust when goalId matches existing key', () => {
      const result = manager.updateOnFailure(baseTrust, 'goal-1');
      expect(result.per_goal['goal-1']).toBeCloseTo(0.35, 5);
    });

    it('does not add per-goal entry for unknown goalId', () => {
      const result = manager.updateOnFailure(baseTrust, 'goal-unknown');
      expect('goal-unknown' in result.per_goal).toBe(false);
    });

    it('clamps global trust at 0.0', () => {
      const lowTrust = TrustBalance.parse({ global: 0.1 });
      const result = manager.updateOnFailure(lowTrust);
      expect(result.global).toBe(0.0);
    });
  });

  describe('updateOnIrreversibleSuccess', () => {
    it('increments global trust by 0.1', () => {
      const result = manager.updateOnIrreversibleSuccess(baseTrust);
      expect(result.global).toBeCloseTo(0.8, 5);
    });

    it('increments per-goal trust by 0.1 when goalId matches', () => {
      const result = manager.updateOnIrreversibleSuccess(baseTrust, 'goal-1');
      expect(result.per_goal['goal-1']).toBeCloseTo(0.6, 5);
    });

    it('clamps global trust at 1.0', () => {
      const highTrust = TrustBalance.parse({ global: 0.95 });
      const result = manager.updateOnIrreversibleSuccess(highTrust);
      expect(result.global).toBe(1.0);
    });
  });

  describe('updateOnIrreversibleFailure', () => {
    it('decrements global trust by 0.3', () => {
      const result = manager.updateOnIrreversibleFailure(baseTrust);
      expect(result.global).toBeCloseTo(0.4, 5);
    });

    it('decrements per-goal trust by 0.3 when goalId matches', () => {
      const result = manager.updateOnIrreversibleFailure(baseTrust, 'goal-1');
      expect(result.per_goal['goal-1']).toBeCloseTo(0.2, 5);
    });

    it('clamps global trust at 0.0', () => {
      const lowTrust = TrustBalance.parse({ global: 0.2 });
      const result = manager.updateOnIrreversibleFailure(lowTrust);
      expect(result.global).toBe(0.0);
    });

    it('clamps per-goal trust at 0.0', () => {
      const trust = TrustBalance.parse({ global: 0.5, per_goal: { 'goal-1': 0.1 } });
      const result = manager.updateOnIrreversibleFailure(trust, 'goal-1');
      expect(result.per_goal['goal-1']).toBe(0.0);
    });
  });
});
