/**
 * slot-definitions.ts
 * Purpose-specific slot configurations for the PromptGateway.
 * Defines context slots, memory layers, budget categories, and per-purpose configs.
 */

// ─── Core Types ──────────────────────────────────────────────────────────────

export type ContextPurpose =
  | "observation"
  | "task_generation"
  | "verification"
  | "strategy_generation"
  | "goal_decomposition"
  | "learning_extraction"
  | "learning_patternize"
  | "capability_detect"
  | "capability_goal_gap"
  | "capability_verify"
  | "ethics_evaluate"
  | "curiosity_propose"
  | "checkpoint_adapt"
  | "knowledge_gap_detection"
  | "knowledge_acquisition"
  | "knowledge_contradiction"
  | "knowledge_enrichment"
  | "knowledge_stability"
  | "memory_distill_extract_patterns"
  | "memory_distill_lessons"
  | "knowledge_transfer_adapt"
  | "knowledge_transfer_meta_patterns"
  | "knowledge_transfer_incremental"
  // Batch C: Goal + Strategy (Phase D step 2)
  | "goal_quality_assessment"
  | "goal_quality_improvement"
  | "goal_quality_validation"
  | "dependency_analysis"
  | "strategy_template_match"
  | "strategy_template_adapt"
  // Batch D: Knowledge (Phase D step 2)
  | "knowledge_extraction"
  | "knowledge_consolidation"
  | "knowledge_query"
  | "knowledge_decision"
  | "knowledge_revalidation"
  | "memory_distill_summarize"
  | "memory_distill_prioritize"
  | "knowledge_transfer_extract"
  | "knowledge_transfer_apply"
  | "knowledge_transfer_validate"
  // Batch E: Learning + Traits (Phase D step 2)
  | "learning_pattern_extract"
  | "learning_insight_generate"
  | "capability_assess"
  | "capability_plan"
  | "ethics_explain"
  | "checkpoint_analyze"
  // Batch F: Final migration (Phase D step 3)
  | "goal_suggestion"
  | "reflection_generation"
  | "impact_analysis"
  | "result_reconciliation"
  | "negotiation_feasibility"
  | "negotiation_capability"
  | "negotiation_response"
  | "goal_specificity_evaluation"
  | "goal_subgoal_decomposition"
  | "goal_coverage_validation";

export type ContextSlot =
  | "goal_definition"
  | "current_state"
  | "dimension_history"
  | "recent_task_results"
  | "reflections"
  | "lessons"
  | "knowledge"
  | "strategy_templates"
  | "workspace_state"
  | "failure_context";

export type MemoryLayer = "hot" | "warm" | "cold" | "archival";

export type BudgetCategory =
  | "goalDefinition"
  | "observations"
  | "knowledge"
  | "transferKnowledge"
  | "meta";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface SlotDefinition {
  slot: ContextSlot;
  layer: MemoryLayer;
  xmlTag: string;
  /** Lower value = higher priority (used for budget trimming) */
  priority: number;
}

export interface PurposeSlotConfig {
  purpose: ContextPurpose;
  activeSlots: ContextSlot[];
  budgetOverrides?: Partial<Record<BudgetCategory, number>>;
}

// ─── Default Budget Allocations (percentages) ────────────────────────────────

export const DEFAULT_BUDGET: Record<BudgetCategory, number> = {
  goalDefinition: 20,
  observations: 30,
  knowledge: 30,
  transferKnowledge: 15,
  meta: 5,
};

// ─── Slot Definitions ────────────────────────────────────────────────────────

const SLOT_DEFINITIONS: SlotDefinition[] = [
  { slot: "goal_definition",      layer: "hot",      xmlTag: "goal_definition",      priority: 1 },
  { slot: "current_state",        layer: "hot",      xmlTag: "current_state",         priority: 2 },
  { slot: "dimension_history",    layer: "warm",     xmlTag: "dimension_history",     priority: 5 },
  { slot: "recent_task_results",  layer: "warm",     xmlTag: "recent_task_results",   priority: 4 },
  { slot: "reflections",          layer: "warm",     xmlTag: "reflections",           priority: 6 },
  { slot: "lessons",              layer: "cold",     xmlTag: "lessons",               priority: 7 },
  { slot: "knowledge",            layer: "archival", xmlTag: "knowledge",             priority: 8 },
  { slot: "strategy_templates",   layer: "archival", xmlTag: "strategy_templates",    priority: 9 },
  { slot: "workspace_state",      layer: "warm",     xmlTag: "workspace_state",       priority: 3 },
  { slot: "failure_context",      layer: "warm",     xmlTag: "failure_context",       priority: 10 },
];

