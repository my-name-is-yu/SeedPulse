import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StateManager } from "./state-manager.js";
import type { ILLMClient } from "./llm-client.js";
import type { EthicsGate } from "./ethics-gate.js";
import type { SatisficingJudge } from "./satisficing-judge.js";
import type { StallDetector } from "./stall-detector.js";
import type { ObservationEngine } from "./observation-engine.js";
import type { DriveSystem } from "./drive-system.js";
import type { VectorIndex } from "./vector-index.js";
import type { Goal } from "./types/goal.js";
import {
  CuriosityStateSchema,
  CuriosityTriggerSchema,
  CuriosityProposalSchema,
  CuriosityConfigSchema,
  LearningRecordSchema,
} from "./types/curiosity.js";
import type {
  CuriosityState,
  CuriosityTrigger,
  CuriosityProposal,
  CuriosityConfig,
  LearningRecord,
} from "./types/curiosity.js";

// ─── Constants ───

const CURIOSITY_STATE_PATH = "curiosity/state.json";

// ─── Deps Interface ───

export interface CuriosityEngineDeps {
  stateManager: StateManager;
  llmClient: ILLMClient;
  ethicsGate: EthicsGate;
  satisficingJudge: SatisficingJudge;
  stallDetector: StallDetector;
  observationEngine: ObservationEngine;
  driveSystem: DriveSystem;
  vectorIndex?: VectorIndex;  // Phase 2: embedding-based detection
  config?: Partial<CuriosityConfig>;
}

// ─── LLM Proposal Schema (for parsing LLM output) ───

const LLMProposalItemSchema = z.object({
  description: z.string(),
  rationale: z.string(),
  suggested_dimensions: z
    .array(
      z.object({
        name: z.string(),
        threshold_type: z.string(),
        target: z.number(),
      })
    )
    .default([]),
  scope_domain: z.string(),
  detection_method: z
    .enum([
      "observation_log",
      "stall_pattern",
      "cross_goal_transfer",
      "llm_heuristic",
      "periodic_review",
      "embedding_similarity",
    ])
    .default("llm_heuristic"),
});

const LLMProposalsResponseSchema = z.array(LLMProposalItemSchema);

// ─── CuriosityEngine ───

/**
 * CuriosityEngine implements Stage 11C (Curiosity MVP).
 *
 * It acts as a meta-motivator: while the 3 drive forces (dissatisfaction,
 * deadline, opportunity) select tasks within existing goals, CuriosityEngine
 * proposes new goals or goal restructurings based on learning feedback.
 *
 * Key responsibilities:
 * - Evaluate 5 trigger conditions (§2 of curiosity.md)
 * - Generate LLM-based proposals, filtered by ethics gate
 * - Track proposal lifecycle (pending → approved/rejected/expired/auto_closed)
 * - Enforce constraints: max proposals, rejection cooldown, resource budget
 * - Persist all state to curiosity/state.json via StateManager
 */
export class CuriosityEngine {
  private readonly stateManager: StateManager;
  private readonly llmClient: ILLMClient;
  private readonly ethicsGate: EthicsGate;
  private readonly satisficingJudge: SatisficingJudge;
  private readonly stallDetector: StallDetector;
  private readonly observationEngine: ObservationEngine;
  private readonly driveSystem: DriveSystem;
  private readonly vectorIndex?: VectorIndex;
  private readonly config: CuriosityConfig;
  private state: CuriosityState;

  constructor(deps: CuriosityEngineDeps) {
    this.stateManager = deps.stateManager;
    this.llmClient = deps.llmClient;
    this.ethicsGate = deps.ethicsGate;
    this.satisficingJudge = deps.satisficingJudge;
    this.stallDetector = deps.stallDetector;
    this.observationEngine = deps.observationEngine;
    this.driveSystem = deps.driveSystem;
    this.vectorIndex = deps.vectorIndex;

    // Merge user config with defaults
    this.config = CuriosityConfigSchema.parse(deps.config ?? {});

    // Load persisted state (or initialize empty)
    this.state = this.loadState();
  }

