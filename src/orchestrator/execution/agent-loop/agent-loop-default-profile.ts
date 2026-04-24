import type { AgentLoopBudget } from "./agent-loop-budget.js";
import type { CorePhaseKind } from "./core-phase-runner.js";
import type { AgentLoopSecurityConfig, ExecutionPolicy } from "./execution-policy.js";
import { resolveExecutionPolicy, withExecutionPolicyOverrides } from "./execution-policy.js";
import type { AgentLoopReasoningEffort } from "./agent-loop-model.js";
import type { AgentLoopToolPolicy } from "./agent-loop-turn-context.js";
import { withDefaultBudget } from "./agent-loop-turn-context.js";
import type { AgentLoopWorktreePolicy } from "./task-agent-loop-worktree.js";
import type { ProviderConfig } from "../../../base/llm/provider-config.js";
import { resolveProviderNativeAgentLoopDefaults } from "../../../base/llm/provider-config.js";

export type AgentLoopDefaultProfileName =
  | "task"
  | "chat"
  | "review"
  | `core_phase:${CorePhaseKind}`;

export interface AgentLoopResolvedProfile {
  name: AgentLoopDefaultProfileName;
  budget: AgentLoopBudget;
  toolPolicy: AgentLoopToolPolicy;
  executionPolicy?: ExecutionPolicy;
  reasoningEffort?: AgentLoopReasoningEffort;
  worktreePolicy?: AgentLoopWorktreePolicy;
  corePhase?: {
    enabled: boolean;
    maxInvocationsPerIteration: number;
    failPolicy: "return_low_confidence" | "fallback_deterministic" | "fail_cycle";
  };
}

export interface AgentLoopResolvedProfileSummary {
  profileId: AgentLoopDefaultProfileName;
  resolvedPosture: string;
}

interface CorePhaseProfileDefaults {
  enabled: boolean;
  maxInvocationsPerIteration: number;
  budget: Partial<AgentLoopBudget>;
  toolPolicy: AgentLoopToolPolicy;
  failPolicy: "return_low_confidence" | "fallback_deterministic" | "fail_cycle";
}

interface SurfaceProfileInput {
  surface: "task" | "chat" | "review";
  workspaceRoot: string;
  security?: AgentLoopSecurityConfig;
  budget?: Partial<AgentLoopBudget>;
  toolPolicy?: AgentLoopToolPolicy;
  worktreePolicy?: AgentLoopWorktreePolicy;
  reasoningEffort?: AgentLoopReasoningEffort;
}

interface CorePhaseProfileInput {
  surface: "core_phase";
  phase: CorePhaseKind;
  budget?: Partial<AgentLoopBudget>;
  toolPolicy?: AgentLoopToolPolicy;
  enabled?: boolean;
  maxInvocationsPerIteration?: number;
  failPolicy?: "return_low_confidence" | "fallback_deterministic" | "fail_cycle";
}

export type ResolveAgentLoopDefaultProfileInput =
  | SurfaceProfileInput
  | CorePhaseProfileInput;

export interface ResolveAgentLoopDefaultProfileFromProviderConfigInput {
  surface: "task" | "chat" | "review";
  workspaceRoot: string;
  providerConfig?: Pick<ProviderConfig, "agent_loop">;
  budget?: Partial<AgentLoopBudget>;
  toolPolicy?: AgentLoopToolPolicy;
  worktreePolicy?: AgentLoopWorktreePolicy;
  reasoningEffort?: AgentLoopReasoningEffort;
}

const DEFAULT_SURFACE_PROFILE = {
  budget: withDefaultBudget(),
  toolPolicy: {},
} as const;

const DEFAULT_CORE_PHASE_BUDGET: Partial<Record<CorePhaseKind, Partial<AgentLoopBudget>>> = {
  observe_evidence: {
    maxModelTurns: 6,
    maxToolCalls: 8,
    maxWallClockMs: 90_000,
    compactionMaxMessages: 6,
  },
  wait_observation: {
    maxModelTurns: 3,
    maxToolCalls: 8,
    maxWallClockMs: 45_000,
    maxRepeatedToolCalls: 1,
    compactionMaxMessages: 4,
  },
  knowledge_refresh: {
    maxModelTurns: 6,
    maxToolCalls: 8,
    maxWallClockMs: 90_000,
    compactionMaxMessages: 6,
  },
  stall_investigation: {
    maxModelTurns: 4,
    maxToolCalls: 5,
    maxWallClockMs: 60_000,
    compactionMaxMessages: 6,
  },
  replanning_options: {
    maxModelTurns: 4,
    maxToolCalls: 4,
    maxWallClockMs: 60_000,
    compactionMaxMessages: 6,
  },
  verification_evidence: {
    maxModelTurns: 6,
    maxToolCalls: 8,
    maxWallClockMs: 90_000,
    compactionMaxMessages: 6,
  },
};

