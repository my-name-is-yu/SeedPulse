import { execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";

const execFileAsync = promisify(execFile);

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
  const cwd = options?.cwd || process.cwd();
  const maxLines = options?.maxFileContentLines ?? 100;
  const parts: string[] = [];

  // 1. Search for files related to the dimension name
  // Convert dimension_name to search terms (e.g., "todo_count" → "TODO")
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
        parts.push(`[grep "${term}" — ${files.length} files matched]`);

        // Read first few matching files (up to 3, maxLines each)
        for (const filePath of files.slice(0, 3)) {
          try {
            const content = await readFile(filePath, "utf-8");
            const lines = content.split("\n").slice(0, maxLines);
            const relativePath = filePath.replace(cwd + "/", "");
            parts.push(`[File: ${relativePath} (${lines.length} lines)]`);
            parts.push(lines.join("\n"));
          } catch {
            // skip unreadable files
          }
        }
      }
    } catch {
      // grep returns exit 1 for zero matches — ignore
    }
  }

  // 2. Git diff (recent changes)
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "HEAD~1", "--stat"],
      { cwd, timeout: 10000 }
    );
    if (stdout.trim()) {
      parts.push(`[Recent changes: git diff HEAD~1 --stat]`);
      parts.push(stdout.trim());
    }
  } catch {
    // ignore
  }

  // 3. Test status summary
  try {
    const { stdout } = await execFileAsync(
      "npx",
      ["vitest", "run", "--reporter=dot"],
      { cwd, timeout: 30000 }
    );
    const lastLines = stdout.split("\n").slice(-10).join("\n");
    parts.push(`[Test status]`);
    parts.push(lastLines);
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "stdout" in err) {
      const lastLines = (
        (err as { stdout: string }).stdout || ""
      )
        .split("\n")
        .slice(-10)
        .join("\n");
      if (lastLines.trim()) {
        parts.push(`[Test status (failures detected)]`);
        parts.push(lastLines);
      }
    }
  }

  return parts.join("\n\n") || "(No workspace context available)";
}

/**
 * Convert dimension names to search terms for grep.
 * e.g., "todo_count" → ["TODO"], "fixme_count" → ["FIXME"],
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
