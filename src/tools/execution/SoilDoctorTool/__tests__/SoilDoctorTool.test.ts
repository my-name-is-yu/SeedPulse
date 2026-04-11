import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SoilCompiler } from "../../../../platform/soil/compiler.js";
import { rebuildSoilIndex } from "../../../../platform/soil/index-store.js";
import { SoilDoctorTool } from "../SoilDoctorTool.js";
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
    soil_id: "health/example",
    kind: "health",
    status: "confirmed",
    title: "Health Page",
    route: "health",
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

describe("SoilDoctorTool", () => {
  let rootDir: string;
  let tool: SoilDoctorTool;

  beforeEach(() => {
    rootDir = makeTempDir("soil-doctor-tool-");
    tool = new SoilDoctorTool();
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
      expect(tool.metadata.name).toBe("soil_doctor");
      expect(tool.metadata.permissionLevel).toBe("read_only");
      expect(tool.metadata.isReadOnly).toBe(true);
    });
  });

  describe("checkPermissions", () => {
    it("allows access", async () => {
      const result = await tool.checkPermissions({}, makeContext());
      expect(result.status).toBe("allowed");
    });
  });

  describe("isConcurrencySafe", () => {
    it("returns true", () => {
      expect(tool.isConcurrencySafe()).toBe(true);
    });
  });

  describe("call", () => {
    it("returns an empty report for a clean soil root", async () => {
      await seedPage();
      await rebuildSoilIndex({ rootDir });

      const result = await tool.call({ rootDir }, makeContext());

      expect(result.success).toBe(true);
      const data = result.data as { report: { findingCount: number; errorCount: number; warnCount: number; totalPages: number }; findings: unknown[] };
      expect(data.report.totalPages).toBe(1);
      expect(data.report.findingCount).toBe(0);
      expect(data.report.errorCount).toBe(0);
      expect(data.report.warnCount).toBe(0);
      expect(data.findings).toHaveLength(0);
    });

    it("reports invalid frontmatter and checksum drift", async () => {
      const compiler = SoilCompiler.create({ rootDir });
      const goodPage = await compiler.write({
        frontmatter: makeFrontmatter({ soil_id: "health/good", title: "Good" }),
        body: "good body",
      });
      const pagePath = path.join(rootDir, goodPage.relativePath);
      const content = await fs.readFile(pagePath, "utf-8");
      await fs.writeFile(pagePath, content.replace("good body", "bad body"), "utf-8");
      await fs.writeFile(path.join(rootDir, "broken.md"), "---\nsoil_id: []\n---\nbody\n", "utf-8");

      const result = await tool.call({ rootDir }, makeContext());

      expect(result.success).toBe(true);
      const data = result.data as { report: { findingCount: number; errorCount: number; warnCount: number }; findings: Array<{ code: string }> };
      expect(data.report.findingCount).toBeGreaterThan(0);
      expect(data.findings.some((finding) => finding.code === "checksum-mismatch")).toBe(true);
      expect(data.findings.some((finding) => finding.code === "invalid-frontmatter")).toBe(true);
    });
  });
});
