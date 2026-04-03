import { z } from "zod";
import type { ILLMClient } from "../llm/llm-client.js";
import type { IPromptGateway } from "../prompt/gateway.js";
import type { ShortTermEntry, LessonEntry } from "../types/memory-lifecycle.js";

// ─── LLM response schemas ───

const PatternExtractionResponseSchema = z.object({
  patterns: z.array(z.string()),
});

const LessonDistillationResponseSchema = z.object({
  lessons: z.array(
    z.object({
      type: z.enum(["strategy_outcome", "success_pattern", "failure_pattern"]),
      context: z.string(),
      action: z.string().optional(),
      outcome: z.string().optional(),
      lesson: z.string(),
      relevance_tags: z.array(z.string()).default([]),
      failure_reason: z.string().optional(),
      avoidance_hint: z.string().optional(),
      applicability: z.string().optional(),
    })
  ),
});

// ─── LLM helpers ───

/**
 * Call LLM to extract recurring patterns from a set of short-term entries.
 */
export async function extractPatterns(
  llmClient: ILLMClient,
  entries: ShortTermEntry[],
  gateway?: IPromptGateway
): Promise<string[]> {
  const prompt = `Analyze the following experience log entries and extract recurring patterns, key insights, and lessons learned. Focus on what worked, what failed, and why.

Return a JSON object with a "patterns" array of pattern strings:
{
  "patterns": ["pattern 1", "pattern 2", ...]
}

Entries (${entries.length} total):
${JSON.stringify(
  entries.slice(0, 20).map((e) => ({
    data_type: e.data_type,
    loop_number: e.loop_number,
    dimensions: e.dimensions,
    tags: e.tags,
    data: e.data,
  })),
  null,
  2
)}`;

  if (gateway) {
    try {
      const parsed = await gateway.execute({
        purpose: "memory_distill_extract_patterns",
        additionalContext: { extract_patterns_prompt: prompt },
        responseSchema: PatternExtractionResponseSchema,
        maxTokens: 2048,
      });
      return parsed.patterns;
    } catch {
      return [];
    }
  } else {
    const response = await llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      {
        system:
          "You are a pattern extraction engine. Analyze experience logs and identify recurring patterns, successes, and failures. Respond with JSON only.",
        max_tokens: 2048,
      }
    );

    try {
      const parsed = llmClient.parseJSON(
        response.content,
        PatternExtractionResponseSchema
      );
      return parsed.patterns;
    } catch {
      return [];
    }
  }
}

/**
 * Call LLM to convert extracted patterns into structured LessonEntry objects.
 */
export async function distillLessons(
  llmClient: ILLMClient,
  patterns: string[],
  entries: ShortTermEntry[],
  gateway?: IPromptGateway
): Promise<Array<{
  type: "strategy_outcome" | "success_pattern" | "failure_pattern";
  context: string;
  action?: string;
  outcome?: string;
  lesson: string;
  relevance_tags: string[];
  failure_reason?: string;
  avoidance_hint?: string;
  applicability?: string;
}>> {
  if (patterns.length === 0) return [];

  const failureEntries = entries.filter(
    (e) =>
      e.data["status"] === "failed" ||
      e.data["verdict"] === "fail" ||
      e.data["outcome"] === "failure"
  );

  const prompt = `Convert the following patterns into structured lessons. For each pattern, determine if it represents a strategy outcome, success pattern, or failure pattern.

Patterns:
${patterns.map((p, i) => `${i + 1}. ${p}`).join("\n")}

Failure context (${failureEntries.length} failure entries found):
${JSON.stringify(
  failureEntries.slice(0, 5).map((e) => e.data),
  null,
  2
)}

Return a JSON object with a "lessons" array:
{
  "lessons": [
    {
      "type": "strategy_outcome" | "success_pattern" | "failure_pattern",
      "context": "what situation this lesson applies to",
      "action": "what action was taken (optional)",
      "outcome": "what result occurred (optional)",
      "lesson": "the key lesson learned",
      "relevance_tags": ["tag1", "tag2"],
      "failure_reason": "why it failed (for failure_pattern only)",
      "avoidance_hint": "how to avoid next time (for failure_pattern only)",
      "applicability": "when to apply (for success_pattern only)"
    }
  ]
}`;

  if (gateway) {
    try {
      const parsed = await gateway.execute({
        purpose: "memory_distill_lessons",
        additionalContext: { distill_lessons_prompt: prompt },
        responseSchema: LessonDistillationResponseSchema,
        maxTokens: 4096,
      });
      return parsed.lessons.map((l) => ({
        ...l,
        relevance_tags: l.relevance_tags ?? [],
      }));
    } catch {
      return [];
    }
  } else {
    const response = await llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      {
        system:
          "You are a lesson distillation engine. Convert experience patterns into structured, actionable lessons. Respond with JSON only.",
        max_tokens: 4096,
      }
    );

    try {
      const parsed = llmClient.parseJSON(
        response.content,
        LessonDistillationResponseSchema
      );
      // Normalize: ensure relevance_tags is always a string[]
      return parsed.lessons.map((l) => ({
        ...l,
        relevance_tags: l.relevance_tags ?? [],
      }));
    } catch {
      return [];
    }
  }
}

/**
 * Validate compression quality.
 * MVP check: lesson_count >= failure_count * 0.5
 */
export function validateCompressionQuality(
  lessons: LessonEntry[],
  entries: ShortTermEntry[]
): { passed: boolean; failure_coverage_ratio: number; contradictions_found: number } {
  // Count failure entries
  const failureCount = entries.filter(
    (e) =>
      e.data["status"] === "failed" ||
      e.data["verdict"] === "fail" ||
      e.data["outcome"] === "failure"
  ).length;

  // MVP ratio check: lessons >= failures * 0.5
  const lessonCount = lessons.length;
  const failure_coverage_ratio =
    failureCount === 0
      ? 1
      : Math.min(1, lessonCount / (failureCount * 0.5));
  const passed =
    failureCount === 0 || lessonCount >= failureCount * 0.5;

  // Contradiction detection: check for lessons with opposite type covering same context
  let contradictions_found = 0;
  for (let i = 0; i < lessons.length; i++) {
    for (let j = i + 1; j < lessons.length; j++) {
      const a = lessons[i]!;
      const b = lessons[j]!;
      const isOppositeType =
        (a.type === "success_pattern" && b.type === "failure_pattern") ||
        (a.type === "failure_pattern" && b.type === "success_pattern");
      const sharesTag = a.relevance_tags.some((t) =>
        b.relevance_tags.includes(t)
      );
      if (isOppositeType && sharesTag) {
        contradictions_found++;
      }
    }
  }

  return {
    passed,
    failure_coverage_ratio,
    contradictions_found,
  };
}
