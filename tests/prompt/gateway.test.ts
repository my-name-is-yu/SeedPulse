import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { PromptGateway } from "../../src/prompt/gateway.js";
import { ContextAssembler } from "../../src/prompt/context-assembler.js";
import type { AssembledContext } from "../../src/prompt/context-assembler.js";
import type { ILLMClient } from "../../src/llm/llm-client.js";

const makeAssembledContext = (overrides: Partial<AssembledContext> = {}): AssembledContext => ({
  systemPrompt: "You are an AI assistant.",
  contextBlock: "<goal_definition>\nGoal: Test\n</goal_definition>",
  totalTokensUsed: 20,
  ...overrides,
});

const makeLLMResponse = (content: any) => ({
  content: JSON.stringify(content),
  usage: { input_tokens: 100, output_tokens: 50 },
});

function makeMockLLMClient(responseContent: any): ILLMClient {
  return {
    sendMessage: vi.fn().mockResolvedValue(makeLLMResponse(responseContent)),
    parseJSON: vi.fn().mockImplementation((text: string, schema: z.ZodSchema) => {
      return schema.parse(JSON.parse(text));
    }),
  } as unknown as ILLMClient;
}

function makeMockAssembler(context?: Partial<AssembledContext>): ContextAssembler {
  const assembler = new ContextAssembler({});
  vi.spyOn(assembler, "build").mockResolvedValue(makeAssembledContext(context));
  return assembler;
}

