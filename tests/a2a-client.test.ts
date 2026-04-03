import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { A2AClient } from "../src/adapters/agents/a2a-client.js";

// ─── Helpers ───

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonRpcOk(result: unknown): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: "1", result }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function jsonRpcError(code: number, message: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      error: { code, message },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function a2aTask(
  state: string,
  output?: string
): Record<string, unknown> {
  return {
    id: "task-1",
    contextId: "ctx-1",
    status: { state, timestamp: new Date().toISOString() },
    artifacts: output
      ? [{ parts: [{ kind: "text", text: output }] }]
      : [],
  };
}

function agentCardJson(): Record<string, unknown> {
  return {
    name: "Test Agent",
    description: "A test A2A agent",
    url: "https://agent.example.com",
    version: "1.0",
    capabilities: { streaming: true },
    skills: [
      { id: "code_gen", name: "Code Generation", tags: ["coding"] },
    ],
  };
}

// ─── Tests ───

describe("A2AClient", () => {
  let client: A2AClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new A2AClient({
      baseUrl: "https://agent.example.com",
      pollIntervalMs: 10,
      maxWaitMs: 100,
    });
  });

  // ─── fetchAgentCard ───

  describe("fetchAgentCard", () => {
    it("parses well-known endpoint", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(agentCardJson()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const card = await client.fetchAgentCard();
      expect(card.name).toBe("Test Agent");
      expect(card.url).toBe("https://agent.example.com");
      expect(card.capabilities?.streaming).toBe(true);

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toBe(
        "https://agent.example.com/.well-known/agent.json"
      );
    });

    it("throws on 404", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response("Not Found", { status: 404, statusText: "Not Found" })
      );

      await expect(client.fetchAgentCard()).rejects.toThrow(/404/);
    });
  });

  // ─── sendMessage ───

  describe("sendMessage", () => {
    it("sends correct JSON-RPC body", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonRpcOk(a2aTask("completed", "done"))
      );

      const message = {
        role: "user" as const,
        parts: [{ kind: "text" as const, text: "hello" }],
      };
      await client.sendMessage(message);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("https://agent.example.com");
      const body = JSON.parse(opts.body as string);
      expect(body.jsonrpc).toBe("2.0");
      expect(body.method).toBe("message/send");
      expect(body.params.message.role).toBe("user");
      expect(body.params.message.parts[0].text).toBe("hello");
    });

    it("parses task response", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonRpcOk(a2aTask("completed", "result text"))
      );

      const message = {
        role: "user" as const,
        parts: [{ kind: "text" as const, text: "test" }],
      };
      const task = await client.sendMessage(message);
      expect(task.id).toBe("task-1");
      expect(task.status.state).toBe("completed");
    });

    it("throws on JSON-RPC error", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonRpcError(-32600, "Invalid request")
      );

      const message = {
        role: "user" as const,
        parts: [{ kind: "text" as const, text: "test" }],
      };
      await expect(client.sendMessage(message)).rejects.toThrow(
        /JSON-RPC error -32600: Invalid request/
      );
    });
  });

  // ─── getTask ───

  describe("getTask", () => {
    it("sends correct params", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonRpcOk(a2aTask("working"))
      );

      await client.getTask("task-42");

      const body = JSON.parse(
        (mockFetch.mock.calls[0][1] as { body: string }).body
      );
      expect(body.method).toBe("tasks/get");
      expect(body.params.id).toBe("task-42");
    });
  });

  // ─── cancelTask ───

  describe("cancelTask", () => {
    it("sends correct params", async () => {
      mockFetch.mockResolvedValueOnce(jsonRpcOk(null));

      await client.cancelTask("task-42");

      const body = JSON.parse(
        (mockFetch.mock.calls[0][1] as { body: string }).body
      );
      expect(body.method).toBe("tasks/cancel");
      expect(body.params.id).toBe("task-42");
    });
  });

  // ─── waitForCompletion ───

  describe("waitForCompletion", () => {
    it("polls until terminal state", async () => {
      // First poll: working, second poll: completed
      mockFetch
        .mockResolvedValueOnce(jsonRpcOk(a2aTask("working")))
        .mockResolvedValueOnce(jsonRpcOk(a2aTask("completed", "done")));

      const task = await client.waitForCompletion("task-1");
      expect(task.status.state).toBe("completed");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("respects maxWaitMs", async () => {
      // Return a fresh Response for every call (Response body is single-use)
      mockFetch.mockImplementation(() =>
        Promise.resolve(jsonRpcOk(a2aTask("working")))
      );

      await expect(
        client.waitForCompletion("task-1")
      ).rejects.toThrow(/did not complete within 100ms/);
    });

    it("cancels task on timeout", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(jsonRpcOk(a2aTask("working")))
      );

      try {
        await client.waitForCompletion("task-1");
      } catch {
        // expected
      }

      // Check that one of the calls was a tasks/cancel
      const allBodies = mockFetch.mock.calls
        .filter(
          (c) =>
            c[1] && typeof (c[1] as { body?: string }).body === "string"
        )
        .map((c) => JSON.parse((c[1] as { body: string }).body));
      const cancelCall = allBodies.find(
        (b) => b.method === "tasks/cancel"
      );
      expect(cancelCall).toBeDefined();
      expect(cancelCall.params.id).toBe("task-1");
    });
  });

  // ─── sendMessageStream ───

  describe("sendMessageStream", () => {
    it("parses SSE events", async () => {
      const taskData = a2aTask("completed", "streamed result");
      const ssePayload = [
        `data: ${JSON.stringify({ kind: "status-update", taskId: "task-1", status: { state: "working" } })}`,
        "",
        `data: ${JSON.stringify(taskData)}`,
        "",
        "data: [DONE]",
        "",
      ].join("\n");

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(ssePayload));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      );

      const onStatus = vi.fn();
      const message = {
        role: "user" as const,
        parts: [{ kind: "text" as const, text: "stream test" }],
      };
      const task = await client.sendMessageStream(message, onStatus);

      expect(task.id).toBe("task-1");
      expect(task.status.state).toBe("completed");
      expect(onStatus).toHaveBeenCalledWith("working", undefined);
    });
  });

  // ─── Authorization headers ───

  describe("Authorization header", () => {
    it("included when authToken set", async () => {
      const authedClient = new A2AClient({
        baseUrl: "https://agent.example.com",
        authToken: "sk-secret-token",
      });

      mockFetch.mockResolvedValueOnce(
        jsonRpcOk(a2aTask("completed"))
      );

      await authedClient.getTask("task-1");

      const headers = (mockFetch.mock.calls[0][1] as { headers: Record<string, string> }).headers;
      expect(headers["Authorization"]).toBe("Bearer sk-secret-token");
    });

    it("not included when authToken not set", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonRpcOk(a2aTask("completed"))
      );

      await client.getTask("task-1");

      const headers = (mockFetch.mock.calls[0][1] as { headers: Record<string, string> }).headers;
      expect(headers["Authorization"]).toBeUndefined();
    });
  });
});