const CHAT_ALLOWED_TOOLS = [
  "read-pulseed-file",
  "glob",
  "grep",
  "list_dir",
  "git_diff",
  "git_log",
  "shell_command",
  "apply_patch",
  "file_edit",
  "file_write",
  "json_query",
  "test-runner",
  "task_get",
  "goal_state",
  "progress_history",
  "session_history",
  "tool_search",
  "update_plan",
  "soil_query",
  "knowledge_query",
  "memory_recall",
] as const;

const REVIEW_ALLOWED_TOOLS = [
  "read-pulseed-file",
  "glob",
  "grep",
  "git_diff",
  "git_log",
  "shell_command",
  "test-runner",
  "task_get",
  "goal_state",
  "progress_history",
  "session_history",
  "soil_query",
  "knowledge_query",
] as const;

const CORE_PHASE_PROFILE_DEFAULTS: Record<CorePhaseKind, CorePhaseProfileDefaults> = {
  observe_evidence: {
    enabled: true,
    maxInvocationsPerIteration: 1,
    budget: DEFAULT_CORE_PHASE_BUDGET.observe_evidence ?? {},
    toolPolicy: {
      allowedTools: [
        "read-pulseed-file",
        "glob",
        "grep",
        "git_log",
        "shell_command",
        "soil_query",
        "tool_search",
      ],
    },
    failPolicy: "fallback_deterministic",
  },
  wait_observation: {
    enabled: true,
    maxInvocationsPerIteration: 1,
    budget: DEFAULT_CORE_PHASE_BUDGET.wait_observation ?? {},
    toolPolicy: {
      allowedTools: [
        "process_session_read",
        "process_session_list",
        "process-status",
        "goal_state",
        "task_get",
        "progress_history",
        "read-pulseed-file",
        "json_query",
        "glob",
      ],
      requiredTools: ["process_session_read", "process_session_list"],
    },
    failPolicy: "return_low_confidence",
  },
  knowledge_refresh: {
    enabled: true,
    maxInvocationsPerIteration: 1,
    budget: DEFAULT_CORE_PHASE_BUDGET.knowledge_refresh ?? {},
    toolPolicy: {
      allowedTools: [
        "soil_query",
        "knowledge_query",
        "read-pulseed-file",
        "grep",
      ],
      requiredTools: ["soil_query"],
    },
    failPolicy: "return_low_confidence",
  },
  stall_investigation: {
    enabled: true,
    maxInvocationsPerIteration: 1,
    budget: DEFAULT_CORE_PHASE_BUDGET.stall_investigation ?? {},
    toolPolicy: {
      allowedTools: [
        "read-pulseed-file",
        "glob",
        "grep",
        "git_log",
        "shell_command",
        "progress_history",
        "tool_search",
      ],
    },
    failPolicy: "return_low_confidence",
  },
  replanning_options: {
    enabled: true,
    maxInvocationsPerIteration: 1,
    budget: DEFAULT_CORE_PHASE_BUDGET.replanning_options ?? {},
    toolPolicy: {
      allowedTools: [
        "task_get",
        "goal_state",
        "progress_history",
        "soil_query",
      ],
    },
    failPolicy: "fallback_deterministic",
  },
  verification_evidence: {
    enabled: true,
    maxInvocationsPerIteration: 1,
    budget: DEFAULT_CORE_PHASE_BUDGET.verification_evidence ?? {},
    toolPolicy: {
      allowedTools: [
        "read-pulseed-file",
        "glob",
        "grep",
        "git_diff",
        "git_log",
        "test-runner",
        "shell_command",
      ],
    },
    failPolicy: "return_low_confidence",
  },
};

