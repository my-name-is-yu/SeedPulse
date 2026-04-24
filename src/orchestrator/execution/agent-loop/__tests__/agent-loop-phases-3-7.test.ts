import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import { ToolRegistry } from "../../../../tools/registry.js";
import { ToolExecutor } from "../../../../tools/executor.js";
import { ToolPermissionManager } from "../../../../tools/permission.js";
import { ConcurrencyController } from "../../../../tools/concurrency.js";
import { ApplyPatchTool } from "../../../../tools/fs/ApplyPatchTool/ApplyPatchTool.js";
import { ViewImageTool } from "../../../../tools/media/ViewImageTool/ViewImageTool.js";
import { ShellCommandTool } from "../../../../tools/system/ShellCommandTool/ShellCommandTool.js";
import { UpdatePlanTool } from "../../../../tools/system/UpdatePlanTool/UpdatePlanTool.js";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolResult } from "../../../../tools/types.js";
import type { Task } from "../../../../base/types/task.js";
import {
  AgentLoopContextAssembler,
  BoundedAgentLoopRunner,
  ChatAgentLoopRunner,
  CorePhaseRunner,
  ExtractiveAgentLoopCompactor,
  JsonAgentLoopSessionStateStore,
  NoopAgentLoopCompactor,
  StaticAgentLoopModelRegistry,
  ToolExecutorAgentLoopToolRuntime,
  ToolRegistryAgentLoopToolRouter,
  createAgentLoopHistory,
  createAgentLoopSession,
  createCoreLoopControlTools,
  defaultAgentLoopCapabilities,
  type AgentLoopModelClient,
  type AgentLoopModelInfo,
  type AgentLoopModelRequest,
  type AgentLoopModelResponse,
} from "../index.js";

class ScriptedModelClient implements AgentLoopModelClient {
  calls: AgentLoopModelRequest[] = [];
  private index = 0;

  constructor(
    private readonly modelInfo: AgentLoopModelInfo,
    private readonly responses: AgentLoopModelResponse[],
  ) {}

  async getModelInfo(): Promise<AgentLoopModelInfo> {
    return this.modelInfo;
  }

  async createTurn(input: AgentLoopModelRequest): Promise<AgentLoopModelResponse> {
    this.calls.push(input);
    return this.responses[this.index++] ?? this.responses[this.responses.length - 1];
  }
}