  // ─── State Persistence ───

  private loadState(): CuriosityState {
    const raw = this.stateManager.readRaw(CURIOSITY_STATE_PATH);
    if (raw === null) {
      return CuriosityStateSchema.parse({
        proposals: [],
        learning_records: [],
        last_exploration_at: null,
        rejected_proposal_hashes: [],
      });
    }
    try {
      return CuriosityStateSchema.parse(raw);
    } catch {
      // Corrupt state — start fresh
      return CuriosityStateSchema.parse({
        proposals: [],
        learning_records: [],
        last_exploration_at: null,
        rejected_proposal_hashes: [],
      });
    }
  }

  private saveState(): void {
    const parsed = CuriosityStateSchema.parse(this.state);
    this.stateManager.writeRaw(CURIOSITY_STATE_PATH, parsed);
  }

  // ─── Trigger Helpers ───

  /**
   * 2.1: All active user goals are completed or waiting.
   */
  private checkTaskQueueEmpty(goals: Goal[]): CuriosityTrigger | null {
    const userGoals = goals.filter(
      (g) => g.origin !== "curiosity" || g.origin === null
    );

    if (userGoals.length === 0) return null;

    const allInactive = userGoals.every(
      (g) => g.status === "completed" || g.status === "waiting"
    );

    if (!allInactive) return null;

    return CuriosityTriggerSchema.parse({
      type: "task_queue_empty",
      detected_at: new Date().toISOString(),
      source_goal_id: null,
      details: `All ${userGoals.length} user goal(s) are completed or waiting. Entering curiosity mode.`,
      severity: 0.8,
    });
  }

  /**
   * 2.2: Unexpected observation — a dimension's value deviates significantly
   * from its historical mean (> threshold * stddev).
   */
  private checkUnexpectedObservation(goals: Goal[]): CuriosityTrigger | null {
    const threshold = this.config.unexpected_observation_threshold;

    for (const goal of goals) {
      if (goal.status !== "active") continue;

      for (const dim of goal.dimensions) {
        const history = dim.history;
        if (history.length < 4) continue; // need enough data

        // Compute mean and stddev of numeric history values
        const numericValues = history
          .map((h) => (typeof h.value === "number" ? h.value : null))
          .filter((v): v is number => v !== null);

        if (numericValues.length < 4) continue;

        const mean =
          numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
        const variance =
          numericValues.reduce((a, b) => a + (b - mean) ** 2, 0) /
          numericValues.length;
        const stddev = Math.sqrt(variance);

        if (stddev === 0) continue;

        const currentValue = dim.current_value;
        if (typeof currentValue !== "number") continue;

        const deviation = Math.abs(currentValue - mean);
        if (deviation > threshold * stddev) {
          return CuriosityTriggerSchema.parse({
            type: "unexpected_observation",
            detected_at: new Date().toISOString(),
            source_goal_id: goal.id,
            details: `Dimension "${dim.name}" in goal "${goal.id}" deviated ${deviation.toFixed(2)} from mean ${mean.toFixed(2)} (stddev=${stddev.toFixed(2)}, threshold=${threshold}σ).`,
            severity: Math.min(1.0, deviation / (stddev * threshold * 2)),
          });
        }
      }
    }

    return null;
  }

