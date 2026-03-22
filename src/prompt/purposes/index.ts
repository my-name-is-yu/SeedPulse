/**
 * purposes/index.ts
 * Re-exports all purpose modules and provides the PURPOSE_CONFIGS map.
 */

export * from "./observation.js";
export * from "./task-generation.js";
export * from "./verification.js";
export * from "./strategy.js";
export * from "./goal-decomposition.js";
export * from "./learning.js";
export * from "./capability.js";
export * from "./ethics.js";
export * from "./curiosity.js";
export * from "./checkpoint.js";
export * from "./knowledge.js";
export * from "./memory-distill.js";
export * from "./knowledge-transfer.js";
export * from "./goal-quality.js";
export * from "./dependency.js";
export * from "./strategy-template.js";
export * from "./final-migration.js";

import type { ContextPurpose } from "../slot-definitions.js";
import { OBSERVATION_SYSTEM_PROMPT } from "./observation.js";
import { TASK_GENERATION_SYSTEM_PROMPT } from "./task-generation.js";
import { VERIFICATION_SYSTEM_PROMPT } from "./verification.js";
import { STRATEGY_SYSTEM_PROMPT } from "./strategy.js";
import { GOAL_DECOMPOSITION_SYSTEM_PROMPT } from "./goal-decomposition.js";
import { LEARNING_EXTRACTION_SYSTEM_PROMPT, LEARNING_PATTERNIZE_SYSTEM_PROMPT } from "./learning.js";
import { CAPABILITY_DETECT_SYSTEM_PROMPT, CAPABILITY_GOAL_GAP_SYSTEM_PROMPT, CAPABILITY_VERIFY_SYSTEM_PROMPT } from "./capability.js";
import { ETHICS_SYSTEM_PROMPT } from "./ethics.js";
import { CURIOSITY_PROPOSE_SYSTEM_PROMPT } from "./curiosity.js";
import { CHECKPOINT_ADAPT_SYSTEM_PROMPT } from "./checkpoint.js";
import {
  KNOWLEDGE_GAP_DETECTION_SYSTEM_PROMPT,
  KNOWLEDGE_ACQUISITION_SYSTEM_PROMPT,
  KNOWLEDGE_CONTRADICTION_SYSTEM_PROMPT,
  KNOWLEDGE_ENRICHMENT_SYSTEM_PROMPT,
  KNOWLEDGE_STABILITY_SYSTEM_PROMPT,
  KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT,
  KNOWLEDGE_CONSOLIDATION_SYSTEM_PROMPT,
  KNOWLEDGE_QUERY_SYSTEM_PROMPT,
  KNOWLEDGE_DECISION_SYSTEM_PROMPT,
  KNOWLEDGE_REVALIDATION_SYSTEM_PROMPT,
} from "./knowledge.js";
import {
  MEMORY_DISTILL_EXTRACT_PATTERNS_SYSTEM_PROMPT,
  MEMORY_DISTILL_LESSONS_SYSTEM_PROMPT,
} from "./memory-distill.js";
import {
  KNOWLEDGE_TRANSFER_ADAPT_SYSTEM_PROMPT,
  KNOWLEDGE_TRANSFER_META_PATTERNS_SYSTEM_PROMPT,
  KNOWLEDGE_TRANSFER_INCREMENTAL_SYSTEM_PROMPT,
  KNOWLEDGE_TRANSFER_META_PATTERNS_SYSTEM_PROMPT as KNOWLEDGE_TRANSFER_EXTRACT_SYSTEM_PROMPT,
} from "./knowledge-transfer.js";
import {
  GOAL_QUALITY_ASSESSMENT_SYSTEM_PROMPT,
  GOAL_QUALITY_IMPROVEMENT_SYSTEM_PROMPT,
  GOAL_QUALITY_VALIDATION_SYSTEM_PROMPT,
} from "./goal-quality.js";
import { DEPENDENCY_ANALYSIS_SYSTEM_PROMPT } from "./dependency.js";
import {
  STRATEGY_TEMPLATE_MATCH_SYSTEM_PROMPT,
  STRATEGY_TEMPLATE_ADAPT_SYSTEM_PROMPT,
} from "./strategy-template.js";
import {
  LEARNING_EXTRACTION_SYSTEM_PROMPT as LEARNING_PATTERN_EXTRACT_SYSTEM_PROMPT,
  LEARNING_PATTERNIZE_SYSTEM_PROMPT as LEARNING_INSIGHT_GENERATE_SYSTEM_PROMPT,
} from "./learning.js";
import {
  CAPABILITY_GOAL_GAP_SYSTEM_PROMPT as CAPABILITY_ASSESS_SYSTEM_PROMPT,
  CAPABILITY_VERIFY_SYSTEM_PROMPT as CAPABILITY_PLAN_SYSTEM_PROMPT,
} from "./capability.js";
import {
  GOAL_SUGGESTION_SYSTEM_PROMPT,
  REFLECTION_GENERATION_SYSTEM_PROMPT,
  IMPACT_ANALYSIS_SYSTEM_PROMPT,
  RESULT_RECONCILIATION_SYSTEM_PROMPT,
  NEGOTIATION_FEASIBILITY_SYSTEM_PROMPT,
  NEGOTIATION_CAPABILITY_SYSTEM_PROMPT,
  NEGOTIATION_RESPONSE_SYSTEM_PROMPT,
  GOAL_SPECIFICITY_EVALUATION_SYSTEM_PROMPT,
  GOAL_SUBGOAL_DECOMPOSITION_SYSTEM_PROMPT,
  GOAL_COVERAGE_VALIDATION_SYSTEM_PROMPT,
} from "./final-migration.js";

