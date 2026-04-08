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
import { TaskSchema } from "../../../base/types/task.js";
import { upsertTaskHistory } from "../task-history-utils.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const TaskStopInputSchema = z.object({
  goalId: z.string().min(1, "goalId is required"),
  taskId: z.string().min(1, "taskId is required"),
  reason: z.string().default("Stopped manually"),
});
export type TaskStopInput = z.infer<typeof TaskStopInputSchema>;

export class TaskStopTool implements ITool<TaskStopInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "task_stop",
    aliases: ["stop_task", "cancel_task"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };

  readonly inputSchema = TaskStopInputSchema;

  constructor(private readonly stateManager: StateManager) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: TaskStopInput, _context: ToolCallContext): Promise<ToolResult> {
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

      const existingOutput = parsed.data.execution_output?.trim();
      const stopLine = `[STOPPED] ${input.reason}`;
      const now = new Date().toISOString();
      const updatedTask = TaskSchema.parse({
        ...parsed.data,
        status: "error",
        completed_at: parsed.data.completed_at ?? now,
        timeout_at: parsed.data.timeout_at ?? null,
        execution_output: existingOutput ? `${existingOutput}\n\n${stopLine}` : stopLine,
      });

      await this.stateManager.writeRaw(`tasks/${input.goalId}/${input.taskId}.json`, updatedTask);
      await upsertTaskHistory(this.stateManager, updatedTask);

      return {
        success: true,
        data: {
          taskId: updatedTask.id,
          goalId: updatedTask.goal_id,
          status: updatedTask.status,
        },
        summary: `Task stopped: ${updatedTask.id}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `TaskStopTool failed: ${(err as Error).message}`,
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