function makeModelInfo(): AgentLoopModelInfo {
  return {
    ref: { providerId: "test", modelId: "model" },
    displayName: "test/model",
    capabilities: { ...defaultAgentLoopCapabilities },
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["dim"],
    primary_dimension: "dim",
    work_description: "test task",
    rationale: "test rationale",
    approach: "test approach",
    success_criteria: [{ description: "done", verification_method: "unit", is_blocking: true }],
    scope_boundary: { in_scope: ["."], out_of_scope: [], blast_radius: "low" },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 1, unit: "hours" },
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeRuntime(registry: ToolRegistry) {
  const router = new ToolRegistryAgentLoopToolRouter(registry);
  const executor = new ToolExecutor({
    registry,
    permissionManager: new ToolPermissionManager({}),
    concurrency: new ConcurrencyController(),
  });
  return {
    router,
    runtime: new ToolExecutorAgentLoopToolRuntime(executor, router),
  };
}

class ApprovalTool implements ITool<{ value: string }> {
  readonly metadata = {
    name: "approval_tool",
    aliases: [],
    permissionLevel: "write_remote" as const,
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 8000,
    tags: ["test"],
  };
  readonly inputSchema = z.object({ value: z.string() });

  description(): string {
    return "Tool that requires approval.";
  }

  async call(input: { value: string }, _context: ToolCallContext): Promise<ToolResult> {
    return {
      success: true,
      data: { approved: input.value },
      summary: `approved ${input.value}`,
      durationMs: 1,
    };
  }

  async checkPermissions(_input: { value: string }, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: { value: string }): boolean {
    return false;
  }
}

describe("agentloop phase 3 tools", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    await fsp.writeFile(path.join(tmpDir, "file.txt"), "old\n", "utf-8");
    await run("git", ["init"], tmpDir);
    await run("git", ["config", "user.email", "test@example.com"], tmpDir);
    await run("git", ["config", "user.name", "Test"], tmpDir);
    await run("git", ["add", "file.txt"], tmpDir);
    await run("git", ["commit", "-m", "init"], tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("updates plans, runs shell_command, applies patches, and registers image artifacts", async () => {
    const registry = new ToolRegistry();
    registry.register(new UpdatePlanTool());
    registry.register(new ShellCommandTool());
    registry.register(new ApplyPatchTool());
    registry.register(new ViewImageTool());
    const executor = new ToolExecutor({
      registry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });
    const context = {
      cwd: tmpDir,
      goalId: "goal-1",
      trustBalance: 100,
      preApproved: true,
      trusted: true,
      approvalFn: async () => true,
    };

    const plan = await executor.execute("update_plan", { steps: [{ step: "edit", status: "in_progress" }] }, context);
    expect(plan.success).toBe(true);

    const shell = await executor.execute("shell_command", { command: "pwd", cwd: tmpDir }, context);
    expect(shell.success).toBe(true);

    const patch = [
      "diff --git a/file.txt b/file.txt",
      "index 3367afd..3e75765 100644",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const applied = await executor.execute("apply_patch", { patch, cwd: tmpDir }, context);
    expect(applied.success).toBe(true);
    expect(await fsp.readFile(path.join(tmpDir, "file.txt"), "utf-8")).toBe("new\n");

    const imagePath = path.join(tmpDir, "image.png");
    await fsp.writeFile(imagePath, "not really png");
    const image = await executor.execute("view_image", { path: imagePath }, context);
    expect(image.success).toBe(true);
    expect(image.artifacts).toEqual([imagePath]);
  });
});

describe("agentloop phase 4 context injection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    await fsp.mkdir(path.join(tmpDir, ".git"));
    await fsp.writeFile(path.join(tmpDir, "AGENTS.md"), "Root instruction", "utf-8");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("loads project instructions and injects Soil prefetch blocks", async () => {
    const assembler = new AgentLoopContextAssembler();
    const assembled = await assembler.assembleTask({
      task: makeTask(),
      cwd: tmpDir,
      workspaceContext: "Workspace block",
      soilPrefetch: async (query) => ({
        content: `Soil result for ${query.rootDir}`,
        soilIds: ["soil:1"],
        retrievalSource: "manifest",
      }),
    });

    expect(assembled.userPrompt).toContain("Root instruction");
    expect(assembled.userPrompt).toContain("Workspace block");
    expect(assembled.userPrompt).toContain("Soil result");
    expect(assembled.contextBlocks.map((b) => b.id)).toContain("soil-prefetch");
  });
});

describe("agentloop phase 5 compaction", () => {
  it("NoopAgentLoopCompactor preserves history", async () => {
    const history = createAgentLoopHistory([{ role: "user", content: "hello" }]);
    const result = await new NoopAgentLoopCompactor().compact({ history });
    expect(result.compacted).toBe(false);
    expect(result.history.messages).toEqual(history.messages);
  });

  it("pre-turn auto compaction replaces long history before sampling", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      { content: JSON.stringify({ status: "done", message: "compacted", evidence: [], blockers: [] }), toolCalls: [], stopReason: "end_turn" },
    ]);
    const registry = new ToolRegistry();
    const { router, runtime } = makeRuntime(registry);
    const runner = new BoundedAgentLoopRunner({
      modelClient,
      toolRouter: router,
      toolRuntime: runtime,
      compactor: new ExtractiveAgentLoopCompactor(),
    });

    const result = await runner.run({
      session: createAgentLoopSession(),
      turnId: "turn-1",
      goalId: "goal-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "one ".repeat(120) },
        { role: "assistant", content: "two ".repeat(120) },
        { role: "user", content: "three ".repeat(120) },
        { role: "assistant", content: "four ".repeat(120) },
        { role: "user", content: "latest request" },
      ],
      outputSchema: z.object({ status: z.literal("done"), message: z.string(), evidence: z.array(z.string()), blockers: z.array(z.string()) }),
      budget: { ...defaultBudgetForTest(), autoCompactTokenLimit: 10, compactionMaxMessages: 4 },
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(result.success).toBe(true);
    expect(result.compactions).toBe(1);
    expect(modelClient.calls[0].messages.some((m) => m.content.includes("Summary of earlier agentloop context"))).toBe(true);
    expect(modelClient.calls[0].messages.length).toBeLessThan(6);
  });

  it("mid-turn auto compaction continues after tool output when usage crosses the limit", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "update_plan", input: { steps: [{ step: "work", status: "completed" }] } }],
        stopReason: "tool_use",
        usage: { inputTokens: 100, outputTokens: 100 },
      },
      { content: JSON.stringify({ status: "done", message: "continued", evidence: ["compact"], blockers: [] }), toolCalls: [], stopReason: "end_turn" },
    ]);
    const registry = new ToolRegistry();
    registry.register(new UpdatePlanTool());
    const { router, runtime } = makeRuntime(registry);
    const runner = new BoundedAgentLoopRunner({
      modelClient,
      toolRouter: router,
      toolRuntime: runtime,
      compactor: new ExtractiveAgentLoopCompactor(),
    });

    const result = await runner.run({
      session: createAgentLoopSession(),
      turnId: "turn-1",
      goalId: "goal-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
        { role: "assistant", content: "four" },
        { role: "user", content: "do it" },
      ],
      outputSchema: z.object({ status: z.literal("done"), message: z.string(), evidence: z.array(z.string()), blockers: z.array(z.string()) }),
      budget: { ...defaultBudgetForTest(), autoCompactTokenLimit: 50, compactionMaxMessages: 4 },
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(result.success).toBe(true);
    expect(result.compactions).toBe(1);
    expect(modelClient.calls[1].messages.some((m) => m.role === "tool" && m.toolName === "update_plan")).toBe(true);
    expect(modelClient.calls[1].messages.some((m) => m.content.includes("Summary of earlier agentloop context"))).toBe(true);
  });

  it("resumes from persisted compacted state after an interrupted turn", async () => {
    const statePath = path.join(makeTempDir(), "agentloop.state.json");
    const modelInfo = makeModelInfo();
    const registry = new ToolRegistry();
    registry.register(new UpdatePlanTool());
    const { router, runtime } = makeRuntime(registry);

    const firstModelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "update_plan", input: { steps: [{ step: "verify", status: "completed" }] } }],
        stopReason: "tool_use",
        usage: { inputTokens: 100, outputTokens: 100 },
      },
    ]);
    const firstRunner = new BoundedAgentLoopRunner({
      modelClient: firstModelClient,
      toolRouter: router,
      toolRuntime: runtime,
      compactor: new ExtractiveAgentLoopCompactor(),
    });

    const first = await firstRunner.run({
      session: createAgentLoopSession({
        sessionId: "session-1",
        traceId: "trace-1",
        stateStore: new JsonAgentLoopSessionStateStore(statePath),
      }),
      turnId: "turn-1",
      goalId: "goal-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "one ".repeat(120) },
        { role: "assistant", content: "two ".repeat(120) },
        { role: "user", content: "three ".repeat(120) },
        { role: "user", content: "continue after resume" },
      ],
      outputSchema: z.object({ status: z.literal("done"), message: z.string(), evidence: z.array(z.string()), blockers: z.array(z.string()) }),
      budget: { ...defaultBudgetForTest(), maxToolCalls: 1, autoCompactTokenLimit: 50, compactionMaxMessages: 4 },
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(first.success).toBe(false);
    expect(first.stopReason).toBe("max_tool_calls");
    expect(first.compactions).toBeGreaterThanOrEqual(1);

    const secondModelClient = new ScriptedModelClient(modelInfo, [
      { content: JSON.stringify({ status: "done", message: "resumed", evidence: ["plan update"], blockers: [] }), toolCalls: [], stopReason: "end_turn" },
    ]);
    const secondRunner = new BoundedAgentLoopRunner({
      modelClient: secondModelClient,
      toolRouter: router,
      toolRuntime: runtime,
      compactor: new ExtractiveAgentLoopCompactor(),
    });

    const second = await secondRunner.run({
      session: createAgentLoopSession({
        sessionId: "session-1",
        traceId: "trace-1",
        stateStore: new JsonAgentLoopSessionStateStore(statePath),
      }),
      turnId: "turn-1",
      goalId: "goal-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [{ role: "user", content: "fresh prompt should be replaced by persisted state" }],
      outputSchema: z.object({ status: z.literal("done"), message: z.string(), evidence: z.array(z.string()), blockers: z.array(z.string()) }),
      budget: { ...defaultBudgetForTest(), autoCompactTokenLimit: 50, compactionMaxMessages: 4 },
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(second.success).toBe(true);
    expect(second.compactions).toBeGreaterThanOrEqual(first.compactions);
    expect(secondModelClient.calls[0].messages.some((m) => m.content.includes("Summary of earlier agentloop context"))).toBe(true);
    expect(secondModelClient.calls[0].messages.some((m) => m.role === "tool" && m.toolName === "update_plan")).toBe(true);
  });
});

