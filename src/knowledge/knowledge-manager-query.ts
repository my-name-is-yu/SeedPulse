import { randomUUID } from "node:crypto";
import { z } from "zod";
import { StateManager } from "../state/state-manager.js";
import type { ILLMClient } from "../llm/llm-client.js";
import type { IPromptGateway } from "../prompt/gateway.js";
import type { Logger } from "../logger.js";
import { TaskSchema } from "../types/task.js";
import type { Task } from "../types/task.js";
import {
  KnowledgeGapSignalSchema,
  ContradictionResultSchema,
} from "../types/knowledge.js";
import type {
  KnowledgeEntry,
  KnowledgeGapSignal,
  ContradictionResult,
} from "../types/knowledge.js";
import { loadDomainKnowledge } from "./knowledge-search.js";

// ─── Deps interface ───

export interface KnowledgeQueryDeps {
  llmClient: ILLMClient;
  gateway?: IPromptGateway;
  stateManager: StateManager;
  logger?: Logger;
}

// ─── LLM response schemas ───

export const GapDetectionResponseSchema = z.object({
  has_gap: z.boolean(),
  signal_type: z
    .enum([
      "interpretation_difficulty",
      "strategy_deadlock",
      "stall_information_deficit",
      "new_domain",
      "prerequisite_missing",
    ])
    .optional(),
  missing_knowledge: z.string().optional(),
  source_step: z.string().optional(),
  related_dimension: z.string().nullable().optional(),
});

export const AcquisitionTaskFieldsSchema = z.object({
  knowledge_target: z.string(),
  // Allow up to 6 from LLM; we clamp to 5 in generateAcquisitionTask
  knowledge_questions: z.array(z.string()).min(3),
  in_scope: z.array(z.string()),
  out_of_scope: z.array(z.string()),
});

export const ContradictionCheckResponseSchema = z.object({
  has_contradiction: z.boolean(),
  conflicting_entry_id: z.string().nullable().default(null),
  resolution: z.string().nullable().default(null),
});

// ─── detectKnowledgeGap ───

/**
 * Detect whether the given context reveals a knowledge gap.
 *
 * Fast-path heuristics:
 *   - confidence < 0.3 → interpretation_difficulty
 *   - strategies empty  → strategy_deadlock
 *
 * Otherwise, delegate to LLM for deeper analysis.
 */
export async function detectKnowledgeGap(
  deps: KnowledgeQueryDeps,
  context: {
    observations: unknown[];
    strategies: unknown[] | null | undefined;
    confidence: number;
  }
): Promise<KnowledgeGapSignal | null> {
  const { llmClient, gateway } = deps;

  // Fast-path: low confidence → interpretation difficulty
  if (context.confidence < 0.3) {
    return KnowledgeGapSignalSchema.parse({
      signal_type: "interpretation_difficulty",
      missing_knowledge:
        "Observation confidence is too low to interpret results reliably",
      source_step: "gap_recognition",
      related_dimension: null,
    });
  }

  // Fast-path: strategies is an explicit empty array (tried and found none) → strategy deadlock.
  // null/undefined means "not yet available" and must NOT trigger this fast-path.
  if (Array.isArray(context.strategies) && context.strategies.length === 0) {
    return KnowledgeGapSignalSchema.parse({
      signal_type: "strategy_deadlock",
      missing_knowledge:
        "No strategies available — domain knowledge needed to generate hypotheses",
      source_step: "strategy_selection",
      related_dimension: null,
    });
  }

  // LLM-based detection for borderline cases
  const prompt = `Analyze the following context and determine whether there is a knowledge gap that would prevent effective progress.

Observations (${context.observations.length} items): ${JSON.stringify(context.observations).slice(0, 500)}
Strategies (${(context.strategies ?? []).length} items): ${JSON.stringify(context.strategies ?? []).slice(0, 500)}
Confidence: ${context.confidence}

Determine if there is a knowledge gap. Respond with JSON:
{
  "has_gap": boolean,
  "signal_type": "interpretation_difficulty" | "strategy_deadlock" | "stall_information_deficit" | "new_domain" | "prerequisite_missing" | null,
  "missing_knowledge": "description of what is missing" | null,
  "source_step": "gap_recognition" | "strategy_selection" | "task_generation" | null,
  "related_dimension": "dimension name" | null
}`;

  let parsed: z.infer<typeof GapDetectionResponseSchema>;
  if (gateway) {
    try {
      parsed = await gateway.execute({
        purpose: "knowledge_gap_detection",
        additionalContext: { gap_detection_prompt: prompt },
        responseSchema: GapDetectionResponseSchema,
        maxTokens: 512,
      });
    } catch {
      return null;
    }
  } else {
    const response = await llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      {
        system:
          "You are a knowledge gap detector. Analyze contexts to identify missing domain knowledge. Respond with JSON only.",
        max_tokens: 512,
      }
    );

    try {
      parsed = llmClient.parseJSON(response.content, GapDetectionResponseSchema);
    } catch {
      return null;
    }
  }

  if (!parsed.has_gap) {
    return null;
  }

  return KnowledgeGapSignalSchema.parse({
    signal_type: parsed.signal_type ?? "interpretation_difficulty",
    missing_knowledge:
      parsed.missing_knowledge ?? "Unspecified knowledge gap detected",
    source_step: parsed.source_step ?? "gap_recognition",
    related_dimension: parsed.related_dimension ?? null,
  });
}

