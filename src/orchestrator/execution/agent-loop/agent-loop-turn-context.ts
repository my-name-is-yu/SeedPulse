import type { z } from "zod";
import type { ToolCallContext } from "../../../tools/types.js";
import type { AgentLoopBudget } from "./agent-loop-budget.js";
import { defaultAgentLoopBudget } from "./agent-loop-budget.js";
import type {
  AgentLoopModelInfo,
  AgentLoopMessage,
  AgentLoopModelRef,
  AgentLoopReasoningEffort,
} from "./agent-loop-model.js";
import type { AgentLoopCommandResult, AgentLoopCompletionValidationResult } from "./agent-loop-result.js";
import type { AgentLoopSession } from "./agent-loop-session.js";
import type { AgentLoopSessionState } from "./agent-loop-session-state.js";
import type { ExecutionPolicy } from "./execution-policy.js";

export interface AgentLoopToolPolicy {
  allowedTools?: readonly string[];
  requiredTools?: readonly string[];
  deniedTools?: readonly string[];
  includeDeferred?: boolean;
}

export type AgentLoopFinalOutputMode = "schema" | "display_text";

export interface AgentLoopTurnContext<TOutput> {
  session: AgentLoopSession;
  turnId: string;
  goalId: string;
  profileName?: string;
  taskId?: string;
  cwd: string;
  model: AgentLoopModelRef;
  modelInfo: AgentLoopModelInfo;
  reasoningEffort?: AgentLoopReasoningEffort;
  messages: AgentLoopMessage[];
  outputSchema: z.ZodType<TOutput, z.ZodTypeDef, unknown>;
  finalOutputMode?: AgentLoopFinalOutputMode;
  budget: AgentLoopBudget;
  toolPolicy: AgentLoopToolPolicy;
  toolCallContext: ToolCallContext;
  executionPolicy?: ExecutionPolicy;
  completionValidator?: (input: {
    output: TOutput;
    changedFiles: string[];
    commandResults: AgentLoopCommandResult[];
    calledTools: string[];
    modelTurns: number;
    toolCalls: number;
  }) => AgentLoopCompletionValidationResult;
  resumeState?: AgentLoopSessionState;
  /** When false, skip loading persisted state from session.stateStore for this run. */
  loadPersistedState?: boolean;
  abortSignal?: AbortSignal;
}

export function withDefaultBudget(input?: Partial<AgentLoopBudget>): AgentLoopBudget {
  return { ...defaultAgentLoopBudget, ...input };
}
