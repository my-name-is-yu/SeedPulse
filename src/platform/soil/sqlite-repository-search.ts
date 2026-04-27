import { cosineSimilarity } from "../knowledge/embedding-client.js";
import {
  SoilSearchRequestSchema,
  type SoilCandidate,
  type SoilSearchRequest,
  type SoilSearchRequestInput,
  type SoilSearchResult,
} from "./contracts.js";
import {
  buildSnippet,
  decodeEmbedding,
  dedupeCandidates,
  parseJsonObject,
  type SoilRowChunk,
  type SoilRowEmbedding,
  type SoilRowRecord,
  type SqliteDatabase,
  unique,
} from "./sqlite-repository-helpers.js";

function hasExplicitMetadataFilter(request: SoilSearchRequest): boolean {
  const recordFilter = request.record_filter;
  const pageFilter = request.page_filter;
  return Boolean(
    recordFilter.record_ids?.length ||
      recordFilter.record_keys?.length ||
      recordFilter.record_types?.length ||
      recordFilter.statuses?.length ||
      recordFilter.goal_ids?.length ||
      recordFilter.task_ids?.length ||
      recordFilter.source_types?.length ||
      recordFilter.source_ids?.length ||
      recordFilter.valid_at ||
      recordFilter.updated_after ||
      recordFilter.updated_before ||
      pageFilter.page_ids?.length ||
      pageFilter.soil_ids?.length ||
      pageFilter.routes?.length ||
      pageFilter.kinds?.length ||
      pageFilter.page_statuses?.length ||
      pageFilter.relative_paths?.length
  );
}

export function buildRecordFilterSql(request: SoilSearchRequest, params: unknown[]): string[] {
  const clauses: string[] = [];
  const filter = request.record_filter;
  if (filter.active_only) {
    clauses.push("r.is_active = 1");
  }
  if (filter.record_ids?.length) {
    clauses.push(`r.record_id IN (${filter.record_ids.map(() => "?").join(", ")})`);
    params.push(...filter.record_ids);
  }
  if (filter.record_keys?.length) {
    clauses.push(`r.record_key IN (${filter.record_keys.map(() => "?").join(", ")})`);
    params.push(...filter.record_keys);
  }
  if (filter.record_types?.length) {
    clauses.push(`r.record_type IN (${filter.record_types.map(() => "?").join(", ")})`);
    params.push(...filter.record_types);
  }
  if (filter.statuses?.length) {
    clauses.push(`r.status IN (${filter.statuses.map(() => "?").join(", ")})`);
    params.push(...filter.statuses);
  }
  if (filter.goal_ids?.length) {
    clauses.push(`r.goal_id IN (${filter.goal_ids.map(() => "?").join(", ")})`);
    params.push(...filter.goal_ids);
  }
  if (filter.task_ids?.length) {
    clauses.push(`r.task_id IN (${filter.task_ids.map(() => "?").join(", ")})`);
    params.push(...filter.task_ids);
  }
  if (filter.source_types?.length) {
    clauses.push(`r.source_type IN (${filter.source_types.map(() => "?").join(", ")})`);
    params.push(...filter.source_types);
  }
  if (filter.source_ids?.length) {
    clauses.push(`r.source_id IN (${filter.source_ids.map(() => "?").join(", ")})`);
    params.push(...filter.source_ids);
  }
  if (filter.valid_at) {
    clauses.push("(r.valid_from IS NULL OR r.valid_from <= ?)");
    clauses.push("(r.valid_to IS NULL OR r.valid_to > ?)");
    params.push(filter.valid_at, filter.valid_at);
  }
  if (filter.updated_after) {
    clauses.push("r.updated_at >= ?");
    params.push(filter.updated_after);
  }
  if (filter.updated_before) {
    clauses.push("r.updated_at <= ?");
    params.push(filter.updated_before);
  }
  return clauses;
}

