import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import { writeJsonFileAtomic } from "../../../../base/utils/json-io.js";
import type { NotionPublishClient } from "../../../../platform/soil/index.js";
import type { ToolCallContext } from "../../../types.js";
import { SoilPublishTool } from "../SoilPublishTool.js";

const makeContext = (): ToolCallContext => ({
  cwd: "/tmp",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
});

describe("SoilPublishTool", () => {
  it("runs a dry-run publish without writing to remote clients", async () => {
    const rootDir = makeTempDir("soil-publish-tool-");
    try {
      await fsp.writeFile(path.join(rootDir, "status.md"), "# Status\n", "utf-8");
      await writeJsonFileAtomic(path.join(rootDir, "publish.json"), {
        notion: { enabled: true, token: "secret", parentPageId: "parent" },
      });
      const client: NotionPublishClient = {
        createPage: vi.fn(async () => "page"),
        replacePageMarkdown: vi.fn(async () => undefined),
      };
      const tool = new SoilPublishTool({ notionClient: client });
      const result = await tool.call({ rootDir, provider: "notion", dryRun: true }, makeContext());
      expect(result.success).toBe(true);
      expect(client.createPage).not.toHaveBeenCalled();
      expect(client.replacePageMarkdown).not.toHaveBeenCalled();
      expect(result.summary).toContain("dry run");
    } finally {
      cleanupTempDir(rootDir);
    }
  });
});
