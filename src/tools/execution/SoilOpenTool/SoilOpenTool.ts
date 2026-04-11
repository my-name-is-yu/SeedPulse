import { z } from "zod";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolMetadata,
  ToolResult,
} from "../../types.js";
import { openSoil, type SoilOpenRunner } from "../../../platform/soil/index.js";
import { ALIASES, MAX_OUTPUT_CHARS, PERMISSION_LEVEL, TAGS, TOOL_NAME } from "./constants.js";
import { DESCRIPTION } from "./prompt.js";

export const SoilOpenInputSchema = z.object({
  rootDir: z.string().min(1).optional(),
  viewer: z.enum(["default", "finder", "vscode", "obsidian", "logseq"]).default("default"),
  target: z.enum(["root", "schedule_active", "status", "report", "schedule", "memory", "knowledge", "path"]).default("root"),
  targetPath: z.string().min(1).optional(),
});
export type SoilOpenInput = z.infer<typeof SoilOpenInputSchema>;

export class SoilOpenTool implements ITool<SoilOpenInput> {
  readonly metadata: ToolMetadata = {
    name: TOOL_NAME,
    aliases: [...ALIASES],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };

  readonly inputSchema = SoilOpenInputSchema;

  constructor(private readonly runner?: SoilOpenRunner) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: SoilOpenInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const parsed = this.inputSchema.parse(input);
      const result = await openSoil(parsed, this.runner);
      return {
        success: result.exitCode === 0,
        data: result,
        summary: result.exitCode === 0
          ? `Opened Soil ${result.target} with ${result.viewer}: ${result.path}`
          : `Soil open failed: ${result.stderr || `exit ${result.exitCode}`}`,
        error: result.exitCode === 0 ? undefined : result.stderr || `exit ${result.exitCode}`,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        summary: `Soil open failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: SoilOpenInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "needs_approval", reason: "Opening Soil launches a local viewer application" };
  }

  isConcurrencySafe(_input?: SoilOpenInput): boolean {
    return true;
  }
}
