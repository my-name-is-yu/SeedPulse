import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import type { ToolCallContext } from "../../../types.js";
import { SoilOpenTool } from "../SoilOpenTool.js";

const makeContext = (): ToolCallContext => ({
  cwd: "/tmp",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
});

describe("SoilOpenTool", () => {
  it("opens Soil through an injected runner", async () => {
    const rootDir = makeTempDir("soil-open-tool-");
    try {
      const calls: Array<{ command: string; args: string[] }> = [];
      const tool = new SoilOpenTool(async (command, args) => {
        calls.push({ command, args });
        return { stdout: "", stderr: "", exitCode: 0 };
      });
      const result = await tool.call({ rootDir, viewer: "vscode", target: "schedule_active" }, makeContext());
      expect(result.success).toBe(true);
      expect(calls).toEqual([{ command: "code", args: [path.join(rootDir, "schedule", "active.md")] }]);
    } finally {
      cleanupTempDir(rootDir);
    }
  });
});
