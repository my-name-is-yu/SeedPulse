import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Logger } from "../runtime/logger.js";
import { buildTaskGenerationPrompt } from "./task-prompt-builder.js";
import type { ILLMClient } from "../llm/llm-client.js";
import { StateManager } from "../state-manager.js";
import { StrategyManager } from "../strategy/strategy-manager.js";
import { TaskSchema } from "../types/task.js";
import type { Task } from "../types/task.js";
import { TaskGroupSchema } from "../types/index.js";
import type { TaskGroup } from "../types/index.js";
import type { TaskPipeline } from "../types/pipeline.js";

// ─── Schema for LLM-generated task fields ───

export const LLMGeneratedTaskSchema = z.object({
  work_description: z.string(),
  rationale: z.string(),
  approach: z.string(),
  success_criteria: z.array(
    z.object({
      description: z.string(),
      verification_method: z.string(),
      is_blocking: z.boolean().default(true),
    })
  ),
  scope_boundary: z.object({
    in_scope: z.array(z.string()),
    out_of_scope: z.array(z.string()),
    blast_radius: z.string(),
  }),
  constraints: z.array(z.string()),
  reversibility: z.enum(["reversible", "irreversible", "unknown"]).default("reversible"),
  estimated_duration: z
    .object({
      value: z.number(),
      unit: z.enum(["minutes", "hours", "days", "weeks"]),
    })
    .nullable()
    .default(null),
});

// ─── Deps interface ───

export interface TaskGenerationDeps {
  stateManager: StateManager;
  llmClient: ILLMClient;
  strategyManager: StrategyManager;
  logger?: Logger;
}

// ─── evaluateTaskComplexity ───

/**
 * Evaluate the complexity of a task to determine pipeline requirements.
 *
 * Rules (from design doc §4):
 * - Small: single file target, simple description (no "and" conjunctions, < 50 chars)
 * - Medium: single file but complex description (6+ expected line changes)
 * - Large: multiple file targets OR "and" in description OR explicit multi-file indicators
 */
export function evaluateTaskComplexity(task: Task): "small" | "medium" | "large" {
  const desc = task.work_description ?? "";
  const targets = task.target_dimensions ?? [];

  // Large: multiple dimensions suggest multiple files or actions
  if (targets.length > 1) return "large";
  // Large: "and" conjunction suggests multiple independent actions
  if (/\band\b/i.test(desc)) return "large";
  // Large: explicit multi-file indicator
  if (/multiple files?|across files?/i.test(desc)) return "large";

  // Small: short and simple
  if (desc.length < 50) return "small";

  // Medium: single target, complex description
  return "medium";
}

// ─── Pipeline builder ───

function buildPipeline(complexity: "small" | "medium" | "large"): TaskPipeline | null {
  if (complexity === "small") return null;
  if (complexity === "medium") {
    return {
      stages: [{ role: "implementor" }, { role: "verifier" }],
      fail_fast: true,
    };
  }
  // large
  return {
    stages: [
      { role: "researcher" },
      { role: "implementor" },
      { role: "verifier" },
      { role: "reviewer" },
    ],
    fail_fast: true,
  };
}

// ─── generateTask ───

/**
 * Generate a task for the given goal and target dimension via LLM.
 *
 * @param deps - dependencies (stateManager, llmClient, strategyManager, logger)
 * @param goalId - the goal this task belongs to
 * @param targetDimension - the dimension this task should improve
 * @param strategyId - optional override; if not provided, uses active strategy
 * @returns the generated and persisted Task
 */
export async function generateTask(
  deps: TaskGenerationDeps,
  goalId: string,
  targetDimension: string,
  strategyId?: string,
  knowledgeContext?: string,
  adapterType?: string,
  existingTasks?: string[],
  workspaceContext?: string
): Promise<Task> {
  const prompt = await buildTaskGenerationPrompt(
    deps.stateManager,
    goalId,
    targetDimension,
    knowledgeContext,
    adapterType,
    existingTasks,
    workspaceContext
  );

  const response = await deps.llmClient.sendMessage(
    [{ role: "user", content: prompt }],
    {
      system:
        "You are a task generation assistant. Given a goal and target dimension, generate a concrete, actionable task. Respond with a JSON object inside a markdown code block.",
      max_tokens: 2048,
    }
  );

  let generated: ReturnType<typeof LLMGeneratedTaskSchema.parse>;
  try {
    generated = deps.llmClient.parseJSON(response.content, LLMGeneratedTaskSchema) as ReturnType<typeof LLMGeneratedTaskSchema.parse>;
  } catch (err) {
    deps.logger?.error(
      "Task generation failed: LLM response did not match expected schema.",
      { rawResponse: response.content.substring(0, 500) }
    );
    throw err;
  }

  // Resolve strategy_id
  const activeStrategy = await deps.strategyManager.getActiveStrategy(goalId);
  const resolvedStrategyId = strategyId ?? activeStrategy?.id ?? null;

  const taskId = randomUUID();
  const now = new Date().toISOString();

  const task = TaskSchema.parse({
    id: taskId,
    goal_id: goalId,
    strategy_id: resolvedStrategyId,
    target_dimensions: [targetDimension],
    primary_dimension: targetDimension,
    work_description: generated.work_description,
    rationale: generated.rationale,
    approach: generated.approach,
    success_criteria: generated.success_criteria,
    scope_boundary: generated.scope_boundary,
    constraints: generated.constraints,
    reversibility: generated.reversibility,
    estimated_duration: generated.estimated_duration,
    status: "pending",
    created_at: now,
  });

  // Attach pipeline based on complexity (additive, backward compatible)
  const complexity = evaluateTaskComplexity(task);
  const pipeline = buildPipeline(complexity);
  if (pipeline) {
    (task as Record<string, unknown>).pipeline = pipeline;
  }

  // Persist
  await deps.stateManager.writeRaw(`tasks/${goalId}/${taskId}.json`, task);

  return task;
}