export interface PurposeConfig {
  systemPrompt: string;
  defaultMaxTokens: number;
  defaultTemperature: number;
}

export const PURPOSE_CONFIGS: Record<ContextPurpose, PurposeConfig> = {
  observation: {
    systemPrompt: OBSERVATION_SYSTEM_PROMPT,
    defaultMaxTokens: 512,
    defaultTemperature: 0,
  },
  task_generation: {
    systemPrompt: TASK_GENERATION_SYSTEM_PROMPT,
    defaultMaxTokens: 2048,
    defaultTemperature: 0,
  },
  verification: {
    systemPrompt: VERIFICATION_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  strategy_generation: {
    systemPrompt: STRATEGY_SYSTEM_PROMPT,
    defaultMaxTokens: 2048,
    defaultTemperature: 0.2,
  },
  goal_decomposition: {
    systemPrompt: GOAL_DECOMPOSITION_SYSTEM_PROMPT,
    defaultMaxTokens: 2048,
    defaultTemperature: 0,
  },
  learning_extraction: {
    systemPrompt: LEARNING_EXTRACTION_SYSTEM_PROMPT,
    defaultMaxTokens: 2048,
    defaultTemperature: 0,
  },
  learning_patternize: {
    systemPrompt: LEARNING_PATTERNIZE_SYSTEM_PROMPT,
    defaultMaxTokens: 2048,
    defaultTemperature: 0,
  },
  capability_detect: {
    systemPrompt: CAPABILITY_DETECT_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  capability_goal_gap: {
    systemPrompt: CAPABILITY_GOAL_GAP_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  capability_verify: {
    systemPrompt: CAPABILITY_VERIFY_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  ethics_evaluate: {
    systemPrompt: ETHICS_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  curiosity_propose: {
    systemPrompt: CURIOSITY_PROPOSE_SYSTEM_PROMPT,
    defaultMaxTokens: 2048,
    defaultTemperature: 0.3,
  },
  checkpoint_adapt: {
    systemPrompt: CHECKPOINT_ADAPT_SYSTEM_PROMPT,
    defaultMaxTokens: 2048,
    defaultTemperature: 0,
  },
  knowledge_gap_detection: {
    systemPrompt: KNOWLEDGE_GAP_DETECTION_SYSTEM_PROMPT,
    defaultMaxTokens: 512,
    defaultTemperature: 0,
  },
  knowledge_acquisition: {
    systemPrompt: KNOWLEDGE_ACQUISITION_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  knowledge_contradiction: {
    systemPrompt: KNOWLEDGE_CONTRADICTION_SYSTEM_PROMPT,
    defaultMaxTokens: 512,
    defaultTemperature: 0,
  },
  knowledge_enrichment: {
    systemPrompt: KNOWLEDGE_ENRICHMENT_SYSTEM_PROMPT,
    defaultMaxTokens: 512,
    defaultTemperature: 0,
  },
  knowledge_stability: {
    systemPrompt: KNOWLEDGE_STABILITY_SYSTEM_PROMPT,
    defaultMaxTokens: 256,
    defaultTemperature: 0,
  },
  memory_distill_extract_patterns: {
    systemPrompt: MEMORY_DISTILL_EXTRACT_PATTERNS_SYSTEM_PROMPT,
    defaultMaxTokens: 2048,
    defaultTemperature: 0,
  },
  memory_distill_lessons: {
    systemPrompt: MEMORY_DISTILL_LESSONS_SYSTEM_PROMPT,
    defaultMaxTokens: 4096,
    defaultTemperature: 0,
  },
  knowledge_transfer_adapt: {
    systemPrompt: KNOWLEDGE_TRANSFER_ADAPT_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  knowledge_transfer_meta_patterns: {
    systemPrompt: KNOWLEDGE_TRANSFER_META_PATTERNS_SYSTEM_PROMPT,
    defaultMaxTokens: 2048,
    defaultTemperature: 0,
  },
  knowledge_transfer_incremental: {
    systemPrompt: KNOWLEDGE_TRANSFER_INCREMENTAL_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  // Batch C: Goal + Strategy (Phase D step 2)
  goal_quality_assessment: {
    systemPrompt: GOAL_QUALITY_ASSESSMENT_SYSTEM_PROMPT,
    defaultMaxTokens: 512,
    defaultTemperature: 0,
  },
  goal_quality_improvement: {
    systemPrompt: GOAL_QUALITY_IMPROVEMENT_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  goal_quality_validation: {
    systemPrompt: GOAL_QUALITY_VALIDATION_SYSTEM_PROMPT,
    defaultMaxTokens: 512,
    defaultTemperature: 0,
  },
  dependency_analysis: {
    systemPrompt: DEPENDENCY_ANALYSIS_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  strategy_template_match: {
    systemPrompt: STRATEGY_TEMPLATE_MATCH_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  strategy_template_adapt: {
    systemPrompt: STRATEGY_TEMPLATE_ADAPT_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  // Batch D: Knowledge (Phase D step 2)
  knowledge_extraction: {
    systemPrompt: KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT,
    defaultMaxTokens: 512,
    defaultTemperature: 0,
  },
  knowledge_consolidation: {
    systemPrompt: KNOWLEDGE_CONSOLIDATION_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  knowledge_query: {
    systemPrompt: KNOWLEDGE_QUERY_SYSTEM_PROMPT,
    defaultMaxTokens: 512,
    defaultTemperature: 0,
  },
  knowledge_decision: {
    systemPrompt: KNOWLEDGE_DECISION_SYSTEM_PROMPT,
    defaultMaxTokens: 512,
    defaultTemperature: 0,
  },
  knowledge_revalidation: {
    systemPrompt: KNOWLEDGE_REVALIDATION_SYSTEM_PROMPT,
    defaultMaxTokens: 256,
    defaultTemperature: 0,
  },
  memory_distill_summarize: {
    systemPrompt: MEMORY_DISTILL_EXTRACT_PATTERNS_SYSTEM_PROMPT,
    defaultMaxTokens: 2048,
    defaultTemperature: 0,
  },
  memory_distill_prioritize: {
    systemPrompt: MEMORY_DISTILL_LESSONS_SYSTEM_PROMPT,
    defaultMaxTokens: 4096,
    defaultTemperature: 0,
  },
  knowledge_transfer_extract: {
    systemPrompt: KNOWLEDGE_TRANSFER_EXTRACT_SYSTEM_PROMPT,
    defaultMaxTokens: 2048,
    defaultTemperature: 0,
  },
  knowledge_transfer_apply: {
    systemPrompt: KNOWLEDGE_TRANSFER_ADAPT_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  knowledge_transfer_validate: {
    systemPrompt: KNOWLEDGE_TRANSFER_INCREMENTAL_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  // Batch E: Learning + Traits (Phase D step 2)
  learning_pattern_extract: {
    systemPrompt: LEARNING_EXTRACTION_SYSTEM_PROMPT,
    defaultMaxTokens: 2048,
    defaultTemperature: 0,
  },
  learning_insight_generate: {
    systemPrompt: LEARNING_PATTERNIZE_SYSTEM_PROMPT,
    defaultMaxTokens: 2048,
    defaultTemperature: 0,
  },
  capability_assess: {
    systemPrompt: CAPABILITY_GOAL_GAP_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  capability_plan: {
    systemPrompt: CAPABILITY_VERIFY_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  ethics_explain: {
    systemPrompt: ETHICS_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  checkpoint_analyze: {
    systemPrompt: CHECKPOINT_ADAPT_SYSTEM_PROMPT,
    defaultMaxTokens: 2048,
    defaultTemperature: 0,
  },
  // Batch F: Final migration (Phase D step 3)
  goal_suggestion: {
    systemPrompt: GOAL_SUGGESTION_SYSTEM_PROMPT,
    defaultMaxTokens: 2048,
    defaultTemperature: 0.3,
  },
  reflection_generation: {
    systemPrompt: REFLECTION_GENERATION_SYSTEM_PROMPT,
    defaultMaxTokens: 512,
    defaultTemperature: 0,
  },
  impact_analysis: {
    systemPrompt: IMPACT_ANALYSIS_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  result_reconciliation: {
    systemPrompt: RESULT_RECONCILIATION_SYSTEM_PROMPT,
    defaultMaxTokens: 512,
    defaultTemperature: 0,
  },
  negotiation_feasibility: {
    systemPrompt: NEGOTIATION_FEASIBILITY_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  negotiation_capability: {
    systemPrompt: NEGOTIATION_CAPABILITY_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  negotiation_response: {
    systemPrompt: NEGOTIATION_RESPONSE_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  goal_specificity_evaluation: {
    systemPrompt: GOAL_SPECIFICITY_EVALUATION_SYSTEM_PROMPT,
    defaultMaxTokens: 512,
    defaultTemperature: 0,
  },
  goal_subgoal_decomposition: {
    systemPrompt: GOAL_SUBGOAL_DECOMPOSITION_SYSTEM_PROMPT,
    defaultMaxTokens: 2048,
    defaultTemperature: 0,
  },
  goal_coverage_validation: {
    systemPrompt: GOAL_COVERAGE_VALIDATION_SYSTEM_PROMPT,
    defaultMaxTokens: 512,
    defaultTemperature: 0,
  },
};
