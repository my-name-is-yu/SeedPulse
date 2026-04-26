import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { SearchOrchestrator } from "../../../platform/code-search/orchestrator.js";
import type { RankedCandidate } from "../../../platform/code-search/contracts.js";
import { saveCodeSearchSession } from "../../../platform/code-search/session-store.js";
import { validateFilePath } from "../../fs/FileValidationTool/FileValidationTool.js";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolMetadata, ToolResult } from "../../types.js";
import { MAX_OUTPUT_CHARS, PERMISSION_LEVEL, READ_ONLY, TAGS } from "./constants.js";
import { DESCRIPTION } from "./prompt.js";

export const CodeSearchInputSchema = z.object({
  task: z.string().min(1),
  intent: z.enum(["bugfix", "test_failure", "feature_addition", "refactor", "explain", "api_change", "config_fix", "security_review", "unknown"]).optional(),
  queryTerms: z.array(z.string()).optional(),
  stacktrace: z.string().optional(),
  fileGlobs: z.array(z.string()).optional(),
  packageScope: z.string().optional(),
  path: z.string().optional(),
  budget: z.object({
    maxFiles: z.number().int().positive().optional(),
    maxCandidatesPerRetriever: z.number().int().positive().optional(),
    maxFusionCandidates: z.number().int().positive().optional(),
    maxRerankCandidates: z.number().int().positive().optional(),
  }).optional(),
  outputLimit: z.number().int().positive().max(40).optional(),
});
export type CodeSearchInput = z.infer<typeof CodeSearchInputSchema>;

function compactCandidate(candidate: RankedCandidate): Record<string, unknown> {
  return {
    id: candidate.id,
    file: candidate.file,
    range: candidate.range,
    symbol: candidate.symbol ? {
      name: candidate.symbol.name,
      kind: candidate.symbol.kind,
      stableKey: candidate.symbol.stableKey,
    } : undefined,
    confidence: candidate.confidence,
    readRecommendation: candidate.readRecommendation,
    rerankScore: Number(candidate.rerankScore.toFixed(3)),
    retrievers: candidate.sourceRetrievers.slice(0, 3),
    reason: candidate.reasons[0],
  };
}

function isBroadRoot(root: string): boolean {
  const resolved = path.resolve(root);
  const homeDir = path.resolve(os.homedir());
  return resolved === path.parse(resolved).root || resolved === path.dirname(homeDir) || resolved === homeDir;
}

function findProjectRoot(cwd: string): string | null {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, ".git")) || fs.existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveSearchRoot(input: CodeSearchInput, context: ToolCallContext): string {
  if (input.path) {
    return validateFilePath(input.path, context.cwd).resolved;
  }
  const projectRoot = findProjectRoot(context.cwd);
  if (projectRoot && !isBroadRoot(projectRoot)) {
    return projectRoot;
  }
  const resolvedCwd = path.resolve(context.cwd);
  if (isBroadRoot(resolvedCwd)) {
    throw new Error(`code_search requires a project working directory or an explicit path; refused broad root "${resolvedCwd}".`);
  }
  throw new Error(`code_search requires a project working directory or an explicit path; no project root found from "${resolvedCwd}".`);
}

export class CodeSearchTool implements ITool<CodeSearchInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "code_search",
    aliases: ["code-search", "structured_code_search"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: true,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };
  readonly inputSchema = CodeSearchInputSchema;

  description(): string {
    return DESCRIPTION;
  }

  async call(input: CodeSearchInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    let cwd: string;
    try {
      cwd = resolveSearchRoot(input, context);
    } catch (err) {
      return {
        success: false,
        data: { candidates: [], candidateIds: [], totalCandidates: 0, warnings: [(err as Error).message] },
        summary: `Code search failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
    const orchestrator = new SearchOrchestrator(cwd);
    const session = await orchestrator.searchWithState({ ...input, cwd });
    saveCodeSearchSession(session, cwd);
    const visibleCandidates = session.candidates.slice(0, input.outputLimit ?? 20);
    return {
      success: true,
      data: {
        queryId: session.queryId,
        candidates: visibleCandidates.map(compactCandidate),
        candidateIds: visibleCandidates.map((candidate) => candidate.id),
        totalCandidates: session.candidates.length,
        trace: {
          queryId: session.trace.queryId,
          retrieversUsed: session.trace.retrieversUsed,
        },
        warnings: session.trace.warnings.slice(0, 5),
      },
      summary: `Code search returned ${session.candidates.length} ranked candidates for ${input.intent ?? "inferred"} intent`,
      durationMs: Date.now() - startTime,
      artifacts: visibleCandidates.map((candidate) => candidate.file),
    };
  }

  async checkPermissions(input: CodeSearchInput, context?: ToolCallContext): Promise<PermissionCheckResult> {
    if (!context) return { status: "allowed" };
    if (!input.path) {
      try {
        resolveSearchRoot(input, context);
      } catch (err) {
        return { status: "denied", reason: (err as Error).message };
      }
      return { status: "allowed" };
    }
    const validation = validateFilePath(input.path, context.cwd, context.executionPolicy?.protectedPaths);
    if (!validation.valid) {
      return { status: "needs_approval", reason: `Searching outside the working directory: ${validation.resolved}` };
    }
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}
