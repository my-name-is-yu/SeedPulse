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
import { DurationSchema, ReversibilityEnum, TaskStatusEnum, VerdictEnum } from "../../../base/types/core.js";
import { upsertTaskHistory } from "../task-history-utils.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const TaskUpdateInputSchema = z.object({
  goalId: z.string().min(1, "goalId is required"),
  taskId: z.string().min(1, "taskId is required"),
  status: TaskStatusEnum.optional(),
  work_description: z.string().optional(),
  rationale: z.string().optional(),
  approach: z.string().optional(),
  success_criteria: z.array(CriterionSchema).optional(),
  scope_boundary: ScopeBoundarySchema.optional(),
  constraints: z.array(z.string()).optional(),
  estimated_duration: DurationSchema.nullable().optional(),
  plateau_until: z.string().nullable().optional(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  timeout_at: z.string().nullable().optional(),
  heartbeat_at: z.string().nullable().optional(),
  consecutive_failure_count: z.number().int().min(0).optional(),
  reversibility: ReversibilityEnum.optional(),
  intended_direction: z.enum(["increase", "decrease", "neutral"]).optional(),
  verification_verdict: VerdictEnum.optional(),
  verification_evidence: z.array(z.string()).optional(),
  verificationVerdict: VerdictEnum.optional(),
  verificationEvidence: z.array(z.string()).optional(),
  appendExecutionOutput: z.string().optional(),
});
export type TaskUpdateInput = z.infer<typeof TaskUpdateInputSchema>;

export class TaskUpdateTool implements ITool<TaskUpdateInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "task_update",
    aliases: ["update_task", "edit_task"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };

  readonly inputSchema = TaskUpdateInputSchema;

  constructor(private readonly stateManager: StateManager) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: TaskUpdateInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const raw = await this.stateManager.readRaw(`tasks/${input.goalId}/${input.taskId}.json`);
      if (raw == null) {
        return {
          success: false,
          data: null,
          summary: `Task not found: ${input.taskId} for goal ${input.goalId}`,
          error: `Task not found: ${input.taskId} for goal ${input.goalId}`,
          durationMs: Date.now() - startTime,
        };
      }

      const parsed = TaskSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          success: false,
          data: null,
          summary: `Task parse failed: ${input.taskId}`,
          error: parsed.error.message,
          durationMs: Date.now() - startTime,
        };
      }

      const updates = Object.fromEntries(
        Object.entries(input).filter(([key, value]) => key !== "goalId" && key !== "taskId" && value !== undefined)
      );

      if (updates["verificationVerdict"] !== undefined) {
        updates["verification_verdict"] = updates["verificationVerdict"];
        delete updates["verificationVerdict"];
      }
      if (updates["verificationEvidence"] !== undefined) {
        updates["verification_evidence"] = updates["verificationEvidence"];
        delete updates["verificationEvidence"];
      }

      const existingOutput = parsed.data.execution_output ?? "";
      if (typeof updates["appendExecutionOutput"] === "string") {
        const appended = `${existingOutput}${updates["appendExecutionOutput"]}`;
        updates["execution_output"] = appended.slice(-2000);
        delete updates["appendExecutionOutput"];
      }

      if (updates["status"] === "running" && parsed.data.started_at == null && updates["started_at"] === undefined) {
        updates["started_at"] = new Date().toISOString();
      }
      if (
        (updates["status"] === "completed" || updates["status"] === "error" || updates["status"] === "timed_out") &&
        parsed.data.completed_at == null &&
        updates["completed_at"] === undefined
      ) {
        updates["completed_at"] = new Date().toISOString();
      }
      if (updates["status"] === "timed_out" && parsed.data.timeout_at == null && updates["timeout_at"] === undefined) {
        updates["timeout_at"] = new Date().toISOString();
      }

      const updatedTask = TaskSchema.parse({
        ...parsed.data,
        ...updates,
      });

      await this.stateManager.writeRaw(`tasks/${input.goalId}/${input.taskId}.json`, updatedTask);
      await upsertTaskHistory(this.stateManager, updatedTask);

      return {
        success: true,
        data: {
          taskId: updatedTask.id,
          goalId: updatedTask.goal_id,
          status: updatedTask.status,
          verification_verdict: updatedTask.verification_verdict,
        },
        summary: `Task updated: ${updatedTask.id} (${updatedTask.status})`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `TaskUpdateTool failed: ${(err as Error).message}`,
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