// ─── generateTaskGroup ───

const LLMTaskGroupSchema = z.object({
  subtasks: z.array(
    z.object({
      work_description: z.string(),
      rationale: z.string(),
      approach: z.string(),
      target_dimension: z.string(),
      success_criteria: z.array(
        z.object({
          description: z.string(),
          verification_method: z.string(),
          is_blocking: z.boolean().default(true),
        })
      ),
      scope_boundary: z.object({
        in_scope: z.array(z.string()),
        out_of_scope: z.array(z.string()),
        blast_radius: z.string(),
      }),
      constraints: z.array(z.string()).default([]),
      reversibility: z.enum(["reversible", "irreversible", "unknown"]).default("reversible"),
    })
  ).min(2),
  dependencies: z
    .array(z.object({ from: z.string(), to: z.string() }))
    .default([]),
  file_ownership: z.record(z.string(), z.array(z.string())).default({}),
  shared_context: z.string().optional(),
});

/**
 * Ask the LLM to decompose a complex task into a TaskGroup of subtasks.
 *
 * @returns TaskGroup on success, null on parse failure
 */
export async function generateTaskGroup(
  llmClient: ILLMClient,
  context: {
    goalDescription: string;
    targetDimension: string;
    currentState: string;
    gap: number;
    availableAdapters: string[];
  },
  logger?: Logger
): Promise<TaskGroup | null> {
  const prompt = [
    `You are a task decomposition assistant. Decompose the following complex task into 2-5 focused subtasks that can be assigned to separate agents.`,
    ``,
    `Goal: ${context.goalDescription}`,
    `Target dimension: ${context.targetDimension}`,
    `Current state: ${context.currentState}`,
    `Gap to close: ${context.gap}`,
    `Available adapters: ${context.availableAdapters.join(", ")}`,
    ``,
    `Respond with a JSON object inside a markdown code block with this structure:`,
    `{`,
    `  "subtasks": [ { "work_description", "rationale", "approach", "target_dimension", "success_criteria", "scope_boundary", "constraints", "reversibility" }, ... ],`,
    `  "dependencies": [ { "from": "<subtask index>", "to": "<subtask index>" }, ... ],`,
    `  "file_ownership": { "<subtask index>": ["file1", "file2"], ... },`,
    `  "shared_context": "<optional shared context for all subtasks>"`,
    `}`,
    ``,
    `Use subtask array index (as string) for dependency/ownership keys. Ensure at least 2 subtasks.`,
  ].join("\n");

  let response: { content: string };
  try {
    response = await llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      {
        system: "You are a task decomposition assistant. Respond with valid JSON only.",
        max_tokens: 4096,
      }
    );
  } catch (err) {
    logger?.error("generateTaskGroup: LLM call failed", { error: String(err) });
    return null;
  }

  let raw: z.infer<typeof LLMTaskGroupSchema>;
  try {
    raw = llmClient.parseJSON(response.content, LLMTaskGroupSchema) as z.infer<typeof LLMTaskGroupSchema>;
  } catch (err) {
    logger?.error("generateTaskGroup: LLM response did not match TaskGroup schema", {
      rawResponse: response.content.substring(0, 500),
    });
    return null;
  }

  const now = new Date().toISOString();

  // Build full Task objects from LLM subtask descriptions
  const subtasks: Task[] = raw.subtasks.map((sub, i) => {
    const taskId = `subtask-${i}-${randomUUID()}`;
    const complexity = sub.work_description.length < 50 ? "small" : "medium";
    const task = TaskSchema.parse({
      id: taskId,
      goal_id: "",
      strategy_id: null,
      target_dimensions: [sub.target_dimension],
      primary_dimension: sub.target_dimension,
      work_description: sub.work_description,
      rationale: sub.rationale,
      approach: sub.approach,
      success_criteria: sub.success_criteria,
      scope_boundary: sub.scope_boundary,
      constraints: sub.constraints,
      reversibility: sub.reversibility,
      estimated_duration: null,
      status: "pending",
      created_at: now,
    });
    const pipeline = buildPipeline(complexity);
    if (pipeline) {
      (task as Record<string, unknown>).pipeline = pipeline;
    }
    return task;
  });

  // Remap file_ownership keys from index strings to task IDs
  const remappedOwnership: Record<string, string[]> = {};
  for (const [key, files] of Object.entries(raw.file_ownership)) {
    const idx = parseInt(key, 10);
    if (!isNaN(idx) && subtasks[idx]) {
      remappedOwnership[subtasks[idx].id] = files;
    } else {
      remappedOwnership[key] = files;
    }
  }

  // Remap dependency keys from index strings to task IDs
  const remappedDeps = raw.dependencies.map((dep) => {
    const fromIdx = parseInt(dep.from, 10);
    const toIdx = parseInt(dep.to, 10);
    return {
      from: !isNaN(fromIdx) && subtasks[fromIdx] ? subtasks[fromIdx].id : dep.from,
      to: !isNaN(toIdx) && subtasks[toIdx] ? subtasks[toIdx].id : dep.to,
    };
  });

  try {
    return TaskGroupSchema.parse({
      subtasks,
      dependencies: remappedDeps,
      file_ownership: remappedOwnership,
      shared_context: raw.shared_context,
    });
  } catch (err) {
    logger?.error("generateTaskGroup: final TaskGroup parse failed", { error: String(err) });
    return null;
  }
}