function buildPageFilterSql(request: SoilSearchRequest, params: unknown[]): string[] {
  const clauses: string[] = [];
  const filter = request.page_filter;
  if (filter.page_ids?.length) {
    clauses.push(`p.page_id IN (${filter.page_ids.map(() => "?").join(", ")})`);
    params.push(...filter.page_ids);
  }
  if (filter.soil_ids?.length) {
    clauses.push(`p.soil_id IN (${filter.soil_ids.map(() => "?").join(", ")})`);
    params.push(...filter.soil_ids);
  }
  if (filter.routes?.length) {
    clauses.push(`p.route IN (${filter.routes.map(() => "?").join(", ")})`);
    params.push(...filter.routes);
  }
  if (filter.kinds?.length) {
    clauses.push(`p.kind IN (${filter.kinds.map(() => "?").join(", ")})`);
    params.push(...filter.kinds);
  }
  if (filter.page_statuses?.length) {
    clauses.push(`p.status IN (${filter.page_statuses.map(() => "?").join(", ")})`);
    params.push(...filter.page_statuses);
  }
  if (filter.relative_paths?.length) {
    clauses.push(`p.relative_path IN (${filter.relative_paths.map(() => "?").join(", ")})`);
    params.push(...filter.relative_paths);
  }
  return clauses;
}

function buildPageExistsSql(recordIdExpr: string, request: SoilSearchRequest, params: unknown[]): string[] {
  const pagePredicates = buildPageFilterSql(request, params);
  if (pagePredicates.length === 0) {
    return [];
  }
  return [
    `EXISTS (
      SELECT 1
      FROM soil_page_members spm
      JOIN soil_pages p ON p.page_id = spm.page_id
      WHERE spm.record_id = ${recordIdExpr}
        AND ${pagePredicates.join(" AND ")}
    )`,
  ];
}

function buildCandidatePageIdSql(recordIdExpr: string, request: SoilSearchRequest, params: unknown[]): string {
  const pagePredicates = buildPageFilterSql(request, params);
  const baseQuery = pagePredicates.length > 0
    ? `SELECT spm.page_id
       FROM soil_page_members spm
       JOIN soil_pages p ON p.page_id = spm.page_id
       WHERE spm.record_id = ${recordIdExpr}
         AND ${pagePredicates.join(" AND ")}
       ORDER BY CASE WHEN spm.role = 'primary' THEN 0 ELSE 1 END, spm.ordinal, p.relative_path, spm.page_id
       LIMIT 1`
    : `SELECT spm.page_id
       FROM soil_page_members spm
       WHERE spm.record_id = ${recordIdExpr}
       ORDER BY CASE WHEN spm.role = 'primary' THEN 0 ELSE 1 END, spm.ordinal, spm.page_id
       LIMIT 1`;

  return `(${baseQuery})`;
}

