import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import { SoilCompiler } from "../../../../platform/soil/compiler.js";
import { SoilPageFrontmatterSchema } from "../../../../platform/soil/types.js";
import type { ToolCallContext } from "../../../types.js";
import { SoilImportTool } from "../SoilImportTool.js";

const makeContext = (): ToolCallContext => ({
  cwd: "/tmp",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
});

function fixedClock(): Date {
  return new Date("2026-04-11T10:00:00.000Z");
}

describe("SoilImportTool", () => {
  it("has write_local metadata", () => {
    const tool = new SoilImportTool();
    expect(tool.metadata.name).toBe("soil_import");
    expect(tool.metadata.permissionLevel).toBe("write_local");
    expect(tool.metadata.isReadOnly).toBe(false);
  });

  it("scans and approves overlay candidates", async () => {
    const rootDir = makeTempDir("soil-import-tool-");
    try {
      await SoilCompiler.create({ rootDir }, { clock: fixedClock }).write({
        frontmatter: SoilPageFrontmatterSchema.parse({
          soil_id: "note/manual",
          kind: "note",
          status: "draft",
          title: "Manual note",
          route: "inbox",
          source: "manual",
          version: "1",
          created_at: "2026-04-11T09:00:00.000Z",
          updated_at: "2026-04-11T09:00:00.000Z",
          generated_at: "2026-04-11T09:00:00.000Z",
          source_refs: [],
          generation_watermark: {
            scope: "note/manual",
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
          "# Manual note",
          "",
          "<!-- soil:overlay-begin -->",
          "Keep this candidate.",
          "<!-- soil:overlay-end -->",
          "",
        ].join("\n"),
      });

      const tool = new SoilImportTool();
      const scan = await tool.call({ action: "scan", rootDir }, makeContext());
      expect(scan.success).toBe(true);
      const queue = scan.data as { overlays: Array<{ overlay_id: string; status: string }> };
      expect(queue.overlays).toHaveLength(1);
      expect(queue.overlays[0]?.status).toBe("candidate");

      const approve = await tool.call({
        action: "approve",
        rootDir,
        overlayId: queue.overlays[0]!.overlay_id,
      }, makeContext());
      expect(approve.success).toBe(true);
      const approvedQueue = approve.data as { overlays: Array<{ status: string }> };
      expect(approvedQueue.overlays[0]?.status).toBe("approved");
    } finally {
      cleanupTempDir(rootDir);
    }
  });
});
