import { z } from "zod";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
  ToolMetadata,
  ToolDescriptionContext,
} from "../../types.js";
import {
  SoilRetriever,
  checkSoilIndexFresh,
  createSoilConfig,
  loadSoilIndexSnapshot,
  querySoilIndexSnapshot,
} from "../../../platform/soil/index.js";
import { DESCRIPTION } from "./prompt.js";
import { ALIASES, MAX_OUTPUT_CHARS, PERMISSION_LEVEL, READ_ONLY, TAGS, TOOL_NAME } from "./constants.js";
import type { SoilPageRecord, SoilQueryHit } from "../../../platform/soil/retriever.js";

const LIMIT_MAX = 50;
const DIRECT_BODY_MAX_CHARS = 4000;
const DIRECT_SNIPPET_MAX_CHARS = 280;

export const SoilQueryInputSchema = z
  .object({
    query: z.string().min(1).optional(),
    soil_id: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(LIMIT_MAX).default(10),
    rootDir: z.string().min(1).optional(),
  })
  .refine((input) => Boolean(input.query || input.soil_id || input.path), {
    message: "Provide query, soil_id, or path",
  });
export type SoilQueryInput = z.infer<typeof SoilQueryInputSchema>;

export interface SoilQueryPageItem {
  soilId: string;
  relativePath: string;
  title: string;
  kind: string;
  route: string;
  status: string;
  summary: string | null;
  snippet?: string;
  body?: string;
}

export interface SoilQueryHitItem {
  soilId: string;
  relativePath: string;
  title: string;
  kind: string;
  route: string;
  status: string;
  summary: string | null;
  score: number;
  snippet?: string;
}

export interface SoilQueryOutput {
  rootDir: string;
  limit: number;
  query: string | null;
  soilId: string | null;
  path: string | null;
  retrievalSource: "index" | "manifest";
  warnings: string[];
  pages: SoilQueryPageItem[];
  hits: SoilQueryHitItem[];
  pageCount: number;
  hitCount: number;
}

function toSummaryItem(record: SoilPageRecord): SoilQueryPageItem {
  return {
    soilId: record.soilId,
    relativePath: record.relativePath,
    title: record.frontmatter.title,
    kind: record.frontmatter.kind,
    route: record.frontmatter.route,
    status: record.frontmatter.status,
    summary: record.frontmatter.summary ?? null,
  };
}

function toDirectItem(record: SoilPageRecord): SoilQueryPageItem {
  const body = record.body.slice(0, DIRECT_BODY_MAX_CHARS);
  return {
    ...toSummaryItem(record),
    snippet: createDirectSnippet(record),
    body,
  };
}

function createDirectSnippet(record: SoilPageRecord): string {
  const candidate = [record.frontmatter.title, record.frontmatter.summary, record.body]
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return candidate.slice(0, DIRECT_SNIPPET_MAX_CHARS);
}

function toHitItem(hit: SoilQueryHit): SoilQueryHitItem {
  return {
    soilId: hit.soilId,
    relativePath: hit.relativePath,
    title: hit.frontmatter.title,
    kind: hit.frontmatter.kind,
    route: hit.frontmatter.route,
    status: hit.frontmatter.status,
    summary: hit.frontmatter.summary ?? null,
    score: hit.score,
  };
}

function toIndexHitItem(hit: Awaited<ReturnType<typeof querySoilIndexSnapshot>>[number]): SoilQueryHitItem {
  return {
    soilId: hit.soil_id,
    relativePath: hit.relative_path,
    title: hit.title,
    kind: hit.kind,
    route: hit.route,
    status: hit.status,
    summary: hit.summary ?? null,
    score: hit.score,
    snippet: hit.snippet,
  };
}

function dedupeByKey<T>(records: T[], keyFn: (record: T) => string): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const record of records) {
    const key = keyFn(record);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(record);
  }
  return deduped;
}

export class SoilQueryTool implements ITool<SoilQueryInput, SoilQueryOutput> {
  readonly metadata: ToolMetadata = {
    name: TOOL_NAME,
    aliases: [...ALIASES],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };

