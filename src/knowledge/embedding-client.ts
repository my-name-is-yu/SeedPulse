export interface IEmbeddingClient {
  embed(text: string): Promise<number[]>;
  batchEmbed(texts: string[]): Promise<number[][]>;
  cosineSimilarity(a: number[], b: number[]): number;
}

/**
 * Standalone cosine similarity function.
 * Returns dot(a, b) / (|a| * |b|). Returns 0 for zero vectors.
 * Throws if vectors have different lengths.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector length mismatch: ${a.length} vs ${b.length}`
    );
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Deterministic mock embedding client for testing.
 * Produces stable vectors based on text content.
 */
export class MockEmbeddingClient implements IEmbeddingClient {
  private readonly dimensions: number;

  constructor(dimensions: number = 768) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    return this._deterministicVector(text);
  }

  async batchEmbed(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  cosineSimilarity(a: number[], b: number[]): number {
    return cosineSimilarity(a, b);
  }

  private _deterministicVector(text: string): number[] {
    // Simple deterministic hash → spread across dimensions
    const vec = new Array<number>(this.dimensions).fill(0);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      vec[i % this.dimensions] += code;
      vec[(i * 31 + 7) % this.dimensions] += code * 0.5;
    }
    // Normalize to unit vector
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm === 0) {
      // Fallback: fill with 1/sqrt(dimensions) to produce unit vector
      const val = 1 / Math.sqrt(this.dimensions);
      return new Array<number>(this.dimensions).fill(val);
    }
    return vec.map((v) => v / norm);
  }
}

/**
 * Ollama embedding client.
 * Calls POST http://localhost:11434/api/embeddings with model + prompt.
 */
export class OllamaEmbeddingClient implements IEmbeddingClient {
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(model: string = "nomic-embed-text", baseUrl: string = "http://localhost:11434") {
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!response.ok) {
      throw new Error(`Ollama embedding request failed: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as { embedding: number[] };
    return data.embedding;
  }

  async batchEmbed(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  cosineSimilarity(a: number[], b: number[]): number {
    return cosineSimilarity(a, b);
  }
}

/**
 * OpenAI embedding client.
 * Calls the OpenAI embeddings API.
 */
export class OpenAIEmbeddingClient implements IEmbeddingClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(
    apiKey: string,
    model: string = "text-embedding-3-small",
    baseUrl: string = "https://api.openai.com"
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI embedding request failed: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  }

  async batchEmbed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI batch embedding request failed: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as { data: Array<{ embedding: number[]; index: number }> };
    // Sort by index to maintain order
    const sorted = [...data.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }

  cosineSimilarity(a: number[], b: number[]): number {
    return cosineSimilarity(a, b);
  }
}
