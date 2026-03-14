import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MockEmbeddingClient } from "../src/embedding-client.js";
import { VectorIndex } from "../src/vector-index.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vector-index-test-"));
}

describe("VectorIndex", () => {
  let tmpDir: string;
  let indexPath: string;
  let client: MockEmbeddingClient;

  beforeEach(() => {
    tmpDir = makeTempDir();
    indexPath = path.join(tmpDir, "index.json");
    client = new MockEmbeddingClient(32);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("add() creates entry and increases size", async () => {
    const idx = new VectorIndex(indexPath, client);
    expect(idx.size).toBe(0);

    const entry = await idx.add("id1", "hello world");
    expect(idx.size).toBe(1);
    expect(entry.id).toBe("id1");
    expect(entry.text).toBe("hello world");
    expect(entry.vector).toHaveLength(32);
  });

  it("add() persists to file (verify JSON on disk)", async () => {
    const idx = new VectorIndex(indexPath, client);
    await idx.add("id1", "persist me", { tag: "test" });

    const raw = fs.readFileSync(indexPath, "utf-8");
    const parsed = JSON.parse(raw) as Array<{ id: string; text: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("id1");
    expect(parsed[0].text).toBe("persist me");
  });

  it("search() returns results sorted by similarity descending", async () => {
    const idx = new VectorIndex(indexPath, client);
    await idx.add("a", "apple fruit");
    await idx.add("b", "banana fruit");
    await idx.add("c", "car vehicle");

    const results = await idx.search("apple fruit");
    expect(results.length).toBeGreaterThan(0);
    // First result should be most similar (the exact match)
    expect(results[0].id).toBe("a");
    // Results must be sorted descending by similarity
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity);
    }
  });

  it("search() respects topK parameter", async () => {
    const idx = new VectorIndex(indexPath, client);
    for (let i = 0; i < 10; i++) {
      await idx.add(`id${i}`, `entry number ${i}`);
    }
    const results = await idx.search("entry number", 3);
    expect(results).toHaveLength(3);
  });

  it("search() respects threshold parameter", async () => {
    const idx = new VectorIndex(indexPath, client);
    await idx.add("a", "completely different text alpha");
    await idx.add("b", "another unrelated topic beta");

    // Use a high threshold to filter out low-similarity results
    const results = await idx.search("completely different text alpha", 10, 0.99);
    // Only exact (or near-exact) matches should pass 0.99 threshold
    expect(results.every((r) => r.similarity >= 0.99)).toBe(true);
  });

  it("search() on empty index returns empty array", async () => {
    const idx = new VectorIndex(indexPath, client);
    const results = await idx.search("anything");
    expect(results).toEqual([]);
  });

  it("searchByVector() works synchronously", async () => {
    const idx = new VectorIndex(indexPath, client);
    await idx.add("id1", "test entry");

    const queryVec = await client.embed("test entry");
    const results = idx.searchByVector(queryVec, 5, 0.0);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("id1");
    expect(results[0].similarity).toBeCloseTo(1.0);
  });

  it("remove() removes entry and decreases size", async () => {
    const idx = new VectorIndex(indexPath, client);
    await idx.add("id1", "to remove");
    await idx.add("id2", "to keep");
    expect(idx.size).toBe(2);

    const removed = idx.remove("id1");
    expect(removed).toBe(true);
    expect(idx.size).toBe(1);
    expect(idx.getEntry("id1")).toBeUndefined();
    expect(idx.getEntry("id2")).toBeDefined();
  });

  it("remove() returns false for non-existent id", () => {
    const idx = new VectorIndex(indexPath, client);
    expect(idx.remove("nonexistent")).toBe(false);
  });

  it("remove() persists after removal", async () => {
    const idx = new VectorIndex(indexPath, client);
    await idx.add("id1", "entry one");
    await idx.add("id2", "entry two");
    idx.remove("id1");

    const raw = fs.readFileSync(indexPath, "utf-8");
    const parsed = JSON.parse(raw) as Array<{ id: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("id2");
  });

  it("getEntry() returns entry by id", async () => {
    const idx = new VectorIndex(indexPath, client);
    await idx.add("myid", "my text", { foo: "bar" });

    const entry = idx.getEntry("myid");
    expect(entry).toBeDefined();
    expect(entry!.id).toBe("myid");
    expect(entry!.text).toBe("my text");
    expect(entry!.metadata).toEqual({ foo: "bar" });
  });

  it("getEntry() returns undefined for missing id", () => {
    const idx = new VectorIndex(indexPath, client);
    expect(idx.getEntry("missing")).toBeUndefined();
  });

  it("clear() removes all entries", async () => {
    const idx = new VectorIndex(indexPath, client);
    await idx.add("id1", "one");
    await idx.add("id2", "two");
    expect(idx.size).toBe(2);

    idx.clear();
    expect(idx.size).toBe(0);
  });

  it("clear() persists empty state to file", async () => {
    const idx = new VectorIndex(indexPath, client);
    await idx.add("id1", "one");
    idx.clear();

    const raw = fs.readFileSync(indexPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown[];
    expect(parsed).toHaveLength(0);
  });

  it("persistence: new instance reads existing data from file", async () => {
    const idx1 = new VectorIndex(indexPath, client);
    await idx1.add("p1", "persist across instances");

    const idx2 = new VectorIndex(indexPath, client);
    expect(idx2.size).toBe(1);
    const entry = idx2.getEntry("p1");
    expect(entry).toBeDefined();
    expect(entry!.text).toBe("persist across instances");
  });

  it("creates parent directories if they don't exist", async () => {
    const nestedPath = path.join(tmpDir, "a", "b", "c", "index.json");
    const idx = new VectorIndex(nestedPath, client);
    await idx.add("id1", "nested dir test");

    expect(fs.existsSync(nestedPath)).toBe(true);
  });
});
