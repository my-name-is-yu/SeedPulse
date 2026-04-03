import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { OllamaLLMClient } from "../ollama-client.js";

// ─── Helpers ───

function makeOkResponse(content: string, finishReason = "stop"): Response {
  const body = JSON.stringify({
    choices: [
      {
        message: { content },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: content.length,
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeErrorResponse(status: number, message: string): Response {
  return new Response(message, { status });
}

// ─── Tests ───

describe("OllamaLLMClient", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── Constructor ───

  describe("constructor", () => {
    it("uses default model when not specified", () => {
      const client = new OllamaLLMClient({ baseUrl: "http://localhost:11434" });
      // model is private; we verify it's used in the request body
      fetchSpy.mockResolvedValueOnce(makeOkResponse("hello"));
      return client.sendMessage([{ role: "user", content: "hi" }]).then(() => {
        const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
        expect(body.model).toBe("qwen3:4b");
      });
    });

    it("uses custom model when specified", () => {
      const client = new OllamaLLMClient({
        baseUrl: "http://localhost:11434",
        model: "llama3:8b",
      });
      fetchSpy.mockResolvedValueOnce(makeOkResponse("hello"));
      return client.sendMessage([{ role: "user", content: "hi" }]).then(() => {
        const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
        expect(body.model).toBe("llama3:8b");
      });
    });

    it("strips trailing slash from baseUrl", () => {
      const client = new OllamaLLMClient({
        baseUrl: "http://192.168.1.100:11434/",
      });
      fetchSpy.mockResolvedValueOnce(makeOkResponse("hello"));
      return client.sendMessage([{ role: "user", content: "hi" }]).then(() => {
        const url = fetchSpy.mock.calls[0][0] as string;
        expect(url).toBe("http://192.168.1.100:11434/v1/chat/completions");
      });
    });
  });

  // ─── sendMessage ───

  describe("sendMessage", () => {
    it("calls the correct endpoint", async () => {
      const client = new OllamaLLMClient({ baseUrl: "http://localhost:11434" });
      fetchSpy.mockResolvedValueOnce(makeOkResponse("hello"));

      await client.sendMessage([{ role: "user", content: "test" }]);

      expect(fetchSpy).toHaveBeenCalledWith(
        "http://localhost:11434/v1/chat/completions",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("maps LLMMessage array to OpenAI format", async () => {
      const client = new OllamaLLMClient({ baseUrl: "http://localhost:11434" });
      fetchSpy.mockResolvedValueOnce(makeOkResponse("response"));

      await client.sendMessage([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "bye" },
      ]);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.messages).toEqual([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "bye" },
      ]);
    });

    it("prepends system message when system option provided", async () => {
      const client = new OllamaLLMClient({ baseUrl: "http://localhost:11434" });
      fetchSpy.mockResolvedValueOnce(makeOkResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }], {
        system: "You are helpful.",
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.messages[0]).toEqual({
        role: "system",
        content: "You are helpful.",
      });
      expect(body.messages[1]).toEqual({ role: "user", content: "hi" });
    });

    it("uses default temperature of 0", async () => {
      const client = new OllamaLLMClient({ baseUrl: "http://localhost:11434" });
      fetchSpy.mockResolvedValueOnce(makeOkResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }]);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.temperature).toBe(0);
    });

    it("respects temperature override from options", async () => {
      const client = new OllamaLLMClient({ baseUrl: "http://localhost:11434" });
      fetchSpy.mockResolvedValueOnce(makeOkResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }], {
        temperature: 0.7,
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.temperature).toBe(0.7);
    });

    it("respects max_tokens override from options", async () => {
      const client = new OllamaLLMClient({ baseUrl: "http://localhost:11434" });
      fetchSpy.mockResolvedValueOnce(makeOkResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }], {
        max_tokens: 256,
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.max_tokens).toBe(256);
    });

    it("returns LLMResponse with content and usage", async () => {
      const client = new OllamaLLMClient({ baseUrl: "http://localhost:11434" });
      fetchSpy.mockResolvedValueOnce(makeOkResponse("the answer", "stop"));

      const result = await client.sendMessage([
        { role: "user", content: "question" },
      ]);

      expect(result.content).toBe("the answer");
      expect(result.stop_reason).toBe("stop");
      expect(result.usage.input_tokens).toBe(10);
      expect(result.usage.output_tokens).toBe("the answer".length);
    });

    it("overrides model via options.model", async () => {
      const client = new OllamaLLMClient({
        baseUrl: "http://localhost:11434",
        model: "default-model",
      });
      fetchSpy.mockResolvedValueOnce(makeOkResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }], {
        model: "override-model",
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.model).toBe("override-model");
    });

    it("sets stream: false in request body", async () => {
      const client = new OllamaLLMClient({ baseUrl: "http://localhost:11434" });
      fetchSpy.mockResolvedValueOnce(makeOkResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }]);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.stream).toBe(false);
    });
  });

  // ─── Retry logic ───

  describe("retry logic", () => {
    it("retries on network error and succeeds on second attempt", async () => {
      const client = new OllamaLLMClient({ baseUrl: "http://localhost:11434" });

      fetchSpy
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(makeOkResponse("success"));

      // Speed up retries in tests by using fake timers or just letting it run
      // (delays are short: 1s, but we can mock the sleep by mocking setTimeout)
      vi.useFakeTimers();
      const promise = client.sendMessage([{ role: "user", content: "hi" }]);
      await vi.runAllTimersAsync();
      const result = await promise;
      vi.useRealTimers();

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result.content).toBe("success");
    });

    it("retries up to 3 times and throws after all attempts fail", async () => {
      const client = new OllamaLLMClient({ baseUrl: "http://localhost:11434" });

      fetchSpy.mockRejectedValue(new TypeError("network error"));

      vi.useFakeTimers();
      // Attach rejection handler before any timer resolution to avoid unhandled rejection
      const promise = client.sendMessage([{ role: "user", content: "hi" }]).catch((e) => e);
      await vi.runAllTimersAsync();
      vi.useRealTimers();

      const result = await promise;
      expect(result).toBeInstanceOf(TypeError);
      expect((result as TypeError).message).toBe("network error");
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it("does not retry on HTTP 4xx client errors", async () => {
      const client = new OllamaLLMClient({ baseUrl: "http://localhost:11434" });

      fetchSpy.mockResolvedValue(makeErrorResponse(400, "Bad Request"));

      await expect(
        client.sendMessage([{ role: "user", content: "hi" }])
      ).rejects.toThrow("HTTP 400");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Error handling ───

  describe("error handling", () => {
    it("throws on HTTP 500 server error (with retry)", async () => {
      const client = new OllamaLLMClient({ baseUrl: "http://localhost:11434" });

      fetchSpy.mockResolvedValue(makeErrorResponse(500, "Internal Server Error"));

      vi.useFakeTimers();
      // Attach rejection handler immediately to avoid unhandled rejection warnings
      const promise = client.sendMessage([{ role: "user", content: "hi" }]).catch((e) => e);
      await vi.runAllTimersAsync();
      vi.useRealTimers();

      const result = await promise;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("HTTP 500");
    });

    it("throws descriptive error with HTTP status", async () => {
      const client = new OllamaLLMClient({ baseUrl: "http://localhost:11434" });

      fetchSpy.mockResolvedValue(makeErrorResponse(404, "Not Found"));

      await expect(
        client.sendMessage([{ role: "user", content: "hi" }])
      ).rejects.toThrow("HTTP 404");
    });
  });

  // ─── parseJSON ───

  describe("parseJSON", () => {
    const schema = z.object({ name: z.string(), count: z.number() });

    it("parses bare JSON", () => {
      const client = new OllamaLLMClient({ baseUrl: "http://localhost:11434" });
      const result = client.parseJSON('{"name":"test","count":42}', schema);
      expect(result).toEqual({ name: "test", count: 42 });
    });

    it("parses JSON in ```json code block", () => {
      const client = new OllamaLLMClient({ baseUrl: "http://localhost:11434" });
      const content = '```json\n{"name":"hello","count":1}\n```';
      const result = client.parseJSON(content, schema);
      expect(result).toEqual({ name: "hello", count: 1 });
    });

    it("parses JSON in generic ``` code block", () => {
      const client = new OllamaLLMClient({ baseUrl: "http://localhost:11434" });
      const content = '```\n{"name":"world","count":99}\n```';
      const result = client.parseJSON(content, schema);
      expect(result).toEqual({ name: "world", count: 99 });
    });

    it("throws on invalid JSON", () => {
      const client = new OllamaLLMClient({ baseUrl: "http://localhost:11434" });
      expect(() => client.parseJSON("not json at all", schema)).toThrow(
        "LLM response JSON parse failed"
      );
    });

    it("throws on schema validation failure", () => {
      const client = new OllamaLLMClient({ baseUrl: "http://localhost:11434" });
      expect(() =>
        client.parseJSON('{"name":123,"count":"wrong"}', schema)
      ).toThrow();
    });

    it("includes content in error message for failed parse", () => {
      const client = new OllamaLLMClient({ baseUrl: "http://localhost:11434" });
      const badContent = "this is not json";
      expect(() => client.parseJSON(badContent, schema)).toThrow(badContent);
    });
  });
});
