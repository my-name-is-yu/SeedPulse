import { describe, expect, it, vi } from "vitest";
import { ChatAgentLoopRunner } from "../chat-agent-loop-runner.js";
import { buildAgentLoopBaseInstructions } from "../agent-loop-prompts.js";
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

function makeRunner(returnOutput: unknown) {
  const modelInfo = makeModelInfo();
  const boundedRunner = {
    run: vi.fn().mockResolvedValue({
      success: true,
      output: returnOutput,
      finalText: JSON.stringify(returnOutput),
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

  it("biases chat mode prompts toward concise structured markdown", () => {
    const chatPrompt = buildAgentLoopBaseInstructions({ mode: "chat" });
    const taskPrompt = buildAgentLoopBaseInstructions({ mode: "task" });

    expect(chatPrompt).toContain("finalAnswer");
    expect(chatPrompt).toContain("concise structured markdown");
    expect(chatPrompt).toContain("short headings and bullets");
    expect(taskPrompt).not.toContain("concise structured markdown");
  });
});
