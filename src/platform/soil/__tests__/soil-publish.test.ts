import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { writeJsonFileAtomic } from "../../../base/utils/json-io.js";
import { SqliteSoilRepository } from "../sqlite-repository.js";
import {
  collectSoilSnapshotFiles,
  filterAppleNotesSnapshotFiles,
  loadSoilPublishState,
  publishSoilSnapshots,
  type NotionPublishClient,
} from "../publish/index.js";

async function writeSoilFixture(rootDir: string): Promise<void> {
  await fsp.mkdir(path.join(rootDir, "schedule"), { recursive: true });
  await fsp.mkdir(path.join(rootDir, "knowledge"), { recursive: true });
  await fsp.mkdir(path.join(rootDir, ".index"), { recursive: true });
  await fsp.mkdir(path.join(rootDir, ".publish"), { recursive: true });
  await fsp.writeFile(path.join(rootDir, "status.md"), "# Status\n", "utf-8");
  await fsp.writeFile(path.join(rootDir, "schedule", "active.md"), "# Active\n", "utf-8");
  await fsp.writeFile(path.join(rootDir, "knowledge", "index.md"), "# Knowledge\n", "utf-8");
  await fsp.writeFile(path.join(rootDir, ".index", "hidden.md"), "# Hidden\n", "utf-8");
  await fsp.writeFile(path.join(rootDir, ".publish", "hidden.md"), "# Hidden\n", "utf-8");
}

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

