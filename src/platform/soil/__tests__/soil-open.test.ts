import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { buildSoilOpenCommand, openSoil, resolveSoilOpenPath } from "../open.js";

describe("Soil open bridge", () => {
  it("resolves known Soil targets without creating root active.md", () => {
    const rootDir = makeTempDir("soil-open-");
    try {
      expect(resolveSoilOpenPath({ rootDir, target: "root" }).path).toBe(rootDir);
      expect(resolveSoilOpenPath({ rootDir, target: "status" }).path).toBe(path.join(rootDir, "status.md"));
      expect(resolveSoilOpenPath({ rootDir, target: "schedule_active" }).path).toBe(path.join(rootDir, "schedule", "active.md"));
    } finally {
      cleanupTempDir(rootDir);
    }
  });

  it("builds vscode argv and uses the injected runner", async () => {
    const rootDir = makeTempDir("soil-open-runner-");
    try {
      const command = buildSoilOpenCommand({ rootDir, viewer: "vscode", target: "schedule_active" });
      expect(command.command).toBe("code");
      expect(command.args).toEqual([path.join(rootDir, "schedule", "active.md")]);

      const calls: Array<{ command: string; args: string[] }> = [];
      const result = await openSoil(
        { rootDir, viewer: "vscode", target: "status" },
        async (command, args) => {
          calls.push({ command, args });
          return { stdout: "", stderr: "", exitCode: 0 };
        }
      );
      expect(result.exitCode).toBe(0);
      expect(calls).toEqual([{ command: "code", args: [path.join(rootDir, "status.md")] }]);
    } finally {
      cleanupTempDir(rootDir);
    }
  });

  it("rejects path targets outside the Soil root", () => {
    const rootDir = makeTempDir("soil-open-escape-");
    try {
      expect(() => resolveSoilOpenPath({ rootDir, target: "path", targetPath: path.join(rootDir, "..", "outside.md") }))
        .toThrow(/escapes the root/);
    } finally {
      cleanupTempDir(rootDir);
    }
  });
});
