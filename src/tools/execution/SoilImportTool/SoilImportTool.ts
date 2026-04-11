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
  loadSoilOverlayQueue,
  scanAndStoreSoilOverlays,
  updateSoilOverlayStatus,
} from "../../../platform/soil/index.js";
import { ALIASES, MAX_OUTPUT_CHARS, PERMISSION_LEVEL, TAGS, TOOL_NAME } from "./constants.js";
import { DESCRIPTION } from "./prompt.js";

export const SoilImportInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("scan"), rootDir: z.string().min(1).optional() }),
  z.object({ action: z.literal("list"), rootDir: z.string().min(1).optional() }),
  z.object({
    action: z.literal("approve"),
    overlayId: z.string().min(1),
    rootDir: z.string().min(1).optional(),
    decisionNote: z.string().optional(),
  }),
  z.object({
    action: z.literal("reject"),
    overlayId: z.string().min(1),
    rootDir: z.string().min(1).optional(),
    decisionNote: z.string().optional(),
  }),
]);
export type SoilImportInput = z.infer<typeof SoilImportInputSchema>;

export class SoilImportTool implements ITool<SoilImportInput> {
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

  readonly inputSchema = SoilImportInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: SoilImportInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const parsed = this.inputSchema.parse(input);
      const config = { rootDir: parsed.rootDir };
      const queue = parsed.action === "scan"
        ? await scanAndStoreSoilOverlays(config)
        : parsed.action === "list"
          ? await loadSoilOverlayQueue(config)
          : await updateSoilOverlayStatus(
              parsed.overlayId,
              parsed.action === "approve" ? "approved" : "rejected",
              config,
              { decisionNote: parsed.decisionNote }
            );

      return {
        success: true,
        data: queue,
        summary: `${queue.overlays.length} Soil overlay${queue.overlays.length !== 1 ? "s" : ""} in queue`,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        summary: `Soil import failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: SoilImportInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "needs_approval", reason: "Soil import updates the local overlay import queue" };
  }

  isConcurrencySafe(_input?: SoilImportInput): boolean {
    return false;
  }
}