  /**
   * 2.3: Repeated domain failures — StallDetector reports consecutive_failure
   * or global_stall for any active user goal.
   */
  private checkRepeatedFailures(goals: Goal[]): CuriosityTrigger | null {
    const activeUserGoals = goals.filter(
      (g) => g.status === "active" && g.origin !== "curiosity"
    );

    for (const goal of activeUserGoals) {
      const stallState = this.stallDetector.getStallState(goal.id);

      // Check dimension-level escalation: any dimension with escalation_level > 0
      // that was caused by consecutive failures
      const hasConsecutiveFailure = Object.entries(
        stallState.dimension_escalation
      ).some(([, level]) => level > 0);

      if (hasConsecutiveFailure) {
        const stalledDims = Object.entries(stallState.dimension_escalation)
          .filter(([, level]) => level > 0)
          .map(([dim]) => dim);

        return CuriosityTriggerSchema.parse({
          type: "repeated_failure",
          detected_at: new Date().toISOString(),
          source_goal_id: goal.id,
          details: `Goal "${goal.id}" has escalated stall on dimension(s): ${stalledDims.join(", ")}. Task-level approaches are failing; goal structure may need revision.`,
          severity: 0.7,
        });
      }
    }

    return null;
  }

  /**
   * 2.4: Goal Reviewer found undefined problems — dimensions with very low
   * observation confidence indicate unmapped important problems.
   */
  private checkUndefinedProblems(goals: Goal[]): CuriosityTrigger | null {
    const activeGoals = goals.filter((g) => g.status === "active");

    for (const goal of activeGoals) {
      // Look for dimensions with extremely low confidence (< 0.3)
      // that represent important but poorly understood aspects
      const lowConfidenceDims = goal.dimensions.filter(
        (d) => d.confidence < 0.3
      );

      if (lowConfidenceDims.length > 0 && goal.dimensions.length > 0) {
        const ratio = lowConfidenceDims.length / goal.dimensions.length;
        // Trigger only when more than half the dimensions are poorly observed
        if (ratio >= 0.5) {
          const dimNames = lowConfidenceDims.map((d) => d.name).join(", ");
          return CuriosityTriggerSchema.parse({
            type: "undefined_problem",
            detected_at: new Date().toISOString(),
            source_goal_id: goal.id,
            details: `Goal "${goal.id}" has ${lowConfidenceDims.length} dimension(s) with very low confidence (< 0.3): ${dimNames}. Current goal structure may not cover the real problem space.`,
            severity: 0.5 + ratio * 0.3,
          });
        }
      }
    }

    return null;
  }

  /**
   * 2.5: Periodic exploration — has it been >= periodic_exploration_hours
   * since the last exploration trigger?
   */
  private checkPeriodicExploration(): CuriosityTrigger | null {
    const lastExploration = this.state.last_exploration_at;
    const intervalMs =
      this.config.periodic_exploration_hours * 60 * 60 * 1000;

    if (lastExploration === null) {
      // Never explored — trigger immediately
      return CuriosityTriggerSchema.parse({
        type: "periodic_exploration",
        detected_at: new Date().toISOString(),
        source_goal_id: null,
        details: `First periodic exploration check. No previous exploration recorded.`,
        severity: 0.3,
      });
    }

    const elapsed = Date.now() - new Date(lastExploration).getTime();
    if (elapsed >= intervalMs) {
      const hoursElapsed = (elapsed / (1000 * 60 * 60)).toFixed(1);
      return CuriosityTriggerSchema.parse({
        type: "periodic_exploration",
        detected_at: new Date().toISOString(),
        source_goal_id: null,
        details: `${hoursElapsed} hours since last exploration (threshold: ${this.config.periodic_exploration_hours}h). Periodic curiosity check.`,
        severity: 0.3,
      });
    }

    return null;
  }

  // ─── LLM Prompt Building ───

