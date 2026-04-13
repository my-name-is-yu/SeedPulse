import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { SoilPageFrontmatterSchema } from "../types.js";
import { SoilCompiler } from "../compiler.js";
import { SoilRetriever } from "../retriever.js";
import { SoilDoctor } from "../doctor.js";
import { readSoilMarkdownFile } from "../io.js";
import { SqliteSoilRepository } from "../sqlite-repository.js";

function fixedClock(): Date {
  return new Date("2026-04-11T10:00:00.000Z");
}

function makeBaseFrontmatter(overrides: Record<string, unknown> = {}) {
  return SoilPageFrontmatterSchema.parse({
    soil_id: "report/daily/2026-04-11",
    kind: "report",
    status: "confirmed",
    title: "Daily report",
    route: "report",
    source: "compiled",
    version: "1",
    created_at: "2026-04-11T09:00:00.000Z",
    updated_at: "2026-04-11T09:00:00.000Z",
    generated_at: "2026-04-11T09:00:00.000Z",
    source_refs: [],
    generation_watermark: {
      scope: "report/daily",
      source_paths: [],
      source_hashes: [],
      generated_at: "2026-04-11T09:00:00.000Z",
      projection_version: "soil-v1",
    },
    stale: false,
    manual_overlay: {
      enabled: false,
      status: "candidate",
    },
    import_status: "none",
    approval_status: "none",
    supersedes: [],
    ...overrides,
  });
}

describe("Soil compiler", () => {
  it("writes a markdown page atomically and can be read back", async () => {
    const rootDir = makeTempDir("soil-compiler-");
    try {
      const compiler = SoilCompiler.create({ rootDir }, { clock: fixedClock });
      const frontmatter = makeBaseFrontmatter();
      const result = await compiler.write({
        frontmatter,
        body: "# Daily report\n\n- status: green\n",
      });

      expect(result.filePath).toBe(path.join(rootDir, "report/daily/2026-04-11.md"));
      expect(result.frontmatter.generated_at).toBe("2026-04-11T10:00:00.000Z");
      expect(result.frontmatter.updated_at).toBe("2026-04-11T10:00:00.000Z");
      expect(result.frontmatter.checksum).toMatch(/^sha256:/);

      const loaded = await readSoilMarkdownFile(result.filePath);
      expect(loaded?.frontmatter.soil_id).toBe(frontmatter.soil_id);
      expect(loaded?.body).toContain("status: green");
    } finally {
      cleanupTempDir(rootDir);
    }
  });
});

describe("Soil retriever", () => {
  it("supports direct lookup and lexical query", async () => {
    const rootDir = makeTempDir("soil-retriever-");
    try {
      const compiler = SoilCompiler.create({ rootDir }, { clock: fixedClock });
      await compiler.write({
        frontmatter: makeBaseFrontmatter({
          soil_id: "report/daily/2026-04-11",
          title: "Daily report",
          summary: "Morning brief with launch status.",
        }),
        body: "# Daily report\n\nLaunch status and rollout notes.",
      });
      await compiler.write({
        frontmatter: makeBaseFrontmatter({
          soil_id: "note/launch-plan",
          kind: "note",
          status: "draft",
          title: "Launch plan",
          route: "inbox",
          source: "manual",
          summary: "Plan for rollout and follow-up.",
        }),
        body: "Rollout steps and checklist.",
      });

      const retriever = SoilRetriever.create({ rootDir });
      const byId = await retriever.getBySoilId("report/daily/2026-04-11");
      expect(byId?.frontmatter.title).toBe("Daily report");

      const byPath = await retriever.getByPath("note/launch-plan.md");
      expect(byPath?.frontmatter.soil_id).toBe("note/launch-plan");

      const hits = await retriever.query("launch status rollout", 5);
      expect(hits[0]?.soilId).toBe("report/daily/2026-04-11");
      expect(hits.some((hit) => hit.soilId === "note/launch-plan")).toBe(true);
    } finally {
      cleanupTempDir(rootDir);
    }
  });
});

