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
import { rebuildSoilFromRuntime } from "../../../platform/soil/index.js";
import { ALIASES, MAX_OUTPUT_CHARS, PERMISSION_LEVEL, TAGS, TOOL_NAME } from "./constants.js";
import { DESCRIPTION } from "./prompt.js";

export const SoilRebuildInputSchema = z.object({
  baseDir: z.string().min(1).optional(),
  rootDir: z.string().min(1).optional(),
});
export type SoilRebuildInput = z.infer<typeof SoilRebuildInputSchema>;

export class SoilRebuildTool implements ITool<SoilRebuildInput> {
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

  readonly inputSchema = SoilRebuildInputSchema;

  constructor(private readonly stateManager?: StateManager) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: SoilRebuildInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const parsed = this.inputSchema.parse(input);
      const baseDir = parsed.baseDir ?? this.stateManager?.getBaseDir();
      if (!baseDir) {
        throw new Error("baseDir is required when stateManager is not configured");
      }
      const report = await rebuildSoilFromRuntime({
        baseDir,
        rootDir: parsed.rootDir,
      });
      return {
        success: true,
        data: report,
        summary: `Rebuilt Soil with ${report.index.page_count} pages and ${report.index.chunk_count} chunks`,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        summary: `Soil rebuild failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: SoilRebuildInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "needs_approval", reason: "Rebuilding Soil writes Markdown projections and index files" };
  }

  isConcurrencySafe(_input?: SoilRebuildInput): boolean {
    return false;
  }
}
