import { accessSync } from "fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "path";
import type { MemoryTier } from "../../../base/types/memory-lifecycle.js";

export const WORKSPACE_CONTEXT_BUDGET = 8000;
export const WORKSPACE_CONTEXT_MAX_CHARS = 32000;
export const CHAT_CONTEXT_MAX_CHARS = 24000;

export interface ContextItem {
  label: string;
  content: string;
  memory_tier: MemoryTier;
}

export function classifyTier(label: string): MemoryTier {
  const normalized = label.toLowerCase();
  if (normalized.includes("goal") || normalized.includes("gap") || normalized.includes("strategy")) {
    return "core";
  }
  if (normalized.includes("recent changes") || normalized.includes("test status") || normalized.includes("observation")) {
    return "recall";
  }
  if (normalized.includes("completed") || normalized.includes("archive")) {
    return "archival";
  }
  return "recall";
}

export function selectByTier(items: ContextItem[], maxItems: number): ContextItem[] {
  const core = items.filter((item) => (item.memory_tier ?? "recall") === "core");
  const recall = items.filter((item) => (item.memory_tier ?? "recall") === "recall");
  const archival = items.filter((item) => (item.memory_tier ?? "recall") === "archival");

  const selected: ContextItem[] = [...core];
  let remaining = maxItems - selected.length;

  for (const item of recall) {
    if (remaining <= 0) {
      break;
    }
    selected.push(item);
    remaining -= 1;
  }

  for (const item of archival) {
    if (remaining <= 0) {
      break;
    }
    selected.push(item);
    remaining -= 1;
  }

  return selected;
}

export function truncateToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = maxChars - headChars;
  return (
    text.slice(0, headChars) +
    "\n[... truncated to fit token budget ...]\n" +
    text.slice(text.length - tailChars)
  );
}

export function sanitizeNumberedContent(content: string): string {
  return content.replace(/^\d+\t/gm, "");
}

export function tailLines(content: string, maxLines: number): string {
  return content.split("\n").slice(-maxLines).join("\n");
}

export function toRelativePath(root: string, filePath: string): string {
  return filePath.replace(root + "/", "");
}

export function resolveGitRoot(cwd: string): string {
  const resolvedCwd = expandWorkspacePath(cwd);
  let dir = resolvedCwd;
  while (true) {
    try {
      accessSync(join(dir, ".git"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) {
        return resolvedCwd;
      }
      dir = parent;
    }
  }
}

function expandWorkspacePath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(value);
}
