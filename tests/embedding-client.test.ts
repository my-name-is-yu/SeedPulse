import { describe, it, expect } from "vitest";
import {
  MockEmbeddingClient,
  cosineSimilarity,
} from "../src/embedding-client.js";

describe("MockEmbeddingClient", () => {
  it("embed returns vector with correct dimensions (default 768)", async () => {
    const client = new MockEmbeddingClient();
    const vec = await client.embed("hello world");
    expect(vec).toHaveLength(768);
  });

  it("embed returns vector with custom dimensions", async () => {
    const client = new MockEmbeddingClient(128);
    const vec = await client.embed("hello");
    expect(vec).toHaveLength(128);
  });

  it("same text produces the same vector", async () => {
    const client = new MockEmbeddingClient(64);
    const v1 = await client.embed("deterministic");
    const v2 = await client.embed("deterministic");
    expect(v1).toEqual(v2);
  });

  it("different texts produce different vectors", async () => {
    const client = new MockEmbeddingClient(64);
    const v1 = await client.embed("apple");
    const v2 = await client.embed("orange");
    expect(v1).not.toEqual(v2);
  });

  it("batchEmbed returns array of correct length", async () => {
    const client = new MockEmbeddingClient(32);
    const texts = ["foo", "bar", "baz"];
    const vecs = await client.batchEmbed(texts);
    expect(vecs).toHaveLength(3);
    for (const vec of vecs) {
      expect(vec).toHaveLength(32);
    }
  });

  it("batchEmbed returns same vectors as individual embed calls", async () => {
    const client = new MockEmbeddingClient(32);
    const texts = ["cat", "dog"];
    const batch = await client.batchEmbed(texts);
    const single0 = await client.embed(texts[0]);
    const single1 = await client.embed(texts[1]);
    expect(batch[0]).toEqual(single0);
    expect(batch[1]).toEqual(single1);
  });

  it("instance cosineSimilarity delegates to standalone function", () => {
    const client = new MockEmbeddingClient(4);
    const a = [1, 0, 0, 0];
    const b = [1, 0, 0, 0];
    expect(client.cosineSimilarity(a, b)).toBeCloseTo(1.0);
  });
});

describe("cosineSimilarity (standalone)", () => {
  it("identical vectors return 1.0", () => {
    const v = [0.5, 0.5, 0.5, 0.5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it("orthogonal vectors return 0.0", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it("opposite vectors return -1.0", () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  it("zero vector returns 0", () => {
    const zero = [0, 0, 0];
    const other = [1, 2, 3];
    expect(cosineSimilarity(zero, other)).toBe(0);
    expect(cosineSimilarity(other, zero)).toBe(0);
    expect(cosineSimilarity(zero, zero)).toBe(0);
  });

  it("throws for different length vectors", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow();
  });
});
