import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "fs/promises";
import type { ToolExecutor } from "../../../tools/executor.js";
import type { ToolCallContext } from "../../../tools/types.js";
import type { ContextItem } from "./shared.js";
import {
  classifyTier,
  sanitizeNumberedContent,
  tailLines,
  toRelativePath,
} from "./shared.js";
import { dimensionNameToSearchTerms } from "./search-terms.js";

const execFileAsync = promisify(execFile);

const DEFAULT_FILE_CONTENT_LINES = 100;
const REDUCED_FILE_CONTENT_LINES = 50;
const MAX_GREP_MATCHES = 5;
const MAX_FILE_READS_PER_TERM = 3;
const MAX_CHAT_KEYWORDS = 3;
const TEST_STATUS_LABEL = "[Test status]";
const TEST_FAILURE_STATUS_LABEL = "[Test status (failures detected)]";
const WORKSPACE_GIT_LABEL = "[Recent changes: git diff HEAD~1 --stat]";
const CHAT_GIT_LABEL = "[Recent changes: git diff HEAD --stat]";
const TOOL_GIT_LABEL = "[Recent changes: git log --oneline]";

export type CollectorOptions = {
  cwd?: string;
  maxFileContentLines?: number;
  maxTotalChars?: number;
  toolExecutor?: ToolExecutor;
  toolContext?: Partial<ToolCallContext>;
};

type ContextCollector = {
  cwd: string;
  toolExecutor?: ToolExecutor;
  ctx: ToolCallContext;
};

type CodeSearchCandidate = {
  id: string;
  file: string;
  reasons?: string[];
};

type CodeSearchBundle = {
  ranges?: Array<{ file: string; content: string }>;
};

function createCollector(goalId: string, options?: CollectorOptions): ContextCollector {
  const cwd = options?.cwd || process.cwd();
  return {
    cwd,
    toolExecutor: options?.toolExecutor,
    ctx: {
      cwd,
      goalId: goalId || "context-provider",
      trustBalance: 0,
      preApproved: true,
      approvalFn: async () => true,
      ...(options?.toolContext ?? {}),
    },
  };
}

function toContextItem(label: string, content: string): ContextItem {
  return {
    label,
    content,
    memory_tier: classifyTier(label),
  };
}

async function findMatchingFiles(
  collector: ContextCollector,
  searchRoot: string,
  term: string,
  limit: number
): Promise<string[]> {
  if (collector.toolExecutor) {
    const result = await collector.toolExecutor.execute(
      "grep",
      { pattern: term, path: searchRoot, glob: "*.{ts,js}", outputMode: "files_with_matches", limit },
      collector.ctx
    );
    return result.success
      ? String(result.data ?? "").split("\n").filter(Boolean).slice(0, limit)
      : [];
  }

  const { stdout } = await execFileAsync(
    "grep",
    ["-rn", "--include=*.ts", "--include=*.js", "-l", term, searchRoot],
    { timeout: 10000 }
  );
  return stdout.trim().split("\n").filter(Boolean).slice(0, limit);
}

async function readFileExcerpt(
  collector: ContextCollector,
  filePath: string,
  maxLines: number
): Promise<string[]> {
  if (collector.toolExecutor) {
    const result = await collector.toolExecutor.execute(
      "read",
      { file_path: filePath, limit: maxLines },
      collector.ctx
    );
    if (!result.success || typeof result.data !== "string") {
      return [];
    }
    return sanitizeNumberedContent(result.data).split("\n").slice(0, maxLines);
  }

  const content = await readFile(filePath, "utf-8");
  return content.split("\n").slice(0, maxLines);
}

