import { describe, expect, it, vi } from "vitest";
import type { ILLMClient } from "../../../../base/llm/llm-client.js";
import type { ProviderConfig } from "../../../../base/llm/provider-config.js";
import { createBuiltinTools } from "../../../../tools/builtin/index.js";
import { ToolRegistry } from "../../../../tools/registry.js";
import { ToolExecutor } from "../../../../tools/executor.js";
import { ToolPermissionManager } from "../../../../tools/permission.js";
import { ConcurrencyController } from "../../../../tools/concurrency.js";
import { ToolRegistryAgentLoopToolRouter } from "../agent-loop-tool-router.js";
import { resolveAgentLoopDefaultProfileFromProviderConfig } from "../agent-loop-default-profile.js";
import {
  createNativeChatAgentLoopRunner,
  createNativeReviewAgentLoopRunner,
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
        base_dir: "/tmp/provider-worktrees",
        keep_for_debug: true,
        cleanup_policy: "always",
      },
    },
  } as ProviderConfig;
}

function makeProviderConfigWithoutAgentLoop(): ProviderConfig {
  return {
    provider: "openai",
    model: "gpt-5.4-mini",
    adapter: "openai_codex_cli",
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
    const profile = resolveAgentLoopDefaultProfileFromProviderConfig({
      surface: "task",
      workspaceRoot: "/repo",
      providerConfig,
    });

    expect(deps.defaultBudget).toEqual(profile.budget);
    expect(deps.defaultToolPolicy).toEqual(profile.toolPolicy);
    expect(deps.defaultReasoningEffort).toBe(profile.reasoningEffort);
    expect(deps.defaultProfileName).toBe(profile.name);
    expect(deps.defaultExecutionPolicy).toEqual(profile.executionPolicy);
    expect(deps.defaultWorktreePolicy).toEqual(profile.worktreePolicy);
    expect(profile.worktreePolicy).toEqual({
      enabled: true,
      baseDir: "/tmp/provider-worktrees",
      keepForDebug: true,
      cleanupPolicy: "always",
    });
  });

  it("restores fallback task defaults when provider config omits agent_loop settings", () => {
    const providerConfig = makeProviderConfigWithoutAgentLoop();
    const registry = new ToolRegistry();
    const runner = createNativeTaskAgentLoopRunner({
      llmClient: makeLlmClient(),
      providerConfig,
      toolRegistry: registry,
      toolExecutor: makeToolExecutor(registry),
      cwd: "/repo",
    });

    const deps = (runner as unknown as { deps: Record<string, unknown> }).deps;
    const profile = resolveAgentLoopDefaultProfileFromProviderConfig({
      surface: "task",
      workspaceRoot: "/repo",
      providerConfig,
    });

    expect(deps.defaultBudget).toEqual(profile.budget);
    expect(deps.defaultToolPolicy).toEqual(profile.toolPolicy);
    expect(deps.defaultReasoningEffort).toBe(profile.reasoningEffort);
    expect(deps.defaultProfileName).toBe(profile.name);
    expect(deps.defaultExecutionPolicy).toEqual(profile.executionPolicy);
    expect(deps.defaultWorktreePolicy).toEqual(profile.worktreePolicy);
    expect(profile.executionPolicy).toMatchObject({
      sandboxMode: "workspace_write",
      approvalPolicy: "never",
      networkAccess: false,
      trustProjectInstructions: true,
    });
    expect(profile.worktreePolicy).toEqual({
      enabled: true,
      cleanupPolicy: "on_success",
    });
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
    const profile = resolveAgentLoopDefaultProfileFromProviderConfig({
      surface: "chat",
      workspaceRoot: "/repo",
      providerConfig,
    });

    expect(deps.defaultBudget).toEqual(profile.budget);
    expect(deps.defaultToolPolicy).toEqual(profile.toolPolicy);
    expect(deps.defaultReasoningEffort).toBe(profile.reasoningEffort);
    expect(deps.defaultProfileName).toBe(profile.name);
    expect(deps.defaultExecutionPolicy).toEqual(profile.executionPolicy);
    expect(profile.toolPolicy.allowedTools).toEqual(
      expect.arrayContaining([
        "kaggle_workspace_prepare",
        "kaggle_experiment_start",
        "kaggle_experiment_read",
        "kaggle_experiment_list",
        "kaggle_experiment_stop",
        "kaggle_metric_report",
        "kaggle_compare_experiments",
        "kaggle_submission_prepare",
        "kaggle_list_submissions",
        "kaggle_leaderboard_snapshot",
      ]),
    );
    expect(profile.toolPolicy.allowedTools).not.toContain("kaggle_submit");
  });

  it("makes registered Kaggle training tools model-visible in chat while hiding submit", () => {
    const providerConfig = makeProviderConfig();
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({ registry })) {
      registry.register(tool);
    }
    const profile = resolveAgentLoopDefaultProfileFromProviderConfig({
      surface: "chat",
      workspaceRoot: "/repo",
      providerConfig,
    });
    const router = new ToolRegistryAgentLoopToolRouter(registry);

    const visibleTools = router.modelVisibleTools({
      cwd: "/repo",
      goalId: "chat",
      toolPolicy: profile.toolPolicy,
    } as never).map((tool) => tool.function.name);

    expect(visibleTools).toEqual(
      expect.arrayContaining([
        "kaggle_workspace_prepare",
        "kaggle_experiment_start",
        "kaggle_experiment_read",
        "kaggle_experiment_list",
        "kaggle_experiment_stop",
        "kaggle_metric_report",
        "kaggle_compare_experiments",
        "kaggle_submission_prepare",
        "kaggle_list_submissions",
        "kaggle_leaderboard_snapshot",
      ]),
    );
    expect(visibleTools).not.toContain("kaggle_submit");
  });

  it("keeps review profile defaults for budget, tools, and execution posture", () => {
    const providerConfig = makeProviderConfig();
    const registry = new ToolRegistry();
    const runner = createNativeReviewAgentLoopRunner({
      llmClient: makeLlmClient(),
      providerConfig,
      toolRegistry: registry,
      toolExecutor: makeToolExecutor(registry),
      cwd: "/repo",
    });

    const deps = (runner as unknown as { deps: Record<string, unknown> }).deps;
    const profile = resolveAgentLoopDefaultProfileFromProviderConfig({
      surface: "review",
      workspaceRoot: "/repo",
      providerConfig,
    });

    expect(deps.defaultBudget).toEqual(profile.budget);
    expect(deps.defaultToolPolicy).toEqual(profile.toolPolicy);
    expect(deps.defaultReasoningEffort).toBe(profile.reasoningEffort);
    expect(deps.defaultExecutionPolicy).toEqual(profile.executionPolicy);
  });
});