const SLOT_DEFINITION_MAP = new Map<ContextSlot, SlotDefinition>(
  SLOT_DEFINITIONS.map((d) => [d.slot, d])
);

// ─── Purpose → Active Slots (slot matrix §5.2) ───────────────────────────────

const PURPOSE_SLOT_CONFIGS: PurposeSlotConfig[] = [
  {
    purpose: "observation",
    activeSlots: [
      "goal_definition",
      "current_state",
      "dimension_history",
      "workspace_state",
    ],
    budgetOverrides: {
      observations: 40,
      knowledge: 15,
    },
  },
  {
    purpose: "task_generation",
    activeSlots: [
      "goal_definition",
      "current_state",
      "recent_task_results",
      "reflections",
      "lessons",
      "knowledge",
      "workspace_state",
      "failure_context",
    ],
    budgetOverrides: {
      knowledge: 35,
      observations: 25,
    },
  },
  {
    purpose: "verification",
    activeSlots: [
      "goal_definition",
      "current_state",
      "recent_task_results",
      "knowledge",
    ],
    budgetOverrides: {
      observations: 35,
      knowledge: 25,
    },
  },
  {
    purpose: "strategy_generation",
    activeSlots: [
      "goal_definition",
      "current_state",
      "lessons",
      "knowledge",
      "strategy_templates",
    ],
    budgetOverrides: {
      knowledge: 40,
      transferKnowledge: 20,
      observations: 15,
      goalDefinition: 20,
      meta: 5,
    },
  },
  {
    purpose: "goal_decomposition",
    activeSlots: [
      "goal_definition",
      "knowledge",
    ],
    budgetOverrides: {
      goalDefinition: 30,
      knowledge: 35,
      observations: 15,
      transferKnowledge: 15,
      meta: 5,
    },
  },
  {
    purpose: "learning_extraction",
    activeSlots: ["goal_definition"],
    budgetOverrides: { goalDefinition: 20, observations: 60, knowledge: 10, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "learning_patternize",
    activeSlots: ["goal_definition"],
    budgetOverrides: { goalDefinition: 10, observations: 70, knowledge: 10, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "capability_detect",
    activeSlots: ["goal_definition", "current_state"],
    budgetOverrides: { goalDefinition: 30, observations: 40, knowledge: 20, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "capability_goal_gap",
    activeSlots: ["goal_definition", "current_state"],
    budgetOverrides: { goalDefinition: 30, observations: 40, knowledge: 20, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "capability_verify",
    activeSlots: ["goal_definition", "current_state"],
    budgetOverrides: { goalDefinition: 20, observations: 50, knowledge: 20, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "ethics_evaluate",
    activeSlots: ["goal_definition"],
    budgetOverrides: { goalDefinition: 40, observations: 30, knowledge: 20, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "curiosity_propose",
    activeSlots: ["goal_definition", "current_state", "lessons"],
    budgetOverrides: { goalDefinition: 25, observations: 35, knowledge: 25, transferKnowledge: 10, meta: 5 },
  },
  {
    purpose: "checkpoint_adapt",
    activeSlots: ["goal_definition", "current_state"],
    budgetOverrides: { goalDefinition: 20, observations: 50, knowledge: 20, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "knowledge_gap_detection",
    activeSlots: ["recent_task_results"],
    budgetOverrides: { goalDefinition: 5, observations: 80, knowledge: 10, transferKnowledge: 0, meta: 5 },
  },
  {
    purpose: "knowledge_acquisition",
    activeSlots: ["recent_task_results"],
    budgetOverrides: { goalDefinition: 5, observations: 80, knowledge: 10, transferKnowledge: 0, meta: 5 },
  },
  {
    purpose: "knowledge_contradiction",
    activeSlots: ["recent_task_results"],
    budgetOverrides: { goalDefinition: 5, observations: 80, knowledge: 10, transferKnowledge: 0, meta: 5 },
  },
  {
    purpose: "knowledge_enrichment",
    activeSlots: ["recent_task_results"],
    budgetOverrides: { goalDefinition: 5, observations: 80, knowledge: 10, transferKnowledge: 0, meta: 5 },
  },
  {
    purpose: "knowledge_stability",
    activeSlots: ["recent_task_results"],
    budgetOverrides: { goalDefinition: 5, observations: 80, knowledge: 10, transferKnowledge: 0, meta: 5 },
  },
  {
    purpose: "memory_distill_extract_patterns",
    activeSlots: ["recent_task_results"],
    budgetOverrides: { goalDefinition: 5, observations: 80, knowledge: 10, transferKnowledge: 0, meta: 5 },
  },
  {
    purpose: "memory_distill_lessons",
    activeSlots: ["recent_task_results"],
    budgetOverrides: { goalDefinition: 5, observations: 80, knowledge: 10, transferKnowledge: 0, meta: 5 },
  },
  {
    purpose: "knowledge_transfer_adapt",
    activeSlots: ["recent_task_results"],
    budgetOverrides: { goalDefinition: 5, observations: 80, knowledge: 10, transferKnowledge: 0, meta: 5 },
  },
  {
    purpose: "knowledge_transfer_meta_patterns",
    activeSlots: ["recent_task_results"],
    budgetOverrides: { goalDefinition: 5, observations: 80, knowledge: 10, transferKnowledge: 0, meta: 5 },
  },
  {
    purpose: "knowledge_transfer_incremental",
    activeSlots: ["recent_task_results"],
    budgetOverrides: { goalDefinition: 5, observations: 80, knowledge: 10, transferKnowledge: 0, meta: 5 },
  },
  // Batch C: Goal + Strategy (Phase D step 2)
  {
    purpose: "goal_quality_assessment",
    activeSlots: ["goal_definition"],
    budgetOverrides: { goalDefinition: 40, observations: 30, knowledge: 20, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "goal_quality_improvement",
    activeSlots: ["goal_definition"],
    budgetOverrides: { goalDefinition: 40, observations: 30, knowledge: 20, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "goal_quality_validation",
    activeSlots: ["goal_definition"],
    budgetOverrides: { goalDefinition: 40, observations: 30, knowledge: 20, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "dependency_analysis",
    activeSlots: ["goal_definition", "current_state"],
    budgetOverrides: { goalDefinition: 30, observations: 40, knowledge: 20, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "strategy_template_match",
    activeSlots: ["goal_definition", "current_state", "strategy_templates"],
    budgetOverrides: { goalDefinition: 20, observations: 30, knowledge: 30, transferKnowledge: 15, meta: 5 },
  },
  {
    purpose: "strategy_template_adapt",
    activeSlots: ["goal_definition", "current_state", "strategy_templates"],
    budgetOverrides: { goalDefinition: 20, observations: 30, knowledge: 30, transferKnowledge: 15, meta: 5 },
  },
  // Batch D: Knowledge (Phase D step 2)
  {
    purpose: "knowledge_extraction",
    activeSlots: ["recent_task_results"],
    budgetOverrides: { goalDefinition: 5, observations: 80, knowledge: 10, transferKnowledge: 0, meta: 5 },
  },
  {
    purpose: "knowledge_consolidation",
    activeSlots: ["recent_task_results", "knowledge"],
    budgetOverrides: { goalDefinition: 5, observations: 40, knowledge: 50, transferKnowledge: 0, meta: 5 },
  },
  {
    purpose: "knowledge_query",
    activeSlots: ["knowledge"],
    budgetOverrides: { goalDefinition: 5, observations: 20, knowledge: 70, transferKnowledge: 0, meta: 5 },
  },
  {
    purpose: "knowledge_decision",
    activeSlots: ["recent_task_results", "knowledge"],
    budgetOverrides: { goalDefinition: 5, observations: 60, knowledge: 30, transferKnowledge: 0, meta: 5 },
  },
  {
    purpose: "knowledge_revalidation",
    activeSlots: ["knowledge"],
    budgetOverrides: { goalDefinition: 5, observations: 30, knowledge: 60, transferKnowledge: 0, meta: 5 },
  },
  {
    purpose: "memory_distill_summarize",
    activeSlots: ["recent_task_results"],
    budgetOverrides: { goalDefinition: 5, observations: 80, knowledge: 10, transferKnowledge: 0, meta: 5 },
  },
  {
    purpose: "memory_distill_prioritize",
    activeSlots: ["recent_task_results"],
    budgetOverrides: { goalDefinition: 5, observations: 80, knowledge: 10, transferKnowledge: 0, meta: 5 },
  },
  {
    purpose: "knowledge_transfer_extract",
    activeSlots: ["recent_task_results"],
    budgetOverrides: { goalDefinition: 5, observations: 80, knowledge: 10, transferKnowledge: 0, meta: 5 },
  },
  {
    purpose: "knowledge_transfer_apply",
    activeSlots: ["recent_task_results"],
    budgetOverrides: { goalDefinition: 5, observations: 60, knowledge: 20, transferKnowledge: 15, meta: 5 },
  },
  {
    purpose: "knowledge_transfer_validate",
    activeSlots: ["recent_task_results"],
    budgetOverrides: { goalDefinition: 5, observations: 60, knowledge: 20, transferKnowledge: 10, meta: 5 },
  },
  // Batch E: Learning + Traits (Phase D step 2)
  {
    purpose: "learning_pattern_extract",
    activeSlots: ["goal_definition"],
    budgetOverrides: { goalDefinition: 20, observations: 60, knowledge: 10, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "learning_insight_generate",
    activeSlots: ["goal_definition"],
    budgetOverrides: { goalDefinition: 10, observations: 70, knowledge: 10, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "capability_assess",
    activeSlots: ["goal_definition", "current_state"],
    budgetOverrides: { goalDefinition: 30, observations: 40, knowledge: 20, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "capability_plan",
    activeSlots: ["goal_definition", "current_state"],
    budgetOverrides: { goalDefinition: 20, observations: 50, knowledge: 20, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "ethics_explain",
    activeSlots: ["goal_definition"],
    budgetOverrides: { goalDefinition: 40, observations: 30, knowledge: 20, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "checkpoint_analyze",
    activeSlots: ["goal_definition", "current_state"],
    budgetOverrides: { goalDefinition: 20, observations: 50, knowledge: 20, transferKnowledge: 5, meta: 5 },
  },
  // Batch F: Final migration (Phase D step 3)
  {
    purpose: "goal_suggestion",
    activeSlots: ["goal_definition", "current_state", "knowledge"],
    budgetOverrides: { goalDefinition: 30, observations: 30, knowledge: 30, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "reflection_generation",
    activeSlots: ["goal_definition", "recent_task_results"],
    budgetOverrides: { goalDefinition: 20, observations: 60, knowledge: 10, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "impact_analysis",
    activeSlots: ["goal_definition", "recent_task_results"],
    budgetOverrides: { goalDefinition: 15, observations: 65, knowledge: 10, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "result_reconciliation",
    activeSlots: ["recent_task_results"],
    budgetOverrides: { goalDefinition: 5, observations: 80, knowledge: 10, transferKnowledge: 0, meta: 5 },
  },
  {
    purpose: "negotiation_feasibility",
    activeSlots: ["goal_definition", "current_state"],
    budgetOverrides: { goalDefinition: 30, observations: 40, knowledge: 20, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "negotiation_capability",
    activeSlots: ["goal_definition", "current_state"],
    budgetOverrides: { goalDefinition: 25, observations: 45, knowledge: 20, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "negotiation_response",
    activeSlots: ["goal_definition"],
    budgetOverrides: { goalDefinition: 40, observations: 30, knowledge: 20, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "goal_specificity_evaluation",
    activeSlots: ["goal_definition"],
    budgetOverrides: { goalDefinition: 40, observations: 30, knowledge: 20, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "goal_subgoal_decomposition",
    activeSlots: ["goal_definition", "knowledge"],
    budgetOverrides: { goalDefinition: 30, observations: 30, knowledge: 30, transferKnowledge: 5, meta: 5 },
  },
  {
    purpose: "goal_coverage_validation",
    activeSlots: ["goal_definition"],
    budgetOverrides: { goalDefinition: 40, observations: 30, knowledge: 20, transferKnowledge: 5, meta: 5 },
  },
];

const PURPOSE_CONFIG_MAP = new Map<ContextPurpose, PurposeSlotConfig>(
  PURPOSE_SLOT_CONFIGS.map((c) => [c.purpose, c])
);

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns the slot configuration (active slots + budget overrides) for a given purpose.
 * Throws if the purpose is not registered (should never happen with the union type).
 */
export function getSlotConfig(purpose: ContextPurpose): PurposeSlotConfig {
  const config = PURPOSE_CONFIG_MAP.get(purpose);
  if (!config) {
    throw new Error(`No slot config registered for purpose: ${purpose}`);
  }
  return config;
}

/**
 * Returns the full SlotDefinition for a given slot name.
 * Throws if the slot is not registered.
 */
export function getSlotDefinition(slot: ContextSlot): SlotDefinition {
  const def = SLOT_DEFINITION_MAP.get(slot);
  if (!def) {
    throw new Error(`No slot definition registered for slot: ${slot}`);
  }
  return def;
}