  private buildProposalPrompt(
    trigger: CuriosityTrigger,
    goals: Goal[],
    learningRecords: LearningRecord[]
  ): string {
    const activeGoalsSummary = goals
      .filter((g) => g.status === "active" || g.status === "waiting")
      .map((g) => {
        const dimNames = g.dimensions.map((d) => d.name).join(", ");
        return `- Goal "${g.id}" (${g.title}): dimensions=[${dimNames}], origin=${g.origin ?? "user"}`;
      })
      .join("\n");

    const recentLearning = learningRecords
      .slice(-10) // last 10 records
      .map(
        (r) =>
          `- Goal ${r.goal_id}, dim "${r.dimension_name}", approach "${r.approach}": ${r.outcome} (improvement_ratio=${r.improvement_ratio.toFixed(2)})`
      )
      .join("\n");

    return `You are Motiva, an AI agent orchestrator analyzing curiosity triggers to propose new exploration goals.

## Current Trigger
Type: ${trigger.type}
Details: ${trigger.details}
Severity: ${trigger.severity}
${trigger.source_goal_id ? `Source goal: ${trigger.source_goal_id}` : ""}

## Active Goals
${activeGoalsSummary || "(none)"}

## Recent Learning Records
${recentLearning || "(none)"}

## Task
Based on the trigger and learning history, propose 1-3 curiosity goals that:
1. Are grounded in the trigger and learning evidence (not generic advice)
2. Are directly related to the user's current goal domains or 1-step adjacent
3. Have clear rationale based on observed patterns

Return a JSON array of proposal objects. Each object must have:
- description: string — what to explore (specific, actionable)
- rationale: string — why this is worth exploring (cite the trigger/learning evidence)
- suggested_dimensions: array of { name: string, threshold_type: string, target: number }
- scope_domain: string — domain this exploration belongs to
- detection_method: one of "observation_log" | "stall_pattern" | "cross_goal_transfer" | "llm_heuristic" | "periodic_review"

Return only valid JSON array, no markdown, no explanation outside the JSON.`;
  }

  // ─── Proposal Hash (for rejection cooldown dedup) ───

  /**
   * Compute a simple hash for a proposal description to track rejected proposals.
   * Uses a normalized lowercase version of the first 100 chars.
   */
  private computeProposalHash(description: string): string {
    const normalized = description.toLowerCase().trim().slice(0, 100);
    // Simple djb2-style hash as a hex string
    let hash = 5381;
    for (let i = 0; i < normalized.length; i++) {
      hash = (hash * 33) ^ normalized.charCodeAt(i);
    }
    return (hash >>> 0).toString(16);
  }

  /**
   * Check if a proposal description is currently in rejection cooldown.
   */
  private isInRejectionCooldown(description: string): boolean {
    const hash = this.computeProposalHash(description);
    return this.state.rejected_proposal_hashes.includes(hash);
  }

  // ─── Public API ───

  /**
   * Evaluate all 5 trigger conditions against current goal state.
   * Returns an array of fired triggers (may be empty if none fire).
   */
  evaluateTriggers(goals: Goal[]): CuriosityTrigger[] {
    if (!this.config.enabled) return [];

    const triggers: CuriosityTrigger[] = [];

    const t1 = this.checkTaskQueueEmpty(goals);
    if (t1) triggers.push(t1);

    const t2 = this.checkUnexpectedObservation(goals);
    if (t2) triggers.push(t2);

    const t3 = this.checkRepeatedFailures(goals);
    if (t3) triggers.push(t3);

    const t4 = this.checkUndefinedProblems(goals);
    if (t4) triggers.push(t4);

    const t5 = this.checkPeriodicExploration();
    if (t5) triggers.push(t5);

    return triggers;
  }

  /**
   * Generate curiosity proposals using the LLM, filtered by ethics gate.
   *
   * - Respects max_active_proposals limit (skips generation if at capacity)
   * - Skips proposals in rejection cooldown
   * - Runs ethics check on each proposal before adding
   * - Updates last_exploration_at on any periodic_exploration trigger
   * - Saves state after mutation
   */
  async generateProposals(
    triggers: CuriosityTrigger[],
    goals: Goal[]
  ): Promise<CuriosityProposal[]> {
    if (!this.config.enabled || triggers.length === 0) return [];

    // Check capacity
    const activeProposals = this.getActiveProposals();
    if (activeProposals.length >= this.config.max_active_proposals) {
      return [];
    }

    const newProposals: CuriosityProposal[] = [];
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + this.config.proposal_expiry_hours * 60 * 60 * 1000
    );

