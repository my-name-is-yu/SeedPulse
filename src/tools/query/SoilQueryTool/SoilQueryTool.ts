import * as os from "node:os";
import * as path from "node:path";
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
  SqliteSoilRepository,
} from "../../../platform/soil/index.js";
import { DESCRIPTION } from "./prompt.js";
import { ALIASES, MAX_OUTPUT_CHARS, PERMISSION_LEVEL, READ_ONLY, TAGS, TOOL_NAME } from "./constants.js";
import type { SoilPageRecord, SoilQueryHit, SoilScanStats } from "../../../platform/soil/retriever.js";
import type { SoilCandidate, SoilPage } from "../../../platform/soil/contracts.js";
import {
  OllamaEmbeddingClient,
  OpenAIEmbeddingClient,
  type IEmbeddingClient,
} from "../../../platform/knowledge/embedding-client.js";

const LIMIT_MAX = 50;
const DIRECT_BODY_MAX_CHARS = 4000;
const DIRECT_SNIPPET_MAX_CHARS = 280;
const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";

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
  retrievalSource: "sqlite" | "index" | "manifest";
  warnings: string[];
  pages: SoilQueryPageItem[];
  hits: SoilQueryHitItem[];
  pageCount: number;
  hitCount: number;
}

export interface SoilQueryToolOptions {
  embeddingClient?: IEmbeddingClient | null;
  embeddingModel?: string;
}

interface QueryEmbeddingConfig {
  client: IEmbeddingClient;
  model?: string;
}

interface SqliteQueryResult {
  hits: SoilQueryHitItem[];
  warnings: string[];
}

function createDefaultQueryEmbeddingConfig(): QueryEmbeddingConfig | null {
  const provider = process.env["SOIL_EMBEDDING_PROVIDER"]?.toLowerCase();
  const model = process.env["SOIL_EMBEDDING_MODEL"];
  if (provider === "ollama") {
    const ollamaModel = model ?? process.env["OLLAMA_EMBEDDING_MODEL"] ?? DEFAULT_OLLAMA_EMBEDDING_MODEL;
    return {
      client: new OllamaEmbeddingClient(ollamaModel, process.env["OLLAMA_BASE_URL"]),
      model: ollamaModel,
    };
  }

  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    return null;
  }
  const openaiModel = model ?? process.env["OPENAI_EMBEDDING_MODEL"] ?? DEFAULT_OPENAI_EMBEDDING_MODEL;
  return {
    client: new OpenAIEmbeddingClient(apiKey, openaiModel, process.env["OPENAI_BASE_URL"]),
    model: openaiModel,
  };
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

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toSqliteHitItem(candidate: SoilCandidate, page: SoilPage | undefined): SoilQueryHitItem {
  const title = metadataString(candidate.metadata_json, "title") ?? page?.soil_id ?? candidate.soil_id;
  const summary = metadataString(candidate.metadata_json, "summary");
  return {
    soilId: page?.soil_id ?? candidate.soil_id,
    relativePath: page?.relative_path ?? `${candidate.soil_id}.md`,
    title,
    kind: page?.kind ?? "knowledge",
    route: page?.route ?? "knowledge",
    status: page?.status ?? "confirmed",
    summary,
    score: candidate.score,
    snippet: candidate.snippet ?? undefined,
  };
}

