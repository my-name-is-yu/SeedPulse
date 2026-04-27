import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { getDefaultSoilSqliteIndexPath, resolveSoilRootDir, type SoilConfigInput } from "./config.js";
import {
  SoilRecordFilterSchema,
  SoilSearchRequestSchema,
  type SoilCandidate,
  type SoilMutationInput,
  type SoilPage,
  type SoilPageMember,
  type SoilRecord,
  type SoilRecordFilterInput,
  type SoilRepository,
  type SoilSearchRequestInput,
  type SoilSearchResult,
} from "./contracts.js";
import { fuseCandidates, toPage, toPageMember, toRecord, type SoilRowPage, type SoilRowPageMember, type SoilRowRecord, type SqliteDatabase, unique } from "./sqlite-repository-helpers.js";
import {
  buildRecordFilterSql,
  lookupDirectCandidates,
  searchDenseCandidates,
  searchLexicalCandidates,
  shouldRunDenseSearch,
} from "./sqlite-repository-search.js";
import {
  applySoilMutation,
  initializeReadonlySoilSqlite,
  initializeSoilSqlite,
  loadOpenEmbeddingReindexRecordIds,
  replaceSoilPageMembers,
} from "./sqlite-repository-storage.js";

export class SqliteSoilRepository implements SoilRepository {
  private constructor(
    private readonly db: SqliteDatabase,
    readonly dbPath: string
  ) {}

  static async create(configInput: SoilConfigInput = {}): Promise<SqliteSoilRepository> {
    const rootDir = resolveSoilRootDir(configInput.rootDir);
    const indexPath = configInput.indexPath ? path.resolve(configInput.indexPath) : getDefaultSoilSqliteIndexPath(rootDir);
    await fsp.mkdir(path.dirname(indexPath), { recursive: true });
    const db = new Database(indexPath);
    initializeSoilSqlite(db);
    return new SqliteSoilRepository(db, indexPath);
  }

  static async openExisting(configInput: SoilConfigInput = {}): Promise<SqliteSoilRepository | null> {
    const rootDir = resolveSoilRootDir(configInput.rootDir);
    const indexPath = configInput.indexPath ? path.resolve(configInput.indexPath) : getDefaultSoilSqliteIndexPath(rootDir);
    try {
      await fsp.access(indexPath);
    } catch {
      return null;
    }
    const db = new Database(indexPath, { readonly: true, fileMustExist: true });
    initializeReadonlySoilSqlite(db);
    return new SqliteSoilRepository(db, indexPath);
  }

  close(): void {
    this.db.close();
  }

  async applyMutation(input: SoilMutationInput): Promise<void> {
    applySoilMutation(this.db, input);
  }

  async loadRecords(input: SoilRecordFilterInput = {}): Promise<SoilRecord[]> {
    const record_filter = SoilRecordFilterSchema.parse(input);
    const params: unknown[] = [];
    const where = buildRecordFilterSql(
      SoilSearchRequestSchema.parse({ query: "__load_records__", direct_lookup: false, record_filter }),
      params
    );
    const rows = this.db.prepare(`
      SELECT *
      FROM soil_records r
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY r.record_key, r.version
    `).all(...params) as SoilRowRecord[];
    return rows.map((row) => toRecord(row));
  }

  async queueReindex(recordIds: string[], reason: string): Promise<void> {
    const ids = unique(recordIds);
    if (ids.length === 0) return;
    this.db.prepare(`
      INSERT INTO soil_reindex_jobs (
        job_id, scope, reason, status, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      "embedding",
      reason,
      "pending",
      JSON.stringify({ record_ids: ids }),
      new Date().toISOString()
    );
  }

  async upsertPages(pages: SoilPage[]): Promise<void> {
    await this.applyMutation({ pages });
  }

  async replacePageMembers(pageId: string, members: SoilPageMember[]): Promise<void> {
    replaceSoilPageMembers(this.db, pageId, members);
  }

  async lookupDirect(input: SoilSearchRequestInput): Promise<SoilSearchResult> {
    return lookupDirectCandidates(this.db, input);
  }

  async searchHybrid(input: SoilSearchRequestInput): Promise<SoilCandidate[]> {
    const request = SoilSearchRequestSchema.parse(input);
    if (request.direct_lookup) {
      const direct = await this.lookupDirect(request);
      if (direct.candidates.length > 0) {
        return direct.candidates.slice(0, request.limit);
      }
    }

    const lexical = await this.searchLexical({ ...request, direct_lookup: false });
    if (!request.query_embedding?.length) {
      return lexical;
    }

    const lexicalRecordIds = unique(lexical.map((candidate) => candidate.record_id));
    const dense = shouldRunDenseSearch(request, lexicalRecordIds)
      ? await this.searchDense({
          ...request,
          direct_lookup: false,
          ...(lexicalRecordIds.length > 0 ? { dense_candidate_record_ids: lexicalRecordIds } : {}),
        })
      : [];

    return fuseCandidates(lexical, dense, request.limit);
  }

  async searchLexical(input: SoilSearchRequestInput): Promise<SoilCandidate[]> {
    return searchLexicalCandidates(this.db, input);
  }

  async searchDense(input: SoilSearchRequestInput): Promise<SoilCandidate[]> {
    return searchDenseCandidates(this.db, input, loadOpenEmbeddingReindexRecordIds(this.db));
  }

  async loadPagesForRecords(recordIds: string[]): Promise<Map<string, SoilPage[]>> {
    const ids = unique(recordIds);
    const result = new Map<string, SoilPage[]>();
    if (ids.length === 0) return result;
    const rows = this.db.prepare(`
      SELECT p.*, spm.record_id
      FROM soil_page_members spm
      JOIN soil_pages p ON p.page_id = spm.page_id
      WHERE spm.record_id IN (${ids.map(() => "?").join(", ")})
      ORDER BY p.relative_path, spm.ordinal
    `).all(...ids) as Array<SoilRowPage & { record_id: string }>;
    for (const row of rows) {
      const pages = result.get(row.record_id) ?? [];
      pages.push(toPage(row));
      result.set(row.record_id, pages);
    }
    return result;
  }

  async loadPageMembers(pageIds: string[]): Promise<SoilPageMember[]> {
    const ids = unique(pageIds);
    if (ids.length === 0) return [];
    const rows = this.db.prepare(`
      SELECT *
      FROM soil_page_members
      WHERE page_id IN (${ids.map(() => "?").join(", ")})
      ORDER BY page_id, ordinal
    `).all(...ids) as SoilRowPageMember[];
    return rows.map((row) => toPageMember(row));
  }

}
