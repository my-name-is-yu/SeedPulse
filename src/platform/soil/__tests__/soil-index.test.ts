import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { SoilCompiler } from "../compiler.js";
import { SoilDoctor } from "../doctor.js";
import {
  loadSoilIndexSnapshot,
  querySoilIndexSnapshot,
  rebuildSoilIndex,
  SOIL_INDEX_STORAGE_FORMAT,
} from "../index-store.js";
import { SoilPageFrontmatterSchema } from "../types.js";

function fixedClock(): Date {
  return new Date("2026-04-11T10:00:00.000Z");
}

function makeFrontmatter(overrides: Record<string, unknown> = {}) {
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

describe("Soil index snapshot", () => {
  it("rebuilds, loads, and queries a file-backed index snapshot", async () => {
    const rootDir = makeTempDir("soil-index-");
    try {
      const compiler = SoilCompiler.create({ rootDir }, { clock: fixedClock });
      await compiler.write({
        frontmatter: makeFrontmatter({
          title: "Daily report",
          summary: "Launch status and rollout notes.",
        }),
        body: [
          "# Daily report",
          "",
          "Launch status is green.",
          "",
          "## Rollout",
          "",
          "Rollout notes with follow-up items.",
          "",
        ].join("\n"),
      });
      await compiler.write({
        frontmatter: makeFrontmatter({
          soil_id: "note/launch-plan",
          kind: "note",
          status: "draft",
          title: "Launch plan",
          route: "inbox",
          source: "manual",
          summary: "Planning notes for the rollout.",
        }),
        body: [
          "# Launch plan",
          "",
          "Checklist and open questions.",
          "",
        ].join("\n"),
      });

      const snapshot = await rebuildSoilIndex({ rootDir });
      expect(snapshot.storage).toBe(SOIL_INDEX_STORAGE_FORMAT);
      expect(snapshot.page_count).toBe(2);
      expect(snapshot.chunk_count).toBeGreaterThan(0);
      expect(await fsp.access(path.join(rootDir, ".index", "soil.db")).then(() => true)).toBe(true);

      const loaded = await loadSoilIndexSnapshot({ rootDir });
      expect(loaded?.storage).toBe(SOIL_INDEX_STORAGE_FORMAT);
      expect(loaded?.page_count).toBe(2);
      expect(loaded?.source_manifest_checksum).toBe(snapshot.source_manifest_checksum);

      const hits = await querySoilIndexSnapshot("launch status rollout", 5, { rootDir });
      expect(hits[0]?.soil_id).toBe("report/daily/2026-04-11");
      expect(hits[0]?.snippet).toContain("Launch status is green.");
      expect(hits.some((hit) => hit.soil_id === "note/launch-plan")).toBe(true);
    } finally {
      cleanupTempDir(rootDir);
    }
  });

  it("detects index drift after the page set changes", async () => {
    const rootDir = makeTempDir("soil-index-drift-");
    try {
      const compiler = SoilCompiler.create({ rootDir }, { clock: fixedClock });
      const firstPage = await compiler.write({
        frontmatter: makeFrontmatter({
          title: "Daily report",
          summary: "Launch status and rollout notes.",
        }),
        body: [
          "# Daily report",
          "",
          "Launch status is green.",
          "",
        ].join("\n"),
      });
      await rebuildSoilIndex({ rootDir });

      await fsp.appendFile(firstPage.filePath, "\nChanged after index rebuild.\n", "utf-8");

      const addedPagePath = path.join(rootDir, "note", "late-note.md");
      await fsp.mkdir(path.dirname(addedPagePath), { recursive: true });
      await fsp.writeFile(
        addedPagePath,
        [
          "---",
          "soil_id: note/late-note",
          "kind: note",
          "status: draft",
          "title: Late note",
          "route: inbox",
          "source: manual",
          "version: \"1\"",
          "created_at: 2026-04-11T09:00:00.000Z",
          "updated_at: 2026-04-11T09:00:00.000Z",
          "generated_at: 2026-04-11T09:00:00.000Z",
          "source_refs: []",
          "generation_watermark:",
          "  scope: note/late-note",
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
          "# Late note",
          "",
          "Added after the index was rebuilt.",
          "",
        ].join("\n"),
        "utf-8"
      );

      const report = await SoilDoctor.create({ rootDir }).inspect();
      expect(report.findings.some((finding) => finding.code === "index-page-count-mismatch")).toBe(true);
      expect(report.findings.some((finding) => finding.code === "index-checksum-mismatch")).toBe(true);
      expect(report.findings.some((finding) => finding.code === "missing-index")).toBe(false);
    } finally {
      cleanupTempDir(rootDir);
    }
  });

  it("reports missing required Soil entry pages", async () => {
    const rootDir = makeTempDir("soil-required-pages-");
    try {
      const report = await SoilDoctor.create({ rootDir }).inspect();
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "missing-required-page",
          relativePath: "index.md",
        }),
        expect.objectContaining({
          code: "missing-required-page",
          relativePath: "schedule/active.md",
        }),
      ]));
    } finally {
      cleanupTempDir(rootDir);
    }
  });
});
