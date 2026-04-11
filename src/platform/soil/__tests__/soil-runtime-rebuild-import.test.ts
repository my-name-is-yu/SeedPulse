import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { writeJsonFileAtomic } from "../../../base/utils/json-io.js";
import { SoilCompiler } from "../compiler.js";
import { rebuildSoilFromRuntime } from "../runtime-rebuild.js";
import { SoilDoctor } from "../doctor.js";
import {
  loadSoilOverlayQueue,
  scanAndStoreSoilOverlays,
  updateSoilOverlayStatus,
} from "../importer.js";
import { readSoilMarkdownFile } from "../io.js";
import { SoilPageFrontmatterSchema } from "../types.js";

function fixedClock(): Date {
  return new Date("2026-04-11T10:00:00.000Z");
}

describe("Soil runtime rebuild", () => {
  it("rebuilds projections and index from runtime JSON truth", async () => {
    const baseDir = makeTempDir("soil-runtime-rebuild-");
    try {
      await writeJsonFileAtomic(path.join(baseDir, "reports", "goal-1", "report-1.json"), {
        id: "report-1",
        report_type: "weekly_report",
        goal_id: "goal-1",
        title: "Weekly Report",
        content: "Weekly progress and schedule notes.",
        verbosity: "standard",
        generated_at: "2026-04-11T09:00:00.000Z",
        delivered_at: null,
        read: false,
      });
      await writeJsonFileAtomic(path.join(baseDir, "schedules.json"), []);
      await writeJsonFileAtomic(path.join(baseDir, "goals", "goal-1", "domain_knowledge.json"), {
        goal_id: "goal-1",
        domain: "research",
        last_updated: "2026-04-11T09:00:00.000Z",
        entries: [
          {
            entry_id: "k-1",
            question: "What matters?",
            answer: "Readable projections.",
            sources: [{ type: "document", reference: "doc", reliability: "high" }],
            confidence: 0.9,
            acquired_at: "2026-04-11T08:00:00.000Z",
            acquisition_task_id: "task-1",
            superseded_by: null,
            tags: ["soil"],
            embedding_id: null,
          },
        ],
      });
      await writeJsonFileAtomic(path.join(baseDir, "memory", "shared-knowledge", "entries.json"), []);
      await writeJsonFileAtomic(path.join(baseDir, "memory", "agent-memory", "entries.json"), {
        entries: [
          {
            id: "m-1",
            key: "tone",
            value: "Prefer concise answers.",
            tags: ["preference"],
            memory_type: "preference",
            status: "compiled",
            created_at: "2026-04-11T08:00:00.000Z",
            updated_at: "2026-04-11T09:00:00.000Z",
          },
        ],
        last_consolidated_at: "2026-04-11T09:30:00.000Z",
      });
      await writeJsonFileAtomic(path.join(baseDir, "decisions", "goal-1-2026-04-11T09-00-00-000Z.json"), {
        id: "d-1",
        goal_id: "goal-1",
        goal_type: "research",
        strategy_id: "s-1",
        decision: "proceed",
        context: { gap_value: 0.1, stall_count: 0, cycle_count: 1, trust_score: 1 },
        outcome: "pending",
        timestamp: "2026-04-11T09:00:00.000Z",
        what_worked: [],
        what_failed: [],
        suggested_next: [],
      });
      await fsp.writeFile(path.join(baseDir, "SEED.md"), "# Seed\n", "utf-8");
      await fsp.writeFile(path.join(baseDir, "ROOT.md"), "# Root\n", "utf-8");
      await fsp.writeFile(path.join(baseDir, "USER.md"), "# User\n", "utf-8");

      const report = await rebuildSoilFromRuntime({ baseDir, clock: fixedClock });

      expect(report.projected.reports).toBe(1);
      expect(report.projected.domainKnowledge).toBe(1);
      expect(report.projected.agentMemory).toBe(1);
      expect(report.projected.decisions).toBe(1);
      expect(report.index.page_count).toBeGreaterThan(5);

      expect(await readSoilMarkdownFile(path.join(baseDir, "soil", "knowledge", "domain", "goal-1.md"))).not.toBeNull();
      expect(await readSoilMarkdownFile(path.join(baseDir, "soil", "memory", "index.md"))).not.toBeNull();
      expect(await readSoilMarkdownFile(path.join(baseDir, "soil", "decision", "recent.md"))).not.toBeNull();

      const doctor = await SoilDoctor.create({ rootDir: path.join(baseDir, "soil") }).inspect();
      expect(doctor.findings.filter((finding) => finding.code === "missing-index")).toHaveLength(0);
      expect(doctor.findings.filter((finding) => finding.code === "watermark-mismatch")).toHaveLength(0);
      expect(doctor.findings.filter((finding) => finding.code === "index-checksum-mismatch")).toHaveLength(0);
    } finally {
      cleanupTempDir(baseDir);
    }
  });

  it("prunes generated runtime projections whose JSON source was deleted", async () => {
    const baseDir = makeTempDir("soil-runtime-prune-");
    try {
      const reportPath = path.join(baseDir, "reports", "goal-1", "report-1.json");
      const decisionPath = path.join(baseDir, "decisions", "goal-1-2026-04-11T09-00-00-000Z.json");
      await writeJsonFileAtomic(reportPath, {
        id: "report-1",
        report_type: "weekly_report",
        goal_id: "goal-1",
        title: "Weekly Report",
        content: "This report should disappear from the active Soil index.",
        verbosity: "standard",
        generated_at: "2026-04-11T09:00:00.000Z",
        delivered_at: null,
        read: false,
      });
      await writeJsonFileAtomic(decisionPath, {
        id: "d-1",
        goal_id: "goal-1",
        goal_type: "research",
        strategy_id: "s-1",
        decision: "temporary decision",
        context: { gap_value: 0.1, stall_count: 0, cycle_count: 1, trust_score: 1 },
        outcome: "pending",
        timestamp: "2026-04-11T09:00:00.000Z",
        what_worked: [],
        what_failed: [],
        suggested_next: [],
      });

      await rebuildSoilFromRuntime({ baseDir, clock: fixedClock });
      await fsp.unlink(reportPath);
      await fsp.unlink(decisionPath);

      const rebuilt = await rebuildSoilFromRuntime({ baseDir, clock: fixedClock });
      const reportPagePath = path.join(baseDir, "soil", "report", "weekly", "goal-1", "report-1.md");
      const decisionPage = await readSoilMarkdownFile(path.join(baseDir, "soil", "decision", "recent.md"));

      await expect(fsp.access(reportPagePath)).rejects.toThrow();
      expect(rebuilt.pruned.map((item) => item.soilId)).toContain("report/weekly/goal-1/report-1");
      expect(rebuilt.index.pages.map((page) => page.soil_id)).not.toContain("report/weekly/goal-1/report-1");
      expect(decisionPage?.body).toContain("- Records: 0");
      expect(rebuilt.index.pages.find((page) => page.soil_id === "decision/recent")?.summary).toBe("0 records");
    } finally {
      cleanupTempDir(baseDir);
    }
  });
});

