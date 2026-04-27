import type { infer as ZodInfer } from "zod";
import type { StateManager } from "../../base/state/state-manager.js";
import type { ReportingEngine } from "../../reporting/reporting-engine.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { IPromptGateway } from "../../prompt/gateway.js";
import type { Task } from "../../base/types/task.js";
import type { PluginMatchResult } from "../../base/types/plugin.js";
import type { PluginLoader } from "../../runtime/plugin-loader.js";
import { CapabilityGapSchema } from "../../base/types/capability.js";
import type {
  Capability,
  CapabilityRegistry,
  CapabilityGap,
  CapabilityStatus,
  AcquisitionContext,
  CapabilityAcquisitionTask,
  CapabilityVerificationResult,
  CapabilityDependency,
} from "../../base/types/capability.js";
import type { AgentResult } from "../../orchestrator/execution/adapter-layer.js";
import {
  loadRegistry,
  saveRegistry,
  registerCapability,
  removeCapability,
  findCapabilityByName,
  getAcquisitionHistory,
  setCapabilityStatus,
  escalateToUser,
} from "./capability-registry.js";
import { addDependency, getDependencies, resolveDependencies, detectCircularDependency, getAcquisitionOrder } from "./capability-dependencies.js";
import {
  buildDeficiencyPrompt,
  buildGoalGapPrompt,
  buildVerificationPrompt,
  formatAvailableCapabilities,
  formatAvailableGoalCapabilities,
} from "./capability-detector/prompts.js";
import {
  recommendAcquisition as buildRecommendations,
  planAcquisitionTask,
} from "./capability-detector/recommendations.js";
import {
  DeficiencyResponseSchema,
  GoalCapabilityGapResponseSchema,
  VerificationResponseSchema,
  type CapabilityAcquisitionRecommendation,
} from "./capability-detector/types.js";

const CONSECUTIVE_FAILURE_THRESHOLD = 3;
export type { CapabilityAcquisitionRecommendation } from "./capability-detector/types.js";

// ─── CapabilityDetector ───

export class CapabilityDetector {
  private readonly stateManager: StateManager;
  private readonly llmClient: ILLMClient;
  private readonly reportingEngine: ReportingEngine;
  private readonly pluginLoader?: PluginLoader;
  private readonly gateway?: IPromptGateway;

  constructor(
    stateManager: StateManager,
    llmClient: ILLMClient,
    reportingEngine: ReportingEngine,
    pluginLoader?: PluginLoader,
    gateway?: IPromptGateway
  ) {
    this.stateManager = stateManager;
    this.llmClient = llmClient;
    this.reportingEngine = reportingEngine;
    this.pluginLoader = pluginLoader;
    this.gateway = gateway;
  }

  // ─── detectDeficiency ───

  /**
   * Analyzes a task description against the capability registry via LLM.
   * Returns a CapabilityGap if the task requires unavailable capabilities,
   * or null if all required capabilities are available.
   */
  async detectDeficiency(task: Task): Promise<CapabilityGap | null> {
    const registry = await this.loadRegistry();
    const availableCapabilities = formatAvailableCapabilities(registry.capabilities);
    const { systemPrompt, userMessage } = buildDeficiencyPrompt(task, availableCapabilities);

    let parsed: ZodInfer<typeof DeficiencyResponseSchema>;
    if (this.gateway) {
      parsed = await this.gateway.execute({
        purpose: "capability_detect",
        additionalContext: { deficiency_prompt: userMessage },
        responseSchema: DeficiencyResponseSchema,
      });
    } else {
      const response = await this.llmClient.sendMessage(
        [{ role: "user", content: userMessage }],
        { system: systemPrompt }
      );
      parsed = this.llmClient.parseJSON(response.content, DeficiencyResponseSchema);
    }

    if (!parsed.has_deficiency) {
      return null;
    }

    const gap = CapabilityGapSchema.parse({
      missing_capability: parsed.missing_capability,
      reason: parsed.reason,
      alternatives: parsed.alternatives,
      impact_description: parsed.impact_description,
      related_task_id: task.id,
    });

    return gap;
  }

