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
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS } from "./constants.js";
import { DESCRIPTION } from "./prompt.js";

export const TaskGetInputSchema = z.object({
  goalId: z.string(),
  taskId: z.string(),
});
export type TaskGetInput = z.infer<typeof TaskGetInputSchema>;

export class TaskGetTool implements ITool<TaskGetInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "task_get",
    aliases: ["get_task", "observe_task"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };

  readonly inputSchema = TaskGetInputSchema;

  constructor(private readonly stateManager: StateManager) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: TaskGetInput, _context: ToolCallContext): Promise<ToolResult> {
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

      return {
        success: true,
        data: parsed.data,
        summary: `Task ${parsed.data.id}: status=${parsed.data.status}, category=${parsed.data.task_category}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `TaskGetTool failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}
