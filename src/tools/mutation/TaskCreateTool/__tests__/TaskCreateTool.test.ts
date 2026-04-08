import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskCreateTool } from "../TaskCreateTool.js";
import type { ToolCallContext } from "../../../types.js";
import type { StateManager } from "../../../../base/state/state-manager.js";

async function fakeReadRaw(baseDir: string, relativePath: string): Promise<unknown | null> {
  const resolved = path.resolve(baseDir, relativePath);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep)) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }
  if (!fs.existsSync(resolved)) return null;
  try {
    return JSON.parse(fs.readFileSync(resolved, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

function makeContext(): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "goal-1",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

describe("TaskCreateTool", () => {
  let stateManager: StateManager;
  let tool: TaskCreateTool;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-create-tool-"));
    stateManager = {
      writeRaw: vi.fn().mockImplementation(async (rel: string, data: unknown) => {
        const resolved = path.resolve(tmpDir, rel);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, JSON.stringify(data), "utf-8");
      }),
    } as unknown as StateManager;
    tool = new TaskCreateTool(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a pending task on disk", async () => {
    const result = await tool.call(
      {
        goalId: "goal-1",
        targetDimensions: ["coverage"],
        primaryDimension: "coverage",
        work_description: "Delegate test improvement to sub-agent",
      },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { taskId: string };
    const persisted = await fakeReadRaw(tmpDir, `tasks/goal-1/${data.taskId}.json`) as Record<string, unknown>;
    expect(persisted.goal_id).toBe("goal-1");
    expect(persisted.status).toBe("pending");
    expect(persisted.primary_dimension).toBe("coverage");
  });

  it("persists optional fields", async () => {
    const result = await tool.call(
      {
        goalId: "goal-1",
        strategyId: "strategy-1",
        targetDimensions: ["coverage", "quality"],
        primaryDimension: "coverage",
        work_description: "Run implementation in a sub-agent",
        rationale: "Keep parent loop clean",
        approach: "Spawn sub-agent and verify output",
        constraints: ["Do not change package.json"],
      },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { taskId: string };
    const persisted = await fakeReadRaw(tmpDir, `tasks/goal-1/${data.taskId}.json`) as Record<string, unknown>;
    expect(persisted.strategy_id).toBe("strategy-1");
    expect(persisted.target_dimensions).toEqual(["coverage", "quality"]);
    expect(persisted.constraints).toEqual(["Do not change package.json"]);
  });
});