export function lookupDirectCandidates(db: SqliteDatabase, input: SoilSearchRequestInput): SoilSearchResult {
  const request = SoilSearchRequestSchema.parse(input);
  if (!request.direct_lookup) {
    return { request, candidates: [] };
  }

  const pageParams: unknown[] = [request.query, request.query, request.query];
  const pageWhere = ["(soil_id = ? OR relative_path = ? OR page_id = ?)"];
  pageWhere.push(...buildPageFilterSql(request, pageParams));
  pageParams.push(request.limit);
  const pageMatches = db.prepare(`
    SELECT page_id, soil_id
    FROM soil_pages p
    WHERE ${pageWhere.join(" AND ")}
    LIMIT ?
  `).all(...pageParams) as Array<{ page_id: string; soil_id: string }>;

  const recordParams: unknown[] = [request.query, request.query, request.query, request.query];
  const recordWhere = ["(r.record_id = ? OR r.record_key = ? OR r.soil_id = ? OR r.source_id = ?)"];
  recordWhere.push(...buildRecordFilterSql(request, recordParams));
  recordParams.push(request.limit);
  const recordRows = db.prepare(`
    SELECT *
    FROM soil_records r
    WHERE ${recordWhere.join(" AND ")}
    LIMIT ?
  `).all(...recordParams) as SoilRowRecord[];

  const pageIdBySoilId = new Map<string, string>();
  for (const page of pageMatches) {
    if (!pageIdBySoilId.has(page.soil_id)) {
      pageIdBySoilId.set(page.soil_id, page.page_id);
    }
  }

  const firstChunkByRecordId = new Map<string, SoilRowChunk>();
  const recordIds = unique(recordRows.map((row) => row.record_id));
  if (recordIds.length > 0) {
    const chunkRows = db
      .prepare(`
        SELECT *
        FROM soil_chunks
        WHERE record_id IN (${recordIds.map(() => "?").join(", ")})
        ORDER BY record_id, chunk_index
      `)
      .all(...recordIds) as SoilRowChunk[];
    for (const chunk of chunkRows) {
      if (!firstChunkByRecordId.has(chunk.record_id)) {
        firstChunkByRecordId.set(chunk.record_id, chunk);
      }
    }
  }

  const firstPageMemberByPageId = new Map<
    string,
    { record_id: string | null; chunk_id: string | null; chunk_text: string | null }
  >();
  const pageIds = unique(pageMatches.map((page) => page.page_id));
  if (pageIds.length > 0) {
    const pageMemberRows = db
      .prepare(`
        SELECT spm.page_id, spm.record_id, sc.chunk_id, sc.chunk_text
        FROM soil_page_members spm
        LEFT JOIN soil_chunks sc ON sc.record_id = spm.record_id
        WHERE spm.page_id IN (${pageIds.map(() => "?").join(", ")})
        ORDER BY spm.page_id, spm.ordinal, sc.chunk_index
      `)
      .all(...pageIds) as Array<{
      page_id: string;
      record_id: string | null;
      chunk_id: string | null;
      chunk_text: string | null;
    }>;
    for (const row of pageMemberRows) {
      if (!firstPageMemberByPageId.has(row.page_id)) {
        firstPageMemberByPageId.set(row.page_id, row);
      }
    }
  }

  const candidates: SoilCandidate[] = [];
  const representedPageIds = new Set<string>();
  for (const row of recordRows) {
    const chunk = firstChunkByRecordId.get(row.record_id);
    const page_id = pageIdBySoilId.get(row.soil_id) ?? null;
    if (page_id) {
      representedPageIds.add(page_id);
    }
    candidates.push({
      chunk_id: chunk?.chunk_id ?? `record:${row.record_id}`,
      record_id: row.record_id,
      soil_id: row.soil_id,
      lane: "direct",
      rank: candidates.length + 1,
      score: 1,
      snippet: chunk ? buildSnippet(chunk.chunk_text, request.query) : row.summary ?? row.title,
      page_id,
      metadata_json: parseJsonObject(row.metadata_json),
    });
  }

  for (const page of pageMatches) {
    if (representedPageIds.has(page.page_id)) continue;
    representedPageIds.add(page.page_id);
    const member = firstPageMemberByPageId.get(page.page_id);
    candidates.push({
      chunk_id: member?.chunk_id ?? `page:${page.page_id}`,
      record_id: member?.record_id ?? `page:${page.page_id}`,
      soil_id: page.soil_id,
      lane: "direct",
      rank: candidates.length + 1,
      score: 1,
      snippet: member?.chunk_text ? buildSnippet(member.chunk_text, request.query) : page.soil_id,
      page_id: page.page_id,
      metadata_json: {},
    });
  }

  return { request, candidates: candidates.slice(0, request.limit) };
}

export function searchLexicalCandidates(db: SqliteDatabase, input: SoilSearchRequestInput): SoilCandidate[] {
  const request = SoilSearchRequestSchema.parse(input);
  const pageIdParams: unknown[] = [];
  const pageIdSql = buildCandidatePageIdSql("r.record_id", request, pageIdParams);
  const whereParams: unknown[] = [];
  const where = ["soil_chunk_fts MATCH ?"];
  where.push(...buildRecordFilterSql(request, whereParams));
  where.push(...buildPageExistsSql("r.record_id", request, whereParams));
  const params: unknown[] = [...pageIdParams, request.query, ...whereParams, request.lexical_top_k];

  const rows = db.prepare(`
    SELECT
      soil_chunk_fts.chunk_id AS chunk_id,
      soil_chunk_fts.record_id AS record_id,
      soil_chunk_fts.soil_id AS soil_id,
      ${pageIdSql} AS page_id,
      r.title AS title,
      r.summary AS summary,
      sc.chunk_text AS chunk_text,
      bm25(soil_chunk_fts, 8.0, 5.0, 3.0, 1.0) AS score
    FROM soil_chunk_fts
    JOIN soil_chunks sc ON sc.chunk_id = soil_chunk_fts.chunk_id
    JOIN soil_records r ON r.record_id = soil_chunk_fts.record_id
    WHERE ${where.join(" AND ")}
    ORDER BY score
    LIMIT ?
  `).all(...params) as Array<{
    chunk_id: string;
    record_id: string;
    soil_id: string;
    page_id: string | null;
    title: string;
    summary: string | null;
    chunk_text: string;
    score: number;
  }>;

  const candidates: SoilCandidate[] = rows.map((row, index) => ({
    chunk_id: row.chunk_id,
    record_id: row.record_id,
    soil_id: row.soil_id,
    page_id: row.page_id,
    lane: "lexical",
    rank: index + 1,
    score: -1 * row.score,
    snippet: buildSnippet(row.chunk_text, request.query),
    metadata_json: { title: row.title, summary: row.summary },
  }));
  return dedupeCandidates(candidates, request.limit);
}

