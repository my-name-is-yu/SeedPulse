import * as fsp from "node:fs/promises";
import * as path from "node:path";
import Database from "better-sqlite3";
import { computeSoilChecksum } from "../checksum.js";
import { createSoilConfig, getDefaultSoilSqliteIndexPath, type SoilConfig } from "../config.js";
import { SoilChunkSchema, SoilPageSchema, SoilRecordSchema } from "../contracts.js";
import { writeSoilMarkdownFile } from "../io.js";
import { normalizeSoilRelativePath, resolveSoilPageFilePath } from "../paths.js";
import { baseFrontmatter, nowIso, trimText } from "../projection-support.js";
import { SoilPageFrontmatterSchema, type SoilKind, type SoilPageFrontmatter, type SoilRoute, type SoilStatus } from "../types.js";
import type { SoilDisplayMaterializedPage, SoilDisplaySnapshotInput, SoilDisplaySnapshotResult } from "./types.js";

interface SoilRecordRow {
  record_id: string;
  record_key: string;
  version: number;
  record_type: string;
  soil_id: string;
  title: string;
  summary: string | null;
  canonical_text: string;
  goal_id: string | null;
  task_id: string | null;
  status: string;
  confidence: number | null;
  importance: number | null;
  source_reliability: number | null;
  valid_from: string | null;
  valid_to: string | null;
  supersedes_record_id: string | null;
  is_active: number;
  source_type: string;
  source_id: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface SoilPageRow {
  page_id: string;
  soil_id: string;
  relative_path: string;
  route: string;
  kind: string;
  status: string;
  markdown: string;
  checksum: string;
  projected_at: string;
}

interface SoilChunkRow {
  chunk_id: string;
  record_id: string;
  soil_id: string;
  chunk_index: number;
  chunk_kind: string;
  heading_path_json: string;
  chunk_text: string;
  token_count: number;
  checksum: string;
  created_at: string;
}

interface SoilPageMemberRow {
  page_id: string;
  record_id: string;
  ordinal: number;
  role: string;
  confidence: number | null;
}

type SoilRenderableRecord = {
  title: string;
  record_key: string;
  record_type: string;
  soil_id: string;
  summary: string | null;
  canonical_text: string;
  status: string;
  created_at: string;
  updated_at: string;
  confidence: number | null;
  record_id: string;
};
type SoilParsedRecord = ReturnType<typeof toRecord>;
type SoilParsedChunk = ReturnType<typeof toChunk>;

function toRecord(row: SoilRecordRow) {
  return SoilRecordSchema.parse({
    ...row,
    is_active: Boolean(row.is_active),
    metadata_json: JSON.parse(row.metadata_json || "{}"),
  });
}

function toPage(row: SoilPageRow) {
  return SoilPageSchema.parse(row);
}

function toChunk(row: SoilChunkRow) {
  return SoilChunkSchema.parse({
    ...row,
    heading_path_json: JSON.parse(row.heading_path_json || "[]"),
  });
}

function isSqliteDatabase(filePath: string): Promise<boolean> {
  return (async () => {
    let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
    try {
      handle = await fsp.open(filePath, "r");
      const buffer = Buffer.alloc(16);
      const result = await handle.read(buffer, 0, buffer.length, 0);
      return result.bytesRead === buffer.length && buffer.toString("utf-8") === "SQLite format 3\0";
    } catch {
      return false;
    } finally {
      await handle?.close();
    }
  })();
}

async function resolveTypedStoreSqlitePath(config: SoilConfig): Promise<string | null> {
  const candidates = Array.from(new Set([config.indexPath, getDefaultSoilSqliteIndexPath(config.rootDir)]));
  for (const candidate of candidates) {
    if (await isSqliteDatabase(candidate)) {
      return candidate;
    }
  }
  return null;
}

function pageTitleFromRecord(record: SoilRenderableRecord | undefined, fallbackPath: string): string {
  return record?.title ?? path.posix.basename(fallbackPath, ".md").replaceAll("-", " ");
}

function inferRouteAndKind(soilId: string): { route: SoilRoute; kind: SoilKind } {
  const firstSegment = soilId.split("/")[0] ?? "memory";
  const allowed = new Set<SoilRoute>([
    "index",
    "status",
    "health",
    "report",
    "schedule",
    "memory",
    "knowledge",
    "decision",
    "identity",
    "goal",
    "task",
    "timeline",
    "operations",
    "inbox",
  ]);
  if (allowed.has(firstSegment as SoilRoute)) {
    return { route: firstSegment as SoilRoute, kind: firstSegment as SoilKind };
  }
  return { route: "memory", kind: "memory" };
}

function pageStatusFromRecordStatus(status: string): SoilStatus {
  switch (status) {
    case "draft":
      return "draft";
    case "candidate":
      return "candidate";
    case "stale":
      return "stale";
    case "superseded":
    case "replaced":
      return "superseded";
    case "archived":
      return "archived";
    case "rejected":
      return "rejected";
    default:
      return "confirmed";
  }
}

function renderFallbackPageBody(record: SoilRenderableRecord, chunks: SoilParsedChunk[]): string {
  const chunkSections =
    chunks.length > 0
      ? chunks.map((chunk) => [
          `### ${chunk.chunk_id}`,
          "",
          `- Kind: ${chunk.chunk_kind}`,
          `- Chunk index: ${chunk.chunk_index}`,
          `- Heading path: ${chunk.heading_path_json.length > 0 ? chunk.heading_path_json.join(" / ") : "[]"}`,
          `- Token count: ${chunk.token_count}`,
          `- Checksum: ${chunk.checksum}`,
          "",
          chunk.chunk_text,
          "",
        ].join("\n"))
      : ["No chunks."];

  return [
    `# ${record.title}`,
    "",
    `- Record key: ${record.record_key}`,
    `- Record type: ${record.record_type}`,
    `- Status: ${record.status}`,
    `- Soil ID: ${record.soil_id}`,
    `- Summary: ${record.summary ?? "none"}`,
    `- Canonical text: ${trimText(record.canonical_text, 360)}`,
    `- Created: ${record.created_at}`,
    `- Updated: ${record.updated_at}`,
    "",
    "## Chunks",
    "",
    ...chunkSections,
    "",
  ].join("\n");
}

function renderGroupedFallbackPageBody(records: SoilParsedRecord[], chunksByRecordId: Map<string, SoilParsedChunk[]>): string {
  const primary = records[0];
  if (!primary) {
    return "# Soil records\n\nNo records.\n";
  }
  if (records.length === 1) {
    return renderFallbackPageBody(primary, chunksByRecordId.get(primary.record_id) ?? []);
  }

  return [
    `# ${primary.title}`,
    "",
    `- Soil ID: ${primary.soil_id}`,
    `- Records: ${records.length}`,
    `- Updated: ${records.map((record) => record.updated_at).sort().at(-1) ?? primary.updated_at}`,
    "",
    "## Records",
    "",
    ...records.map((record) => {
      const chunks = chunksByRecordId.get(record.record_id) ?? [];
      return [
        `### ${record.title}`,
        "",
        `- Record ID: ${record.record_id}`,
        `- Record key: ${record.record_key}`,
        `- Record type: ${record.record_type}`,
        `- Status: ${record.status}`,
        `- Summary: ${record.summary ?? "none"}`,
        `- Canonical text: ${trimText(record.canonical_text, 360)}`,
        "",
        ...chunks.map((chunk) => [
          `#### ${chunk.chunk_id}`,
          "",
          chunk.chunk_text,
          "",
        ].join("\n")),
      ].join("\n");
    }),
    "",
  ].join("\n");
}

function buildFrontmatter(input: {
  soilId: string;
  title: string;
  kind: SoilKind;
  route: SoilRoute;
  status: SoilStatus;
  createdAt: string;
  updatedAt: string;
  generatedAt: string;
  summary?: string;
}): SoilPageFrontmatter {
  return SoilPageFrontmatterSchema.parse({
    ...baseFrontmatter({
      soilId: input.soilId,
      title: input.title,
      kind: input.kind,
      route: input.route,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      generatedAt: input.generatedAt,
      sourceRefs: [],
      sourceTruth: "soil",
      renderedFrom: "soil-display-integration",
      summary: input.summary,
    }),
    status: input.status,
  });
}

async function writeMaterializedPage(filePath: string, frontmatter: SoilPageFrontmatter, body: string): Promise<void> {
  await writeSoilMarkdownFile(filePath, frontmatter, body);
}

export async function prepareSoilDisplaySnapshot(input: SoilDisplaySnapshotInput = {}): Promise<SoilDisplaySnapshotResult> {
  const config = createSoilConfig(input);
  const sqlitePath = await resolveTypedStoreSqlitePath(config);
  if (sqlitePath === null) {
    return {
      rootDir: config.rootDir,
      indexPath: config.indexPath,
      typedPageCount: 0,
      fallbackPageCount: 0,
      materializedPages: [],
    };
  }

  const db = new Database(sqlitePath, { readonly: false, fileMustExist: true });
  try {
    const recordRows = db.prepare(`
      SELECT *
      FROM soil_records
      ORDER BY record_key, version
    `).all() as SoilRecordRow[];
    const records = recordRows.map((row) => toRecord(row));
    const recordsById = new Map(records.map((record) => [record.record_id, record]));
    const activeRecords = records.filter((record) => record.is_active);

    const pageRows = db.prepare(`
      SELECT *
      FROM soil_pages
      ORDER BY relative_path
    `).all() as SoilPageRow[];
    const pages = pageRows.map((row) => toPage(row));
    const pagesBySoilId = new Map(pages.map((page) => [page.soil_id, page]));

    const pageIds = pages.map((page) => page.page_id);
    const memberRows = pageIds.length > 0
      ? db.prepare(`
          SELECT *
          FROM soil_page_members
          WHERE page_id IN (${pageIds.map(() => "?").join(", ")})
          ORDER BY page_id, ordinal
        `).all(...pageIds) as SoilPageMemberRow[]
      : [];
    const membersByPageId = new Map<string, SoilPageMemberRow[]>();
    for (const row of memberRows) {
      const current = membersByPageId.get(row.page_id) ?? [];
      current.push(row);
      membersByPageId.set(row.page_id, current);
    }

    const chunkRows = db.prepare(`
      SELECT *
      FROM soil_chunks
      ORDER BY record_id, chunk_index
    `).all() as SoilChunkRow[];
    const chunksByRecordId = new Map<string, SoilParsedChunk[]>();
    for (const row of chunkRows) {
      const current = chunksByRecordId.get(row.record_id) ?? [];
      current.push(toChunk(row));
      chunksByRecordId.set(row.record_id, current);
    }

    const materializedPages: SoilDisplayMaterializedPage[] = [];

    for (const page of pages) {
      const pageMembers = membersByPageId.get(page.page_id) ?? [];
      const primaryMember = pageMembers[0];
      const primaryRecord = primaryMember ? recordsById.get(primaryMember.record_id) : undefined;
      const generatedAt = page.projected_at;
      const frontmatter = buildFrontmatter({
        soilId: page.soil_id,
        title: pageTitleFromRecord(primaryRecord, page.relative_path),
        kind: page.kind as SoilKind,
        route: page.route as SoilRoute,
        status: page.status as SoilStatus,
        createdAt: primaryRecord?.created_at ?? generatedAt,
        updatedAt: primaryRecord?.updated_at ?? generatedAt,
        generatedAt,
        summary: primaryRecord?.summary ?? undefined,
      });
      const body = page.markdown;
      const checksum = computeSoilChecksum({ frontmatter, body });
      const fileFrontmatter = SoilPageFrontmatterSchema.parse({ ...frontmatter, checksum });
      const filePath = resolveSoilPageFilePath(config.rootDir, page.relative_path);
      await writeMaterializedPage(filePath, fileFrontmatter, body);
      materializedPages.push({
        pageId: page.page_id,
        soilId: page.soil_id,
        relativePath: page.relative_path,
        source: "typed_page",
        recordIds: pageMembers.map((member) => member.record_id),
        filePath,
      });
    }

    const fallbackRecordsBySoilId = new Map<string, SoilParsedRecord[]>();
    for (const record of activeRecords) {
      if (pagesBySoilId.has(record.soil_id)) continue;
      const current = fallbackRecordsBySoilId.get(record.soil_id) ?? [];
      current.push(record);
      fallbackRecordsBySoilId.set(record.soil_id, current);
    }
    const fallbackGroups = [...fallbackRecordsBySoilId.entries()];
    if (fallbackGroups.length > 0) {
      const insertPage = db.prepare(`
        INSERT INTO soil_pages (
          page_id, soil_id, relative_path, route, kind, status, markdown, checksum, projected_at
        ) VALUES (
          @page_id, @soil_id, @relative_path, @route, @kind, @status, @markdown, @checksum, @projected_at
        )
        ON CONFLICT(page_id) DO UPDATE SET
          soil_id = excluded.soil_id,
          relative_path = excluded.relative_path,
          route = excluded.route,
          kind = excluded.kind,
          status = excluded.status,
          markdown = excluded.markdown,
          checksum = excluded.checksum,
          projected_at = excluded.projected_at
      `);
      const deleteMembers = db.prepare("DELETE FROM soil_page_members WHERE page_id = ?");
      const insertMember = db.prepare(`
        INSERT INTO soil_page_members (page_id, record_id, ordinal, role, confidence)
        VALUES (@page_id, @record_id, @ordinal, @role, @confidence)
        ON CONFLICT(page_id, record_id, role) DO UPDATE SET
          ordinal = excluded.ordinal,
          confidence = excluded.confidence
      `);
      for (const [soilId, recordsForPage] of fallbackGroups) {
        const record = recordsForPage[0];
        if (!record) continue;
        const { route, kind } = inferRouteAndKind(record.soil_id);
        const updatedAt = recordsForPage.map((item) => item.updated_at).sort().at(-1) ?? record.updated_at;
        const createdAt = recordsForPage.map((item) => item.created_at).sort().at(0) ?? record.created_at;
        const generatedAt = updatedAt ?? createdAt ?? nowIso(input.clock);
        const body = renderGroupedFallbackPageBody(recordsForPage, chunksByRecordId);
        const frontmatter = buildFrontmatter({
          soilId,
          title: record.title,
          kind,
          route,
          status: pageStatusFromRecordStatus(record.status),
          createdAt: createdAt ?? generatedAt,
          updatedAt: updatedAt ?? generatedAt,
          generatedAt,
          summary: record.summary ?? trimText(record.canonical_text, 180),
        });
        const checksum = computeSoilChecksum({ frontmatter, body });
        const fileFrontmatter = SoilPageFrontmatterSchema.parse({ ...frontmatter, checksum });
        const relativePath = normalizeSoilRelativePath(soilId);
        const pageId = `display:${record.record_id}`;
        insertPage.run({
          page_id: pageId,
          soil_id: soilId,
          relative_path: relativePath,
          route,
          kind,
          status: pageStatusFromRecordStatus(record.status),
          markdown: body,
          checksum,
          projected_at: generatedAt,
        });
        deleteMembers.run(pageId);
        recordsForPage.forEach((memberRecord, ordinal) => {
          insertMember.run({
            page_id: pageId,
            record_id: memberRecord.record_id,
            ordinal,
            role: ordinal === 0 ? "primary" : "supporting",
            confidence: memberRecord.confidence,
          });
        });
        const filePath = resolveSoilPageFilePath(config.rootDir, soilId);
        await writeMaterializedPage(filePath, fileFrontmatter, body);
        materializedPages.push({
          pageId,
          soilId,
          relativePath,
          source: "fallback_record",
          recordIds: recordsForPage.map((item) => item.record_id),
          filePath,
        });
      }
    }

    return {
      rootDir: config.rootDir,
      indexPath: sqlitePath,
      typedPageCount: pages.length,
      fallbackPageCount: fallbackGroups.length,
      materializedPages,
    };
  } finally {
    db.close();
  }
}
