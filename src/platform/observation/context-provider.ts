import type { ToolExecutor } from "../../tools/executor.js";
import type { ToolCallContext } from "../../tools/types.js";
import {
  CHAT_CONTEXT_MAX_CHARS,
  WORKSPACE_CONTEXT_MAX_CHARS,
  type ContextItem,
  resolveGitRoot,
  selectByTier,
  truncateToBudget,
} from "./context-provider/shared.js";
import { collectChatContextParts, collectContextItems } from "./context-provider/collector.js";
export { type ContextItem, selectByTier, resolveGitRoot, WORKSPACE_CONTEXT_BUDGET, WORKSPACE_CONTEXT_MAX_CHARS } from "./context-provider/shared.js";
export { dimensionNameToSearchTerms } from "./context-provider/search-terms.js";

/**
 * Provides workspace context for task generation.
 * Given a goalId and dimensionName, returns relevant file contents,
 * grep results, and test status.
 */
export async function buildWorkspaceContext(
  goalId: string,
  dimensionName: string,
  options?: {
    cwd?: string;
    maxFileContentLines?: number; // default: 100
    maxTotalChars?: number; // default: WORKSPACE_CONTEXT_MAX_CHARS
    toolExecutor?: ToolExecutor;
    toolContext?: Partial<ToolCallContext>;
  }
): Promise<string> {
  const maxTotalChars = options?.maxTotalChars ?? WORKSPACE_CONTEXT_MAX_CHARS;
  const items = await collectContextItems(goalId, dimensionName, { ...options, maxTotalChars });
  const selected = selectByTier(items, items.length); // include all; callers may use selectByTier with a cap
  const parts = selected.flatMap((item) => [item.label, item.content]);
  const result = parts.join("\n\n") || "(No workspace context available)";
  return truncateToBudget(result, maxTotalChars);
}

/**
 * Collect workspace context as typed ContextItems with memory_tier annotations.
 * Exported for callers that need tier-aware selection.
 */
export async function buildWorkspaceContextItems(
  goalId: string,
  dimensionName: string,
  options?: {
    cwd?: string;
    maxFileContentLines?: number;
    maxItems?: number; // default: unlimited
    maxTotalChars?: number; // default: WORKSPACE_CONTEXT_MAX_CHARS
    toolExecutor?: ToolExecutor;
    toolContext?: Partial<ToolCallContext>;
  }
): Promise<ContextItem[]> {
  const maxTotalChars = options?.maxTotalChars ?? WORKSPACE_CONTEXT_MAX_CHARS;
  const items = await collectContextItems(goalId, dimensionName, { ...options, maxTotalChars });
  const maxItems = options?.maxItems ?? items.length;
  return selectByTier(items, maxItems);
}

/**
 * Build a context string for chat mode execution.
 * Gathers git diff, test status, and keyword-matching files.
 */
export async function buildChatContext(
  taskDescription: string,
  cwd: string,
  options?: {
    toolExecutor?: ToolExecutor;
    toolContext?: Partial<ToolCallContext>;
  }
): Promise<string> {
  const gitRoot = resolveGitRoot(cwd);
  const parts: string[] = [
    `Working directory: ${cwd}`,
    gitRoot !== cwd ? `Git root: ${gitRoot}` : null,
    `Task: ${taskDescription}`,
    `Session type: chat_execution`,
  ].filter((x): x is string => x !== null);

  try {
    parts.push(...(await collectChatContextParts(taskDescription, gitRoot, options)));
  } catch {
    // ignore
  }

  const combined = parts.join("\n\n");
  return truncateToBudget(combined, CHAT_CONTEXT_MAX_CHARS);
}