    // Update last_exploration_at for periodic triggers
    const hasPeriodicTrigger = triggers.some(
      (t) => t.type === "periodic_exploration"
    );
    if (hasPeriodicTrigger) {
      this.state.last_exploration_at = now.toISOString();
    }

    // Process each trigger (stop when at capacity)
    for (const trigger of triggers) {
      if (
        activeProposals.length + newProposals.length >=
        this.config.max_active_proposals
      ) {
        break;
      }

      type LLMProposalItem = {
        description: string;
        rationale: string;
        suggested_dimensions: Array<{ name: string; threshold_type: string; target: number }>;
        scope_domain: string;
        detection_method: "observation_log" | "stall_pattern" | "cross_goal_transfer" | "llm_heuristic" | "periodic_review" | "embedding_similarity";
      };
      let llmItems: LLMProposalItem[] = [];

      try {
        const prompt = this.buildProposalPrompt(
          trigger,
          goals,
          this.state.learning_records
        );
        const response = await this.llmClient.sendMessage(
          [{ role: "user", content: prompt }],
          { temperature: 0.3 }
        );
        llmItems = this.llmClient.parseJSON(
          response.content,
          LLMProposalsResponseSchema
        ) as LLMProposalItem[];
      } catch (err) {
        // Don't throw on LLM failure — return what we have so far
        console.warn(
          `CuriosityEngine: LLM proposal generation failed for trigger "${trigger.type}": ${err}`
        );
        continue;
      }

      for (const item of llmItems) {
        if (
          activeProposals.length + newProposals.length >=
          this.config.max_active_proposals
        ) {
          break;
        }

        // Skip if in rejection cooldown
        if (this.isInRejectionCooldown(item.description)) {
          continue;
        }

        // Run ethics check
        const proposalId = randomUUID();
        let ethicsVerdict: { verdict: string } = { verdict: "pass" };
        try {
          ethicsVerdict = await this.ethicsGate.check(
            "goal",
            proposalId,
            item.description,
            `Curiosity proposal triggered by: ${trigger.type}`
          );
        } catch (err) {
          // On ethics check failure, skip this proposal (conservative)
          console.warn(
            `CuriosityEngine: ethics check failed for proposal "${item.description.slice(0, 60)}": ${err}`
          );
          continue;
        }

        if (ethicsVerdict.verdict === "reject") {
          continue;
        }

        // Phase 2: use embedding_similarity detection method when vectorIndex
        // is available and the trigger is undefined_problem
        const detectionMethod =
          this.vectorIndex && trigger.type === "undefined_problem"
            ? "embedding_similarity"
            : item.detection_method;

        const proposal = CuriosityProposalSchema.parse({
          id: proposalId,
          trigger,
          proposed_goal: {
            description: item.description,
            rationale: item.rationale,
            suggested_dimensions: item.suggested_dimensions,
            scope_domain: item.scope_domain,
            detection_method: detectionMethod,
          },
          status: "pending",
          created_at: now.toISOString(),
          expires_at: expiresAt.toISOString(),
          reviewed_at: null,
          rejection_cooldown_until: null,
          loop_count: 0,
          goal_id: null,
        });

        newProposals.push(proposal);
        this.state.proposals.push(proposal);
      }
    }

