import { execFile } from "child_process";
import { accessSync } from "fs";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import type { MemoryTier } from "../types/memory-lifecycle.js";

const execFileAsync = promisify(execFile);

// ─── Context Item ───

export interface ContextItem {
  label: string;
  content: string;
  memory_tier: MemoryTier;
}

// ─── Tier Classification ───

/**
 * Classify a context section by memory tier.
 * - core: active goal dimensions, current gap, active strategy
 * - recall: recent observations (git diff), strategy history, test status
 * - archival: completed goals
 */
function classifyTier(label: string): MemoryTier {
  const l = label.toLowerCase();
  if (l.includes("goal") || l.includes("gap") || l.includes("strategy")) {
    return "core";
  }
  if (l.includes("recent changes") || l.includes("test status") || l.includes("observation")) {
    return "recall";
  }
  if (l.includes("completed") || l.includes("archive")) {
    return "archival";
  }
  // Default: grep file results are recall (recent workspace context)
  return "recall";
}

// ─── Tier-aware Selection ───

/**
 * Select context items with tier-priority ordering.
 * - Always include all core items
 * - Fill remaining slots from recall items
 * - Only include archival if slots remain
 * - Items with no tier default to recall (backward compat)
 */
export function selectByTier(items: ContextItem[], maxItems: number): ContextItem[] {
  const core = items.filter((i) => (i.memory_tier ?? "recall") === "core");
  const recall = items.filter((i) => (i.memory_tier ?? "recall") === "recall");
  const archival = items.filter((i) => (i.memory_tier ?? "recall") === "archival");

  const selected: ContextItem[] = [...core];
  let remaining = maxItems - selected.length;

  for (const item of recall) {
    if (remaining <= 0) break;
    selected.push(item);
    remaining--;
  }

  for (const item of archival) {
    if (remaining <= 0) break;
    selected.push(item);
    remaining--;
  }

  return selected;
}

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
  }
): Promise<string> {
  const items = await collectContextItems(goalId, dimensionName, options);
  const selected = selectByTier(items, items.length); // include all; callers may use selectByTier with a cap
  const parts = selected.flatMap((item) => [item.label, item.content]);
  return parts.join("\n\n") || "(No workspace context available)";
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
  }
): Promise<ContextItem[]> {
  const items = await collectContextItems(goalId, dimensionName, options);
  const maxItems = options?.maxItems ?? items.length;
  return selectByTier(items, maxItems);
}

async function collectContextItems(
  _goalId: string,
  dimensionName: string,
  options?: {
    cwd?: string;
    maxFileContentLines?: number;
  }
): Promise<ContextItem[]> {
  const cwd = options?.cwd || process.cwd();
  const maxLines = options?.maxFileContentLines ?? 100;
  const items: ContextItem[] = [];

  // 1. Search for files related to the dimension name
  // Convert dimension_name to search terms (e.g., "unfinished_item_count" → "UNFINISHED ITEM")
  const searchTerms = dimensionNameToSearchTerms(dimensionName);

  for (const term of searchTerms) {
    try {
      const { stdout } = await execFileAsync(
        "grep",
        ["-rn", "--include=*.ts", "--include=*.js", "-l", term, cwd],
        { timeout: 10000 }
      );
      const files = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(0, 5);

      if (files.length > 0) {
        const label = `[grep "${term}" — ${files.length} files matched]`;
        const contentParts: string[] = [];

        // Read first few matching files (up to 3, maxLines each)
        for (const filePath of files.slice(0, 3)) {
          try {
            const content = await readFile(filePath, "utf-8");
            const lines = content.split("\n").slice(0, maxLines);
            const relativePath = filePath.replace(cwd + "/", "");
            contentParts.push(`[File: ${relativePath} (${lines.length} lines)]`);
            contentParts.push(lines.join("\n"));
          } catch {
            // skip unreadable files
          }
        }

        items.push({
          label,
          content: contentParts.join("\n\n"),
          memory_tier: classifyTier(label),
        });
      }
    } catch {
      // grep returns exit 1 for zero matches — ignore
    }
  }

  // 2. Git diff (recent changes) — recall tier
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "HEAD~1", "--stat"],
      { cwd, timeout: 10000 }
    );
    if (stdout.trim()) {
      const label = `[Recent changes: git diff HEAD~1 --stat]`;
      items.push({ label, content: stdout.trim(), memory_tier: classifyTier(label) });
    }
  } catch {
    // ignore
  }

  // 3. Test status summary — recall tier
  try {
    const { stdout } = await execFileAsync(
      "npx",
      ["vitest", "run", "--reporter=dot"],
      { cwd, timeout: 30000 }
    );
    const lastLines = stdout.split("\n").slice(-10).join("\n");
    const label = `[Test status]`;
    items.push({ label, content: lastLines, memory_tier: classifyTier(label) });
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "stdout" in err) {
      const lastLines = (
        (err as { stdout: string }).stdout || ""
      )
        .split("\n")
        .slice(-10)
        .join("\n");
      if (lastLines.trim()) {
        const label = `[Test status (failures detected)]`;
        items.push({ label, content: lastLines, memory_tier: classifyTier(label) });
      }
    }
  }

  return items;
}

/**
 * Build a lightweight context string for chat mode execution.
 * Does not run git or test commands — returns synchronously.
 */
export function buildChatContext(taskDescription: string, cwd: string): string {
  const gitRoot = resolveGitRoot(cwd);
  const lines = [
    `Working directory: ${cwd}`,
    gitRoot !== cwd ? `Git root: ${gitRoot}` : null,
    `Task: ${taskDescription}`,
    `Session type: chat_execution`,
  ].filter(Boolean);
  return lines.join("\n");
}

/**
 * Walk up from cwd until a .git directory is found.
 * Returns cwd itself if no git root is found.
 */
export function resolveGitRoot(cwd: string): string {
  let dir = cwd;
  while (true) {
    try {
      accessSync(join(dir, ".git"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return cwd;
      dir = parent;
    }
  }
}

/**
 * Convert dimension names to search terms for grep.
 * e.g., "unfinished_item_count" → ["UNFINISHED ITEM"], "fixme_count" → ["FIXME"],
 *        "test_coverage" → ["test", "coverage"], "code_quality" → ["quality"]
 */
export function dimensionNameToSearchTerms(dimensionName: string): string[] {
  const terms: string[] = [];
  const lower = dimensionName.toLowerCase();

  if (lower.includes("todo")) terms.push("TODO");
  if (lower.includes("fixme")) terms.push("FIXME");
  if (lower.includes("test")) terms.push("test");
  if (lower.includes("coverage")) terms.push("coverage");
  if (lower.includes("lint") || lower.includes("eslint")) terms.push("eslint");
  if (lower.includes("error") || lower.includes("bug")) terms.push("error");
  if (lower.includes("doc") || lower.includes("readme")) terms.push("README");

  // Fallback: use the dimension name itself as a search term
  if (terms.length === 0) {
    const words = dimensionName.split("_").filter((w) => w.length > 2);
    terms.push(...words.slice(0, 2));
  }

  return terms.length > 0 ? terms : [dimensionName];
}
