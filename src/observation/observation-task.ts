import type { TaskDomain } from "../types/pipeline.js";
import type { AgentTask } from "../execution/adapter-layer.js";
import type { Logger } from "../runtime/logger.js";

// ─── TaskObservationContext ───

export interface TaskObservationContext {
  context: string;    // Assembled context string for the agent
  sources: string[];  // What sources contributed to this context
  domain: TaskDomain; // The domain used
}

// ─── Domain labels ───

const DOMAIN_LABEL: Record<TaskDomain, string> = {
  code: "Target files, related tests, and module dependencies",
  data: "Data sources, schemas, and previous observation values",
  api_action: "API endpoints, rate limits, and authentication state",
  research: "Known knowledge and unresolved questions",
  monitoring: "Current metric values, alert thresholds, and recent trends",
  communication: "Recipient context and message history",
};

// ─── ObserveForTaskDeps ───

export interface ObserveForTaskDeps {
  contextProvider?: (goalId: string, dimensionName: string) => Promise<string | null>;
  logger?: Logger;
}

// ─── observeForTask ───

/**
 * Collect domain-specific pre-execution context for a task.
 *
 * Phase 1 MVP: all domains use a unified strategy — concatenate the task
 * description with any workspace context from `contextProvider`.
 * Domain-specific collection strategies (file graphs, schema discovery,
 * metric snapshots, etc.) will be expanded in later phases.
 *
 * The assembled context is intended for `implementor` and `researcher`
 * roles only. Do NOT pass it to `verifier` or `reviewer` (bias prevention).
 *
 * @param deps   Injected dependencies (contextProvider, logger).
 * @param task   The agent task requiring pre-execution context.
 * @param domain The task domain that governs the collection strategy.
 */
export async function observeForTask(
  deps: ObserveForTaskDeps,
  task: AgentTask,
  domain: TaskDomain
): Promise<TaskObservationContext> {
  const sources: string[] = ["task_description"];
  const parts: string[] = [`Task: ${task.prompt}`];

  // Attempt to pull workspace context via contextProvider.
  // Use the domain as the dimension key since AgentTask has no goal_id field.
  if (deps.contextProvider) {
    try {
      const workspaceCtx = await deps.contextProvider("", domain);
      if (workspaceCtx) {
        parts.push(`Workspace context (${domain}):\n${workspaceCtx}`);
        sources.push("context_provider");
      }
    } catch (err) {
      deps.logger?.warn(
        `[ObservationEngine] observeForTask: contextProvider failed for domain "${domain}": ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  parts.push(`Domain focus (${domain}): ${DOMAIN_LABEL[domain]}`);

  return {
    context: parts.join("\n\n"),
    sources,
    domain,
  };
}
