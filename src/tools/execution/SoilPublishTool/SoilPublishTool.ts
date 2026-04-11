import { z } from "zod";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolMetadata,
  ToolResult,
} from "../../types.js";
import {
  publishSoilSnapshots,
  type AppleNotesRunner,
  type NotionPublishClient,
} from "../../../platform/soil/index.js";
import { ALIASES, MAX_OUTPUT_CHARS, PERMISSION_LEVEL, TAGS, TOOL_NAME } from "./constants.js";
import { DESCRIPTION } from "./prompt.js";

export const SoilPublishInputSchema = z.object({
  provider: z.enum(["notion", "apple_notes", "all"]).default("all"),
  dryRun: z.boolean().default(false),
  baseDir: z.string().min(1).optional(),
  rootDir: z.string().min(1).optional(),
});
export type SoilPublishInput = z.infer<typeof SoilPublishInputSchema>;

export class SoilPublishTool implements ITool<SoilPublishInput> {
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

  readonly inputSchema = SoilPublishInputSchema;

  constructor(private readonly deps: {
    notionClient?: NotionPublishClient;
    appleNotesRunner?: AppleNotesRunner;
  } = {}) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: SoilPublishInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const parsed = this.inputSchema.parse(input);
      const result = await publishSoilSnapshots({
        ...parsed,
        notionClient: this.deps.notionClient,
        appleNotesRunner: this.deps.appleNotesRunner,
      });
      const pageCount = result.providers.reduce((sum, provider) => sum + provider.pages.length, 0);
      const errors = result.providers.reduce((sum, provider) => sum + provider.pages.filter((page) => page.status === "error").length, 0);
      return {
        success: errors === 0,
        data: result,
        summary: `Soil publish ${result.dryRun ? "dry run " : ""}completed for ${result.providers.length} provider(s), ${pageCount} page result(s), ${errors} error(s)`,
        error: errors === 0 ? undefined : `${errors} publish page result(s) failed`,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        summary: `Soil publish failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(input: SoilPublishInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    if (input.dryRun) {
      return { status: "allowed" };
    }
    return { status: "needs_approval", reason: "Soil publish writes to configured external destinations" };
  }

  isConcurrencySafe(_input?: SoilPublishInput): boolean {
    return false;
  }
}