describe("agentloop phase 6 CorePhaseRunner", () => {
  it("runs schema-validated core phase evidence through the bounded runner", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      { content: JSON.stringify({ confidence: 0.2, evidence: ["premature"] }), toolCalls: [], stopReason: "end_turn" },
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "update_plan", input: { steps: [{ step: "verify", status: "completed" }] } }],
        stopReason: "tool_use",
      },
      { content: JSON.stringify({ confidence: 0.9, evidence: ["ok"] }), toolCalls: [], stopReason: "end_turn" },
    ]);
    const registry = new ToolRegistry();
    registry.register(new UpdatePlanTool());
    const { router, runtime } = makeRuntime(registry);
    const runner = new CorePhaseRunner({
      boundedRunner: new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime }),
      model: modelInfo.ref,
      modelInfo,
      cwd: process.cwd(),
    });

    const result = await runner.run(
      {
        phase: "verification_evidence",
        inputSchema: z.object({ taskId: z.string() }),
        outputSchema: z.object({ confidence: z.number(), evidence: z.array(z.string()) }),
        requiredTools: ["update_plan"],
        allowedTools: [],
        failPolicy: "fail_cycle",
      },
      { taskId: "task-1" },
      { goalId: "goal-1", taskId: "task-1" },
    );

    expect(result.success).toBe(true);
    expect(result.output?.confidence).toBe(0.9);
    expect(modelClient.calls[1].messages.some((m) => m.content.includes("required tool"))).toBe(true);
  });
});

