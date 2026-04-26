import * as path from "node:path";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SoilCompiler } from "../../../../platform/soil/compiler.js";
import { rebuildSoilIndex } from "../../../../platform/soil/index-store.js";
import { SqliteSoilRepository } from "../../../../platform/soil/sqlite-repository.js";
import { SoilQueryTool } from "../SoilQueryTool.js";
import { cleanupTempDir, makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import type { ToolCallContext } from "../../../types.js";
import type { IEmbeddingClient } from "../../../../platform/knowledge/embedding-client.js";
import type { SoilPageFrontmatter } from "../../../../platform/soil/types.js";

const makeContext = (): ToolCallContext => ({
  cwd: "/tmp",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
});

class FakeEmbeddingClient implements IEmbeddingClient {
  calls = 0;

  constructor(private readonly vector: number[], private readonly failure: Error | null = null) {}

  async embed(_text: string): Promise<number[]> {
    this.calls += 1;
    if (this.failure) {
      throw this.failure;
    }
    return this.vector;
  }

  async batchEmbed(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

function makeFrontmatter(overrides: Partial<SoilPageFrontmatter> = {}): SoilPageFrontmatter {
  const timestamp = "2026-04-11T00:00:00.000Z";
  return {
    soil_id: "memory/example",
    kind: "memory",
    status: "confirmed",
    title: "Example Page",
    route: "memory",
    source: "runtime",
    version: "1",
    created_at: timestamp,
    updated_at: timestamp,
    generated_at: timestamp,
    source_refs: [],
    generation_watermark: {
      scope: "test",
      generated_at: timestamp,
      projection_version: "1",
      source_paths: [],
      source_hashes: [],
      input_commit_ids: [],
      input_checksums: {},
    },
    stale: false,
    manual_overlay: { enabled: false, status: "candidate" },
    import_status: "none",
    approval_status: "none",
    supersedes: [],
    ...overrides,
  };
}

describe("SoilQueryTool", () => {
  let rootDir: string;
  let tool: SoilQueryTool;

  beforeEach(() => {
    rootDir = makeTempDir("soil-query-tool-");
    tool = new SoilQueryTool({ embeddingClient: null });
  });

  afterEach(() => {
    cleanupTempDir(rootDir);
  });

  async function seedPage(overrides: Partial<SoilPageFrontmatter> = {}, body = "Body text"): Promise<string> {
    const compiler = SoilCompiler.create({ rootDir });
    const result = await compiler.write({
      frontmatter: makeFrontmatter(overrides),
      body,
    });
    return path.join(rootDir, result.relativePath);
  }

  async function seedSqliteSearchRecord(options: { withEmbedding?: boolean } = {}): Promise<void> {
    const repository = await SqliteSoilRepository.create({ rootDir });
    try {
      await repository.applyMutation({
        records: [
          {
            record_id: "rec-sqlite",
            record_key: "fact.sqlite",
            version: 1,
            record_type: "fact",
            soil_id: "knowledge/sqlite",
            title: "SQLite indexed fact",
            summary: "Search target from SQLite",
            canonical_text: "Search target appears only in the SQLite record.",
            goal_id: null,
            task_id: null,
            status: "active",
            confidence: 0.9,
            importance: 0.7,
            source_reliability: 0.8,
            valid_from: null,
            valid_to: null,
            supersedes_record_id: null,
            is_active: true,
            source_type: "test",
            source_id: "sqlite-source",
            metadata_json: {},
            created_at: "2026-04-12T00:00:00.000Z",
            updated_at: "2026-04-12T00:00:00.000Z",
          },
        ],
        chunks: [
          {
            chunk_id: "chunk-sqlite",
            record_id: "rec-sqlite",
            soil_id: "knowledge/sqlite",
            chunk_index: 0,
            chunk_kind: "paragraph",
            heading_path_json: ["Knowledge"],
            chunk_text: "Search target appears only in the SQLite record.",
            token_count: 8,
            checksum: "sqlite-chunk",
            created_at: "2026-04-12T00:00:00.000Z",
          },
        ],
        pages: [
          {
            page_id: "page-sqlite",
            soil_id: "knowledge/sqlite",
            relative_path: "knowledge/sqlite.md",
            route: "knowledge",
            kind: "knowledge",
            status: "confirmed",
            markdown: "# SQLite indexed fact",
            checksum: "sqlite-page",
            projected_at: "2026-04-12T00:00:00.000Z",
          },
        ],
        page_members: [
          {
            page_id: "page-sqlite",
            record_id: "rec-sqlite",
            ordinal: 0,
            role: "primary",
            confidence: 0.9,
          },
        ],
        embeddings: options.withEmbedding
          ? [
              {
                chunk_id: "chunk-sqlite",
                model: "test-model",
                embedding_version: 1,
                encoding: "json",
                embedding: [0, 1, 0],
                embedded_at: "2026-04-12T00:00:00.000Z",
              },
            ]
          : [],
      });
    } finally {
      repository.close();
    }
  }

  describe("metadata", () => {
    it("has read_only metadata", () => {
      expect(tool.metadata.name).toBe("soil_query");
      expect(tool.metadata.permissionLevel).toBe("read_only");
      expect(tool.metadata.isReadOnly).toBe(true);
    });
  });

  describe("checkPermissions", () => {
    it("allows access", async () => {
      const result = await tool.checkPermissions({ query: "example", limit: 10 }, makeContext());
      expect(result.status).toBe("allowed");
    });
  });

  describe("isConcurrencySafe", () => {
    it("returns true", () => {
      expect(tool.isConcurrencySafe()).toBe(true);
    });
  });

  describe("call", () => {
    it("returns direct page data for soil_id lookups", async () => {
      await seedPage({}, "Direct body content with a unique token.");

      const result = await tool.call({ soil_id: "memory/example", rootDir, limit: 10 }, makeContext());

      expect(result.success).toBe(true);
      const data = result.data as { pages: Array<{ body?: string; snippet?: string }>; hits: unknown[]; pageCount: number; hitCount: number };
      expect(data.pageCount).toBe(1);
      expect(data.hitCount).toBe(0);
      expect(data.pages[0]).toMatchObject({
        soilId: "memory/example",
        relativePath: "memory/example.md",
        title: "Example Page",
        kind: "memory",
        route: "memory",
        status: "confirmed",
      });
      expect(data.pages[0].body).toContain("unique token");
      expect(data.pages[0].snippet).toContain("Example Page");
    });

    it("returns direct page data for path lookups", async () => {
      await seedPage({ soil_id: "memory/path-example", title: "Path Page" }, "Path body");

      const result = await tool.call({ path: "memory/path-example.md", rootDir, limit: 10 }, makeContext());

      expect(result.success).toBe(true);
      const data = result.data as { pages: Array<{ body?: string }> };
      expect(data.pages).toHaveLength(1);
      expect(data.pages[0].body).toContain("Path body");
    });

    it("returns search hits without body for query lookups", async () => {
      await seedPage({ soil_id: "memory/query-example", title: "Query Page", summary: "Search target" }, "This body mentions search target.");

      const result = await tool.call({ query: "search target", limit: 10, rootDir }, makeContext());

      expect(result.success).toBe(true);
      const data = result.data as { hits: Array<{ score: number }>; pages: Array<{ body?: string; snippet?: string }> };
      expect(data.hits).toHaveLength(1);
      expect(data.hits[0].score).toBeGreaterThan(0);
      expect(data.pages).toHaveLength(0);
    });

    it("does not create a SQLite index while querying an unindexed root", async () => {
      const result = await tool.call({ query: "missing", limit: 10, rootDir }, makeContext());

      expect(result.success).toBe(true);
      await expect(fsp.access(path.join(rootDir, ".index", "soil.sqlite"))).rejects.toThrow();
    });

    it("ignores unsafe broad home roots from model input", async () => {
      const homeDir = os.homedir();

      const result = await tool.call({ query: "missing", limit: 10, rootDir: homeDir }, makeContext());

      expect(result.success).toBe(true);
      const data = result.data as { rootDir: string; warnings: string[] };
      expect(path.resolve(data.rootDir)).not.toBe(path.resolve(homeDir));
      expect(data.warnings[0]).toContain("Ignored unsafe Soil rootDir");
    });

    it("uses SQLite retrieval when the SQLite soil index has hits", async () => {
      await seedSqliteSearchRecord();

      const result = await tool.call({ query: "search target", limit: 10, rootDir }, makeContext());

      expect(result.success).toBe(true);
      const data = result.data as { retrievalSource: string; hits: Array<{ soilId: string; relativePath: string; title: string }> };
      expect(data.retrievalSource).toBe("sqlite");
      expect(data.hits).toHaveLength(1);
      expect(data.hits[0]).toMatchObject({
        soilId: "knowledge/sqlite",
        relativePath: "knowledge/sqlite.md",
        title: "SQLite indexed fact",
      });
    });

    it("passes query embeddings to SQLite hybrid retrieval when configured", async () => {
      const embeddingClient = new FakeEmbeddingClient([0, 1, 0]);
      tool = new SoilQueryTool({ embeddingClient, embeddingModel: "test-model" });
      await seedSqliteSearchRecord({ withEmbedding: true });

      const result = await tool.call({ query: "search target", limit: 10, rootDir }, makeContext());

      expect(result.success).toBe(true);
      expect(embeddingClient.calls).toBe(1);
      const data = result.data as { retrievalSource: string; hits: Array<{ soilId: string }> };
      expect(data.retrievalSource).toBe("sqlite");
      expect(data.hits[0]?.soilId).toBe("knowledge/sqlite");
    });

    it("keeps SQLite lexical retrieval when query embedding fails", async () => {
      const embeddingClient = new FakeEmbeddingClient([0, 1, 0], new Error("embedding unavailable"));
      tool = new SoilQueryTool({ embeddingClient, embeddingModel: "test-model" });
      await seedSqliteSearchRecord({ withEmbedding: true });

      const result = await tool.call({ query: "search target", limit: 10, rootDir }, makeContext());

      expect(result.success).toBe(true);
      expect(embeddingClient.calls).toBe(1);
      const data = result.data as { retrievalSource: string; hits: Array<{ soilId: string }>; warnings: string[] };
      expect(data.retrievalSource).toBe("sqlite");
      expect(data.hits[0]?.soilId).toBe("knowledge/sqlite");
      expect(data.warnings[0]).toContain("Soil query embedding failed");
    });

    it("uses the matched SQLite page metadata for multi-page records", async () => {
      const repository = await SqliteSoilRepository.create({ rootDir });
      try {
        await repository.applyMutation({
          records: [
            {
              record_id: "rec-multi",
              record_key: "fact.multi",
              version: 1,
              record_type: "fact",
              soil_id: "knowledge/multi",
              title: "Multi page fact",
              summary: "Shared across pages",
              canonical_text: "Shared across pages",
              goal_id: null,
              task_id: null,
              status: "active",
              confidence: 0.9,
              importance: 0.7,
              source_reliability: 0.8,
              valid_from: null,
              valid_to: null,
              supersedes_record_id: null,
              is_active: true,
              source_type: "test",
              source_id: "multi-source",
              metadata_json: {},
              created_at: "2026-04-12T00:00:00.000Z",
              updated_at: "2026-04-12T00:00:00.000Z",
            },
          ],
          chunks: [
            {
              chunk_id: "chunk-multi",
              record_id: "rec-multi",
              soil_id: "knowledge/multi",
              chunk_index: 0,
              chunk_kind: "paragraph",
              heading_path_json: ["Shared"],
              chunk_text: "Shared across pages",
              token_count: 3,
              checksum: "multi-chunk",
              created_at: "2026-04-12T00:00:00.000Z",
            },
          ],
          pages: [
            {
              page_id: "page-multi-alpha",
              soil_id: "knowledge/multi-alpha",
              relative_path: "knowledge/alpha.md",
              route: "knowledge",
              kind: "knowledge",
              status: "confirmed",
              markdown: "# Alpha",
              checksum: "multi-alpha",
              projected_at: "2026-04-12T00:00:00.000Z",
            },
            {
              page_id: "page-multi-zeta",
              soil_id: "knowledge/multi-zeta",
              relative_path: "knowledge/zeta.md",
              route: "memory",
              kind: "memory",
              status: "candidate",
              markdown: "# Zeta",
              checksum: "multi-zeta",
              projected_at: "2026-04-12T00:00:00.000Z",
            },
          ],
          page_members: [
            {
              page_id: "page-multi-zeta",
              record_id: "rec-multi",
              ordinal: 0,
              role: "primary",
              confidence: 0.9,
            },
            {
              page_id: "page-multi-alpha",
              record_id: "rec-multi",
              ordinal: 1,
              role: "supporting",
              confidence: 0.6,
            },
          ],
        });
      } finally {
        repository.close();
      }

      const result = await tool.call({ query: "Shared across pages", limit: 10, rootDir }, makeContext());

      expect(result.success).toBe(true);
      const data = result.data as { retrievalSource: string; hits: Array<{ relativePath: string; kind: string; route: string; status: string }> };
      expect(data.retrievalSource).toBe("sqlite");
      expect(data.hits[0]).toMatchObject({
        relativePath: "knowledge/zeta.md",
        kind: "memory",
        route: "memory",
        status: "candidate",
      });
    });

    it("falls back to manifest scan when the index is stale", async () => {
      const pagePath = await seedPage(
        { soil_id: "memory/stale-index", title: "Old title", summary: "Old summary" },
        "Old body"
      );
      await rebuildSoilIndex({ rootDir });
      await fsp.appendFile(pagePath, "\nFresh manual overlay keyword.\n", "utf-8");

      const result = await tool.call({ query: "fresh manual overlay", limit: 10, rootDir }, makeContext());

      expect(result.success).toBe(true);
      const data = result.data as { hits: Array<{ soilId: string }>; retrievalSource: string; warnings: string[] };
      expect(data.retrievalSource).toBe("manifest");
      expect(data.warnings[0]).toContain("stale");
      expect(data.hits[0]?.soilId).toBe("memory/stale-index");
    });

    it("caps limit to 50 via validation", () => {
      const parsed = tool.inputSchema.safeParse({ query: "a", limit: 51 });
      expect(parsed.success).toBe(false);
    });

    it("rejects missing selector via validation", () => {
      const parsed = tool.inputSchema.safeParse({ rootDir, limit: 10 });
      expect(parsed.success).toBe(false);
    });
  });
});
