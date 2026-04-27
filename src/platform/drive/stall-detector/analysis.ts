import { StallAnalysisSchema } from "../../../base/types/stall.js";
import type { StallAnalysis } from "../../../base/types/stall.js";

export function analyzeStallCause(gapHistory: Array<{ normalized_gap: number }>): StallAnalysis {
  const minimumEntries = 3;

  if (gapHistory.length < minimumEntries) {
    return StallAnalysisSchema.parse({
      cause: "strategy_wrong",
      confidence: 0.3,
      evidence: `Insufficient history (${gapHistory.length} entries, need ${minimumEntries})`,
      recommended_action: "pivot",
    });
  }

  const gaps = gapHistory.map((entry) => entry.normalized_gap);
  const count = gaps.length;
  const mean = gaps.reduce((sum, value) => sum + value, 0) / count;
  const variance = gaps.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;
  const delta = gaps[count - 1] - gaps[0];

  let monotonicallyIncreasing = true;
  for (let index = 1; index < count; index += 1) {
    if (gaps[index] <= gaps[index - 1]) {
      monotonicallyIncreasing = false;
      break;
    }
  }

  if (monotonicallyIncreasing && delta > 0.05) {
    return StallAnalysisSchema.parse({
      cause: "goal_unreachable",
      confidence: 0.8,
      evidence: `Gap is monotonically increasing (delta=${delta.toFixed(3)})`,
      recommended_action: "escalate",
    });
  }

  if (variance > 0.01 && Math.abs(delta) < 0.05) {
    return StallAnalysisSchema.parse({
      cause: "parameter_issue",
      confidence: 0.75,
      evidence: `Oscillating gap (variance=${variance.toFixed(4)}, delta=${delta.toFixed(3)})`,
      recommended_action: "refine",
    });
  }

  if (variance <= 0.005 && Math.abs(delta) < 0.05) {
    return StallAnalysisSchema.parse({
      cause: "strategy_wrong",
      confidence: 0.75,
      evidence: `Flat gap with no progress (variance=${variance.toFixed(4)}, delta=${delta.toFixed(3)})`,
      recommended_action: "pivot",
    });
  }

  return StallAnalysisSchema.parse({
    cause: "strategy_wrong",
    confidence: 0.5,
    evidence: `Unclear pattern (variance=${variance.toFixed(4)}, delta=${delta.toFixed(3)})`,
    recommended_action: "pivot",
  });
}

