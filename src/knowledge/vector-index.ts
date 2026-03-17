import * as fs from "fs";
import * as path from "path";
import type { IEmbeddingClient } from "./embedding-client.js";
import type { EmbeddingEntry, VectorSearchResult } from "../types/embedding.js";
import { EmbeddingEntrySchema } from "../types/embedding.js";
import { cosineSimilarity } from "./embedding-client.js";

export class VectorIndex {
  private readonly entries: Map<string, EmbeddingEntry> = new Map();

  constructor(
    private readonly indexPath: string,
    private readonly embeddingClient: IEmbeddingClient
  ) {
    this._load();
  }

  /**
   * Embed text and add an entry to the index.
   */
  async add(
    id: string,
    text: string,
    metadata: Record<string, unknown> = {}
  ): Promise<EmbeddingEntry> {
    const vector = await this.embeddingClient.embed(text);
    const entry: EmbeddingEntry = EmbeddingEntrySchema.parse({
      id,
      text,
      vector,
      model: "embedding",
      created_at: new Date().toISOString(),
      metadata,
    });
    this.entries.set(id, entry);
    this._save();
    return entry;
  }

  /**
   * Embed a query string and search for the most similar entries.
   */
  async search(
    query: string,
    topK: number = 5,
    threshold: number = 0.0
  ): Promise<VectorSearchResult[]> {
    const queryVector = await this.embeddingClient.embed(query);
    return this.searchByVector(queryVector, topK, threshold);
  }

  /**
   * Search using a pre-computed vector.
   */
  searchByVector(
    queryVector: number[],
    topK: number = 5,
    threshold: number = 0.0
  ): VectorSearchResult[] {
    const results: VectorSearchResult[] = [];

    for (const entry of this.entries.values()) {
      const similarity = cosineSimilarity(queryVector, entry.vector);
      if (similarity >= threshold) {
        results.push({
          id: entry.id,
          text: entry.text,
          similarity,
          metadata: entry.metadata,
        });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  /**
   * Remove an entry by id. Returns true if removed, false if not found.
   */
  remove(id: string): boolean {
    const existed = this.entries.has(id);
    if (existed) {
      this.entries.delete(id);
      this._save();
    }
    return existed;
  }

  /**
   * Return the number of entries in the index.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Retrieve a single entry by id.
   */
  getEntry(id: string): EmbeddingEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Remove all entries from the index and persist.
   */
  clear(): void {
    this.entries.clear();
    this._save();
  }

  private _load(): void {
    if (!fs.existsSync(this.indexPath)) return;
    try {
      const raw = fs.readFileSync(this.indexPath, "utf-8");
      const parsed = JSON.parse(raw) as Array<EmbeddingEntry>;
      for (const item of parsed) {
        const entry = EmbeddingEntrySchema.parse(item);
        this.entries.set(entry.id, entry);
      }
    } catch {
      // Corrupt or empty file — start fresh
    }
  }

  private _save(): void {
    const dir = path.dirname(this.indexPath);
    fs.mkdirSync(dir, { recursive: true });

    const data = JSON.stringify(Array.from(this.entries.values()), null, 2);
    const tmpPath = `${this.indexPath}.tmp`;
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, this.indexPath);
  }
}
