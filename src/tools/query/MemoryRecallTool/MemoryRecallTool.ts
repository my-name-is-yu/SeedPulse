import { z } from "zod";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
  ToolMetadata,
  ToolDescriptionContext,
} from "../../types.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS } from "./constants.js";
import type { KnowledgeManager } from "../../../platform/knowledge/knowledge-manager.js";
import type { AgentMemoryEntry } from "../../../platform/knowledge/types/agent-memory.js";

export const MemoryRecallInputSchema = z.object({
  query: z
    .string()
    .describe(
      "Search query (key for exact match, or keywords for search)"
    ),
  exact: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, match key exactly; if false, keyword search across key+value+tags"
    ),
  category: z.string().optional().describe("Filter by category"),
  memory_type: z
    .enum(["fact", "procedure", "preference", "observation"])
    .optional()
    .describe("Filter by memory type"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe("Maximum results to return"),
  include_archived: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include archived entries in results"),
});
export type MemoryRecallInput = z.infer<typeof MemoryRecallInputSchema>;

export interface MemoryRecallOutput {
  entries: AgentMemoryEntry[];
  totalFound: number;
}

export class MemoryRecallTool
  implements ITool<MemoryRecallInput, MemoryRecallOutput>
{
  readonly metadata: ToolMetadata = {
    name: "memory_recall",
    aliases: ["recall_memory", "remember_query"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };

  readonly inputSchema = MemoryRecallInputSchema;

  constructor(private readonly knowledgeManager: KnowledgeManager) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(
    input: MemoryRecallInput,
    _context: ToolCallContext
  ): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      const entries = await this.knowledgeManager.recallAgentMemory(
        input.query,
        {
          exact: input.exact,
          category: input.category,
          memory_type: input.memory_type,
          limit: input.limit,
          include_archived: input.include_archived,
        }
      );

      const output: MemoryRecallOutput = {
        entries,
        totalFound: entries.length,
      };

      return {
        success: true,
        data: output,
        summary: `Found ${entries.length} memory entries for query "${input.query}"`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: { entries: [], totalFound: 0 },
        summary: `Memory recall failed: ${(err as Error).message}`,
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