    this.saveState();
    return newProposals;
  }

  /**
   * Approve a pending proposal by ID.
   * Sets status to "approved" and records reviewed_at.
   * Throws if proposal is not found or not in "pending" status.
   */
  approveProposal(proposalId: string): CuriosityProposal {
    const index = this.state.proposals.findIndex((p) => p.id === proposalId);
    if (index === -1) {
      throw new Error(
        `CuriosityEngine.approveProposal: proposal "${proposalId}" not found`
      );
    }

    const proposal = this.state.proposals[index]!;
    if (proposal.status !== "pending") {
      throw new Error(
        `CuriosityEngine.approveProposal: proposal "${proposalId}" is not pending (status=${proposal.status})`
      );
    }

    const updated = CuriosityProposalSchema.parse({
      ...proposal,
      status: "approved",
      reviewed_at: new Date().toISOString(),
    });

    this.state.proposals[index] = updated;
    this.saveState();
    return updated;
  }

  /**
   * Reject a pending proposal by ID.
   * Sets status to "rejected", records reviewed_at, and sets rejection_cooldown_until.
   * Also adds the proposal hash to rejected_proposal_hashes for cooldown tracking.
   * Throws if proposal is not found or not in "pending" status.
   */
  rejectProposal(proposalId: string): CuriosityProposal {
    const index = this.state.proposals.findIndex((p) => p.id === proposalId);
    if (index === -1) {
      throw new Error(
        `CuriosityEngine.rejectProposal: proposal "${proposalId}" not found`
      );
    }

    const proposal = this.state.proposals[index]!;
    if (proposal.status !== "pending") {
      throw new Error(
        `CuriosityEngine.rejectProposal: proposal "${proposalId}" is not pending (status=${proposal.status})`
      );
    }

    const now = new Date();
    const cooldownUntil = new Date(
      now.getTime() +
        this.config.rejection_cooldown_hours * 60 * 60 * 1000
    );

    const updated = CuriosityProposalSchema.parse({
      ...proposal,
      status: "rejected",
      reviewed_at: now.toISOString(),
      rejection_cooldown_until: cooldownUntil.toISOString(),
    });

    this.state.proposals[index] = updated;

    // Track hash for cooldown deduplication
    const hash = this.computeProposalHash(
      proposal.proposed_goal.description
    );
    if (!this.state.rejected_proposal_hashes.includes(hash)) {
      this.state.rejected_proposal_hashes.push(hash);
    }

    this.saveState();
    return updated;
  }

  /**
   * Expire pending proposals past their expires_at date, and auto-close
   * approved proposals that have reached the unproductive_loop_limit.
   *
   * Returns the list of proposals that were changed in this call.
   */
  checkAutoExpiration(): CuriosityProposal[] {
    const now = new Date();
    const changed: CuriosityProposal[] = [];

    this.state.proposals = this.state.proposals.map((p) => {
      // Expire pending proposals past expires_at
      if (p.status === "pending" && new Date(p.expires_at) <= now) {
        const updated = CuriosityProposalSchema.parse({
          ...p,
          status: "expired",
        });
        changed.push(updated);
        return updated;
      }

      // Auto-close approved proposals at or past the unproductive loop limit
      if (
        p.status === "approved" &&
        p.loop_count >= this.config.unproductive_loop_limit
      ) {
        const updated = CuriosityProposalSchema.parse({
          ...p,
          status: "auto_closed",
        });
        changed.push(updated);
        return updated;
      }

      return p;
    });

    if (changed.length > 0) {
      this.saveState();
    }

    return changed;
  }

  /**
   * Increment loop_count for an approved curiosity proposal identified by its goal_id.
   * No-op if no matching proposal is found.
   */
  incrementLoopCount(goalId: string): void {
    let changed = false;

    this.state.proposals = this.state.proposals.map((p) => {
      if (p.status === "approved" && p.goal_id === goalId) {
        changed = true;
        return CuriosityProposalSchema.parse({
          ...p,
          loop_count: p.loop_count + 1,
        });
      }
      return p;
    });

    if (changed) {
      this.saveState();
    }
  }

  /**
   * Add a learning record to state and persist.
   * Automatically sets recorded_at to now.
   */
  recordLearning(record: Omit<LearningRecord, "recorded_at">): void {
    const full = LearningRecordSchema.parse({
      ...record,
      recorded_at: new Date().toISOString(),
    });
    this.state.learning_records.push(full);
    this.saveState();
  }

  /**
   * Return all proposals with status "pending" or "approved".
   */
  getActiveProposals(): CuriosityProposal[] {
    return this.state.proposals.filter(
      (p) => p.status === "pending" || p.status === "approved"
    );
  }

  /**
   * Quick check: are there any triggers that warrant curiosity?
   * Used by CoreLoop to decide whether to run full evaluateTriggers.
   *
   * Returns true if:
   * - Curiosity is enabled
   * - Any of the quick-check conditions are met (task queue empty,
   *   periodic exploration overdue, or any stall state detected)
   */
  shouldExplore(goals: Goal[]): boolean {
    if (!this.config.enabled) return false;

    // Quick check 1: task queue empty
    const userGoals = goals.filter((g) => g.origin !== "curiosity");
    if (
      userGoals.length > 0 &&
      userGoals.every(
        (g) => g.status === "completed" || g.status === "waiting"
      )
    ) {
      return true;
    }

    // Quick check 2: periodic exploration overdue
    const lastExploration = this.state.last_exploration_at;
    if (lastExploration === null) return true;
    const intervalMs =
      this.config.periodic_exploration_hours * 60 * 60 * 1000;
    if (Date.now() - new Date(lastExploration).getTime() >= intervalMs) {
      return true;
    }

    // Quick check 3: any active goal has stall state with escalated dimensions
    const activeGoals = goals.filter(
      (g) => g.status === "active" && g.origin !== "curiosity"
    );
    for (const goal of activeGoals) {
      const stallState = this.stallDetector.getStallState(goal.id);
      const hasEscalated = Object.values(stallState.dimension_escalation).some(
        (level) => level > 0
      );
      if (hasEscalated) return true;
    }

    return false;
  }

  // ─── Phase 2: Embedding-based Detection ───

  /**
   * Detect semantically similar dimensions across goals using VectorIndex.
   * Returns cross-goal transfers with similarity > 0.7.
   */
  async detectSemanticTransfer(
    goalId: string,
    dimensions: string[]
  ): Promise<Array<{ source_goal_id: string; dimension: string; similarity: number }>> {
    if (!this.vectorIndex) return [];

    const transfers: Array<{ source_goal_id: string; dimension: string; similarity: number }> = [];

    for (const dim of dimensions) {
      const results = await this.vectorIndex.search(dim, 5, 0.7);
      for (const result of results) {
        const sourceGoalId = result.metadata.goal_id as string;
        if (sourceGoalId && sourceGoalId !== goalId) {
          transfers.push({
            source_goal_id: sourceGoalId,
            dimension: dim,
            similarity: result.similarity,
          });
        }
      }
    }

    return transfers;
  }

  /**
   * Calculate the allowed resource percentage for curiosity goals based on
   * the current state of user goals.
   *
   * Returns:
   *   - 100 (no limit) if all user goals are completed
   *   - waiting_user_goals_max_percent if all user goals are waiting
   *   - active_user_goals_max_percent if any user goals are active
   *   - 0 if curiosity is disabled
   */
  getResourceBudget(goals: Goal[]): number {
    if (!this.config.enabled) return 0;

    const userGoals = goals.filter(
      (g) => g.origin !== "curiosity" && g.origin !== null
    );

    // Also treat goals with no origin as user goals
    const allUserGoals = goals.filter((g) => g.origin !== "curiosity");

    if (allUserGoals.length === 0) {
      // No user goals — unlimited curiosity budget
      return 100;
    }

    const allCompleted = allUserGoals.every((g) => g.status === "completed");
    if (allCompleted) {
      return 100;
    }

    const allWaiting = allUserGoals.every(
      (g) => g.status === "completed" || g.status === "waiting"
    );
    if (allWaiting) {
      return this.config.resource_budget.waiting_user_goals_max_percent;
    }

    // Some goals are active — limited budget
    void userGoals; // suppress unused-var warning; variable used above via allUserGoals
    return this.config.resource_budget.active_user_goals_max_percent;
  }
}