// ─── generateAcquisitionTask ───

/**
 * Generate a knowledge acquisition Task for the given signal and goal.
 * The task will have task_category: "knowledge_acquisition", 3-5 research
 * questions, and explicit scope limits.
 */
export async function generateAcquisitionTask(
  deps: KnowledgeQueryDeps,
  signal: KnowledgeGapSignal,
  goalId: string
): Promise<Task> {
  const { llmClient, gateway, stateManager } = deps;

  const prompt = `You are generating a knowledge acquisition task for an AI orchestrator.

Goal ID: ${goalId}
Knowledge Gap Signal:
  Type: ${signal.signal_type}
  Missing Knowledge: ${signal.missing_knowledge}
  Source Step: ${signal.source_step}
  Related Dimension: ${signal.related_dimension ?? "none"}

Generate a research task with 3-5 specific questions that, when answered, will resolve this knowledge gap.
The task must be scoped to information collection only — no system changes.

Respond with JSON:
{
  "knowledge_target": "concise description of what knowledge is needed",
  "knowledge_questions": ["question 1", "question 2", "question 3"],
  "in_scope": ["item 1", "item 2"],
  "out_of_scope": ["item 1", "item 2"]
}`;

  let fields: z.infer<typeof AcquisitionTaskFieldsSchema>;
  if (gateway) {
    fields = await gateway.execute({
      purpose: "knowledge_acquisition",
      goalId,
      additionalContext: { acquisition_prompt: prompt },
      responseSchema: AcquisitionTaskFieldsSchema,
      maxTokens: 1024,
    });
  } else {
    const response = await llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      {
        system:
          "You generate knowledge acquisition tasks. Produce 3-5 specific research questions. Respond with JSON only.",
        max_tokens: 1024,
      }
    );

    fields = llmClient.parseJSON(response.content, AcquisitionTaskFieldsSchema);
  }

  // Clamp questions to 3-5
  const questions = fields.knowledge_questions.slice(0, 5);

  const taskId = randomUUID();
  const now = new Date().toISOString();

  const criteriaDescription = `All ${questions.length} research questions are answered with cited sources: ${questions.join("; ")}`;

  const task = TaskSchema.parse({
    id: taskId,
    goal_id: goalId,
    strategy_id: null,
    target_dimensions: signal.related_dimension
      ? [signal.related_dimension]
      : [],
    primary_dimension: signal.related_dimension ?? "knowledge",
    work_description: `Research task: ${fields.knowledge_target}`,
    rationale: `Knowledge gap detected (${signal.signal_type}): ${signal.missing_knowledge}`,
    approach: `Research the following questions using web search and document analysis:
${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
    success_criteria: [
      {
        description: criteriaDescription,
        verification_method:
          "Verify each question has a cited answer in the task output",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["Information collection", "Web search", "Document reading", ...fields.in_scope],
      out_of_scope: [
        "System modifications",
        "Code changes",
        "Data mutations",
        ...fields.out_of_scope,
      ],
      blast_radius: "None — read-only research task",
    },
    constraints: [
      `In scope: ${fields.in_scope.join(", ")}. Out of scope: ${fields.out_of_scope.join(", ")}`,
      "No system modifications allowed",
      "Maximum 3-5 research questions per task",
    ],
    reversibility: "reversible",
    estimated_duration: { value: 4, unit: "hours" },
    task_category: "knowledge_acquisition",
    status: "pending",
    created_at: now,
  });

  // Persist
  await stateManager.writeRaw(`tasks/${goalId}/${taskId}.json`, task);

  return task;
}

// ─── checkContradiction ───

/**
 * Check whether a new entry contradicts existing same-tag entries.
 * Uses LLM to compare answers for entries sharing tags with the new entry.
 */
export async function checkContradiction(
  deps: KnowledgeQueryDeps,
  goalId: string,
  newEntry: KnowledgeEntry
): Promise<ContradictionResult> {
  const { llmClient, gateway, stateManager } = deps;

  // Load entries that share at least one tag with the new entry
  const domainKnowledge = await loadDomainKnowledge(stateManager, goalId);
  const candidateEntries = domainKnowledge.entries.filter(
    (existing) =>
      existing.entry_id !== newEntry.entry_id &&
      existing.tags.some((tag) => newEntry.tags.includes(tag)) &&
      existing.superseded_by === null
  );

  if (candidateEntries.length === 0) {
    return ContradictionResultSchema.parse({
      has_contradiction: false,
      conflicting_entry_id: null,
      resolution: null,
    });
  }

  const existingSummary = candidateEntries
    .map(
      (e) =>
        `Entry ${e.entry_id}:
  Question: ${e.question}
  Answer: ${e.answer}
  Tags: ${e.tags.join(", ")}`
    )
    .join("\n\n");

  const prompt = `Check whether the new knowledge entry contradicts any existing entries.

New Entry:
  Question: ${newEntry.question}
  Answer: ${newEntry.answer}
  Tags: ${newEntry.tags.join(", ")}

Existing Entries (same tags):
${existingSummary}

Determine if there is a factual contradiction. Respond with JSON:
{
  "has_contradiction": boolean,
  "conflicting_entry_id": "entry_id of the conflicting entry" | null,
  "resolution": "explanation of the contradiction and suggested resolution" | null
}`;

  if (gateway) {
    try {
      const parsed = await gateway.execute({
        purpose: "knowledge_contradiction",
        goalId,
        additionalContext: { contradiction_prompt: prompt },
        responseSchema: ContradictionCheckResponseSchema,
        maxTokens: 512,
      });
      return ContradictionResultSchema.parse(parsed);
    } catch {
      return ContradictionResultSchema.parse({
        has_contradiction: false,
        conflicting_entry_id: null,
        resolution: null,
      });
    }
  } else {
    const response = await llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      {
        system:
          "You are a knowledge consistency checker. Detect factual contradictions between knowledge entries. Respond with JSON only.",
        max_tokens: 512,
      }
    );

    try {
      const parsed = llmClient.parseJSON(
        response.content,
        ContradictionCheckResponseSchema
      );
      return ContradictionResultSchema.parse(parsed);
    } catch {
      return ContradictionResultSchema.parse({
        has_contradiction: false,
        conflicting_entry_id: null,
        resolution: null,
      });
    }
  }
}