  // ─── detectGoalCapabilityGap ───

  /**
   * Goal-level analog of detectDeficiency(). Takes a goal description and a flat
   * list of adapter capability strings (e.g. ["create_github_issue", "execute_code"]),
   * combines them with registry capabilities, and uses LLM to determine if any
   * capabilities required by the goal are missing.
   *
   * Returns a CapabilityGap (without related_task_id) if a gap is found, or null if
   * all required capabilities are available.
   */
  async detectGoalCapabilityGap(
    goalDescription: string,
    adapterCapabilities: string[],
    goalDimensions?: string[]
  ): Promise<{ gap: CapabilityGap; acquirable: boolean; suggestedPlugins?: PluginMatchResult[] } | null> {
    try {
      const registry = await this.loadRegistry();
      const availableCapabilities = formatAvailableGoalCapabilities(registry.capabilities, adapterCapabilities);
      const { systemPrompt, userMessage } = buildGoalGapPrompt(goalDescription, availableCapabilities);

      let parsed: ZodInfer<typeof GoalCapabilityGapResponseSchema>;
      if (this.gateway) {
        parsed = await this.gateway.execute({
          purpose: "capability_goal_gap",
          additionalContext: { goal_gap_prompt: userMessage },
          responseSchema: GoalCapabilityGapResponseSchema,
        });
      } else {
        const response = await this.llmClient.sendMessage(
          [{ role: "user", content: userMessage }],
          { system: systemPrompt }
        );
        try {
          parsed = this.llmClient.parseJSON(response.content, GoalCapabilityGapResponseSchema);
        } catch (err) {
          console.warn(`[CapabilityDetector] Failed to parse LLM response as GoalCapabilityGapResponse: ${String(err)}`);
          return null;
        }
      }

      if (!parsed.has_gap) {
        return null;
      }

      const gap = CapabilityGapSchema.parse({
        missing_capability: parsed.missing_capability,
        reason: parsed.reason,
        alternatives: parsed.alternatives,
        impact_description: parsed.impact_description,
        // related_task_id intentionally omitted — this is goal-level, not task-level
      });

      const result: { gap: CapabilityGap; acquirable: boolean; suggestedPlugins?: PluginMatchResult[] } = {
        gap,
        acquirable: parsed.acquirable ?? false,
      };

      if (this.pluginLoader && goalDimensions && goalDimensions.length > 0) {
        result.suggestedPlugins = await this.matchPluginsForGoal(goalDimensions);
      }

      return result;
    } catch {
      return null;
    }
  }

  // ─── matchPluginsForGoal ───

  /**
   * Finds installed plugins that match the goal's dimensions.
   * Returns plugins with matchScore >= 0.5, sorted by score then trust.
   */
  async matchPluginsForGoal(goalDimensions: string[]): Promise<PluginMatchResult[]> {
    if (!this.pluginLoader || goalDimensions.length === 0) {
      return [];
    }

    const pluginStates = await this.pluginLoader.loadAll();

    const results: PluginMatchResult[] = [];

    for (const state of pluginStates) {
      if (state.status !== "loaded") continue;

      const pluginDimensions = state.manifest.dimensions ?? [];
      if (pluginDimensions.length === 0) continue;

      const matchedDimensions = goalDimensions.filter((d) => pluginDimensions.includes(d));
      const matchScore = matchedDimensions.length / goalDimensions.length;

      if (matchScore < 0.5) continue;

      results.push({
        pluginName: state.name,
        matchScore,
        matchedDimensions,
        trustScore: state.trust_score,
        autoSelectable: state.trust_score >= 20,
      });
    }

    // Sort by matchScore descending, then trustScore descending
    results.sort((a, b) => {
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
      return b.trustScore - a.trustScore;
    });

    return results;
  }

  // ─── Registry wrappers ───

  async loadRegistry(): Promise<CapabilityRegistry> {
    return loadRegistry({ stateManager: this.stateManager });
  }

  async saveRegistry(registry: CapabilityRegistry): Promise<void> {
    return saveRegistry({ stateManager: this.stateManager }, registry);
  }

