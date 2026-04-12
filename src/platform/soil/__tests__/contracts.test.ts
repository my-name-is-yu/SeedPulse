import { describe, expect, it } from "vitest";
import { SOIL_QUERY_BUDGETS, SOIL_SCHEMA_SQL } from "../ddl.js";
import {
  SoilMutationSchema,
  SoilPageSchema,
  SoilRecordSchema,
  SoilSearchRequestSchema,
} from "../contracts.js";

describe("soil contracts", () => {
  it("defines the core sqlite tables and fts index", () => {
    expect(SOIL_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS soil_records");
    expect(SOIL_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS soil_chunks");
    expect(SOIL_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS soil_pages");
    expect(SOIL_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS soil_page_members");
    expect(SOIL_SCHEMA_SQL).toContain("CREATE VIRTUAL TABLE IF NOT EXISTS soil_chunk_fts");
  });

  it("keeps the agreed query budgets", () => {
    expect(SOIL_QUERY_BUDGETS.lexicalTopK).toBe(50);
    expect(SOIL_QUERY_BUDGETS.denseTopK).toBe(50);
    expect(SOIL_QUERY_BUDGETS.rerankTopK).toBe(20);
  });

  it("parses a record with versioning fields", () => {
    const parsed = SoilRecordSchema.parse({
      record_id: "rec-1",
      record_key: "user.preference.theme",
      version: 2,
      record_type: "preference",
      soil_id: "identity/preferences",
      title: "Theme preference",
      summary: "User prefers a dark theme.",
      canonical_text: "The user prefers a dark theme in tools and dashboards.",
      goal_id: null,
      task_id: null,
      status: "active",
      confidence: 0.9,
      importance: 0.7,
      source_reliability: 0.8,
      valid_from: "2026-04-12T00:00:00.000Z",
      valid_to: null,
      supersedes_record_id: "rec-0",
      is_active: true,
      source_type: "agent_memory",
      source_id: "mem-123",
      metadata_json: { tags: ["preference"] },
      created_at: "2026-04-12T00:00:00.000Z",
      updated_at: "2026-04-12T00:00:00.000Z",
    });
    expect(parsed.version).toBe(2);
    expect(parsed.supersedes_record_id).toBe("rec-0");
  });

  it("parses a page without embedding truth into projection metadata", () => {
    const parsed = SoilPageSchema.parse({
      page_id: "page-1",
      soil_id: "identity/preferences",
      relative_path: "identity/preferences.md",
      route: "identity",
      kind: "identity",
      status: "confirmed",
      markdown: "# Preferences",
      checksum: "abc123",
      projected_at: "2026-04-12T00:00:00.000Z",
    });
    expect(parsed.route).toBe("identity");
    expect(parsed.kind).toBe("identity");
  });

  it("defaults search and mutation contracts sanely", () => {
    const search = SoilSearchRequestSchema.parse({ query: "dark theme" });
    expect(search.record_filter.active_only).toBe(true);
    expect(search.page_filter).toEqual({});
    expect(search.rerank_top_k).toBe(20);
    expect(search.dense_candidate_record_ids).toBeUndefined();
    expect(search.query_embedding_model).toBeUndefined();

    const mutation = SoilMutationSchema.parse({});
    expect(mutation.records).toEqual([]);
    expect(mutation.pages).toEqual([]);
    expect(mutation.tombstones).toEqual([]);
  });
});