describe("Soil doctor", () => {
  it("reports invalid frontmatter, duplicate ids, stale checksums, and missing sources", async () => {
    const rootDir = makeTempDir("soil-doctor-");
    try {
      const compiler = SoilCompiler.create({ rootDir }, { clock: fixedClock });
      const sourceFile = path.join(rootDir, "sources", "daily.json");
      await fsp.mkdir(path.dirname(sourceFile), { recursive: true });
      await fsp.writeFile(sourceFile, "hello world", "utf-8");

      const sharedFrontmatter = makeBaseFrontmatter({
        soil_id: "report/daily/duplicate",
        summary: "A report that will become stale.",
        source_refs: [
          {
            source_type: "runtime_json",
            source_path: sourceFile,
            source_hash: "sha256:000000",
            fetched_at: "2026-04-11T09:00:00.000Z",
          },
          {
            source_type: "runtime_json",
            source_path: path.join(rootDir, "sources", "missing.json"),
            fetched_at: "2026-04-11T09:00:00.000Z",
          },
        ],
        generation_watermark: {
          scope: "report/daily",
          source_path: sourceFile,
          source_paths: [sourceFile],
          source_hash: "sha256:000000",
          source_hashes: ["sha256:000000"],
          generated_at: "2026-04-11T09:00:00.000Z",
          projection_version: "soil-v1",
          input_checksums: {
            [sourceFile]: "sha256:000000",
          },
        },
      });

      const result = await compiler.write({
        frontmatter: sharedFrontmatter,
        body: "stale body",
      });
      await fsp.appendFile(result.filePath, "\nchanged after write\n", "utf-8");

      const duplicatePath = path.join(rootDir, "report", "daily", "duplicate-copy.md");
      await fsp.mkdir(path.dirname(duplicatePath), { recursive: true });
      await fsp.writeFile(
        duplicatePath,
        [
          "---",
          "soil_id: report/daily/duplicate",
          "kind: report",
          "status: confirmed",
          "title: Duplicate report",
          "route: report",
          "source: manual",
          "version: \"1\"",
          "created_at: 2026-04-11T09:00:00.000Z",
          "updated_at: 2026-04-11T09:00:00.000Z",
          "generated_at: 2026-04-11T09:00:00.000Z",
          "source_refs: []",
          "generation_watermark:",
          "  scope: report/daily",
          "  source_paths: []",
          "  source_hashes: []",
          "  generated_at: 2026-04-11T09:00:00.000Z",
          "  projection_version: soil-v1",
          "stale: false",
          "manual_overlay:",
          "  enabled: false",
          "  status: candidate",
          "import_status: none",
          "approval_status: none",
          "supersedes: []",
          "---",
          "duplicate body",
        ].join("\n"),
        "utf-8"
      );

      const invalidPath = path.join(rootDir, "note", "invalid.md");
      await fsp.mkdir(path.dirname(invalidPath), { recursive: true });
      await fsp.writeFile(
        invalidPath,
        [
          "---",
          "soil_id: note/invalid",
          "kind: note",
          "title: invalid",
          "route: inbox",
          "---",
          "body",
        ].join("\n"),
        "utf-8"
      );

      const doctor = SoilDoctor.create({ rootDir });
      const report = await doctor.inspect();

      expect(report.totalPages).toBe(3);
      expect(report.findings.some((finding) => finding.code === "invalid-frontmatter")).toBe(true);
      expect(report.findings.some((finding) => finding.code === "duplicate-soil-id")).toBe(true);
      expect(report.findings.some((finding) => finding.code === "checksum-mismatch")).toBe(true);
      expect(report.findings.some((finding) => finding.code === "watermark-mismatch")).toBe(true);
      expect(report.findings.some((finding) => finding.code === "missing-source-path")).toBe(true);

      expect(result.frontmatter.checksum).not.toBeUndefined();
    } finally {
      cleanupTempDir(rootDir);
    }
  });

  it("warns when typed Soil records have not been projected to publishable pages", async () => {
    const rootDir = makeTempDir("soil-doctor-typed-gap-");
    const indexPath = path.join(rootDir, ".index", "custom-soil-store.db");
    let repo: SqliteSoilRepository | null = null;
    try {
      repo = await SqliteSoilRepository.create({ rootDir, indexPath });
      await repo.applyMutation({
        records: [{
          record_id: "rec-memory",
          record_key: "memory.preference",
          version: 1,
          record_type: "preference",
          soil_id: "memory/preferences/rec-memory",
          title: "Preferred editor",
          summary: "Use Obsidian as the memory viewer.",
          canonical_text: "Use Obsidian as the memory viewer.",
          goal_id: null,
          task_id: null,
          status: "active",
          confidence: 0.9,
          importance: 0.7,
          source_reliability: null,
          valid_from: null,
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "knowledge",
          source_id: "memory-preference",
          metadata_json: {},
          created_at: "2026-04-11T09:00:00.000Z",
          updated_at: "2026-04-11T09:00:00.000Z",
        }],
        chunks: [{
          chunk_id: "chunk-memory",
          record_id: "rec-memory",
          soil_id: "memory/preferences/rec-memory",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "Use Obsidian as the memory viewer.",
          token_count: 7,
          checksum: "memory",
          created_at: "2026-04-11T09:00:00.000Z",
        }],
      });
      repo.close();
      repo = null;

      const report = await SoilDoctor.create({ rootDir, indexPath }).inspect();
      expect(report.findings.some((finding) => finding.code === "typed-store-projection-gap")).toBe(true);
    } finally {
      repo?.close();
      cleanupTempDir(rootDir);
    }
  });
});
