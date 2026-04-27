import type Database from "better-sqlite3";
import {
  SoilPageMemberSchema,
  SoilPageSchema,
  SoilRecordSchema,
  type SoilCandidate,
  type SoilEmbedding,
  type SoilPage,
  type SoilPageMember,
  type SoilRecord,
} from "./contracts.js";

export type SqliteDatabase = Database.Database;

export interface SoilRowRecord {
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

export interface SoilRowChunk {
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

export interface SoilRowPage {
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

export interface SoilRowPageMember {
  page_id: string;
  record_id: string;
  ordinal: number;
  role: string;
  confidence: number | null;
}

export interface SoilRowEmbedding {
  chunk_id: string;
  model: string;
  embedding_version: number;
  encoding: string;
  embedding: Buffer;
  embedded_at: string;
}

export function buildSnippet(text: string, query: string): string {
  const haystack = text.trim();
  if (!haystack) return "";
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = haystack.toLowerCase();
  for (const token of tokens) {
    const index = lower.indexOf(token);
    if (index >= 0) {
      const start = Math.max(0, index - 50);
      const end = Math.min(haystack.length, index + token.length + 100);
      return haystack.slice(start, end);
    }
  }
  return haystack.slice(0, 160);
}

export function serializeJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export function parseJsonObject(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function parseJsonArray(input: string): string[] {
  try {
    const parsed = JSON.parse(input) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function parseReindexRecordIds(input: string): string[] {
  try {
    const payload = JSON.parse(input) as unknown;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return [];
    }
    const value = (payload as Record<string, unknown>).record_ids;
    return Array.isArray(value)
      ? value.filter((recordId): recordId is string => typeof recordId === "string" && recordId.length > 0)
      : [];
  } catch {
    return [];
  }
}

export function encodeEmbedding(entry: SoilEmbedding): Buffer {
  if (entry.encoding === "f32le") {
    const floats = entry.embedding instanceof Uint8Array
      ? new Float32Array(entry.embedding.buffer.slice(entry.embedding.byteOffset, entry.embedding.byteOffset + entry.embedding.byteLength))
      : Float32Array.from(entry.embedding);
    return Buffer.from(floats.buffer.slice(floats.byteOffset, floats.byteOffset + floats.byteLength));
  }
  const payload = entry.embedding instanceof Uint8Array
    ? Array.from(entry.embedding.values())
    : entry.embedding;
  return Buffer.from(JSON.stringify(payload), "utf8");
}

export function decodeEmbedding(row: SoilRowEmbedding): number[] {
  if (row.encoding === "f32le") {
    const copy = row.embedding.buffer.slice(
      row.embedding.byteOffset,
      row.embedding.byteOffset + row.embedding.byteLength
    );
    return Array.from(new Float32Array(copy));
  }
  return JSON.parse(row.embedding.toString("utf8")) as number[];
}

export function toRecord(row: SoilRowRecord): SoilRecord {
  return SoilRecordSchema.parse({
    ...row,
    is_active: Boolean(row.is_active),
    metadata_json: parseJsonObject(row.metadata_json),
  });
}

export function toPage(row: SoilRowPage): SoilPage {
  return SoilPageSchema.parse(row);
}

export function toPageMember(row: SoilRowPageMember): SoilPageMember {
  return SoilPageMemberSchema.parse(row);
}

export function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

export function dedupeCandidates(candidates: SoilCandidate[], limit: number): SoilCandidate[] {
  const byChunkId = new Map<string, SoilCandidate>();
  for (const candidate of candidates) {
    const current = byChunkId.get(candidate.chunk_id);
    if (
      !current ||
      candidate.score > current.score ||
      (candidate.score === current.score && current.page_id === null && candidate.page_id !== null)
    ) {
      byChunkId.set(candidate.chunk_id, candidate);
    }
  }
  return [...byChunkId.values()]
    .sort((left, right) => right.score - left.score || left.chunk_id.localeCompare(right.chunk_id))
    .slice(0, limit)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

export function fuseCandidates(lexical: SoilCandidate[], dense: SoilCandidate[], limit: number, rrfK = 60): SoilCandidate[] {
  const byChunkId = new Map<string, SoilCandidate>();
  for (const [lane, weight, candidates] of [
    ["lexical", 1, lexical],
    ["dense", 0.85, dense],
  ] as const) {
    for (const candidate of candidates) {
      const prior = byChunkId.get(candidate.chunk_id);
      const laneScore = weight / (rrfK + candidate.rank);
      const metadata_json = {
        ...(prior?.metadata_json ?? candidate.metadata_json),
        [`${lane}_rank`]: candidate.rank,
        [`${lane}_score`]: candidate.score,
      };
      if (!prior) {
        byChunkId.set(candidate.chunk_id, {
          ...candidate,
          lane: "hybrid",
          score: laneScore,
          metadata_json,
        });
        continue;
      }
      byChunkId.set(candidate.chunk_id, {
        ...prior,
        page_id: prior.page_id ?? candidate.page_id,
        snippet: prior.snippet ?? candidate.snippet,
        score: prior.score + laneScore,
        metadata_json,
      });
    }
  }
  return [...byChunkId.values()]
    .sort((left, right) => right.score - left.score || left.chunk_id.localeCompare(right.chunk_id))
    .slice(0, limit)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}