  async registerCapability(cap: Capability, context?: AcquisitionContext): Promise<void> {
    return registerCapability({ stateManager: this.stateManager }, cap, context);
  }

  async removeCapability(capabilityId: string): Promise<void> {
    return removeCapability({ stateManager: this.stateManager }, capabilityId);
  }

  async findCapabilityByName(name: string): Promise<Capability | null> {
    return findCapabilityByName({ stateManager: this.stateManager }, name);
  }

  async getAcquisitionHistory(goalId: string): Promise<AcquisitionContext[]> {
    return getAcquisitionHistory({ stateManager: this.stateManager }, goalId);
  }

  async setCapabilityStatus(
    capabilityName: string,
    capabilityType: CapabilityGap["missing_capability"]["type"],
    status: CapabilityStatus
  ): Promise<void> {
    return setCapabilityStatus(
      { stateManager: this.stateManager },
      capabilityName,
      capabilityType,
      status
    );
  }

  async escalateToUser(gap: CapabilityGap, goalId: string): Promise<void> {
    return escalateToUser({ reportingEngine: this.reportingEngine }, gap, goalId);
  }

  // ─── confirmDeficiency ───

  /**
   * Returns true if consecutiveFailures has reached the escalation threshold (>= 3).
   * This confirms that repeated failures are due to a capability deficiency.
   */
  confirmDeficiency(_taskId: string, consecutiveFailures: number): boolean {
    return consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD;
  }

  recommendAcquisition(gap: CapabilityGap): CapabilityAcquisitionRecommendation[] {
    return buildRecommendations(gap);
  }

  // ─── planAcquisition ───

  /**
   * Deterministically creates a CapabilityAcquisitionTask from a CapabilityGap.
   * Pure synchronous function — no LLM needed. Rules from design doc §5.3.
   */
  planAcquisition(gap: CapabilityGap): CapabilityAcquisitionTask {
    const recommendation = this.recommendAcquisition(gap)[0];
    return planAcquisitionTask(gap, recommendation);
  }

  // ─── verifyAcquiredCapability ───

  /**
   * Uses LLM to verify a newly acquired capability.
   * Checks basic operation, error handling, and scope boundary.
   * Returns "pass", "fail", or "escalate" (if max verification attempts reached).
   */
  async verifyAcquiredCapability(
    capability: Capability,
    acquisitionTask: CapabilityAcquisitionTask,
    agentResult: AgentResult
  ): Promise<CapabilityVerificationResult> {
    const { systemPrompt, userMessage } = buildVerificationPrompt(capability, acquisitionTask, agentResult);

    let parsed: ZodInfer<typeof VerificationResponseSchema>;
    if (this.gateway) {
      parsed = await this.gateway.execute({
        purpose: "capability_verify",
        additionalContext: { verify_prompt: userMessage },
        responseSchema: VerificationResponseSchema,
      });
    } else {
      const response = await this.llmClient.sendMessage(
        [{ role: "user", content: userMessage }],
        { system: systemPrompt }
      );
      parsed = this.llmClient.parseJSON(response.content, VerificationResponseSchema);
    }

    if (parsed.verdict === "fail") {
      acquisitionTask.verification_attempts += 1;
      if (acquisitionTask.verification_attempts >= acquisitionTask.max_verification_attempts) {
        return "escalate";
      }
      return "fail";
    }

    return "pass";
  }

  // ─── Dependency wrappers ───

  async addDependency(capabilityId: string, dependsOn: string[]): Promise<void> {
    return addDependency({ stateManager: this.stateManager }, capabilityId, dependsOn);
  }

  async getDependencies(capabilityId: string): Promise<string[]> {
    return getDependencies({ stateManager: this.stateManager }, capabilityId);
  }

  resolveDependencies(dependencies: CapabilityDependency[]): string[] {
    return resolveDependencies(dependencies);
  }

  detectCircularDependency(dependencies: CapabilityDependency[]): string[] | null {
    return detectCircularDependency(dependencies);
  }

  async getAcquisitionOrder(gaps: CapabilityGap[]): Promise<CapabilityGap[]> {
    return getAcquisitionOrder({ stateManager: this.stateManager }, gaps);
  }
}
