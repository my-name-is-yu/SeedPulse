import type { StateManager } from "../base/state/state-manager.js";

export type GroundingSurface = "chat" | "agent_loop" | "core_loop";

export type GroundingPurpose =
  | "general_turn"
  | "task_execution"
  | "replanning"
  | "verification"
  | "knowledge_refresh"
  | "handoff";

export type GroundingProfileId =
  | "chat/general_turn"
  | "chat/handoff"
  | "agent_loop/task_execution"
  | "core_loop/verification";

export type GroundingSectionKey =
  | "identity"
  | "execution_policy"
  | "approval_policy"
  | "trust_state"
  | "repo_instructions"
  | "goal_state"
  | "task_state"
  | "progress_history"
  | "session_history"
  | "soil_knowledge"
  | "knowledge_query"
  | "lessons"
  | "provider_state"
  | "plugins"
  | "workspace_facts";

export interface GroundingSection {
  key: GroundingSectionKey;
  title: string;
  priority: number;
  estimatedTokens: number;
  content: string;
  sources: GroundingSourceRef[];
}

export interface GroundingSourceRef {
  sectionKey: GroundingSectionKey;
  type: "file" | "state" | "tool" | "derived" | "none";
  label: string;
  path?: string;
  trusted?: boolean;
  accepted?: boolean;
  retrievalId?: string;
  metadata?: Record<string, unknown>;
}

export interface GroundingBundleMetrics {
  totalEstimatedTokens: number;
  buildMs: number;
  cacheHits: number;
}

export interface GroundingBundleTraces {
  source: GroundingSourceRef[];
  retrievalIds: string[];
}

export interface GroundingBundle {
  profile: GroundingProfileId;
  staticSections: GroundingSection[];
  dynamicSections: GroundingSection[];
  warnings: string[];
  metrics: GroundingBundleMetrics;
  traces: GroundingBundleTraces;
  render(format?: "prompt" | "debug-json"): string | Record<string, unknown>;
}

export interface GroundingInclusionPolicy {
  identity: boolean;
  execution_policy: boolean;
  approval_policy: boolean;
  trust_state: boolean;
  repo_instructions: boolean;
  goal_state: boolean;
  task_state: boolean;
  progress_history: boolean;
  session_history: boolean;
  soil_knowledge: boolean;
  knowledge_query: boolean;
  lessons: boolean;
  provider_state: boolean;
  plugins: boolean;
  workspace_facts: boolean;
}

export interface GroundingProfileBudgets {
  maxTokens: number;
  maxGoalCount: number;
  maxTaskCount: number;
  maxHistoryMessages: number;
  maxProgressEntries: number;
  maxKnowledgeHits: number;
  maxRepoInstructionChars: number;
}

export interface GroundingProfile {
  id: GroundingProfileId;
  surface: GroundingSurface;
  purpose: GroundingPurpose;
  include: GroundingInclusionPolicy;
  budgets: GroundingProfileBudgets;
}

export interface GroundingMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GroundingSoilHit {
  soilId: string;
  title: string;
  summary?: string | null;
  snippet?: string;
  score?: number;
}

export interface GroundingSoilResult {
  retrievalSource: "sqlite" | "index" | "manifest" | "prefetch";
  warnings: string[];
  hits: GroundingSoilHit[];
}

export interface GroundingKnowledgeItem {
  id: string;
  content: string;
  source: string;
  confidence?: number;
  relevance?: number;
}

export interface GroundingKnowledgeResult {
  retrievalId?: string;
  warnings?: string[];
  items: GroundingKnowledgeItem[];
}

export interface GroundingLessonResult {
  items: GroundingKnowledgeItem[];
}

export interface GroundingRequest {
  surface: GroundingSurface;
  purpose: GroundingPurpose;
  workspaceRoot?: string;
  goalId?: string;
  taskId?: string;
  query?: string;
  userMessage?: string;
  maxTokens?: number;
  include?: Partial<GroundingInclusionPolicy>;
  homeDir?: string;
  trustProjectInstructions?: boolean;
  workspaceContext?: string;
  knowledgeContext?: string;
  recentMessages?: GroundingMessage[];
  compactionSummary?: string;
  soilQuery?: (input: { query: string; rootDir: string; limit: number }) => Promise<GroundingSoilResult | null>;
  knowledgeQuery?: (input: { query: string; goalId?: string; limit: number }) => Promise<GroundingKnowledgeResult | null>;
  lessonsQuery?: (input: { query: string; goalId?: string; limit: number }) => Promise<GroundingLessonResult | null>;
}

export interface GroundingGatewayDeps {
  stateManager?: StateManager;
  pluginLoader?: { loadAll(): Promise<Array<{ name: string; enabled?: boolean; error?: string | null }>> };
}

export interface GroundingProviderContext {
  deps: GroundingGatewayDeps;
  profile: GroundingProfile;
  request: GroundingRequest;
  warnings: string[];
  runtime: Map<string, unknown>;
}

export interface GroundingProvider {
  key: GroundingSectionKey;
  kind: "static" | "dynamic";
  build(context: GroundingProviderContext): Promise<GroundingSection | null>;
}
