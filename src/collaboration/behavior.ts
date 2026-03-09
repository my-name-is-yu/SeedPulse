export type BehaviorAction = 'autonomous' | 'confirm_with_human' | 'verify_first';

export class BehaviorMatrix {
  /**
   * Decide behavior based on trust level and confidence alone.
   *
   * | Trust  | Confidence | Behavior           |
   * | >=0.6  | >=0.7      | autonomous         |
   * | >=0.6  | <0.7       | confirm_with_human |
   * | <0.6   | >=0.7      | confirm_with_human |
   * | <0.6   | <0.7       | verify_first       |
   */
  decide(trustLevel: number, confidence: number): BehaviorAction {
    const highTrust = trustLevel >= 0.6;
    const highConfidence = confidence >= 0.7;

    if (highTrust && highConfidence) return 'autonomous';
    if (!highTrust && !highConfidence) return 'verify_first';
    return 'confirm_with_human';
  }

  /**
   * Decide behavior for a specific action, taking irreversibility into account.
   * Irreversible actions always require human confirmation regardless of trust/confidence.
   */
  decideForAction(trustLevel: number, confidence: number, isIrreversible: boolean): BehaviorAction {
    if (isIrreversible) return 'confirm_with_human';
    return this.decide(trustLevel, confidence);
  }
}
