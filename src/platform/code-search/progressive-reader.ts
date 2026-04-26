import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type {
  CodeSearchIndexes,
  ContextBundle,
  RankedCandidate,
  ReadRangeKey,
  ReadRangeResult,
  ReadRequest,
  ReadSessionState,
} from "./contracts.js";
import { hashFileOrNull } from "./indexes/file-index.js";
import { createRetrievalTrace, createQueryId } from "./trace.js";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function overlaps(a: ReadRangeKey, b: ReadRangeKey): boolean {
  return a.file === b.file && a.startLine <= b.endLine && b.startLine <= a.endLine;
}

function expandRange(candidate: RankedCandidate, phase: ReadSessionState["phase"]): ReadRangeKey {
  const expansion =
    phase === "locate" ? 12
    : phase === "understand" ? 40
    : phase === "plan_edit" || phase === "edit" ? 80
    : phase === "repair" ? 60
    : 30;
  return {
    file: candidate.file,
    startLine: Math.max(1, candidate.range.startLine - expansion),
    endLine: candidate.range.endLine + expansion,
  };
}

function sliceIndexesForRanges(indexes: CodeSearchIndexes | undefined, ranges: ReadRangeResult[]): Pick<ContextBundle, "repoMap" | "packageContext" | "testContext" | "configContext"> {
  if (!indexes || ranges.length === 0) return {};
  const readFiles = new Set(ranges.map((range) => range.file));
  const readPackages = new Set(
    indexes.packages.packages
      .filter((pkg) => [...readFiles].some((file) => pkg.root === "" || file === pkg.root || file.startsWith(`${pkg.root}/`)))
      .map((pkg) => pkg.root)
  );
  const repoFiles = indexes.repoMap.files
    .filter((entry) =>
      readFiles.has(entry.file)
      || entry.imports.some((specifier) => [...readFiles].some((file) => file.includes(specifier.replace(/^\.\//, "").replace(/\.(js|ts|tsx|jsx)$/, ""))))
    )
    .slice(0, 12)
    .map((entry) => ({
      file: entry.file,
      imports: entry.imports.slice(0, 12),
      exports: entry.exports.slice(0, 12),
    }));
  const tests = indexes.tests.tests
    .filter((test) =>
      readFiles.has(test.file)
      || test.imports.some((specifier) => [...readFiles].some((file) => file.includes(specifier.replace(/^\.\//, "").replace(/\.(js|ts|tsx|jsx)$/, ""))))
    )
    .slice(0, 8)
    .map((test) => ({
      file: test.file,
      names: test.names.slice(0, 12),
      imports: test.imports.slice(0, 12),
    }));
  const packages = indexes.packages.packages
    .filter((pkg) => readPackages.has(pkg.root))
    .slice(0, 4)
    .map((pkg) => ({
      name: pkg.name,
      root: pkg.root,
      dependencies: pkg.dependencies.slice(0, 24),
    }));
  const configs = indexes.configs.files
    .filter((file) => file === "package.json" || file.includes("tsconfig") || file.includes("vitest"))
    .slice(0, 8);

  return {
    repoMap: repoFiles.length > 0 ? { files: repoFiles } : undefined,
    packageContext: packages.length > 0 ? { packages } : undefined,
    testContext: tests.length > 0 ? { tests } : undefined,
    configContext: configs.length > 0 ? { files: configs } : undefined,
  };
}

async function readRange(root: string, candidate: RankedCandidate, key: ReadRangeKey): Promise<ReadRangeResult | null> {
  try {
    const absolute = path.resolve(root, key.file);
    const lines = (await fsp.readFile(absolute, "utf8")).split("\n");
    const start = Math.max(1, key.startLine);
    const end = Math.min(lines.length, key.endLine);
    const content = lines
      .slice(start - 1, end)
      .map((line, index) => `${start + index}\t${line}`)
      .join("\n");
    return {
      ...key,
      startLine: start,
      endLine: end,
      candidateId: candidate.id,
      reason: candidate.reasons[0] ?? candidate.readRecommendation,
      content,
      tokenEstimate: estimateTokens(content),
    };
  } catch {
    return null;
  }
}

export class ProgressiveReader {
  constructor(private readonly root: string, private readonly indexes?: CodeSearchIndexes) {}

  async read(candidates: RankedCandidate[], request: ReadRequest, state?: ReadSessionState): Promise<ContextBundle> {
    const queryId = request.queryId ?? state?.queryId ?? createQueryId("code-read");
    const nextState: ReadSessionState = state ?? {
      queryId,
      readRanges: [],
      rejectedRanges: [],
      budget: {
        maxReadRanges: request.maxReadRanges ?? 8,
        maxReadTokens: request.maxReadTokens ?? 12_000,
        usedReadRanges: 0,
        estimatedTokens: 0,
      },
      phase: request.phase ?? "locate",
    };
    nextState.phase = request.phase ?? nextState.phase;
    nextState.budget.maxReadRanges = request.maxReadRanges ?? nextState.budget.maxReadRanges;
    nextState.budget.maxReadTokens = request.maxReadTokens ?? nextState.budget.maxReadTokens;

    const requestedIds = new Set(request.candidateIds ?? []);
    const pool = requestedIds.size > 0
      ? candidates.filter((candidate) => requestedIds.has(candidate.id))
      : candidates.filter((candidate) => candidate.readRecommendation === "read_now").slice(0, nextState.budget.maxReadRanges);

    const ranges: ReadRangeResult[] = [];
    const warnings: string[] = [];
    const omittedCandidates: ContextBundle["omittedCandidates"] = [];

    for (const candidate of pool) {
      if (nextState.budget.usedReadRanges >= nextState.budget.maxReadRanges) {
        omittedCandidates.push({ candidateId: candidate.id, reason: "read range budget exhausted" });
        continue;
      }
      if (candidate.readRecommendation === "avoid_edit") {
        omittedCandidates.push({ candidateId: candidate.id, reason: "vendor/build artifact candidate" });
        continue;
      }
      const file = this.indexes?.files.find((entry) => entry.path === candidate.file);
      if (file) {
        const currentHash = await hashFileOrNull(file.absolutePath);
        if (currentHash && currentHash !== candidate.fileHashAtIndex) warnings.push(`Stale candidate hash for ${candidate.file}`);
      }
      const key = expandRange(candidate, nextState.phase);
      if (nextState.readRanges.some((read) => overlaps(read, key))) {
        omittedCandidates.push({ candidateId: candidate.id, reason: "range already read" });
        continue;
      }
      const result = await readRange(this.root, candidate, key);
      if (!result) {
        omittedCandidates.push({ candidateId: candidate.id, reason: "file could not be read" });
        continue;
      }
      if (nextState.budget.estimatedTokens + result.tokenEstimate > nextState.budget.maxReadTokens) {
        nextState.rejectedRanges.push({ key, reason: "token budget exhausted" });
        omittedCandidates.push({ candidateId: candidate.id, reason: "token budget exhausted" });
        continue;
      }
      ranges.push(result);
      nextState.readRanges.push(key);
      nextState.budget.usedReadRanges += 1;
      nextState.budget.estimatedTokens += result.tokenEstimate;
    }

    const trace = createRetrievalTrace({ queryId, task: "code_read_context", intent: "unknown" });
    trace.readCandidates = ranges.map((range) => range.candidateId);
    trace.omittedCandidates = omittedCandidates;
    trace.warnings = warnings;
    const contextSlices = sliceIndexesForRanges(this.indexes, ranges);

    return {
      queryId,
      state: nextState,
      ranges,
      ...contextSlices,
      omittedCandidates,
      warnings,
      tokenEstimate: ranges.reduce((sum, range) => sum + range.tokenEstimate, 0),
      trace,
    };
  }
}
