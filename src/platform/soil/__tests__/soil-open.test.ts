import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { SqliteSoilRepository } from "../sqlite-repository.js";
import { buildSoilOpenCommand, openSoil, resolveSoilOpenPath } from "../open.js";

async function seedTypedMemoryFixture(rootDir: string): Promise<string> {
  const indexPath = path.join(rootDir, ".index", "typed-soil.db");
  const repo = await SqliteSoilRepository.create({ rootDir, indexPath });
  try {
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
  } finally {
    repo.close();
  }
  return indexPath;
}

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

  it("materializes typed memory pages before opening Soil targets", async () => {
    const rootDir = makeTempDir("soil-open-display-");
    try {
      const indexPath = await seedTypedMemoryFixture(rootDir);
      const calls: Array<{ command: string; args: string[] }> = [];
      const result = await openSoil(
        { rootDir, indexPath, viewer: "vscode", target: "memory" },
        async (command, args) => {
          calls.push({ command, args });
          return { stdout: "", stderr: "", exitCode: 0 };
        }
      );
      expect(result.exitCode).toBe(0);
      expect(calls).toEqual([{ command: "code", args: [path.join(rootDir, "memory")] }]);
      await expect(fsp.access(path.join(rootDir, "memory", "preferences", "rec-memory.md"))).resolves.toBeUndefined();
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