function resolveSqlitePage(candidate: SoilCandidate, pages: SoilPage[] | undefined): SoilPage | undefined {
  if (!pages || pages.length === 0) {
    return undefined;
  }
  if (candidate.page_id) {
    const matched = pages.find((page) => page.page_id === candidate.page_id);
    if (matched) {
      return matched;
    }
  }
  return pages[0];
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

function isUnsafeBroadRoot(rootDir: string): boolean {
  const resolved = path.resolve(rootDir);
  const homeDir = path.resolve(os.homedir());
  const homeParent = path.dirname(homeDir);
  const filesystemRoot = path.parse(homeDir).root;
  return resolved === filesystemRoot || resolved === homeParent || resolved === homeDir;
}

function resolveSoilQueryRoot(input: SoilQueryInput, warnings: string[]): string {
  const defaultRoot = createSoilConfig().rootDir;
  if (!input.rootDir) {
    return defaultRoot;
  }
  const requestedRoot = path.resolve(input.rootDir);
  if (!isUnsafeBroadRoot(requestedRoot)) {
    return requestedRoot;
  }
  warnings.push(`Ignored unsafe Soil rootDir "${requestedRoot}"; using default Soil root "${defaultRoot}".`);
  return defaultRoot;
}

function appendScanWarnings(warnings: string[], scan: SoilScanStats | null): void {
  if (!scan?.truncated) {
    return;
  }
  const reason = scan.reason ?? "scan_limit";
  warnings.push(
    `Soil manifest scan stopped early (${reason}; matched ${scan.matchedFiles}/${scan.maxFiles} Markdown files, scanned ${scan.scannedDirs} dirs).`
  );
}

export class SoilQueryTool implements ITool<SoilQueryInput, SoilQueryOutput> {
  private readonly queryEmbedding: QueryEmbeddingConfig | null;

  constructor(options: SoilQueryToolOptions = {}) {
    this.queryEmbedding =
      "embeddingClient" in options
        ? options.embeddingClient
          ? { client: options.embeddingClient, model: options.embeddingModel }
          : null
        : createDefaultQueryEmbeddingConfig();
  }

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
      const warnings: string[] = [];
      const effectiveRootDir = resolveSoilQueryRoot(parsedInput, warnings);
      const effectiveInput = { ...parsedInput, rootDir: effectiveRootDir };
      const retriever = SoilRetriever.create({ rootDir: effectiveRootDir });
      const config = createSoilConfig({ rootDir: effectiveRootDir });
      const pages: SoilQueryPageItem[] = [];
      const hits: SoilQueryHitItem[] = [];
      let retrievalSource: SoilQueryOutput["retrievalSource"] = "manifest";

      if (parsedInput.soil_id || parsedInput.path) {
        const directRecords = await this.lookupDirectRecords(retriever, effectiveInput);
        for (const record of directRecords) {
          pages.push(toDirectItem(record));
        }
      }

      if (parsedInput.query) {
        const sqliteResult = await this.querySqlite(effectiveInput);
        warnings.push(...sqliteResult.warnings);
        if (sqliteResult.hits.length > 0) {
          retrievalSource = "sqlite";
          hits.push(...sqliteResult.hits);
        }

        const indexSnapshot = hits.length === 0 ? await loadSoilIndexSnapshot({ rootDir: effectiveRootDir }) : null;
        const freshness = indexSnapshot
          ? await checkSoilIndexFresh({ rootDir: effectiveRootDir })
          : null;
        if (hits.length === 0 && indexSnapshot && freshness?.fresh) {
          retrievalSource = "index";
          const queried = await querySoilIndexSnapshot(parsedInput.query, parsedInput.limit, { rootDir: effectiveRootDir });
          for (const hit of queried) {
            hits.push(toIndexHitItem(hit));
          }
        } else if (hits.length === 0) {
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
      appendScanWarnings(warnings, retriever.getLastScanStats());

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

  private async querySqlite(input: SoilQueryInput): Promise<SqliteQueryResult> {
    if (!input.query) {
      return { hits: [], warnings: [] };
    }
    let repository: SqliteSoilRepository | null = null;
    const warnings: string[] = [];
    try {
      repository = await SqliteSoilRepository.openExisting({ rootDir: input.rootDir });
      if (!repository) {
        return { hits: [], warnings };
      }
      const embedding = await this.embedQuery(input.query);
      if (embedding.warning) {
        warnings.push(embedding.warning);
      }
      const candidates = await repository.searchHybrid({
        query: input.query,
        limit: input.limit ?? 10,
        ...(embedding.vector ? { query_embedding: embedding.vector } : {}),
        ...(embedding.model ? { query_embedding_model: embedding.model } : {}),
      });
      if (candidates.length === 0) {
        return { hits: [], warnings };
      }
      const pages = await repository.loadPagesForRecords(candidates.map((candidate) => candidate.record_id));
      return {
        hits: candidates.map((candidate) => toSqliteHitItem(candidate, resolveSqlitePage(candidate, pages.get(candidate.record_id)))),
        warnings,
      };
    } catch {
      return { hits: [], warnings };
    } finally {
      repository?.close();
    }
  }

  private async embedQuery(query: string): Promise<{ vector: number[] | null; model?: string; warning?: string }> {
    if (!this.queryEmbedding) {
      return { vector: null };
    }
    try {
      return {
        vector: await this.queryEmbedding.client.embed(query),
        model: this.queryEmbedding.model,
      };
    } catch (err) {
      return {
        vector: null,
        warning: `Soil query embedding failed; used lexical-only SQLite search (${err instanceof Error ? err.message : String(err)}).`,
      };
    }
  }

  async checkPermissions(_input: SoilQueryInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input?: SoilQueryInput): boolean {
    return true;
  }
}
