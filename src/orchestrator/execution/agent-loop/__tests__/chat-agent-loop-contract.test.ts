import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ChatAgentLoopRunner } from "../chat-agent-loop-runner.js";
import { buildAgentLoopBaseInstructions, buildChatStructuredOutputInstructions } from "../agent-loop-prompts.js";
import type {
  AgentLoopModelClient,
  AgentLoopModelInfo,
  AgentLoopModelRegistry,
  AgentLoopModelRef,
} from "../agent-loop-model.js";
import type { BoundedAgentLoopRunner } from "../bounded-agent-loop-runner.js";
import { defaultAgentLoopCapabilities } from "../index.js";

function makeModelRef(): AgentLoopModelRef {
  return { providerId: "test", modelId: "model" };
}

function makeModelInfo(): AgentLoopModelInfo {
  return {
    ref: makeModelRef(),
    displayName: "test/model",
    capabilities: { ...defaultAgentLoopCapabilities },
  };
}

function makeRunner(returnOutput: unknown, finalText = JSON.stringify(returnOutput)) {
  const modelInfo = makeModelInfo();
  const boundedRunner = {
    run: vi.fn().mockResolvedValue({
      success: true,
      output: returnOutput,
      finalText,
      stopReason: "completed",
      traceId: "trace-1",
      sessionId: "session-1",
      turnId: "turn-1",
      modelTurns: 1,
      toolCalls: 0,
      usage: undefined,
      compactions: 0,
      changedFiles: [],
      commandResults: [],
    }),
  } as unknown as BoundedAgentLoopRunner;
  const modelClient = {
    getModelInfo: vi.fn().mockResolvedValue(modelInfo),
  } as unknown as AgentLoopModelClient;
  const modelRegistry = {
    defaultModel: vi.fn().mockResolvedValue(modelInfo.ref),
  } as unknown as AgentLoopModelRegistry;

  return {
    runner: new ChatAgentLoopRunner({ boundedRunner, modelClient, modelRegistry }),
    boundedRunner,
  };
}

