import { z } from "zod";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolMetadata,
  ToolResult,
} from "../../types.js";
import type { ScheduleEngine } from "../../../runtime/schedule/engine.js";
import type { ScheduleEntry } from "../../../runtime/types/schedule.js";
import { resolveScheduleEntry } from "../../../runtime/schedule/entry-resolver.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const RemoveScheduleInputSchema = z.object({
  schedule_id: z.string().min(1),
});
export type RemoveScheduleInput = z.infer<typeof RemoveScheduleInputSchema>;

export interface RemoveScheduleOutput {
  removed: true;
  entry: {
    id: string;
    name: string;
  };
}

export class RemoveScheduleTool implements ITool<RemoveScheduleInput, RemoveScheduleOutput> {
  readonly metadata: ToolMetadata = {
    name: "remove_schedule",
    aliases: ["delete_schedule"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: true,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };

  readonly inputSchema = RemoveScheduleInputSchema;

  constructor(private readonly scheduleEngine: ScheduleEngine) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: RemoveScheduleInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      const existingEntry = resolveScheduleEntry(this.scheduleEngine.getEntries(), input.schedule_id);
      if (!existingEntry) {
        return {
          success: false,
          data: null,
          summary: `Schedule not found: ${input.schedule_id}`,
          error: `Schedule not found: ${input.schedule_id}`,
          durationMs: Date.now() - startTime,
        };
      }

      const removed = await this.scheduleEngine.removeEntry(existingEntry.id);
      if (!removed) {
        return {
          success: false,
          data: null,
          summary: `Schedule not found: ${input.schedule_id}`,
          error: `Schedule not found: ${input.schedule_id}`,
          durationMs: Date.now() - startTime,
        };
      }

      return {
        success: true,
        data: {
          removed: true,
          entry: {
            id: existingEntry.id,
            name: existingEntry.name,
          },
        },
        summary: `Removed schedule: ${existingEntry.name}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `RemoveScheduleTool failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(
    _input: RemoveScheduleInput,
    context: ToolCallContext,
  ): Promise<PermissionCheckResult> {
    if (context.preApproved) return { status: "allowed" };
    return {
      status: "needs_approval",
      reason: "Removing a persistent schedule is irreversible and requires approval",
    };
  }

  isConcurrencySafe(_input: RemoveScheduleInput): boolean {
    return false;
  }
}
