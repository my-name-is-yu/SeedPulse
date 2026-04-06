import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { KnowledgeManager } from "../knowledge-manager.js";
import { StateManager } from "../../../base/state/state-manager.js";
import type { IEmbeddingClient } from "../embedding-client.js";
import { cosineSimilarity } from "../embedding-client.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import type { AgentMemoryEntry } from "../types/agent-memory.js";

// ─── Helpers ───

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir();
});

afterEach(() => {
  cleanupTempDir(tmpDir);
});

function makeKM(embeddingClient?: IEmbeddingClient): KnowledgeManager {
  const sm = new StateManager(tmpDir);
  const llm = createMockLLMClient([]);
  return new KnowledgeManager(sm, llm, undefined, embeddingClient);
}

function makeEntry(overrides: Partial<AgentMemoryEntry> = {}): AgentMemoryEntry {
  return {
    id: `mem-${Math.random().toString(36).slice(2)}`,
    key: "test.key",
    value: "test value",
    tags: [],
    category: "general",
    memory_type: "fact",
    status: "raw",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

async function seedMemory(km: KnowledgeManager, entries: AgentMemoryEntry[]): Promise<void> {
  for (const e of entries) {
    await km.saveAgentMemory({
      key: e.key,
      value: e.value,
      tags: e.tags,
      category: e.category,
      memory_type: e.memory_type,
    });
  }
}

// ─── Tests ───

describe("recallAgentMemory — semantic mode", () => {
  it("returns semantically similar entries when embeddingClient available and semantic=true", async () => {
    // query vec: [1, 0, 0]
    // batchEmbed returns: entry0=[0.9,0.1,0] (similar), entry1=[0,1,0] (not similar), entry2=[0.8,0.2,0] (similar)
    const mockEmbeddingClient: IEmbeddingClient = {
      embed: vi.fn().mockResolvedValue([1, 0, 0]),
      batchEmbed: vi.fn().mockResolvedValue([[0.9, 0.1, 0], [0, 1, 0], [0.8, 0.2, 0]]),
      cosineSimilarity: vi.fn(),
    };

    const km = makeKM(mockEmbeddingClient);
    const entries = [
      makeEntry({ key: "entry.0", value: "alpha" }),
      makeEntry({ key: "entry.1", value: "beta" }),
      makeEntry({ key: "entry.2", value: "gamma" }),
    ];
    await seedMemory(km, entries);

    const results = await km.recallAgentMemory("test query", { semantic: true });

    // Both entry0 and entry2 are above 0.3 threshold
    // entry1 has cosine similarity of 0 (orthogonal) — filtered out
    const queryVec = [1, 0, 0];
    const score0 = cosineSimilarity(queryVec, [0.9, 0.1, 0]);
    const score2 = cosineSimilarity(queryVec, [0.8, 0.2, 0]);
    expect(score0).toBeGreaterThan(0.3);
    expect(score2).toBeGreaterThan(0.3);
    expect(cosineSimilarity(queryVec, [0, 1, 0])).toBeLessThan(0.3);

    expect(results).toHaveLength(2);
    // Results should be sorted by similarity descending (score0 > score2)
    expect(results[0]!.key).toBe("entry.0");
    expect(results[1]!.key).toBe("entry.2");
  });

  it("falls back to keyword search when embeddingClient is undefined and semantic=true", async () => {
    const km = makeKM(undefined); // no embedding client
    const entries = [
      makeEntry({ key: "typescript.preference", value: "TypeScript is preferred" }),
      makeEntry({ key: "python.info", value: "Python is also used" }),
    ];
    await seedMemory(km, entries);

    const results = await km.recallAgentMemory("TypeScript", { semantic: true });

    // Falls back to keyword search — only the TypeScript entry matches
    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe("typescript.preference");
  });

  it("respects category filter before semantic ranking", async () => {
    const mockEmbeddingClient: IEmbeddingClient = {
      embed: vi.fn().mockResolvedValue([1, 0, 0]),
      batchEmbed: vi.fn().mockImplementation((texts: string[]) => {
        // Return similar vectors for all entries — category filter must reduce candidates
        return Promise.resolve(texts.map(() => [0.9, 0.1, 0]));
      }),
      cosineSimilarity: vi.fn(),
    };

    const km = makeKM(mockEmbeddingClient);
    const entries = [
      makeEntry({ key: "proj.setting", value: "project config", category: "project" }),
      makeEntry({ key: "user.lang", value: "user language", category: "user" }),
    ];
    await seedMemory(km, entries);

    const results = await km.recallAgentMemory("config", {
      semantic: true,
      category: "project",
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.category).toBe("project");
    // batchEmbed should have been called with only 1 text (category filtered to 1 entry)
    const batchEmbedCall = vi.mocked(mockEmbeddingClient.batchEmbed).mock.calls[0]!;
    expect(batchEmbedCall[0]).toHaveLength(1);
  });

  it("respects memory_type filter before semantic ranking", async () => {
    const mockEmbeddingClient: IEmbeddingClient = {
      embed: vi.fn().mockResolvedValue([1, 0, 0]),
      batchEmbed: vi.fn().mockImplementation((texts: string[]) => {
        return Promise.resolve(texts.map(() => [0.9, 0.1, 0]));
      }),
      cosineSimilarity: vi.fn(),
    };

    const km = makeKM(mockEmbeddingClient);
    const entries = [
      makeEntry({ key: "how.to.test", value: "run vitest", memory_type: "procedure" }),
      makeEntry({ key: "lang.fact", value: "TypeScript is typed", memory_type: "fact" }),
    ];
    await seedMemory(km, entries);

    const results = await km.recallAgentMemory("testing", {
      semantic: true,
      memory_type: "procedure",
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.memory_type).toBe("procedure");
  });

  it("filters out entries below 0.3 similarity threshold", async () => {
    // All candidate vecs will be orthogonal to query — similarity = 0
    const mockEmbeddingClient: IEmbeddingClient = {
      embed: vi.fn().mockResolvedValue([1, 0, 0]),
      batchEmbed: vi.fn().mockResolvedValue([[0, 1, 0], [0, 0, 1]]),
      cosineSimilarity: vi.fn(),
    };

    const km = makeKM(mockEmbeddingClient);
    const entries = [
      makeEntry({ key: "entry.a", value: "aaa" }),
      makeEntry({ key: "entry.b", value: "bbb" }),
    ];
    await seedMemory(km, entries);

    const results = await km.recallAgentMemory("something", { semantic: true });

    expect(results).toHaveLength(0);
  });

  it("respects limit parameter", async () => {
    // All 3 entries are above threshold
    const mockEmbeddingClient: IEmbeddingClient = {
      embed: vi.fn().mockResolvedValue([1, 0, 0]),
      batchEmbed: vi.fn().mockResolvedValue([
        [0.99, 0.01, 0],
        [0.95, 0.05, 0],
        [0.90, 0.10, 0],
      ]),
      cosineSimilarity: vi.fn(),
    };

    const km = makeKM(mockEmbeddingClient);
    const entries = [
      makeEntry({ key: "e1", value: "one" }),
      makeEntry({ key: "e2", value: "two" }),
      makeEntry({ key: "e3", value: "three" }),
    ];
    await seedMemory(km, entries);

    const results = await km.recallAgentMemory("query", { semantic: true, limit: 2 });

    expect(results).toHaveLength(2);
  });

  it("works with default keyword mode unchanged (no semantic flag)", async () => {
    const mockEmbeddingClient: IEmbeddingClient = {
      embed: vi.fn(),
      batchEmbed: vi.fn(),
      cosineSimilarity: vi.fn(),
    };

    const km = makeKM(mockEmbeddingClient);
    const entries = [
      makeEntry({ key: "typescript.version", value: "TypeScript 5.3" }),
      makeEntry({ key: "node.version", value: "Node.js 20" }),
    ];
    await seedMemory(km, entries);

    // Default keyword mode — should NOT call embeddingClient
    const results = await km.recallAgentMemory("TypeScript");

    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe("typescript.version");
    expect(mockEmbeddingClient.embed).not.toHaveBeenCalled();
    expect(mockEmbeddingClient.batchEmbed).not.toHaveBeenCalled();
  });

  it("includes entry with summary in text sent to batchEmbed", async () => {
    const mockEmbeddingClient: IEmbeddingClient = {
      embed: vi.fn().mockResolvedValue([1, 0, 0]),
      batchEmbed: vi.fn().mockResolvedValue([[0.9, 0.1, 0]]),
      cosineSimilarity: vi.fn(),
    };

    const km = makeKM(mockEmbeddingClient);
    // Save entry first, then patch the stored JSON to add summary
    await km.saveAgentMemory({ key: "my.key", value: "my value" });
    const storePath = path.join(tmpDir, "memory", "agent-memory", "entries.json");
    const stored = JSON.parse(fs.readFileSync(storePath, "utf8")) as { entries: AgentMemoryEntry[] };
    stored.entries[0] = { ...stored.entries[0]!, summary: "my summary" };
    fs.writeFileSync(storePath, JSON.stringify(stored));

    await km.recallAgentMemory("query", { semantic: true });

    const batchEmbedTexts = vi.mocked(mockEmbeddingClient.batchEmbed).mock.calls[0]![0];
    expect(batchEmbedTexts[0]).toBe("my.key: my value (my summary)");
  });
});
