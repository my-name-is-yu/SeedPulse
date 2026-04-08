import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolMetadata,
  ToolResult,
} from "../../types.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import { CriterionSchema, ScopeBoundarySchema, TaskSchema } from "../../../base/types/task.js";
import { DurationSchema, ReversibilityEnum } from "../../../base/types/core.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const TaskCreateInputSchema = z.object({
  goalId: z.string().min(1, "goalId is required"),
  strategyId: z.string().nullable().optional(),
  targetDimensions: z.array(z.string()).min(1, "at least one target dimension is required"),
  primaryDimension: z.string().min(1, "primaryDimension is required"),
  work_description: z.string().min(1, "work_description is required"),
  rationale: z.string().default("Created manually via task_create"),
  approach: z.string().default("Delegate to a sub-agent and record results back into the task."),
  success_criteria: z.array(CriterionSchema).default([]),
  scope_boundary: ScopeBoundarySchema.default({
    in_scope: [],
    out_of_scope: [],
    blast_radius: "unknown",
  }),
  constraints: z.array(z.string()).default([]),
  reversibility: ReversibilityEnum.default("unknown"),
  intended_direction: z.enum(["increase", "decrease", "neutral"]).optional(),
  estimated_duration: DurationSchema.nullable().default(null),
  task_category: z
    .enum(["normal", "knowledge_acquisition", "verification", "observation", "capability_acquisition"])
    .default("normal"),
});
export type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>;

export class TaskCreateTool implements ITool<TaskCreateInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "task_create",
    aliases: ["create_task"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };

  readonly inputSchema = TaskCreateInputSchema;

  constructor(private readonly stateManager: StateManager) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: TaskCreateInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const normalized = this.inputSchema.parse(input);
      const now = new Date().toISOString();
      const taskId = randomUUID();
      const task = TaskSchema.parse({
        id: taskId,
        goal_id: normalized.goalId,
        strategy_id: normalized.strategyId ?? null,
        target_dimensions: normalized.targetDimensions,
        primary_dimension: normalized.primaryDimension,
        work_description: normalized.work_description,
        rationale: normalized.rationale,
        approach: normalized.approach,
        success_criteria: normalized.success_criteria,
        scope_boundary: normalized.scope_boundary,
        constraints: normalized.constraints,
        reversibility: normalized.reversibility,
        intended_direction: normalized.intended_direction,
        estimated_duration: normalized.estimated_duration,
        task_category: normalized.task_category,
        status: "pending",
        created_at: now,
      });

      await this.stateManager.writeRaw(`tasks/${normalized.goalId}/${taskId}.json`, task);

      return {
        success: true,
        data: {
          taskId: task.id,
          goalId: task.goal_id,
          status: task.status,
        },
        summary: `Task created: ${task.id}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `TaskCreateTool failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}
