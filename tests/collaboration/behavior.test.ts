import { describe, it, expect, beforeEach } from 'vitest';
import { BehaviorMatrix } from '../../src/collaboration/behavior.js';

describe('BehaviorMatrix', () => {
  let matrix: BehaviorMatrix;

  beforeEach(() => {
    matrix = new BehaviorMatrix();
  });

  describe('decide', () => {
    it('returns autonomous when trust >= 0.6 and confidence >= 0.7', () => {
      expect(matrix.decide(0.6, 0.7)).toBe('autonomous');
      expect(matrix.decide(0.8, 0.9)).toBe('autonomous');
      expect(matrix.decide(1.0, 1.0)).toBe('autonomous');
    });

    it('returns confirm_with_human when trust >= 0.6 and confidence < 0.7', () => {
      expect(matrix.decide(0.6, 0.69)).toBe('confirm_with_human');
      expect(matrix.decide(0.9, 0.5)).toBe('confirm_with_human');
      expect(matrix.decide(1.0, 0.0)).toBe('confirm_with_human');
    });

    it('returns confirm_with_human when trust < 0.6 and confidence >= 0.7', () => {
      expect(matrix.decide(0.59, 0.7)).toBe('confirm_with_human');
      expect(matrix.decide(0.3, 0.9)).toBe('confirm_with_human');
      expect(matrix.decide(0.0, 1.0)).toBe('confirm_with_human');
    });

    it('returns verify_first when trust < 0.6 and confidence < 0.7', () => {
      expect(matrix.decide(0.59, 0.69)).toBe('verify_first');
      expect(matrix.decide(0.3, 0.5)).toBe('verify_first');
      expect(matrix.decide(0.0, 0.0)).toBe('verify_first');
    });

    it('uses exact boundary values correctly (0.6 trust, 0.7 confidence)', () => {
      expect(matrix.decide(0.6, 0.7)).toBe('autonomous');
      expect(matrix.decide(0.6, 0.699)).toBe('confirm_with_human');
      expect(matrix.decide(0.599, 0.7)).toBe('confirm_with_human');
      expect(matrix.decide(0.599, 0.699)).toBe('verify_first');
    });
  });

  describe('decideForAction', () => {
    it('returns confirm_with_human for irreversible action regardless of trust/confidence', () => {
      expect(matrix.decideForAction(1.0, 1.0, true)).toBe('confirm_with_human');
      expect(matrix.decideForAction(0.9, 0.9, true)).toBe('confirm_with_human');
      expect(matrix.decideForAction(0.0, 0.0, true)).toBe('confirm_with_human');
    });

    it('delegates to decide() when action is not irreversible', () => {
      expect(matrix.decideForAction(0.8, 0.8, false)).toBe('autonomous');
      expect(matrix.decideForAction(0.8, 0.5, false)).toBe('confirm_with_human');
      expect(matrix.decideForAction(0.4, 0.8, false)).toBe('confirm_with_human');
      expect(matrix.decideForAction(0.4, 0.4, false)).toBe('verify_first');
    });
  });
});
