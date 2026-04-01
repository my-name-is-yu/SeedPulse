import type { ZodSchema } from "zod";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../src/llm/llm-client.js";

// ─── JSON Extraction (mirrors extractJSON in src/llm-client.ts exactly) ───

function extractJSON(text: string): string {
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

// ─── MockLLMClient class ───

class MockLLMClient implements ILLMClient {
  private readonly responses: string[];
  private _callCount: number = 0;
  private readonly _onCall: (() => void) | undefined;

  constructor(responses: string[], onCall?: () => void) {
    this.responses = responses;
    this._onCall = onCall;
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

    // Invoke callback (e.g. to stop the daemon) after recording the call
    this._onCall?.();

    return {
      content,
      usage: {
        input_tokens: 10,
        output_tokens: content.length,
      },
      stop_reason: "end_turn",
    };
  }

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

// ─── Factory functions ───

/**
 * Create a mock ILLMClient that returns responses sequentially from the array.
 * Throws a descriptive error when responses are exhausted.
 * Exposes a `callCount` getter to track sendMessage invocations.
 *
 * Optional `onCall` callback is invoked after each sendMessage call (useful
 * for stopping a daemon from within the mock to avoid real-time waits).
 */
export function createMockLLMClient(responses: string[], onCall?: () => void): MockLLMClient {
  return new MockLLMClient(responses, onCall);
}

/**
 * Convenience wrapper for a single-response mock.
 */
export function createSingleMockLLMClient(response: string): MockLLMClient {
  return new MockLLMClient([response]);
}