  readonly inputSchema = SoilQueryInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: SoilQueryInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      const parsedInput = this.inputSchema.parse(input);
      const retriever = SoilRetriever.create({ rootDir: parsedInput.rootDir });
      const config = createSoilConfig({ rootDir: parsedInput.rootDir });
      const pages: SoilQueryPageItem[] = [];
      const hits: SoilQueryHitItem[] = [];
      let retrievalSource: SoilQueryOutput["retrievalSource"] = "manifest";
      const warnings: string[] = [];

      if (parsedInput.soil_id || parsedInput.path) {
        const directRecords = await this.lookupDirectRecords(retriever, parsedInput);
        for (const record of directRecords) {
          pages.push(toDirectItem(record));
        }
      }

      if (parsedInput.query) {
        const indexSnapshot = await loadSoilIndexSnapshot({ rootDir: parsedInput.rootDir });
        const freshness = indexSnapshot
          ? await checkSoilIndexFresh({ rootDir: parsedInput.rootDir })
          : null;
        if (indexSnapshot && freshness?.fresh) {
          retrievalSource = "index";
          const queried = await querySoilIndexSnapshot(parsedInput.query, parsedInput.limit, { rootDir: parsedInput.rootDir });
          for (const hit of queried) {
            hits.push(toIndexHitItem(hit));
          }
        } else {
          warnings.push(
            freshness
              ? `Soil index stale (${freshness.reason}); fell back to Markdown manifest scan.`
              : "Soil index missing; fell back to Markdown manifest scan."
          );
          const queried = await retriever.query(parsedInput.query, parsedInput.limit);
          for (const hit of queried.slice(0, parsedInput.limit)) {
            hits.push(toHitItem(hit));
          }
        }
      } else if (!parsedInput.soil_id && !parsedInput.path) {
        const listed = await retriever.list();
        for (const record of listed.slice(0, parsedInput.limit)) {
          pages.push(toSummaryItem(record));
        }
      }

      const dedupedPages = dedupeByKey(pages, (record) => `${record.soilId}:${record.relativePath}`);
      const output: SoilQueryOutput = {
        rootDir: config.rootDir,
        limit: parsedInput.limit,
        query: parsedInput.query ?? null,
        soilId: parsedInput.soil_id ?? null,
        path: parsedInput.path ?? null,
        retrievalSource,
        warnings,
        pages: dedupedPages,
        hits,
        pageCount: dedupedPages.length,
        hitCount: hits.length,
      };

      const summary =
        parsedInput.soil_id || parsedInput.path
          ? `Loaded ${output.pageCount} Soil page${output.pageCount !== 1 ? "s" : ""}`
          : parsedInput.query
            ? `Found ${output.hitCount} Soil hit${output.hitCount !== 1 ? "s" : ""} for "${parsedInput.query}"`
            : `Listed ${output.pageCount} Soil page${output.pageCount !== 1 ? "s" : ""}`;

      return {
        success: true,
        data: output,
        summary,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: {
          rootDir: input.rootDir ?? "",
          limit: input.limit ?? 10,
          query: input.query ?? null,
          soilId: input.soil_id ?? null,
          path: input.path ?? null,
          retrievalSource: "manifest",
          warnings: [],
          pages: [],
          hits: [],
          pageCount: 0,
          hitCount: 0,
        } satisfies SoilQueryOutput,
        summary: `Soil query failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  private async lookupDirectRecords(
    retriever: SoilRetriever,
    input: SoilQueryInput
  ): Promise<SoilPageRecord[]> {
    const records: SoilPageRecord[] = [];
    if (input.soil_id) {
      const bySoilId = await retriever.getBySoilId(input.soil_id);
      if (bySoilId) {
        records.push(bySoilId);
      }
    }
    if (input.path) {
      const byPath = await retriever.getByPath(input.path);
      if (byPath) {
        records.push(byPath);
      }
    }
    return dedupeByKey(records, (record) => `${record.soilId}:${record.relativePath}`);
  }

  async checkPermissions(_input: SoilQueryInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input?: SoilQueryInput): boolean {
    return true;
  }
}