export function resolveAgentLoopDefaultProfile(
  input: ResolveAgentLoopDefaultProfileInput,
): AgentLoopResolvedProfile {
  if (input.surface === "core_phase") {
    const defaults = CORE_PHASE_PROFILE_DEFAULTS[input.phase];
    return {
      name: `core_phase:${input.phase}`,
      budget: withDefaultBudget({ ...defaults.budget, ...input.budget }),
      toolPolicy: mergeToolPolicy(defaults.toolPolicy, input.toolPolicy),
      reasoningEffort: "low",
      corePhase: {
        enabled: input.enabled ?? defaults.enabled,
        maxInvocationsPerIteration: input.maxInvocationsPerIteration ?? defaults.maxInvocationsPerIteration,
        failPolicy: input.failPolicy ?? defaults.failPolicy,
      },
    };
  }

  const executionPolicy = resolveExecutionPolicy({
    workspaceRoot: input.workspaceRoot,
    security: input.security,
  });

  if (input.surface === "review") {
    return {
      name: "review",
      budget: withDefaultBudget({
        ...DEFAULT_SURFACE_PROFILE.budget,
        maxModelTurns: 6,
        maxToolCalls: 10,
        ...input.budget,
      }),
      toolPolicy: mergeToolPolicy(
        {
          allowedTools: REVIEW_ALLOWED_TOOLS,
        },
        input.toolPolicy,
      ),
      executionPolicy: withExecutionPolicyOverrides(executionPolicy, {
        sandboxMode: "read_only",
        approvalPolicy: "never",
      }),
      reasoningEffort: input.reasoningEffort ?? "medium",
    };
  }

  if (input.surface === "chat") {
    return {
      name: "chat",
      budget: withDefaultBudget({ ...DEFAULT_SURFACE_PROFILE.budget, ...input.budget }),
      toolPolicy: mergeToolPolicy(
        {
          ...DEFAULT_SURFACE_PROFILE.toolPolicy,
          allowedTools: CHAT_ALLOWED_TOOLS,
        },
        input.toolPolicy,
      ),
      executionPolicy,
      reasoningEffort: input.reasoningEffort ?? "low",
    };
  }

  return {
    name: "task",
    budget: withDefaultBudget({ ...DEFAULT_SURFACE_PROFILE.budget, ...input.budget }),
    toolPolicy: mergeToolPolicy(DEFAULT_SURFACE_PROFILE.toolPolicy, input.toolPolicy),
    executionPolicy: withExecutionPolicyOverrides(executionPolicy, {
      approvalPolicy: "never",
    }),
    worktreePolicy: mergeWorktreePolicy(
      { enabled: true, cleanupPolicy: "on_success" },
      input.worktreePolicy,
    ),
    reasoningEffort: input.reasoningEffort ?? "medium",
  };
}

export function resolveAgentLoopDefaultProfileFromProviderConfig(
  input: ResolveAgentLoopDefaultProfileFromProviderConfigInput,
): AgentLoopResolvedProfile {
  const providerDefaults = resolveProviderNativeAgentLoopDefaults(input.providerConfig);
  return resolveAgentLoopDefaultProfile({
    surface: input.surface,
    workspaceRoot: input.workspaceRoot,
    security: providerDefaults.security,
    budget: input.budget,
    toolPolicy: input.toolPolicy,
    worktreePolicy: mergeWorktreePolicy(providerDefaults.worktreePolicy, input.worktreePolicy),
    reasoningEffort: input.reasoningEffort,
  });
}

export function summarizeAgentLoopResolvedProfile(
  profile: Pick<
    AgentLoopResolvedProfile,
    "name" | "executionPolicy" | "reasoningEffort" | "worktreePolicy"
  >,
  executionPolicy = profile.executionPolicy,
): AgentLoopResolvedProfileSummary {
  const posture = executionPolicy
    ? [
        `sandbox=${executionPolicy.sandboxMode}`,
        `approval=${executionPolicy.approvalPolicy}`,
        `network=${executionPolicy.networkAccess ? "on" : "off"}`,
      ]
    : ["execution=unset"];

  if (profile.worktreePolicy) {
    posture.push(`worktree=${profile.worktreePolicy.enabled ? "on" : "off"}`);
  }
  if (profile.reasoningEffort) {
    posture.push(`reasoning=${profile.reasoningEffort}`);
  }

  return {
    profileId: profile.name,
    resolvedPosture: posture.join(" "),
  };
}

export function formatAgentLoopResolvedProfileSummary(
  summary: AgentLoopResolvedProfileSummary,
): string {
  return [
    `profile_id: ${summary.profileId}`,
    `resolved_posture: ${summary.resolvedPosture}`,
  ].join("\n");
}

function mergeToolPolicy(
  base: AgentLoopToolPolicy | undefined,
  override?: AgentLoopToolPolicy,
): AgentLoopToolPolicy {
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

function mergeWorktreePolicy(
  base: AgentLoopWorktreePolicy | undefined,
  override: AgentLoopWorktreePolicy | undefined,
): AgentLoopWorktreePolicy | undefined {
  if (!base && !override) return undefined;
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}