async function loadCodeSearchParts(
  collector: ContextCollector,
  dimensionName: string,
  term: string
): Promise<string[]> {
  if (!collector.toolExecutor) {
    return [];
  }

  const searchResult = await collector.toolExecutor.execute(
    "code_search",
    {
      task: `${dimensionName}: ${term}`,
      intent: "explain",
      queryTerms: [term, dimensionName],
      budget: { maxRerankCandidates: 8, maxCandidatesPerRetriever: 20 },
    },
    collector.ctx
  ).catch(() => null);

  const searchData =
    searchResult?.success && searchResult.data && typeof searchResult.data === "object"
      ? (searchResult.data as { candidates?: CodeSearchCandidate[] })
      : null;
  const candidates = searchData?.candidates?.slice(0, MAX_FILE_READS_PER_TERM) ?? [];
  if (candidates.length === 0) {
    return [];
  }

  const readResult = await collector.toolExecutor.execute(
    "code_read_context",
    {
      candidates,
      candidateIds: candidates.map((candidate) => candidate.id),
      phase: "locate",
      maxReadRanges: MAX_FILE_READS_PER_TERM,
      maxReadTokens: 4000,
    },
    collector.ctx
  ).catch(() => null);

  const bundle =
    readResult?.success && readResult.data && typeof readResult.data === "object"
      ? (readResult.data as CodeSearchBundle)
      : null;

  return (bundle?.ranges ?? []).flatMap((range) => [
    `[CodeSearch: ${range.file}]`,
    sanitizeNumberedContent(range.content),
  ]);
}

async function collectRecentChangesContent(
  collector: ContextCollector,
  cwd: string
): Promise<{ label: string; content: string } | null> {
  if (collector.toolExecutor) {
    const result = await collector.toolExecutor.execute(
      "git_log",
      { maxCount: 10, format: "oneline", cwd },
      collector.ctx
    );
    const logLines = result.success && Array.isArray(result.data)
      ? result.data.join("\n").trim()
      : "";
    return logLines ? { label: TOOL_GIT_LABEL, content: logLines } : null;
  }

  const gitArgs = cwd === collector.cwd ? ["diff", "HEAD~1", "--stat"] : ["diff", "HEAD", "--stat"];
  const { stdout } = await execFileAsync("git", gitArgs, { cwd, timeout: 10000 });
  const content = cwd === collector.cwd
    ? stdout.trim()
    : stdout.trim().split("\n").slice(0, 30).join("\n");
  if (!content) {
    return null;
  }
  return {
    label: cwd === collector.cwd ? WORKSPACE_GIT_LABEL : CHAT_GIT_LABEL,
    content,
  };
}

async function collectTestStatusContent(
  collector: ContextCollector
): Promise<{ label: string; content: string } | null> {
  if (collector.toolExecutor) {
    const result = await collector.toolExecutor.execute(
      "test-runner",
      { command: "npx vitest run --reporter=dot", timeout: 30000 },
      collector.ctx
    );
    if (result.success && result.data && typeof result.data === "object" && "rawOutput" in result.data) {
      return {
        label: TEST_STATUS_LABEL,
        content: tailLines((result.data as { rawOutput: string }).rawOutput, 10),
      };
    }
    if (result.success && typeof result.data === "string") {
      return {
        label: TEST_STATUS_LABEL,
        content: tailLines(result.data, 10),
      };
    }
    return null;
  }

  try {
    const { stdout } = await execFileAsync(
      "npx",
      ["vitest", "run", "--reporter=dot"],
      { cwd: collector.cwd, timeout: 30000 }
    );
    return { label: TEST_STATUS_LABEL, content: tailLines(stdout, 10) };
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "stdout" in err) {
      const content = tailLines((err as { stdout: string }).stdout || "", 10);
      return content.trim() ? { label: TEST_FAILURE_STATUS_LABEL, content } : null;
    }
    return null;
  }
}

async function collectSearchTermItems(
  collector: ContextCollector,
  cwd: string,
  dimensionName: string,
  term: string,
  maxTotalChars: number,
  cumulativeChars: number,
  readMaxLines: () => number
): Promise<{ items: ContextItem[]; addedChars: number }> {
  const items: ContextItem[] = [];
  let addedChars = 0;
  const codeSearchContentParts = await loadCodeSearchParts(collector, dimensionName, term);
  const files = await findMatchingFiles(collector, cwd, term, MAX_GREP_MATCHES);

  if (codeSearchContentParts.length > 0) {
    const label = `[code_search "${term}" — structured ranges]`;
    const itemContent = codeSearchContentParts.join("\n\n");
    addedChars += label.length + itemContent.length;
    items.push(toContextItem(label, itemContent));
  }

  if (files.length === 0) {
    return { items, addedChars };
  }

  const label = `[grep "${term}" — ${files.length} files matched]`;
  const contentParts: string[] = [];
  let runningChars = cumulativeChars + addedChars;

  for (const filePath of files.slice(0, MAX_FILE_READS_PER_TERM)) {
    if (runningChars >= maxTotalChars) {
      break;
    }
    try {
      const lines = await readFileExcerpt(collector, filePath, readMaxLines());
      if (lines.length > 0) {
        contentParts.push(`[File: ${toRelativePath(cwd, filePath)} (${lines.length} lines)]`);
        contentParts.push(lines.join("\n"));
        runningChars = cumulativeChars + addedChars + label.length + contentParts.join("\n\n").length;
      }
    } catch {
      // skip unreadable files
    }
  }

  const itemContent = contentParts.join("\n\n");
  addedChars += label.length + itemContent.length;
  items.push(toContextItem(label, itemContent));
  return { items, addedChars };
}