describe("Soil snapshot publish", () => {
  it("collects the Soil markdown tree while excluding hidden directories", async () => {
    const rootDir = makeTempDir("soil-publish-collect-");
    try {
      await writeSoilFixture(rootDir);
      const files = await collectSoilSnapshotFiles(rootDir);
      expect(files.map((file) => file.relativePath)).toEqual([
        "knowledge/index.md",
        "schedule/active.md",
        "status.md",
      ]);
    } finally {
      cleanupTempDir(rootDir);
    }
  });

  it("publishes Notion snapshots for the full visible Soil tree and skips unchanged hashes", async () => {
    const rootDir = makeTempDir("soil-publish-notion-");
    try {
      await writeSoilFixture(rootDir);
      await writeJsonFileAtomic(path.join(rootDir, "publish.json"), {
        notion: { enabled: true, token: "secret", parentPageId: "parent", titlePrefix: "Soil" },
      });

      const created: string[] = [];
      const replaced: string[] = [];
      const client: NotionPublishClient = {
        createPage: vi.fn(async ({ title }) => {
          created.push(title);
          return `page-${created.length}`;
        }),
        replacePageMarkdown: vi.fn(async ({ pageId }) => {
          replaced.push(pageId);
        }),
      };

      const first = await publishSoilSnapshots({ rootDir, provider: "notion", notionClient: client });
      expect(first.providers[0]?.pages.map((page) => page.relativePath).sort()).toEqual([
        "knowledge/index.md",
        "schedule/active.md",
        "status.md",
      ]);
      expect(first.providers[0]?.pages.every((page) => page.status === "published")).toBe(true);
      expect(created).toHaveLength(3);
      expect(replaced).toHaveLength(3);

      const second = await publishSoilSnapshots({ rootDir, provider: "notion", notionClient: client });
      expect(second.providers[0]?.pages.every((page) => page.status === "skipped")).toBe(true);
      expect(created).toHaveLength(3);
      expect(replaced).toHaveLength(3);

      const state = await loadSoilPublishState(rootDir);
      expect(Object.keys(state.notion.pages).sort()).toEqual([
        "knowledge/index.md",
        "schedule/active.md",
        "status.md",
      ]);
    } finally {
      cleanupTempDir(rootDir);
    }
  });

  it("includes typed-store-only memory pages after display preparation", async () => {
    const rootDir = makeTempDir("soil-publish-display-");
    try {
      await writeSoilFixture(rootDir);
      const indexPath = await seedTypedMemoryFixture(rootDir);
      await writeJsonFileAtomic(path.join(rootDir, "publish.json"), {
        notion: { enabled: true, token: "secret", parentPageId: "parent", titlePrefix: "Soil" },
      });

      const result = await publishSoilSnapshots({
        rootDir,
        indexPath,
        provider: "notion",
        dryRun: true,
      });

      expect(result.providers[0]?.pages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          provider: "notion",
          relativePath: "memory/preferences/rec-memory.md",
          status: "dry_run",
        }),
      ]));
      await expect(fsp.access(path.join(rootDir, "memory", "preferences", "rec-memory.md"))).resolves.toBeUndefined();
    } finally {
      cleanupTempDir(rootDir);
    }
  });

  it("archives Notion pages that no longer exist in the Soil tree", async () => {
    const rootDir = makeTempDir("soil-publish-notion-stale-");
    try {
      await writeSoilFixture(rootDir);
      await writeJsonFileAtomic(path.join(rootDir, "publish.json"), {
        notion: { enabled: true, token: "secret", parentPageId: "parent", titlePrefix: "Soil" },
      });
      await writeJsonFileAtomic(path.join(rootDir, ".publish", "state.json"), {
        version: "soil-publish-state-v1",
        notion: {
          pages: {
            "status.md": {
              notion_page_id: "page-status",
              source_hash: "old-status",
              published_at: "2026-04-11T00:00:00.000Z",
            },
            "old.md": {
              notion_page_id: "page-old",
              source_hash: "old",
              published_at: "2026-04-11T00:00:00.000Z",
            },
          },
        },
        apple_notes: { pages: {} },
      });

      const archived: string[] = [];
      const client: NotionPublishClient = {
        createPage: vi.fn(async () => "page-new"),
        replacePageMarkdown: vi.fn(async () => undefined),
        archivePage: vi.fn(async ({ pageId }) => {
          archived.push(pageId);
        }),
      };

      const result = await publishSoilSnapshots({ rootDir, provider: "notion", notionClient: client });
      expect(result.providers[0]?.pages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          provider: "notion",
          relativePath: "old.md",
          status: "archived",
          destinationId: "page-old",
        }),
      ]));
      expect(archived).toEqual(["page-old"]);
      const state = await loadSoilPublishState(rootDir);
      expect(state.notion.pages["old.md"]).toBeUndefined();
    } finally {
      cleanupTempDir(rootDir);
    }
  });

  it("limits Apple Notes snapshots to status and active schedule pages", async () => {
    const rootDir = makeTempDir("soil-publish-apple-");
    try {
      await writeSoilFixture(rootDir);
      const files = filterAppleNotesSnapshotFiles(await collectSoilSnapshotFiles(rootDir));
      expect(files.map((file) => file.relativePath)).toEqual(["schedule/active.md", "status.md"]);

      await writeJsonFileAtomic(path.join(rootDir, "publish.json"), {
        apple_notes: { enabled: true, shortcutName: "Publish Soil Page", folderName: "PulSeed" },
      });
      const result = await publishSoilSnapshots({
        rootDir,
        provider: "apple_notes",
        dryRun: true,
        appleNotesPlatform: "darwin",
      });
      expect(result.providers[0]?.pages).toEqual(expect.arrayContaining([
        expect.objectContaining({ provider: "apple_notes", relativePath: "status.md", status: "dry_run" }),
        expect.objectContaining({ provider: "apple_notes", relativePath: "schedule/active.md", status: "dry_run" }),
      ]));
      expect(result.providers[0]?.pages).toHaveLength(2);
    } finally {
      cleanupTempDir(rootDir);
    }
  });

  it("runs Apple Notes shortcuts with file input only", async () => {
    const rootDir = makeTempDir("soil-publish-apple-runner-");
    try {
      await writeSoilFixture(rootDir);
      await writeJsonFileAtomic(path.join(rootDir, "publish.json"), {
        apple_notes: { enabled: true, shortcutName: "Publish Soil Page", folderName: "PulSeed" },
      });
      const calls: Array<{ command: string; args: string[] }> = [];
      const result = await publishSoilSnapshots({
        rootDir,
        provider: "apple_notes",
        appleNotesPlatform: "darwin",
        appleNotesRunner: async (command, args) => {
          calls.push({ command, args });
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      });

      expect(result.providers[0]?.pages.every((page) => page.status === "published")).toBe(true);
      expect(calls).toEqual([
        {
          command: "shortcuts",
          args: ["run", "Publish Soil Page", "--input-path", path.join(rootDir, "schedule", "active.md")],
        },
        {
          command: "shortcuts",
          args: ["run", "Publish Soil Page", "--input-path", path.join(rootDir, "status.md")],
        },
      ]);
    } finally {
      cleanupTempDir(rootDir);
    }
  });
});