describe("Soil importer", () => {
  it("detects manual overlay blocks and records approve/reject decisions", async () => {
    const rootDir = makeTempDir("soil-importer-");
    try {
      await SoilCompiler.create({ rootDir }, { clock: fixedClock }).write({
        frontmatter: SoilPageFrontmatterSchema.parse({
          soil_id: "memory/preferences",
          kind: "memory",
          status: "confirmed",
          title: "Preferences",
          route: "memory",
          source: "compiled",
          version: "1",
          created_at: "2026-04-11T09:00:00.000Z",
          updated_at: "2026-04-11T09:00:00.000Z",
          generated_at: "2026-04-11T09:00:00.000Z",
          source_refs: [],
          generation_watermark: {
            scope: "memory/preferences",
            source_paths: [],
            source_hashes: [],
            generated_at: "2026-04-11T09:00:00.000Z",
            projection_version: "soil-v1",
          },
          stale: false,
          manual_overlay: { enabled: false, status: "candidate" },
          import_status: "none",
          approval_status: "none",
          supersedes: [],
        }),
        body: [
          "# Preferences",
          "",
          "<!-- soil:overlay-begin -->",
          "- Prefer shorter reports.",
          "<!-- soil:overlay-end -->",
          "",
        ].join("\n"),
      });

      const queue = await scanAndStoreSoilOverlays({ rootDir }, { clock: fixedClock });
      expect(queue.overlays).toHaveLength(1);
      expect(queue.overlays[0]?.status).toBe("candidate");

      const approved = await updateSoilOverlayStatus(
        queue.overlays[0]!.overlay_id,
        "approved",
        { rootDir },
        { clock: fixedClock, decisionNote: "Safe preference candidate" }
      );
      expect(approved.overlays[0]?.status).toBe("approved");
      expect(approved.overlays[0]?.decision_note).toBe("Safe preference candidate");

      const loaded = await loadSoilOverlayQueue({ rootDir });
      expect(loaded.overlays[0]?.status).toBe("approved");
    } finally {
      cleanupTempDir(rootDir);
    }
  });
});
