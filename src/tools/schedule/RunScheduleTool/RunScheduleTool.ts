import { z } from "zod";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolMetadata,
  ToolResult,
} from "../../types.js";
import type { ScheduleEngine, RunScheduleNowResult } from "../../../runtime/schedule/engine.js";
import type { ScheduleEntry } from "../../../runtime/types/schedule.js";
import { DaemonClient, isDaemonRunning } from "../../../runtime/daemon/client.js";
import { resolveScheduleEntry } from "../../../runtime/schedule/entry-resolver.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const RunScheduleInputSchema = z.object({
  schedule_id: z.string().min(1),
  allow_escalation: z.boolean().default(false),
});
export type RunScheduleInput = z.infer<typeof RunScheduleInputSchema>;

export interface RunScheduleOutput {
  entry: ScheduleEntry | null;
  result: RunScheduleNowResult["result"];
  reason: RunScheduleNowResult["reason"];
}

export class RunScheduleTool implements ITool<RunScheduleInput, RunScheduleOutput> {
  readonly metadata: ToolMetadata = {
    name: "run_schedule",
    aliases: ["run_schedule_now"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };

  readonly inputSchema = RunScheduleInputSchema;

  constructor(private readonly scheduleEngine: ScheduleEngine) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: RunScheduleInput, _context: ToolCallContext): Promise<ToolResult> {
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

      const getBaseDir = this.scheduleEngine.getBaseDir;
      if (typeof getBaseDir === "function") {
        const baseDir = getBaseDir.call(this.scheduleEngine);
        const daemon = await isDaemonRunning(baseDir);
        if (daemon.running) {
          const client = new DaemonClient({
            host: "127.0.0.1",
            port: daemon.port,
            authToken: daemon.authToken,
            baseDir,
          });
          await client.runScheduleNow(existingEntry.id, {
            allowEscalation: input.allow_escalation,
          });
          return {
            success: true,
            data: {
              entry: existingEntry,
              reason: "manual_run",
              result: {
                entry_id: existingEntry.id,
                status: "ok",
                duration_ms: Date.now() - startTime,
                fired_at: new Date().toISOString(),
                layer: existingEntry.layer,
                tokens_used: 0,
                escalated_to: null,
                output_summary: "Requested daemon-resident schedule run",
              },
            },
            summary: `Requested daemon schedule run: ${existingEntry.name}`,
            durationMs: Date.now() - startTime,
          };
        }
      }

      const run = await this.scheduleEngine.runEntryNow(existingEntry.id, {
        allowEscalation: input.allow_escalation,
        preserveEnabled: true,
      });
      if (!run) {
        return {
          success: false,
          data: null,
          summary: `Schedule not found: ${input.schedule_id}`,
          error: `Schedule not found: ${input.schedule_id}`,
          durationMs: Date.now() - startTime,
        };
      }

      const summary = run.result.output_summary ? `: ${run.result.output_summary}` : "";
      return {
        success: true,
        data: {
          entry: run.entry,
          result: run.result,
          reason: run.reason,
        },
        summary: `Ran schedule: ${existingEntry.name} -> ${run.result.status}${summary}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `RunScheduleTool failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(
    _input: RunScheduleInput,
    context: ToolCallContext,
  ): Promise<PermissionCheckResult> {
    if (context.preApproved) return { status: "allowed" };
    return {
      status: "needs_approval",
      reason: "Running a persistent schedule may execute background automation and requires approval",
    };
  }

  isConcurrencySafe(_input: RunScheduleInput): boolean {
    return false;
  }
}
