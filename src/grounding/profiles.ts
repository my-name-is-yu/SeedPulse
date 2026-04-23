import type {
  GroundingInclusionPolicy,
  GroundingProfile,
  GroundingProfileId,
  GroundingRequest,
} from "./contracts.js";

const allOff = (): GroundingInclusionPolicy => ({
  identity: false,
  execution_policy: false,
  approval_policy: false,
  trust_state: false,
  repo_instructions: false,
  goal_state: false,
  task_state: false,
  progress_history: false,
  session_history: false,
  soil_knowledge: false,
  knowledge_query: false,
  lessons: false,
  provider_state: false,
  plugins: false,
  workspace_facts: false,
});

const PROFILES: Record<GroundingProfileId, GroundingProfile> = {
  "chat/general_turn": {
    id: "chat/general_turn",
    surface: "chat",
    purpose: "general_turn",
    include: {
      ...allOff(),
      identity: true,
      execution_policy: true,
      approval_policy: true,
      trust_state: true,
      repo_instructions: true,
      goal_state: true,
      provider_state: true,
      plugins: true,
      soil_knowledge: true,
    },
    budgets: {
      maxTokens: 2200,
      maxGoalCount: 8,
      maxTaskCount: 8,
      maxHistoryMessages: 6,
      maxProgressEntries: 5,
      maxKnowledgeHits: 4,
      maxRepoInstructionChars: 20_000,
    },
  },
  "chat/handoff": {
    id: "chat/handoff",
    surface: "chat",
    purpose: "handoff",
    include: {
      ...allOff(),
      identity: true,
      execution_policy: true,
      approval_policy: true,
      trust_state: true,
      repo_instructions: true,
      goal_state: true,
      task_state: true,
      progress_history: true,
      session_history: true,
      soil_knowledge: true,
      knowledge_query: true,
      lessons: true,
      provider_state: true,
      plugins: true,
      workspace_facts: true,
    },
    budgets: {
      maxTokens: 3200,
      maxGoalCount: 8,
      maxTaskCount: 10,
      maxHistoryMessages: 10,
      maxProgressEntries: 8,
      maxKnowledgeHits: 5,
      maxRepoInstructionChars: 24_000,
    },
  },
  "agent_loop/task_execution": {
    id: "agent_loop/task_execution",
    surface: "agent_loop",
    purpose: "task_execution",
    include: {
      ...allOff(),
      identity: true,
      execution_policy: true,
      approval_policy: true,
      repo_instructions: true,
      soil_knowledge: true,
      knowledge_query: true,
      lessons: true,
      workspace_facts: true,
      task_state: true,
      goal_state: true,
    },
    budgets: {
      maxTokens: 2600,
      maxGoalCount: 4,
      maxTaskCount: 8,
      maxHistoryMessages: 4,
      maxProgressEntries: 4,
      maxKnowledgeHits: 4,
      maxRepoInstructionChars: 20_000,
    },
  },
  "core_loop/verification": {
    id: "core_loop/verification",
    surface: "core_loop",
    purpose: "verification",
    include: {
      ...allOff(),
      identity: true,
      execution_policy: true,
      approval_policy: true,
      trust_state: true,
      repo_instructions: true,
      goal_state: true,
      task_state: true,
      progress_history: true,
      soil_knowledge: true,
      knowledge_query: true,
      workspace_facts: true,
    },
    budgets: {
      maxTokens: 2600,
      maxGoalCount: 4,
      maxTaskCount: 8,
      maxHistoryMessages: 4,
      maxProgressEntries: 6,
      maxKnowledgeHits: 4,
      maxRepoInstructionChars: 16_000,
    },
  },
};

export function profileIdForRequest(request: GroundingRequest): GroundingProfileId {
  if (request.surface === "chat" && request.purpose === "handoff") {
    return "chat/handoff";
  }
  if (request.surface === "agent_loop" && request.purpose === "task_execution") {
    return "agent_loop/task_execution";
  }
  if (request.surface === "core_loop" && request.purpose === "verification") {
    return "core_loop/verification";
  }
  return "chat/general_turn";
}

export function resolveGroundingProfile(request: GroundingRequest): GroundingProfile {
  const base = PROFILES[profileIdForRequest(request)];
  return {
    ...base,
    include: {
      ...base.include,
      ...(request.include ?? {}),
    },
    budgets: {
      ...base.budgets,
      ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
    },
  };
}
