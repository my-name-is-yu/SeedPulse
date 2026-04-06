import { z } from "zod";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
  ToolMetadata,
  ToolDescriptionContext,
} from "../../types.js";
import type { KnowledgeManager } from "../../../platform/knowledge/knowledge-manager.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, READ_ONLY, PERMISSION_LEVEL, TOOL_NAME, ALIASES } from "./constants.js";

export const MemoryConsolidateInputSchema = z.object({
  category: z.string().optional().describe("Only consolidate entries in this category"),
  memory_type: z
    .enum(["fact", "procedure", "preference", "observation"])
    .optional()
    .describe("Only consolidate entries of this type"),
  max_entries: z
    .number()
    .int()
    .min(2)
    .max(100)
    .optional()
    .default(50)
    .describe("Maximum raw entries to process"),
});
export type MemoryConsolidateInput = z.infer<typeof MemoryConsolidateInputSchema>;

export interface MemoryConsolidateOutput {
  compiledCount: number;
  archivedCount: number;
  stats: {
    category?: string;
    memory_type?: string;
    max_entries: number;
  };
}

export class MemoryConsolidateTool implements ITool<MemoryConsolidateInput, MemoryConsolidateOutput> {
  readonly metadata: ToolMetadata = {
    name: TOOL_NAME,
    aliases: [...ALIASES],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 2000,
    tags: [...TAGS],
  };

  readonly inputSchema = MemoryConsolidateInputSchema;

  constructor(
    private readonly knowledgeManager: KnowledgeManager,
    private readonly llmCall: (prompt: string) => Promise<string>
  ) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(
    input: MemoryConsolidateInput,
    _context: ToolCallContext
  ): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const result = await this.knowledgeManager.consolidateAgentMemory({
        category: input.category,
        memory_type: input.memory_type,
        llmCall: this.llmCall,
      });

      const output: MemoryConsolidateOutput = {
        compiledCount: result.compiled.length,
        archivedCount: result.archived,
        stats: {
          category: input.category,
          memory_type: input.memory_type,
          max_entries: input.max_entries ?? 50,
        },
      };

      return {
        success: true,
        data: output,
        summary: `Consolidated ${result.compiled.length} groups, archived ${result.archived} entries`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "MemoryConsolidateTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(
    _input: MemoryConsolidateInput,
    _context: ToolCallContext
  ): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: MemoryConsolidateInput): boolean {
    return false;
  }
}