describe("PromptGateway", () => {
  const schema = z.object({ score: z.number() });

  describe("execute()", () => {
    it("calls assembler.build with correct purpose and goalId", async () => {
      const assembler = makeMockAssembler();
      const llmClient = makeMockLLMClient({ score: 0.8 });
      const gateway = new PromptGateway(llmClient, assembler);

      await gateway.execute({
        purpose: "observation",
        goalId: "goal-123",
        responseSchema: schema,
      });

      expect(assembler.build).toHaveBeenCalledWith(
        "observation",
        "goal-123",
        undefined,
        undefined
      );
    });

    it("passes dimensionName and additionalContext to assembler.build", async () => {
      const assembler = makeMockAssembler();
      const llmClient = makeMockLLMClient({ score: 0.5 });
      const gateway = new PromptGateway(llmClient, assembler);

      await gateway.execute({
        purpose: "task_generation",
        goalId: "goal-456",
        dimensionName: "coverage",
        additionalContext: { failureContext: "timed out" },
        responseSchema: schema,
      });

      expect(assembler.build).toHaveBeenCalledWith(
        "task_generation",
        "goal-456",
        "coverage",
        { failureContext: "timed out" }
      );
    });

    it("calls llmClient.sendMessage with assembled context block as user message", async () => {
      const contextBlock = "<goal_definition>\nGoal: Demo\n</goal_definition>";
      const assembler = makeMockAssembler({ contextBlock });
      const llmClient = makeMockLLMClient({ score: 0.9 });
      const gateway = new PromptGateway(llmClient, assembler);

      await gateway.execute({
        purpose: "observation",
        goalId: "goal-1",
        responseSchema: schema,
      });

      expect(llmClient.sendMessage).toHaveBeenCalledWith(
        [{ role: "user", content: contextBlock }],
        expect.objectContaining({ max_tokens: expect.any(Number) })
      );
    });

    it("uses PURPOSE_CONFIGS system prompt when assembler returns no systemPrompt", async () => {
      const assembler = makeMockAssembler({ systemPrompt: "" });
      const llmClient = makeMockLLMClient({ score: 0.5 });
      const gateway = new PromptGateway(llmClient, assembler);

      await gateway.execute({
        purpose: "observation",
        goalId: "goal-1",
        responseSchema: schema,
      });

      const callArgs = (llmClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(callArgs.system).toBeTruthy();
    });

    it("uses default max_tokens from PURPOSE_CONFIGS when not specified", async () => {
      const assembler = makeMockAssembler();
      const llmClient = makeMockLLMClient({ score: 0.5 });
      const gateway = new PromptGateway(llmClient, assembler);

      await gateway.execute({
        purpose: "observation",
        goalId: "goal-1",
        responseSchema: schema,
      });

      const callArgs = (llmClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(callArgs.max_tokens).toBe(512); // observation defaultMaxTokens
    });

    it("overrides max_tokens when provided in input", async () => {
      const assembler = makeMockAssembler();
      const llmClient = makeMockLLMClient({ score: 0.5 });
      const gateway = new PromptGateway(llmClient, assembler);

      await gateway.execute({
        purpose: "observation",
        goalId: "goal-1",
        responseSchema: schema,
        maxTokens: 256,
      });

      const callArgs = (llmClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(callArgs.max_tokens).toBe(256);
    });

    it("passes response.content to parseJSON with the schema", async () => {
      const assembler = makeMockAssembler();
      const llmClient = makeMockLLMClient({ score: 0.7 });
      const gateway = new PromptGateway(llmClient, assembler);

      await gateway.execute({
        purpose: "observation",
        goalId: "goal-1",
        responseSchema: schema,
      });

      expect(llmClient.parseJSON).toHaveBeenCalledWith(
        JSON.stringify({ score: 0.7 }),
        schema
      );
    });

    it("returns the parsed result", async () => {
      const assembler = makeMockAssembler();
      const llmClient = makeMockLLMClient({ score: 0.42 });
      const gateway = new PromptGateway(llmClient, assembler);

      const result = await gateway.execute({
        purpose: "observation",
        goalId: "goal-1",
        responseSchema: schema,
      });

      expect(result).toEqual({ score: 0.42 });
    });

    it("calls logger with usage info when logger is provided", async () => {
      const logger = vi.fn();
      const assembler = makeMockAssembler();
      const llmClient = makeMockLLMClient({ score: 0.5 });
      const gateway = new PromptGateway(llmClient, assembler, { logger });

      await gateway.execute({
        purpose: "observation",
        goalId: "goal-1",
        responseSchema: schema,
      });

      expect(logger).toHaveBeenCalledTimes(1);
      const logMsg: string = logger.mock.calls[0][0];
      expect(logMsg).toContain("observation");
      expect(logMsg).toContain("tokens");
    });

    it("does not call logger when no logger is provided", async () => {
      const assembler = makeMockAssembler();
      const llmClient = makeMockLLMClient({ score: 0.5 });
      const gateway = new PromptGateway(llmClient, assembler);

      // Should not throw
      await expect(
        gateway.execute({ purpose: "observation", goalId: "goal-1", responseSchema: schema })
      ).resolves.toBeDefined();
    });

    it("works without goalId — passes undefined to assembler.build", async () => {
      const assembler = makeMockAssembler();
      const llmClient = makeMockLLMClient({ score: 0.3 });
      const gateway = new PromptGateway(llmClient, assembler);

      const result = await gateway.execute({
        purpose: "observation",
        responseSchema: schema,
      });

      expect(assembler.build).toHaveBeenCalledWith(
        "observation",
        undefined,
        undefined,
        undefined
      );
      expect(result).toEqual({ score: 0.3 });
    });
  });

  describe("error handling", () => {
    it("throws meaningful error when assembler.build fails", async () => {
      const assembler = new ContextAssembler({});
      vi.spyOn(assembler, "build").mockRejectedValue(new Error("state load failed"));
      const llmClient = makeMockLLMClient({ score: 0.5 });
      const gateway = new PromptGateway(llmClient, assembler);

      await expect(
        gateway.execute({ purpose: "observation", goalId: "goal-1", responseSchema: schema })
      ).rejects.toThrow("[PromptGateway] context assembly failed");
    });

    it("throws meaningful error when LLM call fails", async () => {
      const assembler = makeMockAssembler();
      const llmClient = {
        sendMessage: vi.fn().mockRejectedValue(new Error("network error")),
        parseJSON: vi.fn(),
      } as unknown as ILLMClient;
      const gateway = new PromptGateway(llmClient, assembler);

      await expect(
        gateway.execute({ purpose: "observation", goalId: "goal-1", responseSchema: schema })
      ).rejects.toThrow("[PromptGateway] LLM call failed");
    });
  });
});