async function maybeAppendContextItem(
  items: ContextItem[],
  cumulativeChars: number,
  maxTotalChars: number,
  loader: () => Promise<{ label: string; content: string } | null>
): Promise<number> {
  if (cumulativeChars >= maxTotalChars) {
    return cumulativeChars;
  }

  try {
    const item = await loader();
    if (!item) {
      return cumulativeChars;
    }
    items.push(toContextItem(item.label, item.content));
    return cumulativeChars + item.label.length + item.content.length;
  } catch {
    return cumulativeChars;
  }
}

export async function collectContextItems(
  goalId: string,
  dimensionName: string,
  options?: CollectorOptions
): Promise<ContextItem[]> {
  const collector = createCollector(goalId, options);
  const { cwd } = collector;
  const maxTotalChars = options?.maxTotalChars ?? 32000;
  let cumulativeChars = 0;
  const items: ContextItem[] = [];

  const effectiveMaxLines = (): number => {
    const halfBudget = maxTotalChars / 2;
    return cumulativeChars > halfBudget
      ? REDUCED_FILE_CONTENT_LINES
      : (options?.maxFileContentLines ?? DEFAULT_FILE_CONTENT_LINES);
  };

  const searchTerms = dimensionNameToSearchTerms(dimensionName);
  for (const term of searchTerms) {
    if (cumulativeChars >= maxTotalChars) {
      break;
    }
    try {
      const result = await collectSearchTermItems(
        collector,
        cwd,
        dimensionName,
        term,
        maxTotalChars,
        cumulativeChars,
        effectiveMaxLines
      );
      items.push(...result.items);
      cumulativeChars += result.addedChars;
    } catch {
      // grep returns exit 1 for zero matches — ignore
    }
  }

  cumulativeChars = await maybeAppendContextItem(
    items,
    cumulativeChars,
    maxTotalChars,
    () => collectRecentChangesContent(collector, cwd)
  );
  cumulativeChars = await maybeAppendContextItem(
    items,
    cumulativeChars,
    maxTotalChars,
    () => collectTestStatusContent(collector)
  );

  return items;
}

export async function collectChatContextParts(
  taskDescription: string,
  cwd: string,
  options?: Pick<CollectorOptions, "toolExecutor" | "toolContext">
): Promise<string[]> {
  const collector = createCollector("context-provider", { cwd, ...options });
  const keywords = taskDescription
    .split(/\s+/)
    .filter((word) => word.length >= 4)
    .slice(0, MAX_CHAT_KEYWORDS);
  const parts: string[] = [];

  const recentChanges = await collectRecentChangesContent(collector, cwd);
  if (recentChanges) {
    parts.push(`${recentChanges.label}\n${recentChanges.content}`);
  }

  for (const keyword of keywords) {
    try {
      const files = await findMatchingFiles(collector, cwd, keyword, MAX_GREP_MATCHES);
      for (const filePath of files.slice(0, MAX_FILE_READS_PER_TERM)) {
        try {
          const lines = await readFileExcerpt(collector, filePath, REDUCED_FILE_CONTENT_LINES);
          if (lines.length === 0) {
            continue;
          }
          parts.push(
            `[File: ${toRelativePath(cwd, filePath)} (keyword: ${keyword})]\n${lines.join("\n")}`
          );
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // grep no match — ignore
    }
  }

  return parts;
}
