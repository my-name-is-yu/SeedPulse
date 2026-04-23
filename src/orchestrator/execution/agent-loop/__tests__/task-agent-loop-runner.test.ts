import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../../../base/types/task.js";
import type { BoundedAgentLoopRunner } from "../bounded-agent-loop-runner.js";
import type { AgentLoopModelClient, AgentLoopModelRegistry } from "../agent-loop-model.js";
import { TaskAgentLoopRunner } from "../task-agent-loop-runner.js";

const { finalize, prepareTaskAgentLoopWorkspace } = vi.hoisted(() => ({
  finalize: vi.fn(),
  prepareTaskAgentLoopWorkspace: vi.fn(),
}));

vi.mock("../task-agent-loop-worktree.js", () => ({
  prepareTaskAgentLoopWorkspace,
}));

function makeTask(): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    work_description: "Implement grounding safely",
    approach: "Make the minimal code change",
    success_criteria: [],
  } as unknown as Task;
}

describe("TaskAgentLoopRunner", () => {
  it("finalizes the workspace when grounding assembly throws before execution", async () => {
    finalize.mockResolvedValue({
      requestedCwd: "/repo",
      executionCwd: "/repo/.wt",
      isolated: true,
      cleanupStatus: "cleaned_up",
    });
    prepareTaskAgentLoopWorkspace.mockResolvedValue({
      requestedCwd: "/repo",
      executionCwd: "/repo/.wt",
      isolated: true,
      finalize,
    });

    const boundedRunner = {
      run: vi.fn(),
    } as unknown as BoundedAgentLoopRunner;
    const modelInfo = {
      ref: { providerId: "test", modelId: "model" },
      displayName: "test/model",
      capabilities: {},
    };
    const runner = new TaskAgentLoopRunner({
      boundedRunner,
      modelClient: {
        getModelInfo: vi.fn().mockResolvedValue(modelInfo),
      } as unknown as AgentLoopModelClient,
      modelRegistry: {
        defaultModel: vi.fn().mockResolvedValue(modelInfo.ref),
      } as unknown as AgentLoopModelRegistry,
      contextAssembler: {
        groundingGateway: null as never,
        assembleTask: vi.fn().mockRejectedValue(new Error("grounding failed")),
      } as unknown as NonNullable<ConstructorParameters<typeof TaskAgentLoopRunner>[0]["contextAssembler"]>,
    });

    await expect(runner.runTask({ task: makeTask(), cwd: "/repo" })).rejects.toThrow("grounding failed");
    expect((boundedRunner.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(finalize).toHaveBeenCalledWith({ success: false, changedFiles: [] });
  });
});
