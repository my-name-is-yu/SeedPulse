import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

const ACTIVITY_PREVIEW_CHARS = 40;
export const DIFF_ARTIFACT_MAX_LINES = 80;

export interface GitDiffArtifact {
  stat: string;
  nameStatus: string;
  patch: string;
  truncated: boolean;
}

export type ChatInterruptRedirectKind = "diff" | "review" | "summary" | "background" | "redirect";

function runGit(cwd: string, args: string[], timeout = 5_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout }, (err, stdout, stderr) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve((stdout + stderr).trim());
    });
  });
}

export function checkGitChanges(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["diff", "HEAD", "--stat"], { cwd, timeout: 5_000 }, (err, stdout, stderr) => {
      resolve(err ? null : (stdout + stderr).trim());
    });
  });
}

function parseGitLines(output: string | null): string[] {
  return output ? output.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

async function buildUntrackedFilePatch(cwd: string, relativePath: string): Promise<string> {
  const absolutePath = path.resolve(cwd, relativePath);
  const relativeFromCwd = path.relative(cwd, absolutePath);
  if (relativeFromCwd.startsWith("..") || path.isAbsolute(relativeFromCwd)) {
    return `diff --git a/${relativePath} b/${relativePath}\nnew file skipped: path outside workspace`;
  }
  try {
    const stat = await fsp.stat(absolutePath);
    if (!stat.isFile()) {
      return `diff --git a/${relativePath} b/${relativePath}\nnew file skipped: not a regular file`;
    }
    if (stat.size > 100_000) {
      return `diff --git a/${relativePath} b/${relativePath}\nnew file skipped: ${stat.size} bytes`;
    }
    const content = await fsp.readFile(absolutePath, "utf-8");
    const lines = content.split("\n");
    const body = lines.map((line) => `+${line}`).join("\n");
    return [
      `diff --git a/${relativePath} b/${relativePath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${relativePath}`,
      `@@ -0,0 +1,${lines.length} @@`,
      body,
    ].join("\n");
  } catch {
    return `diff --git a/${relativePath} b/${relativePath}\nnew file skipped: unreadable`;
  }
}

export async function collectGitDiffArtifact(cwd: string): Promise<GitDiffArtifact | null> {
  const trackedStat = await runGit(cwd, ["diff", "HEAD", "--stat"]);
  const untrackedFiles = parseGitLines(await runGit(cwd, ["ls-files", "--others", "--exclude-standard"]));
  if (!trackedStat && untrackedFiles.length === 0) return null;
  const trackedNameStatus = await runGit(cwd, ["diff", "HEAD", "--name-status"]) ?? "";
  const trackedPatch = await runGit(cwd, ["diff", "HEAD", "--patch", "--unified=3"], 10_000) ?? "";
  const untrackedPatchParts = await Promise.all(
    untrackedFiles.slice(0, 10).map((file) => buildUntrackedFilePatch(cwd, file))
  );
  if (untrackedFiles.length > 10) {
    untrackedPatchParts.push(`... ${untrackedFiles.length - 10} additional untracked file(s) omitted`);
  }
  const stat = [
    trackedStat,
    untrackedFiles.length > 0
      ? ["Untracked files:", ...untrackedFiles.map((file) => `  ${file}`)].join("\n")
      : "",
  ].filter(Boolean).join("\n");
  const nameStatus = [
    trackedNameStatus,
    ...untrackedFiles.map((file) => `A\t${file}`),
  ].filter(Boolean).join("\n");
  const patch = [trackedPatch, ...untrackedPatchParts].filter(Boolean).join("\n");
  const patchLines = patch.split("\n");
  const truncated = patchLines.length > DIFF_ARTIFACT_MAX_LINES;
  return {
    stat,
    nameStatus,
    patch: patchLines.slice(0, DIFF_ARTIFACT_MAX_LINES).join("\n"),
    truncated,
  };
}

export function previewActivityText(value: string, maxChars = ACTIVITY_PREVIEW_CHARS): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized;
}

export function classifyInterruptRedirect(input: string): ChatInterruptRedirectKind {
  const normalized = input.trim().toLowerCase();
  if (/\b(background|bg)\b|バックグラウンド|裏で|裏側|continue.*background/.test(normalized)) {
    return "background";
  }
  if (/\b(review|read.?only|readonly)\b|レビュー|確認だけ|読むだけ/.test(normalized)) {
    return "review";
  }
  if (/\b(diff|changes?|patch)\b|差分|変更.*見|変更内容/.test(normalized)) {
    return "diff";
  }
  if (/\b(stop|pause|summary|summarize|interrupt)\b|止め|停止|中断|一旦|要約/.test(normalized)) {
    return "summary";
  }
  return "redirect";
}

export function formatToolActivity(action: "Running" | "Finished" | "Failed", toolName: string, detail?: string): string {
  const preview = detail ? previewActivityText(detail) : "";
  return preview ? `${action} tool: ${toolName} - ${preview}` : `${action} tool: ${toolName}`;
}

export function formatIntentInput(input: string, maxChars = 96): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 3)}...` : normalized;
}
