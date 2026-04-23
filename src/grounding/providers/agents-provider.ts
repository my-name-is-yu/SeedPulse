import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import type { GroundingProvider } from "../contracts.js";
import { makeSection, makeSource } from "./helpers.js";

export interface AgentInstructionCandidate {
  filePath: string;
  content: string;
  priority: number;
  trusted: boolean;
  accepted: boolean;
  reason?: string;
}

const UNTRUSTED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  "vendor",
  "dist",
  "build",
  "coverage",
  "tmp",
  "temp",
]);

function findProjectRoot(cwd: string): string {
  let cursor = resolve(cwd);
  while (true) {
    if (existsSync(join(cursor, ".git"))) return cursor;
    const next = dirname(cursor);
    if (next === cursor) return resolve(cwd);
    cursor = next;
  }
}

function hasUntrustedSegment(filePath: string): boolean {
  return filePath.split(/[\\/]+/).some((segment) => UNTRUSTED_SEGMENTS.has(segment));
}

function hasUntrustedWorkspaceSegment(projectRoot: string, filePath: string): boolean {
  const relativePath = relative(projectRoot, filePath);
  if (!relativePath || relativePath.startsWith("..")) {
    return hasUntrustedSegment(filePath);
  }
  return relativePath.split(/[\\/]+/).some((segment) => UNTRUSTED_SEGMENTS.has(segment));
}

export async function discoverAgentInstructionCandidates(
  cwd: string,
  maxChars: number,
  options: { trustProjectInstructions?: boolean } = {},
): Promise<AgentInstructionCandidate[]> {
  const root = findProjectRoot(cwd);
  const dirs: string[] = [];
  let cursor = resolve(cwd);
  while (true) {
    dirs.push(cursor);
    if (cursor === root) break;
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }

  const candidates: AgentInstructionCandidate[] = [];
  let remaining = maxChars;
  const homeCandidates = [
    join(homedir(), ".pulseed", "AGENTS.md"),
    join(homedir(), ".pulseed", "AGENTS.override.md"),
  ];
  for (const filePath of homeCandidates) {
    if (!existsSync(filePath) || remaining <= 0) continue;
    const content = (await readFile(filePath, "utf-8")).slice(0, remaining);
    remaining -= content.length;
    candidates.push({
      filePath,
      content,
      priority: filePath.endsWith("override.md") ? 1 : 2,
      trusted: true,
      accepted: true,
    });
  }

  for (const dir of dirs.reverse()) {
    const projectCandidates = [join(dir, "AGENTS.md"), join(dir, "AGENTS.override.md")];
    for (const filePath of projectCandidates) {
      if (!existsSync(filePath) || remaining <= 0) continue;
      const trusted = options.trustProjectInstructions !== false && !hasUntrustedWorkspaceSegment(root, filePath);
      const content = (await readFile(filePath, "utf-8")).slice(0, remaining);
      remaining -= content.length;
      candidates.push({
        filePath,
        content,
        priority: filePath.endsWith("override.md") ? 3 : 5,
        trusted,
        accepted: trusted,
        reason: trusted
          ? undefined
          : options.trustProjectInstructions === false
            ? "project instructions disabled by execution policy"
            : "untrusted path segment",
      });
    }
  }

  return candidates.sort((a, b) => a.priority - b.priority || a.filePath.localeCompare(b.filePath));
}

export const repoInstructionsProvider: GroundingProvider = {
  key: "repo_instructions",
  kind: "dynamic",
  async build(context) {
    const cwd = context.request.workspaceRoot ?? process.cwd();
    const candidates = await discoverAgentInstructionCandidates(
      cwd,
      context.profile.budgets.maxRepoInstructionChars,
      { trustProjectInstructions: context.request.trustProjectInstructions },
    );

    const accepted = candidates.filter((candidate) => candidate.accepted);
    const rejected = candidates.filter((candidate) => !candidate.accepted);
    for (const candidate of rejected) {
      context.warnings.push(`Rejected repo instructions from ${candidate.filePath}: ${candidate.reason ?? "untrusted"}`);
    }
    if (accepted.length > 1) {
      context.warnings.push("Multiple repo instruction files accepted; higher-precedence entries appear first.");
    }

    const sources = candidates.map((candidate) =>
      makeSource("repo_instructions", candidate.filePath, {
        type: "file",
        path: candidate.filePath,
        trusted: candidate.trusted,
        accepted: candidate.accepted,
        metadata: candidate.reason ? { reason: candidate.reason } : undefined,
      }),
    );

    const content = accepted.length > 0
      ? accepted.map((candidate) => `[${candidate.filePath}]\n${candidate.content}`).join("\n\n")
      : "No trusted repository instructions available.";

    return makeSection("repo_instructions", content, sources.length > 0 ? sources : [
      makeSource("repo_instructions", "repo instructions", {
        type: "none",
        trusted: true,
        accepted: true,
      }),
    ]);
  },
};