describe("agentloop phase 7 ChatAgentLoopRunner and CoreLoopControlTools", () => {
  it("accepts plain final markdown in default display text chat mode", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "Plain **Markdown** answer.",
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const registry = new ToolRegistry();
    const { router, runtime } = makeRuntime(registry);
    const registryModel = new StaticAgentLoopModelRegistry([modelInfo]);
    const chat = new ChatAgentLoopRunner({
      boundedRunner: new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime }),
      modelClient,
      modelRegistry: registryModel,
      defaultModel: modelInfo.ref,
    });

    const result = await chat.execute({ message: "answer plainly" });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Plain **Markdown** answer.");
    expect(result.structuredOutput).toBeUndefined();
    expect(modelClient.calls).toHaveLength(1);
  });

  it("repairs empty final text before completing default display text chat mode", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "   ",
        toolCalls: [],
        stopReason: "end_turn",
      },
      {
        content: "Recovered answer.",
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const registry = new ToolRegistry();
    const { router, runtime } = makeRuntime(registry);
    const registryModel = new StaticAgentLoopModelRegistry([modelInfo]);
    const chat = new ChatAgentLoopRunner({
      boundedRunner: new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime }),
      modelClient,
      modelRegistry: registryModel,
      defaultModel: modelInfo.ref,
    });

    const result = await chat.execute({
      message: "answer plainly",
      budget: { maxSchemaRepairAttempts: 1 },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Recovered answer.");
    expect(modelClient.calls).toHaveLength(2);
    expect(modelClient.calls[1].messages.some((m) => m.content.includes("final answer was empty"))).toBe(true);
  });

  it("uses schema repair and structuredOutput only for explicit structured chat mode", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "Plain text is invalid for this structured turn.",
        toolCalls: [],
        stopReason: "end_turn",
      },
      {
        content: JSON.stringify({
          status: "done",
          answer: "Structured answer.",
          payload: { ok: true },
        }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const registry = new ToolRegistry();
    const { router, runtime } = makeRuntime(registry);
    const registryModel = new StaticAgentLoopModelRegistry([modelInfo]);
    const chat = new ChatAgentLoopRunner({
      boundedRunner: new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime }),
      modelClient,
      modelRegistry: registryModel,
      defaultModel: modelInfo.ref,
    });
    const schema = z.object({
      status: z.literal("done"),
      answer: z.string(),
      payload: z.object({ ok: z.boolean() }),
    });

    const result = await chat.execute({
      message: "return structured data",
      outputMode: { kind: "structured", schema },
      budget: { maxSchemaRepairAttempts: 1 },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Structured answer.");
    expect(result.structuredOutput).toEqual({
      status: "done",
      answer: "Structured answer.",
      payload: { ok: true },
    });
    expect(modelClient.calls).toHaveLength(2);
    expect(modelClient.calls[1].messages.some((m) => m.content.includes("required JSON schema"))).toBe(true);
  });

  it("lets chat use CoreLoop control only as tools", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "core_goal_status", input: { goalId: "goal-1" } }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({ status: "done", message: "Goal is running", evidence: ["tool result"], blockers: [] }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const registry = new ToolRegistry();
    for (const tool of createCoreLoopControlTools({
      goalStatus: async (input) => ({ goalId: input.goalId, loopStatus: "running" }),
    })) {
      registry.register(tool);
    }
    const { router, runtime } = makeRuntime(registry);
    const registryModel = new StaticAgentLoopModelRegistry([modelInfo]);
    const chat = new ChatAgentLoopRunner({
      boundedRunner: new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime }),
      modelClient,
      modelRegistry: registryModel,
      defaultModel: modelInfo.ref,
      defaultToolPolicy: { allowedTools: ["core_goal_status"] },
    });

    const result = await chat.execute({ message: "status?", goalId: "goal-1" });

    expect(result.success).toBe(true);
    expect(result.output.startsWith("Goal is running")).toBe(true);
    expect(result.output).toContain("### Evidence");
    expect(modelClient.calls[1].messages.some((m) => m.role === "tool" && m.toolName === "core_goal_status")).toBe(true);
  });

  it("emits approval_request and continues when chat approval is granted", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "approval_tool", input: { value: "ship" } }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({ status: "done", message: "approved path", evidence: ["tool result"], blockers: [] }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const registry = new ToolRegistry();
    registry.register(new ApprovalTool());
    const { router, runtime } = makeRuntime(registry);
    const registryModel = new StaticAgentLoopModelRegistry([modelInfo]);
    const events: Array<{ type: string; toolName?: string; reason?: string }> = [];
    const chat = new ChatAgentLoopRunner({
      boundedRunner: new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime }),
      modelClient,
      modelRegistry: registryModel,
      defaultModel: modelInfo.ref,
      defaultToolPolicy: { allowedTools: ["approval_tool"] },
    });

    const result = await chat.execute({
      message: "do it",
      goalId: "goal-1",
      approvalFn: async () => true,
      eventSink: {
        emit(event) {
          events.push({
            type: event.type,
            ...("toolName" in event ? { toolName: event.toolName } : {}),
            ...("reason" in event ? { reason: event.reason } : {}),
          });
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.output.startsWith("approved path")).toBe(true);
    expect(result.output).toContain("### Evidence");
    expect(events.some((event) => event.type === "approval_request" && event.toolName === "approval_tool")).toBe(true);
    expect(modelClient.calls[1].messages.some((m) => m.role === "tool" && m.toolName === "approval_tool")).toBe(true);
  });

  it("uses the latest chat input even when a state file path is provided and reused", async () => {
    const stateDir = makeTempDir();
    const statePath = path.join(stateDir, "chat.state.json");
    try {
      const modelInfo = makeModelInfo();
      const modelClient = new ScriptedModelClient(modelInfo, [
        {
          content: JSON.stringify({ status: "done", message: "first", evidence: [], blockers: [] }),
          toolCalls: [],
          stopReason: "end_turn",
        },
        {
          content: JSON.stringify({ status: "done", message: "second", evidence: [], blockers: [] }),
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);
      const registry = new ToolRegistry();
      const { router, runtime } = makeRuntime(registry);
      const registryModel = new StaticAgentLoopModelRegistry([modelInfo]);
      const chat = new ChatAgentLoopRunner({
        boundedRunner: new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime }),
        modelClient,
        modelRegistry: registryModel,
        defaultModel: modelInfo.ref,
        createSession: (input) =>
          createAgentLoopSession({
            sessionId: "chat-session",
            traceId: "chat-trace",
            stateStore: new JsonAgentLoopSessionStateStore(input.resumeStatePath ?? statePath),
          }),
      });

      await chat.execute({ message: "first input", resumeStatePath: statePath });
      await chat.execute({ message: "second input", resumeStatePath: statePath });

      const firstLastUser = [...modelClient.calls[0].messages].reverse().find((message) => message.role === "user")?.content ?? "";
      const secondLastUser = [...modelClient.calls[1].messages].reverse().find((message) => message.role === "user")?.content ?? "";
      expect(firstLastUser).toContain("first input");
      expect(secondLastUser).toContain("second input");
      expect(secondLastUser).not.toContain("first input");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("loads persisted state for explicit resumeOnly chat turns", async () => {
    const stateDir = makeTempDir();
    const statePath = path.join(stateDir, "chat-resume.state.json");
    try {
      const modelInfo = makeModelInfo();
      const modelClient = new ScriptedModelClient(modelInfo, [
        {
          content: JSON.stringify({ status: "done", message: "initial", evidence: [], blockers: [] }),
          toolCalls: [],
          stopReason: "end_turn",
        },
        {
          content: JSON.stringify({ status: "done", message: "resumed", evidence: [], blockers: [] }),
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);
      const registry = new ToolRegistry();
      const { router, runtime } = makeRuntime(registry);
      const registryModel = new StaticAgentLoopModelRegistry([modelInfo]);
      const chat = new ChatAgentLoopRunner({
        boundedRunner: new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime }),
        modelClient,
        modelRegistry: registryModel,
        defaultModel: modelInfo.ref,
        createSession: () =>
          createAgentLoopSession({
            sessionId: "resume-session",
            traceId: "resume-trace",
            stateStore: new JsonAgentLoopSessionStateStore(statePath),
          }),
      });

      await chat.execute({ message: "persist this input" });
      await chat.execute({ message: "fresh input should be ignored on resume", resumeOnly: true });

      const secondUserMessages = modelClient.calls[1].messages
        .filter((message) => message.role === "user")
        .map((message) => message.content);
      expect(secondUserMessages.some((content) => content.includes("persist this input"))).toBe(true);
      expect(secondUserMessages.some((content) => content.includes("fresh input should be ignored on resume"))).toBe(false);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd });
    let stderr = "";
    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (chunk: string) => { stderr += chunk; });
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `${command} failed`)));
  });
}

function defaultBudgetForTest() {
  return {
    maxModelTurns: 12,
    maxToolCalls: 40,
    maxWallClockMs: 10 * 60 * 1000,
    maxConsecutiveToolErrors: 3,
    maxRepeatedToolCalls: 4,
    maxSchemaRepairAttempts: 2,
    maxCompletionValidationAttempts: 2,
    maxCompactions: 3,
    compactionMaxMessages: 8,
  };
}
