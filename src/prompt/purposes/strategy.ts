/**
 * strategy.ts
 * System prompt and response schema for the "strategy_generation" purpose.
 * Used by PromptGateway to generate candidate strategies for achieving a goal.
 */

import { z } from "zod";

export const STRATEGY_SYSTEM_PROMPT = `Generate candidate strategies for achieving the goal.
Consider past lessons, strategy templates from similar goals, and the current gap.
Each strategy should have a testable hypothesis and a clear approach.
Prefer strategies that have succeeded on similar goals when templates are available.

Respond with a JSON array (NOT a wrapped object). The array must contain 1-2 strategy objects.
Each object must have these fields:
- "hypothesis": string (the core bet/approach)
- "expected_effect": array of { "dimension": string, "direction": "increase"|"decrease", "magnitude": "small"|"medium"|"large" }
- "resource_estimate": { "sessions": number, "duration": { "value": number, "unit": "minutes"|"hours"|"days"|"weeks" }, "llm_calls": number|null }
- "allocation": number between 0 and 1

Example format:
[
  {
    "hypothesis": "...",
    "expected_effect": [{ "dimension": "...", "direction": "increase", "magnitude": "medium" }],
    "resource_estimate": { "sessions": 3, "duration": { "value": 2, "unit": "hours" }, "llm_calls": null },
    "allocation": 0.5
  }
]`;

export const StrategyResponseSchema = z.array(
  z.object({
    hypothesis: z.string(),
    expected_effect: z.array(
      z.object({
        dimension: z.string(),
        direction: z.enum(["increase", "decrease"]),
        magnitude: z.enum(["small", "medium", "large"]),
      })
    ),
    resource_estimate: z.object({
      sessions: z.number(),
      duration: z.object({
        value: z.number(),
        unit: z.enum(["minutes", "hours", "days", "weeks"]),
      }),
      llm_calls: z.number().nullable().default(null),
    }),
    allocation: z.number().min(0).max(1).default(0),
  })
);

export type StrategyResponse = z.infer<typeof StrategyResponseSchema>;