describe("chat agentloop final-answer contract", () => {
  it("defaults to display text mode and returns final markdown without structured output", async () => {
    const { runner, boundedRunner } = makeRunner(null, "Plain **Markdown** answer.");

    const result = await runner.execute({ message: "test" });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Plain **Markdown** answer.");
    expect(result.structuredOutput).toBeUndefined();
    expect(boundedRunner.run).toHaveBeenCalledWith(expect.objectContaining({
      finalOutputMode: "display_text",
    }));
  });

  it("keeps parsed structured output separate when structured mode is explicit", async () => {
    const structured = {
      status: "done",
      answer: "Structured answer text.",
      payload: { ok: true },
    };
    const schema = z.object({
      status: z.literal("done"),
      answer: z.string(),
      payload: z.object({ ok: z.boolean() }),
    });
    const { runner, boundedRunner } = makeRunner(structured);

    const result = await runner.execute({
      message: "test",
      outputMode: { kind: "structured", schema },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Structured answer text.");
    expect(result.structuredOutput).toEqual(structured);
    expect(boundedRunner.run).toHaveBeenCalledWith(expect.objectContaining({
      finalOutputMode: "schema",
      outputSchema: schema,
    }));
  });

  it("renders the structured finalAnswer object as concise markdown", async () => {
    const { runner, boundedRunner } = makeRunner({
      status: "done",
      message: "Updated the contract slice.",
      evidence: ["Verified the new JSON contract.", "Kept the legacy fields working."],
      blockers: [],
      finalAnswer: {
        summary: "Updated the contract slice.",
        sections: [
          { title: "What changed", bullets: ["Added a nested finalAnswer object.", "Kept flat output fields for compatibility."] },
        ],
        evidence: ["Verified the new JSON contract."],
        blockers: [],
        nextActions: ["Ship the change behind the current chat output path."],
      },
    });

    const result = await runner.execute({ message: "test" });

    expect(boundedRunner.run).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    expect(result.output.startsWith("Updated the contract slice.")).toBe(true);
    expect(result.output).toContain("### What changed");
    expect(result.output).toContain("### Evidence");
    expect(result.output).toContain("### Next steps");
  });

  it("keeps legacy flat outputs working", async () => {
    const { runner } = makeRunner({
      status: "done",
      message: "Legacy summary",
      evidence: ["legacy evidence"],
      blockers: ["legacy blocker"],
    });

    const result = await runner.execute({ message: "test" });

    expect(result.success).toBe(true);
    expect(result.output.startsWith("Legacy summary")).toBe(true);
    expect(result.output).toContain("### Evidence");
    expect(result.output).toContain("### Blockers");
  });

  it("unwraps answer-only structured chat output into plain assistant text", async () => {
    const { runner } = makeRunner({
      status: "done",
      answer: "Codexです。あなたの端末上の作業環境でコード作業を進めます。",
    });

    const result = await runner.execute({ message: "あなたは誰？" });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Codexです。あなたの端末上の作業環境でコード作業を進めます。");
    expect(result.output).not.toContain('"answer"');
  });

  it("unwraps JSON strings in message fields before display", async () => {
    const { runner } = makeRunner({
      status: "done",
      message: JSON.stringify({ answer: "JSON文字列ではなく本文だけを表示します。" }),
      evidence: [],
      blockers: [],
    });

    const result = await runner.execute({ message: "test" });

    expect(result.success).toBe(true);
    expect(result.output).toBe("JSON文字列ではなく本文だけを表示します。");
    expect(result.output).not.toContain('"answer"');
  });

  it("unwraps finalAnswer.summary JSON strings before display", async () => {
    const { runner } = makeRunner({
      status: "done",
      message: "",
      evidence: [],
      blockers: [],
      finalAnswer: {
        summary: JSON.stringify({ message: "summary の中身だけを表示します。" }),
        sections: [],
        evidence: [],
        blockers: [],
        nextActions: [],
      },
    });

    const result = await runner.execute({ message: "test" });

    expect(result.success).toBe(true);
    expect(result.output).toBe("summary の中身だけを表示します。");
    expect(result.output).not.toContain('"message"');
  });

  it("unwraps finalText finalAnswer.summary objects before display", async () => {
    const modelInfo = makeModelInfo();
    const boundedRunner = {
      run: vi.fn().mockResolvedValue({
        success: true,
        output: { status: "done", message: "", evidence: [], blockers: [] },
        finalText: JSON.stringify({ finalAnswer: { summary: "finalText 由来の本文です。" } }),
        stopReason: "completed",
        traceId: "trace-1",
        sessionId: "session-1",
        turnId: "turn-1",
        modelTurns: 1,
        toolCalls: 0,
        usage: undefined,
        compactions: 0,
        changedFiles: [],
        commandResults: [],
      }),
    } as unknown as BoundedAgentLoopRunner;
    const modelClient = {
      getModelInfo: vi.fn().mockResolvedValue(modelInfo),
    } as unknown as AgentLoopModelClient;
    const modelRegistry = {
      defaultModel: vi.fn().mockResolvedValue(modelInfo.ref),
    } as unknown as AgentLoopModelRegistry;
    const runner = new ChatAgentLoopRunner({ boundedRunner, modelClient, modelRegistry });

    const result = await runner.execute({ message: "test" });

    expect(result.success).toBe(true);
    expect(result.output).toBe("finalText 由来の本文です。");
    expect(result.output).not.toContain("finalAnswer");
  });

  it("does not display unwrappable JSON objects as normal chat text", async () => {
    const { runner } = makeRunner({
      status: "done",
      message: JSON.stringify({ detail: "internal shape" }),
      evidence: [],
      blockers: [],
    });

    const result = await runner.execute({ message: "test" });

    expect(result.success).toBe(true);
    expect(result.output).toBe("(no response)");
    expect(result.output).not.toContain("internal shape");
    expect(result.output).not.toContain("{");
  });

  it("keeps raw JSON final text in display mode when it is the answer body", async () => {
    const finalText = JSON.stringify({ foo: "bar" });
    const { runner } = makeRunner(null, finalText);

    const result = await runner.execute({ message: "JSONで返して" });

    expect(result.success).toBe(true);
    expect(result.output).toBe(finalText);
    expect(result.structuredOutput).toBeUndefined();
  });

  it("biases chat mode prompts toward display markdown by default", () => {
    const chatPrompt = buildAgentLoopBaseInstructions({ mode: "chat" });
    const taskPrompt = buildAgentLoopBaseInstructions({ mode: "task" });
    const structuredPrompt = buildChatStructuredOutputInstructions();

    expect(chatPrompt).toContain("user-visible Markdown");
    expect(chatPrompt).toContain("Do not wrap the final answer in JSON");
    expect(chatPrompt).toContain("short headings and bullets");
    expect(chatPrompt).not.toContain("finalAnswer");
    expect(taskPrompt).not.toContain("Do not wrap the final answer in JSON");
    expect(structuredPrompt).toContain("Return only JSON");
    expect(structuredPrompt).toContain("requested schema");
  });
});
