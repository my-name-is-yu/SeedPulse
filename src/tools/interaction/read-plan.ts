import { z } from "zod";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../types.js";

const PLAN_ID_RE = /^[a-zA-Z0-9-]+$/;

export const ReadPlanInputSchema = z.object({
  plan_id: z.string().min(1, "plan_id is required").regex(PLAN_ID_RE, "plan_id must be alphanumeric with hyphens only"),
});
export type ReadPlanInput = z.infer<typeof ReadPlanInputSchema>;

function decisionsDir(): string {
  return path.join(homedir(), ".pulseed", "decisions");
}

export class ReadPlanTool implements ITool<ReadPlanInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "read-plan",
    aliases: ["read_plan", "get_plan"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 8000,
    tags: ["interaction", "plan", "decision"],
  };
  readonly inputSchema = ReadPlanInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return "Read a plan or decision document from ~/.pulseed/decisions/{plan_id}.md";
  }

  async call(input: ReadPlanInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const filePath = path.join(decisionsDir(), `${input.plan_id}.md`);
      let content: string;
      try {
        content = await fs.readFile(filePath, "utf8");
      } catch {
        return {
          success: false,
          data: null,
          summary: `Plan not found: ${input.plan_id}`,
          error: `Plan not found: ${input.plan_id}`,
          durationMs: Date.now() - startTime,
        };
      }
      return {
        success: true,
        data: { plan_id: input.plan_id, content, path: filePath },
        summary: `Plan read: ${input.plan_id}`,
        durationMs: Date.now() - startTime,
        artifacts: [filePath],
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "ReadPlanTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(
    _input: ReadPlanInput,
    _context: ToolCallContext,
  ): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: ReadPlanInput): boolean {
    return true;
  }
}
