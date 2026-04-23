import { describe, expect, it, vi } from "vitest";
import type { ILLMClient } from "../../../../base/llm/llm-client.js";
import type { ProviderConfig } from "../../../../base/llm/provider-config.js";
import { ToolRegistry } from "../../../../tools/registry.js";
import { ToolExecutor } from "../../../../tools/executor.js";
import { ToolPermissionManager } from "../../../../tools/permission.js";
import { ConcurrencyController } from "../../../../tools/concurrency.js";
import { resolveAgentLoopDefaultProfile } from "../agent-loop-default-profile.js";
import {
  createNativeChatAgentLoopRunner,
  createNativeTaskAgentLoopRunner,
} from "../task-agent-loop-factory.js";

function makeProviderConfig(): ProviderConfig {
  return {
    provider: "openai",
    model: "gpt-5.4-mini",
    adapter: "openai_codex_cli",
    agent_loop: {
      security: {
        sandbox_mode: "workspace_write",
        approval_policy: "on_request",
        network_access: false,
        trust_project_instructions: true,
      },
      worktree: {
        enabled: true,
        cleanupPolicy: "always",
      },
    },
  } as ProviderConfig;
}

function makeLlmClient(): ILLMClient {
  return {
    supportsToolCalling: vi.fn().mockReturnValue(false),
  } as unknown as ILLMClient;
}

function makeToolExecutor(registry: ToolRegistry): ToolExecutor {
  return new ToolExecutor({
    registry,
    permissionManager: new ToolPermissionManager({}),
    concurrency: new ConcurrencyController(),
  });
}

describe("createNative*AgentLoopRunner", () => {
  it("keeps task profile defaults for budget, reasoning, and worktree policy", () => {
    const providerConfig = makeProviderConfig();
    const registry = new ToolRegistry();
    const runner = createNativeTaskAgentLoopRunner({
      llmClient: makeLlmClient(),
      providerConfig,
      toolRegistry: registry,
      toolExecutor: makeToolExecutor(registry),
      cwd: "/repo",
    });

    const deps = (runner as unknown as { deps: Record<string, unknown> }).deps;
    const profile = resolveAgentLoopDefaultProfile({
      surface: "task",
      workspaceRoot: "/repo",
      security: providerConfig.agent_loop?.security,
      worktreePolicy: providerConfig.agent_loop?.worktree,
    });

    expect(deps.defaultBudget).toEqual(profile.budget);
    expect(deps.defaultToolPolicy).toEqual(profile.toolPolicy);
    expect(deps.defaultReasoningEffort).toBe(profile.reasoningEffort);
    expect(deps.defaultProfileName).toBe(profile.name);
    expect(deps.defaultExecutionPolicy).toEqual(profile.executionPolicy);
    expect(deps.defaultWorktreePolicy).toEqual(profile.worktreePolicy);
  });

  it("keeps chat profile defaults for budget, reasoning, and execution policy", () => {
    const providerConfig = makeProviderConfig();
    const registry = new ToolRegistry();
    const runner = createNativeChatAgentLoopRunner({
      llmClient: makeLlmClient(),
      providerConfig,
      toolRegistry: registry,
      toolExecutor: makeToolExecutor(registry),
      cwd: "/repo",
    });

    const deps = (runner as unknown as { deps: Record<string, unknown> }).deps;
    const profile = resolveAgentLoopDefaultProfile({
      surface: "chat",
      workspaceRoot: "/repo",
      security: providerConfig.agent_loop?.security,
    });

    expect(deps.defaultBudget).toEqual(profile.budget);
    expect(deps.defaultToolPolicy).toEqual(profile.toolPolicy);
    expect(deps.defaultReasoningEffort).toBe(profile.reasoningEffort);
    expect(deps.defaultProfileName).toBe(profile.name);
    expect(deps.defaultExecutionPolicy).toEqual(profile.executionPolicy);
  });
});