export function searchDenseCandidates(
  db: SqliteDatabase,
  input: SoilSearchRequestInput,
  excludedRecordIds: string[]
): SoilCandidate[] {
  const request = SoilSearchRequestSchema.parse(input);
  if (!request.query_embedding?.length) {
    return [];
  }
  const pageIdParams: unknown[] = [];
  const pageIdSql = buildCandidatePageIdSql("r.record_id", request, pageIdParams);
  const params: unknown[] = [];
  const where = buildRecordFilterSql(request, params);
  where.push(...buildPageExistsSql("r.record_id", request, params));
  const denseCandidateRecordIds = request.dense_candidate_record_ids ? unique(request.dense_candidate_record_ids) : null;
  if (denseCandidateRecordIds?.length === 0) {
    return [];
  }
  if (denseCandidateRecordIds) {
    where.push(`r.record_id IN (${denseCandidateRecordIds.map(() => "?").join(", ")})`);
    params.push(...denseCandidateRecordIds);
  }
  if (excludedRecordIds.length > 0) {
    where.push(`r.record_id NOT IN (${excludedRecordIds.map(() => "?").join(", ")})`);
    params.push(...excludedRecordIds);
  }
  if (request.query_embedding_model) {
    where.push("se.model = ?");
    params.push(request.query_embedding_model);
  }
  where.push(`
    NOT EXISTS (
      SELECT 1
      FROM soil_embeddings newer
      WHERE newer.chunk_id = se.chunk_id
        AND newer.model = se.model
        AND newer.embedding_version > se.embedding_version
    )
  `);
  const queryParams = [...pageIdParams, ...params];
  const rows = db.prepare(`
    SELECT
      se.chunk_id,
      se.model,
      se.embedding_version,
      se.encoding,
      se.embedding,
      se.embedded_at,
      sc.record_id,
      sc.soil_id,
      sc.chunk_text,
      r.title,
      r.summary,
      ${pageIdSql} AS page_id
    FROM soil_embeddings se
    JOIN soil_chunks sc ON sc.chunk_id = se.chunk_id
    JOIN soil_records r ON r.record_id = sc.record_id
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
  `).all(...queryParams) as Array<SoilRowEmbedding & {
    record_id: string;
    soil_id: string;
    chunk_text: string;
    title: string;
    summary: string | null;
    page_id: string | null;
  }>;

  const scored: Array<{ row: typeof rows[number]; similarity: number }> = [];
  for (const row of rows) {
    try {
      scored.push({
        row,
        similarity: cosineSimilarity(request.query_embedding, decodeEmbedding(row)),
      });
    } catch {
      continue;
    }
  }
  scored.sort((left, right) => right.similarity - left.similarity);
  const candidates: SoilCandidate[] = scored.slice(0, request.dense_top_k).map(({ row, similarity }, index) => ({
    chunk_id: row.chunk_id,
    record_id: row.record_id,
    soil_id: row.soil_id,
    page_id: row.page_id,
    lane: "dense",
    rank: index + 1,
    score: similarity,
    snippet: buildSnippet(row.chunk_text, request.query),
    metadata_json: { model: row.model, embedding_version: row.embedding_version, title: row.title, summary: row.summary },
  }));
  return dedupeCandidates(candidates, request.limit);
}

export function shouldRunDenseSearch(request: SoilSearchRequest, lexicalRecordIds: string[]): boolean {
  return lexicalRecordIds.length > 0 || hasExplicitMetadataFilter(request);
}
