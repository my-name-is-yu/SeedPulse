// Barrel: re-exports from learning sub-modules
export type {
  StructuralFeedback,
  StructuralFeedbackType,
  FeedbackAggregation,
  ParameterTuning,
  CrossGoalPattern,
  PatternSharingResult,
} from "../types/learning.js";
export {
  getStructuralFeedback,
  recordStructuralFeedback,
  aggregateFeedback,
  autoTuneParameters,
} from "./learning-feedback.js";
export {
  extractCrossGoalPatterns,
  sharePatternsAcrossGoals,
} from "./learning-cross-goal.js";
