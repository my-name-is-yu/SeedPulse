import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SoilCompiler } from "../../../../platform/soil/compiler.js";
import { rebuildSoilIndex } from "../../../../platform/soil/index-store.js";
import { SoilQueryTool } from "../SoilQueryTool.js";
import { cleanupTempDir, makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import type { ToolCallContext } from "../../../types.js";
import type { SoilPageFrontmatter } from "../../../../platform/soil/types.js";

const makeContext = (): ToolCallContext => ({
  cwd: "/tmp",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
});

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
    tool = new SoilQueryTool();
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
