import { z } from "zod";
import { LearnedPatternTypeEnum } from "../types/learning.js";
import type { LearningTrigger } from "../types/learning.js";

// ─── LLM Response Schemas ───

export const TripletSchema = z.object({
  state_context: z.string(),
  action_taken: z.string(),
  outcome: z.string(),
  gap_delta: z.number(),
});
export type Triplet = z.infer<typeof TripletSchema>;

export const TripletsResponseSchema = z.object({
  triplets: z.array(TripletSchema),
});

export const PatternItemSchema = z.object({
  description: z.string(),
  pattern_type: LearnedPatternTypeEnum,
  action_group: z.string(),
  applicable_domains: z.array(z.string()).default([]),
  occurrence_count: z.number().int().min(0),
  consistent_count: z.number().int().min(0),
  total_count: z.number().int().min(1),
  is_specific: z.boolean(),
});

export const PatternsResponseSchema = z.object({
  patterns: z.array(PatternItemSchema),
});

// ─── Prompt Builders ───

export function buildExtractionPrompt(
  trigger: LearningTrigger,
  logs: unknown
): string {
  return `Analyze the experience logs for goal "${trigger.goal_id}" and extract state→action→outcome triplets.

Trigger type: ${trigger.type}
Context: ${trigger.context}
Timestamp: ${trigger.timestamp}

Experience logs:
${JSON.stringify(logs, null, 2)}

Extract concrete triplets describing what happened. Each triplet must include:
- state_context: the observable state when the action was taken
- action_taken: a specific, concrete action that was executed
- outcome: what actually happened as a result
- gap_delta: change in goal gap (-1.0 to 1.0, negative means gap reduced/improved)

IMPORTANT: Only include triplets where action_taken describes a specific, concrete action.
Examples of ACCEPTED actions: "reduced task scope to 3 steps", "added prerequisite check at start", "estimated effort at 1.5x"
Examples of REJECTED actions: "did something better", "made improvements", "tried harder"

Output JSON:
{
  "triplets": [
    {
      "state_context": "<specific state description>",
      "action_taken": "<concrete specific action>",
      "outcome": "<measurable outcome>",
      "gap_delta": <number -1.0 to 1.0>
    }
  ]
}

Return ONLY the JSON object, no other text.`;
}

export function buildPatternizationPrompt(triplets: Triplet[]): string {
  return `Analyze the following state→action→outcome triplets and identify repeating patterns.

Triplets:
${JSON.stringify(triplets, null, 2)}

For each group of similar actions, create a pattern entry. Each pattern must have:
- description: a concrete, actionable description (must specify what to do exactly)
- pattern_type: one of "observation_accuracy", "strategy_selection", "scope_sizing", "task_generation"
- action_group: the common action theme across the grouped triplets
- applicable_domains: list of domains where this pattern applies (infer from context)
- occurrence_count: how many triplets have this action group
- consistent_count: how many of those triplets showed consistent outcome direction (all improving or all worsening)
- total_count: total number of triplets analyzed
- is_specific: true if description is concrete enough to act on directly (false for vague descriptions like "do better")

Pattern type mapping:
- "observation_accuracy": patterns about how well observations matched reality
- "strategy_selection": patterns about which strategies worked/failed in which contexts
- "scope_sizing": patterns about task scope, size, or granularity
- "task_generation": patterns about task structure, format, or prerequisites

Only include patterns where is_specific = true AND occurrence_count >= 2.

Output JSON:
{
  "patterns": [
    {
      "description": "<concrete actionable description>",
      "pattern_type": "<type>",
      "action_group": "<common action theme>",
      "applicable_domains": ["<domain1>"],
      "occurrence_count": <int>,
      "consistent_count": <int>,
      "total_count": <int>,
      "is_specific": <boolean>
    }
  ]
}

Return ONLY the JSON object, no other text.`;
}
