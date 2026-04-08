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
import { DESCRIPTION } from "./prompt.js";
import { TAGS, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const TaskOutputInputSchema = z.object({
  goalId: z.string().min(1, "goalId is required"),
  taskId: z.string().min(1, "taskId is required"),
  content: z.string(),
  mode: z.enum(["append", "replace"]).default("append"),
});
export type TaskOutputInput = z.infer<typeof TaskOutputInputSchema>;

export class TaskOutputTool implements ITool<TaskOutputInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "task_output",
    aliases: ["write_task_output", "append_task_output"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };

  readonly inputSchema = TaskOutputInputSchema;

  constructor(private readonly stateManager: StateManager) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: TaskOutputInput, _context: ToolCallContext): Promise<ToolResult> {
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

      const existingOutput = parsed.data.execution_output;
      const nextOutput = input.mode === "replace"
        ? input.content
        : existingOutput
          ? `${existingOutput}\n\n${input.content}`
          : input.content;

      const updatedTask = TaskSchema.parse({
        ...parsed.data,
        execution_output: nextOutput,
      });

      await this.stateManager.writeRaw(`tasks/${input.goalId}/${input.taskId}.json`, updatedTask);

      return {
        success: true,
        data: {
          taskId: updatedTask.id,
          goalId: updatedTask.goal_id,
          outputLength: nextOutput.length,
          mode: input.mode,
        },
        summary: `Task output ${input.mode}d: ${updatedTask.id} (${nextOutput.length} chars)`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `TaskOutputTool failed: ${(err as Error).message}`,
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
