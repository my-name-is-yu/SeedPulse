import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeForeignPluginDirectory, analyzeForeignPluginManifest } from "../foreign-plugins/compatibility.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-foreign-plugin-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

describe("foreign plugin compatibility", () => {
  it("classifies a safe manifest as convertible", async () => {
    const pluginDir = path.join(tmpDir, "convertible");
    await writeJson(path.join(pluginDir, "plugin.json"), {
      name: "convertible",
      version: "1.0.0",
      type: "notifier",
      capabilities: ["notify"],
      description: "safe manifest",
      permissions: {
        network: false,
        file_read: false,
        file_write: false,
        shell: false,
      },
    });

    const report = analyzeForeignPluginDirectory("openclaw", pluginDir);
    expect(report.status).toBe("convertible");
    expect(report.permissions).toEqual({
      network: false,
      file_read: false,
      file_write: false,
      shell: false,
    });
    expect(report.manifest?.name).toBe("convertible");
  });

  it("classifies a manifest with elevated permissions as quarantined", () => {
    const report = analyzeForeignPluginManifest("hermes", {
      name: "riskier",
      version: "1.0.0",
      type: "notifier",
      capabilities: ["notify"],
      description: "needs review",
      permissions: {
        network: true,
        file_read: false,
        file_write: false,
        shell: true,
      },
    });

    expect(report.status).toBe("quarantined");
    expect(report.permissions).toEqual({
      network: true,
      file_read: false,
      file_write: false,
      shell: true,
    });
    expect(report.issues[0]).toContain("network");
    expect(report.manifest?.name).toBe("riskier");
  });

  it("classifies an invalid manifest as incompatible", () => {
    const report = analyzeForeignPluginManifest("openclaw", {
      name: "Bad Name",
      version: "1.0",
      type: "custom",
      capabilities: [],
      description: "",
    });

    expect(report.status).toBe("incompatible");
    expect(report.issues.length).toBeGreaterThan(0);
  });
});
