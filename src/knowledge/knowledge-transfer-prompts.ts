import { z } from "zod";
import type { LearnedPattern } from "../types/learning.js";

// ─── LLM Response Schemas ───

export const AdaptationResponseSchema = z.object({
  adaptation_description: z.string(),
  adapted_content: z.string(),
  success: z.boolean(),
});

export const MetaPatternsResponseSchema = z.object({
  meta_patterns: z.array(
    z.object({
      description: z.string(),
      applicable_domains: z.array(z.string()),
      source_pattern_ids: z.array(z.string()),
    })
  ),
});

// ─── Prompt Builders ───

export function buildAdaptationPrompt(
  sourcePattern: LearnedPattern,
  sourceGoalId: string,
  targetGoalId: string
): string {
  return `You are adapting a learned pattern from one goal context to another.

Source Goal ID: ${sourceGoalId}
Target Goal ID: ${targetGoalId}

Source Pattern:
  ID: ${sourcePattern.pattern_id}
  Type: ${sourcePattern.type}
  Description: ${sourcePattern.description}
  Confidence: ${sourcePattern.confidence}
  Applicable Domains: ${sourcePattern.applicable_domains.join(", ") || "none"}

Task: Adapt this pattern so it is relevant and applicable for the target goal context.
- Remove goal-specific details from the source
- Generalize where needed
- Identify if direct application is possible

Respond with JSON:
{
  "adaptation_description": "<concise description of how the pattern was adapted for the target goal>",
  "adapted_content": "<the adapted pattern description ready for injection into target goal context>",
  "success": <boolean — true if adaptation is meaningful and applicable>
}

Return ONLY the JSON object, no other text.`;
}

export function buildMetaPatternPrompt(patterns: LearnedPattern[]): string {
  const patternSummaries = patterns
    .slice(0, 50) // limit to avoid token overflow
    .map(
      (p) =>
        `- [${p.type}] ${p.description} (confidence: ${p.confidence.toFixed(2)}, domains: ${p.applicable_domains.join(", ") || "general"})`
    )
    .join("\n");

  return `You are extracting cross-domain meta-patterns from a collection of learned patterns across multiple goals.

Learned Patterns (${patterns.length} total, showing up to 50):
${patternSummaries}

Identify 3-7 meta-patterns that generalize across multiple learned patterns and domains.
Each meta-pattern should:
- Be applicable across different domains and goals
- Abstract away goal-specific details
- Capture universal principles about effective execution

Output JSON:
{
  "meta_patterns": [
    {
      "description": "<concrete, actionable meta-pattern description>",
      "applicable_domains": ["<domain1>", "<domain2>"],
      "source_pattern_ids": ["<pattern_id_1>", "<pattern_id_2>"]
    }
  ]
}

Return ONLY the JSON object, no other text.`;
}
