import Anthropic from "@anthropic-ai/sdk";
import type { ZodSchema } from "zod";

// ─── Inline Types ───

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMRequestOptions {
  model?: string;
  max_tokens?: number;
  system?: string;
  temperature?: number;
}

export interface LLMResponse {
  content: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  stop_reason: string;
}

// ─── Interface ───

export interface ILLMClient {
  sendMessage(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse>;
  parseJSON<T>(content: string, schema: ZodSchema<T>): T;
}

// ─── Constants ───

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0;
const MAX_RETRY_ATTEMPTS = 3;

/** Exponential backoff delays in milliseconds: 1s, 2s, 4s */
const RETRY_DELAYS_MS = [1000, 2000, 4000];

// ─── Helpers ───

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract JSON from a string that may contain markdown code blocks.
 * Tries ```json ... ``` first, then ``` ... ```, then bare JSON.
 */
export function extractJSON(text: string): string {
  // Try ```json ... ``` block
  const jsonBlock = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlock) {
    return jsonBlock[1].trim();
  }

  // Try generic ``` ... ``` block
  const genericBlock = text.match(/```\s*([\s\S]*?)```/);
  if (genericBlock) {
    return genericBlock[1].trim();
  }

  // Return as-is (bare JSON)
  return text.trim();
}

// ─── LLMClient ───

/**
 * Thin wrapper around the Anthropic SDK.
 * Provides retry logic and JSON extraction/validation.
 *
 * Constructor throws if no API key is available (no param, no env var).
 */
export class LLMClient implements ILLMClient {
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env["ANTHROPIC_API_KEY"];
    if (!key) {
      throw new Error(
        "LLMClient: no API key provided. Pass apiKey to constructor or set ANTHROPIC_API_KEY env var."
      );
    }
    this.client = new Anthropic({ apiKey: key });
  }

  /**
   * Send a message to the Anthropic API with retry logic.
   * Retries up to MAX_RETRY_ATTEMPTS times with exponential backoff.
   */
  async sendMessage(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    const model = options?.model ?? DEFAULT_MODEL;
    const max_tokens = options?.max_tokens ?? DEFAULT_MAX_TOKENS;
    const temperature = options?.temperature ?? DEFAULT_TEMPERATURE;
    const system = options?.system;

    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const response = await this.client.messages.create({
          model,
          max_tokens,
          temperature,
          ...(system ? { system } : {}),
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        });

        const block = response.content[0];
        const content = block && block.type === "text" ? block.text : "";

        return {
          content,
          usage: {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
          },
          stop_reason: response.stop_reason ?? "unknown",
        };
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRY_ATTEMPTS - 1) {
          await sleep(RETRY_DELAYS_MS[attempt] ?? 1000);
        }
      }
    }

    throw lastError;
  }

  /**
   * Extract JSON from LLM response text (handles markdown code blocks)
   * and validate against the given Zod schema.
   * Throws on parse failure or schema validation failure.
   */
  parseJSON<T>(content: string, schema: ZodSchema<T>): T {
    const jsonText = extractJSON(content);
    let raw: unknown;
    try {
      raw = JSON.parse(jsonText);
    } catch (err) {
      throw new Error(
        `LLMClient.parseJSON: failed to parse JSON — ${String(err)}\nContent: ${content}`
      );
    }
    return schema.parse(raw);
  }
}

// ─── MockLLMClient ───

/**
 * Mock implementation for testing.
 * Returns provided responses in order, tracking call count.
 */
export class MockLLMClient implements ILLMClient {
  private readonly responses: string[];
  private _callCount: number = 0;

  constructor(responses: string[]) {
    this.responses = responses;
  }

  get callCount(): number {
    return this._callCount;
  }

  async sendMessage(
    _messages: LLMMessage[],
    _options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    const index = this._callCount;
    this._callCount++;

    if (index >= this.responses.length) {
      throw new Error(
        `MockLLMClient: no response at index ${index} (only ${this.responses.length} responses configured)`
      );
    }

    const content = this.responses[index]!;

    return {
      content,
      usage: {
        input_tokens: 10,
        output_tokens: content.length,
      },
      stop_reason: "end_turn",
    };
  }

  /**
   * Delegates to real JSON extraction and Zod validation.
   */
  parseJSON<T>(content: string, schema: ZodSchema<T>): T {
    const jsonText = extractJSON(content);
    let raw: unknown;
    try {
      raw = JSON.parse(jsonText);
    } catch (err) {
      throw new Error(
        `MockLLMClient.parseJSON: failed to parse JSON — ${String(err)}\nContent: ${content}`
      );
    }
    return schema.parse(raw);
  }
}
