import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CreateArgs = Record<string, unknown>;

const createMock = vi.fn<(args: CreateArgs) => Promise<any>>();
const anthropicCtor = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  class AnthropicMock {
    messages = {
      create: createMock,
    };

    constructor(config: Record<string, unknown>) {
      anthropicCtor(config);
    }
  }

  return {
    default: AnthropicMock,
  };
});

describe("LLMClient.sendMessage", () => {
  beforeEach(() => {
    createMock.mockReset();
    anthropicCtor.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends mapped messages with default request options", async () => {
    const { LLMClient } = await import("../llm-client.js");
    createMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 12, output_tokens: 3 },
      stop_reason: "end_turn",
    });

    const client = new LLMClient("sk-ant-test");
    const response = await client.sendMessage([{ role: "user", content: "hello" }]);

    expect(anthropicCtor).toHaveBeenCalledWith({ apiKey: "sk-ant-test" });
    expect(createMock).toHaveBeenCalledWith(
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        temperature: 0,
        messages: [{ role: "user", content: "hello" }],
      },
      { timeout: 60000 }
    );
    expect(response).toEqual({
      content: "ok",
      usage: { input_tokens: 12, output_tokens: 3 },
      stop_reason: "end_turn",
    });
  });

  it("passes through explicit options and omits system when undefined", async () => {
    const { LLMClient } = await import("../llm-client.js");
    createMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "custom" }],
      usage: { input_tokens: 5, output_tokens: 6 },
      stop_reason: "stop_sequence",
    });

    const client = new LLMClient("sk-ant-test");
    await client.sendMessage(
      [{ role: "assistant", content: "prior" }],
      { model: "claude-test", max_tokens: 123, temperature: 0.7 }
    );

    expect(createMock).toHaveBeenCalledWith(
      {
        model: "claude-test",
        max_tokens: 123,
        temperature: 0.7,
        messages: [{ role: "assistant", content: "prior" }],
      },
      { timeout: 60000 }
    );
  });

  it("includes system prompts and falls back to empty content or unknown stop reason", async () => {
    const { LLMClient } = await import("../llm-client.js");
    createMock.mockResolvedValueOnce({
      content: [{ type: "tool_use", id: "tool-1" }],
      usage: { input_tokens: 9, output_tokens: 0 },
      stop_reason: null,
    });

    const client = new LLMClient("sk-ant-test");
    const response = await client.sendMessage(
      [{ role: "user", content: "call tool" }],
      { system: "system prompt" }
    );

    expect(createMock).toHaveBeenCalledWith(
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        temperature: 0,
        system: "system prompt",
        messages: [{ role: "user", content: "call tool" }],
      },
      { timeout: 60000 }
    );
    expect(response).toEqual({
      content: "",
      usage: { input_tokens: 9, output_tokens: 0 },
      stop_reason: "unknown",
    });
  });

  it("retries transient failures with exponential backoff and then succeeds", async () => {
    const { LLMClient } = await import("../llm-client.js");
    createMock
      .mockRejectedValueOnce(new Error("429"))
      .mockRejectedValueOnce(new Error("500"))
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "recovered" }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
      });

    const client = new LLMClient("sk-ant-test");
    const responsePromise = client.sendMessage([{ role: "user", content: "retry" }]);

    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(createMock).toHaveBeenCalledTimes(3);
    expect(response.content).toBe("recovered");
  });

  it("does not retry 4xx client errors and throws immediately", async () => {
    const { LLMClient } = await import("../llm-client.js");
    const clientError = Object.assign(new Error("Unauthorized"), { status: 401 });
    createMock.mockImplementationOnce(() => Promise.reject(clientError));

    const client = new LLMClient("sk-ant-test");
    await expect(client.sendMessage([{ role: "user", content: "bad key" }])).rejects.toThrow("Unauthorized");
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("throws the last error after exhausting retries", async () => {
    const { LLMClient } = await import("../llm-client.js");
    createMock
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockRejectedValueOnce(new Error("final failure"));

    const client = new LLMClient("sk-ant-test");
    const responsePromise = client.sendMessage([{ role: "user", content: "still failing" }]);
    const expectation = expect(responsePromise).rejects.toThrow("final failure");

    await vi.runAllTimersAsync();
    await expectation;
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it("retries on HTTP 429 with extended backoff and eventually succeeds", async () => {
    const { LLMClient } = await import("../llm-client.js");
    const rateLimitErr = Object.assign(new Error("Too Many Requests"), { status: 429 });
    createMock
      .mockRejectedValueOnce(rateLimitErr)
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "success after rate limit" }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
      });

    const client = new LLMClient("sk-ant-test");
    const responsePromise = client.sendMessage([{ role: "user", content: "rate limited" }]);

    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(createMock).toHaveBeenCalledTimes(3);
    expect(response.content).toBe("success after rate limit");
  });

  it("does not retry on HTTP 400 or 403", async () => {
    const { LLMClient } = await import("../llm-client.js");
    for (const status of [400, 403]) {
      createMock.mockReset();
      const clientErr = Object.assign(new Error(`HTTP ${status}`), { status });
      createMock.mockRejectedValueOnce(clientErr);

      const client = new LLMClient("sk-ant-test");
      await expect(client.sendMessage([{ role: "user", content: "bad" }])).rejects.toThrow();
      expect(createMock).toHaveBeenCalledTimes(1);
    }
  });
});
