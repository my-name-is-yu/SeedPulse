import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StateManager } from "../state-manager.js";
import type { ILLMClient } from "../llm/llm-client.js";
import { EthicsGate } from "../traits/ethics-gate.js";
import { ObservationEngine } from "../observation/observation-engine.js";
import { GoalSchema } from "../types/goal.js";
import type { Goal, Dimension } from "../types/goal.js";
import type { EthicsVerdict } from "../types/ethics.js";
import {
  DimensionDecompositionSchema,
  NegotiationLogSchema,
  FeasibilityResultSchema,
  CapabilityCheckLogSchema,
} from "../types/negotiation.js";
import type {
  DimensionDecomposition,
  FeasibilityResult,
  NegotiationLog,
  NegotiationResponse,
} from "../types/negotiation.js";
import type { CharacterConfig } from "../types/character.js";
import { DEFAULT_CHARACTER_CONFIG } from "../types/character.js";
import type { SatisficingJudge } from "../drive/satisficing-judge.js";
import type { GoalTreeManager } from "./goal-tree-manager.js";
import type {
  GoalDecompositionConfig,
  DecompositionResult,
} from "../types/goal-tree.js";
import type { CapabilityDetector } from "../observation/capability-detector.js";
import {
  decompositionToDimension,
  deduplicateDimensionKeys,
  findBestDimensionMatch,
} from "./goal-validation.js";
import {
  decompose as decomposeImpl,
  decomposeIntoSubgoals as decomposeIntoSubgoalsImpl,
} from "./goal-decomposer.js";
import {
  suggestGoals as suggestGoalsImpl,
  filterSuggestions as filterSuggestionsImpl,
  buildCapabilityCheckPrompt,
  CapabilityCheckResultSchema,
} from "./goal-suggest.js";
export type { GoalSuggestion } from "./goal-suggest.js";

// ─── Constants ───

const FEASIBILITY_RATIO_THRESHOLD_REALISTIC = 1.5;
// FEASIBILITY_RATIO_THRESHOLD_AMBITIOUS is now dynamic — see getFeasibilityThreshold()
const REALISTIC_TARGET_ACCELERATION_FACTOR = 1.3;
const DEFAULT_TIME_HORIZON_DAYS = 90;

// ─── Error class ───

export class EthicsRejectedError extends Error {
  constructor(public readonly verdict: EthicsVerdict) {
    super(`Goal rejected by ethics gate: ${verdict.reasoning}`);
    this.name = "EthicsRejectedError";
  }
}

// ─── Prompts ───

function buildDecompositionPrompt(
  description: string,
  constraints: string[],
  availableDataSources?: Array<{ name: string; dimensions: string[] }>
): string {
  const constraintsSection =
    constraints.length > 0
      ? `\nConstraints:\n${constraints.map((c) => `- ${c}`).join("\n")}`
      : "";

  const dataSourcesSection =
    availableDataSources && availableDataSources.length > 0
      ? `CRITICAL CONSTRAINT: For dimensions that overlap with the available data sources below, you MUST use those exact dimension names so mechanical measurements can be wired automatically. However, you SHOULD ALSO add additional quality-oriented and semantic dimensions that directly reflect the goal description (e.g., readability, correctness, completeness) — do NOT limit yourself to only DataSource dimensions.

Available Data Sources and their exact dimension names:
${availableDataSources.map((ds) => `- "${ds.name}" provides: ${ds.dimensions.join(", ")}`).join("\n")}

`
      : "";

  return `${dataSourcesSection}Decompose the following goal into measurable dimensions.

Goal: ${description}${constraintsSection}

For each dimension, provide:
- name: a snake_case identifier (use an exact DataSource dimension name if one fits, otherwise use a descriptive custom name)
- label: human-readable label
- threshold_type: one of "min", "max", "range", "present", "match"
- threshold_value: the target value (number, string, or boolean), or null if not yet determined
- observation_method_hint: how to measure this dimension

IMPORTANT — Dimension quality rules:
1. Do NOT create only "present" type dimensions. Goals about quality, correctness, or completeness MUST have quality-scoring dimensions with "min" type thresholds (0.0-1.0 scale).
2. "present" type is ONLY appropriate for pure existence checks (e.g., "does the file exist at all?"). If the goal mentions quality, content, correctness, completeness, or any qualitative attribute, use "min" type with a 0.0-1.0 score instead.
3. For every existence dimension you create, ask: "Does the goal also care about the QUALITY of this thing?" If yes, add a separate quality dimension with "min" type.
4. Quality dimensions should evaluate specific aspects mentioned in the goal (e.g., correctness of fields, quality of documentation sections, completeness of configuration).

Return a JSON array of dimension objects. Example:
[
  {
    "name": "test_coverage",
    "label": "Test Coverage",
    "threshold_type": "min",
    "threshold_value": 80,
    "observation_method_hint": "Run test suite and check coverage report"
  },
  {
    "name": "readme_installation_quality",
    "label": "README Installation Section Quality",
    "threshold_type": "min",
    "threshold_value": 0.7,
    "observation_method_hint": "Evaluate if README has clear installation instructions with code examples, covering npm install, basic setup, and common configurations. Score 0.0-1.0."
  },
  {
    "name": "package_json_exports_valid",
    "label": "package.json exports/main/types Correctness",
    "threshold_type": "min",
    "threshold_value": 0.8,
    "observation_method_hint": "Check that package.json has correct bin, main, exports, and types fields pointing to valid paths. Score 0.0-1.0."
  },
  {
    "name": "license_file_exists",
    "label": "License File Exists",
    "threshold_type": "present",
    "threshold_value": true,
    "observation_method_hint": "Check if LICENSE or LICENSE.md file exists in the project root"
  }
]

Return ONLY a JSON array, no other text.`;
}

function buildFeasibilityPrompt(
  dimension: string,
  description: string,
  baselineValue: number | string | boolean | null,
  thresholdValue: number | string | boolean | (number | string)[] | null,
  timeHorizonDays: number
): string {
  return `Assess the feasibility of achieving this dimension target.

Dimension: ${dimension}
Goal context: ${description}
Current baseline: ${baselineValue === null ? "unknown" : String(baselineValue)}
Target value: ${thresholdValue === null ? "not yet determined" : String(thresholdValue)}
Time horizon: ${timeHorizonDays} days

Return a JSON object with:
{
  "assessment": "realistic" | "ambitious" | "infeasible",
  "confidence": "high" | "medium" | "low",
  "reasoning": "brief explanation",
  "key_assumptions": ["assumption1", ...],
  "main_risks": ["risk1", ...]
}

Return ONLY a JSON object, no other text.`;
}

function buildResponsePrompt(
  description: string,
  responseType: "accept" | "counter_propose" | "flag_as_ambitious",
  feasibilityResults: FeasibilityResult[],
  counterProposal?: { realistic_target: number; reasoning: string }
): string {
  const feasibilitySummary = feasibilityResults
    .map((r) => `- ${r.dimension}: ${r.assessment} (confidence: ${r.confidence})`)
    .join("\n");

  let instruction = "";
  if (responseType === "accept") {
    instruction = "Generate an encouraging acceptance message for the user.";
  } else if (responseType === "counter_propose") {
    instruction = `Generate a counter-proposal message. The realistic target is ${counterProposal?.realistic_target}. Reasoning: ${counterProposal?.reasoning}. Suggest this as a safer alternative.`;
  } else {
    instruction =
      "Generate a message flagging this goal as ambitious. List the risks and suggest the user review carefully.";
  }

  return `Goal: ${description}

Feasibility assessment:
${feasibilitySummary}

${instruction}

Return a brief, user-facing message (1-3 sentences). Return ONLY the message text, no JSON.`;
}

// ─── Qualitative feasibility schema for LLM parsing ───

const QualitativeFeasibilitySchema = z.object({
  assessment: z.enum(["realistic", "ambitious", "infeasible"]),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z.string(),
  key_assumptions: z.array(z.string()),
  main_risks: z.array(z.string()),
});

// ─── GoalNegotiator ───

export class GoalNegotiator {
  private readonly stateManager: StateManager;
  private readonly llmClient: ILLMClient;
  private readonly ethicsGate: EthicsGate;
  private readonly observationEngine: ObservationEngine;
  private readonly characterConfig: CharacterConfig;
  private readonly satisficingJudge?: SatisficingJudge;
  private readonly goalTreeManager?: GoalTreeManager;
  private readonly adapterCapabilities?: Array<{ adapterType: string; capabilities: string[] }>;

  constructor(
    stateManager: StateManager,
    llmClient: ILLMClient,
    ethicsGate: EthicsGate,
    observationEngine: ObservationEngine,
    characterConfig?: CharacterConfig,
    satisficingJudge?: SatisficingJudge,  // Phase 2: auto-mapping proposals
    goalTreeManager?: GoalTreeManager,
    adapterCapabilities?: Array<{ adapterType: string; capabilities: string[] }>
  ) {
    this.stateManager = stateManager;
    this.llmClient = llmClient;
    this.ethicsGate = ethicsGate;
    this.observationEngine = observationEngine;
    this.characterConfig = characterConfig ?? DEFAULT_CHARACTER_CONFIG;
    this.satisficingJudge = satisficingJudge;
    this.goalTreeManager = goalTreeManager;
    this.adapterCapabilities = adapterCapabilities;
  }

  /**
   * Compute the feasibility ratio threshold for "ambitious" vs "infeasible".
   * Driven by caution_level (1=conservative/strict → 2.0, 5=ambitious → 4.0).
   * Formula: threshold = 1.5 + (caution_level * 0.5)
   */
  private getFeasibilityThreshold(): number {
    return 1.5 + this.characterConfig.caution_level * 0.5;
  }

  // ─── negotiate() — 6-step flow ───

  async negotiate(
    rawGoalDescription: string,
    options?: {
      deadline?: string;
      constraints?: string[];
      timeHorizonDays?: number;
    }
  ): Promise<{
    goal: Goal;
    response: NegotiationResponse;
    log: NegotiationLog;
  }> {
    const goalId = randomUUID();
    const deadline = options?.deadline ?? null;
    const constraints = options?.constraints ?? [];
    const timeHorizonDays = options?.timeHorizonDays ?? DEFAULT_TIME_HORIZON_DAYS;
    const now = new Date().toISOString();

    // Initialize negotiation log
    const log: NegotiationLog = NegotiationLogSchema.parse({
      goal_id: goalId,
      timestamp: now,
      is_renegotiation: false,
      renegotiation_trigger: null,
    });

    // Step 0: Ethics Gate
    const ethicsVerdict = await this.ethicsGate.check("goal", goalId, rawGoalDescription);

    if (ethicsVerdict.verdict === "reject") {
      throw new EthicsRejectedError(ethicsVerdict);
    }

    const ethicsFlags =
      ethicsVerdict.verdict === "flag" ? ethicsVerdict.risks : undefined;

    // Step 1: Goal Intake
    // (parsed from options above)

    // Step 2: Dimension Decomposition (LLM)
    const availableDataSources = this.observationEngine.getAvailableDimensionInfo();
    const decompositionPrompt = buildDecompositionPrompt(rawGoalDescription, constraints, availableDataSources);
    const decompositionResponse = await this.llmClient.sendMessage(
      [{ role: "user", content: decompositionPrompt }],
      { temperature: 0 }
    );

    const dimensions = this.llmClient.parseJSON(
      decompositionResponse.content,
      z.array(DimensionDecompositionSchema)
    );

    // Post-process: map dimension names to DataSource dimensions when similar
    if (availableDataSources.length > 0) {
      const allDsNames = availableDataSources.flatMap(ds => ds.dimensions);
      for (const dim of dimensions) {
        if (!allDsNames.includes(dim.name)) {
          // Try to find a similar DataSource dimension
          const match = findBestDimensionMatch(dim.name, allDsNames);
          if (match) {
            dim.name = match;
          }
        }
      }

      // R3-4: Warn if all dimensions were remapped to DataSource dimensions
      const allRemapped = dimensions.length > 0 && dimensions.every(dim => allDsNames.includes(dim.name));
      if (allRemapped) {
        console.warn(
          "[GoalNegotiator] Warning: all dimensions were remapped to DataSource dimensions. " +
          "Quality-specific dimensions may be missing. Consider adding dimensions that directly " +
          "measure the goal's quality aspects."
        );
      }
    }

    // Post-process: ensure all dimension keys are unique (LLM may return duplicates)
    deduplicateDimensionKeys(dimensions);

    log.step2_decomposition = {
      dimensions,
      method: "llm",
    };

    // Step 3: Baseline Observation
    const baselineObservations: Array<{
      dimension: string;
      value: number | string | boolean | null;
      confidence: number;
      method: string;
    }> = [];

    for (const dim of dimensions) {
      // For new goals, we don't have observation setup yet
      // Record null baseline with 0 confidence
      baselineObservations.push({
        dimension: dim.name,
        value: null,
        confidence: 0,
        method: "initial_baseline",
      });
    }

    log.step3_baseline = { observations: baselineObservations };

    // Step 4: Feasibility Evaluation (Hybrid)
    const feasibilityResults: FeasibilityResult[] = [];
    let overallPath: "quantitative" | "qualitative" | "hybrid" = "qualitative";

    for (const dim of dimensions) {
      const baseline = baselineObservations.find((o) => o.dimension === dim.name);
      const baselineValue = baseline?.value ?? null;

      // Determine feasibility path
      if (
        typeof baselineValue === "number" &&
        typeof dim.threshold_value === "number"
      ) {
        // Quantitative path
        overallPath = overallPath === "qualitative" ? "hybrid" : overallPath;

        // No observed_change_rate available for new goals, fallback to qualitative
        const result = await this.evaluateQualitatively(
          dim.name,
          rawGoalDescription,
          baselineValue,
          dim.threshold_value,
          timeHorizonDays
        );
        feasibilityResults.push(result);
      } else {
        // Qualitative path (LLM assessment)
        const result = await this.evaluateQualitatively(
          dim.name,
          rawGoalDescription,
          baselineValue,
          dim.threshold_value,
          timeHorizonDays
        );
        feasibilityResults.push(result);
      }
    }

    log.step4_evaluation = {
      path: overallPath,
      dimensions: feasibilityResults,
    };

    // Step 4b: Capability Check
    if (this.adapterCapabilities && this.adapterCapabilities.length > 0) {
      try {
        const capCheckPrompt = buildCapabilityCheckPrompt(
          rawGoalDescription,
          dimensions,
          this.adapterCapabilities
        );
        const capCheckResponse = await this.llmClient.sendMessage(
          [{ role: "user", content: capCheckPrompt }],
          { temperature: 0 }
        );
        const capCheckResult = this.llmClient.parseJSON(
          capCheckResponse.content,
          CapabilityCheckResultSchema
        );

        const allCapabilities = this.adapterCapabilities.flatMap((ac) => ac.capabilities);
        const infeasibleDimensions: string[] = [];

        for (const gap of capCheckResult.gaps) {
          if (!gap.acquirable) {
            const existing = feasibilityResults.find((r) => r.dimension === gap.dimension);
            if (existing) {
              existing.assessment = "infeasible";
              existing.reasoning = `Capability gap: ${gap.reason}`;
            }
            infeasibleDimensions.push(gap.dimension);
          }
        }

        log.step4_capability_check = CapabilityCheckLogSchema.parse({
          capabilities_available: allCapabilities,
          gaps_detected: capCheckResult.gaps.map((g) => ({
            dimension: g.dimension,
            required_capability: g.required_capability,
            acquirable: g.acquirable,
          })),
          infeasible_dimensions: infeasibleDimensions,
        });
      } catch {
        // Non-critical: capability check failure should not block negotiation
        console.warn("[GoalNegotiator] Step 4b capability check failed, continuing without it");
      }
    }

    // Step 5: Response Generation
    const { responseType, counterProposal, initialConfidence } =
      this.determineResponseType(feasibilityResults, baselineObservations, timeHorizonDays);

    // Generate user-facing message via LLM
    const responsePrompt = buildResponsePrompt(
      rawGoalDescription,
      responseType,
      feasibilityResults,
      counterProposal
    );
    const responseMessage = await this.llmClient.sendMessage(
      [{ role: "user", content: responsePrompt }],
      { temperature: 0 }
    );

    const negotiationResponse: NegotiationResponse = {
      type: responseType,
      message: responseMessage.content.trim(),
      accepted: responseType === "accept" || responseType === "flag_as_ambitious",
      initial_confidence: initialConfidence,
      ...(counterProposal ? { counter_proposal: counterProposal } : {}),
      ...(ethicsFlags ? { flags: ethicsFlags } : {}),
    };

    log.step5_response = {
      type: responseType,
      accepted: negotiationResponse.accepted,
      initial_confidence: initialConfidence,
      user_acknowledged: false,
      counter_proposal: counterProposal
        ? {
            realistic_target: counterProposal.realistic_target,
            reasoning: counterProposal.reasoning,
            alternatives: counterProposal.alternatives,
          }
        : null,
    };

    // Build Goal object
    const goalDimensions = dimensions.map(decompositionToDimension);
    const goal = GoalSchema.parse({
      id: goalId,
      parent_id: null,
      node_type: "goal",
      title: rawGoalDescription,
      description: rawGoalDescription,
      status: "active",
      dimensions: goalDimensions,
      gap_aggregation: "max",
      dimension_mapping: null,
      constraints,
      children_ids: [],
      target_date: null,
      origin: "negotiation",
      pace_snapshot: null,
      deadline,
      confidence_flag: initialConfidence === "low" ? "low" : initialConfidence === "medium" ? "medium" : "high",
      user_override: false,
      feasibility_note:
        responseType === "counter_propose"
          ? `Counter-proposal: target=${counterProposal?.realistic_target}`
          : null,
      uncertainty_weight: 1.0,
      created_at: now,
      updated_at: now,
    });

    // Persist
    this.stateManager.saveGoal(goal);
    this.saveNegotiationLog(goalId, log);

    return { goal, response: negotiationResponse, log };
  }

  // ─── decompose() ───

  async decompose(
    goalId: string,
    parentGoal: Goal
  ): Promise<{
    subgoals: Goal[];
    rejectedSubgoals: Array<{ description: string; reason: string }>;
  }> {
    return decomposeImpl(goalId, parentGoal, {
      stateManager: this.stateManager,
      llmClient: this.llmClient,
      ethicsGate: this.ethicsGate,
      satisficingJudge: this.satisficingJudge,
      goalTreeManager: this.goalTreeManager,
    });
  }

  // ─── renegotiate() ───

  async renegotiate(
    goalId: string,
    trigger: "stall" | "new_info" | "user_request",
    context?: string
  ): Promise<{
    goal: Goal;
    response: NegotiationResponse;
    log: NegotiationLog;
  }> {
    const existingGoal = this.stateManager.loadGoal(goalId);
    if (existingGoal === null) {
      throw new Error(`renegotiate: goal "${goalId}" not found`);
    }

    const now = new Date().toISOString();

    // Initialize renegotiation log
    const log: NegotiationLog = NegotiationLogSchema.parse({
      goal_id: goalId,
      timestamp: now,
      is_renegotiation: true,
      renegotiation_trigger: trigger,
    });

    // Step 0: Ethics re-check
    const ethicsVerdict = await this.ethicsGate.check(
      "goal",
      goalId,
      existingGoal.description,
      context
    );

    if (ethicsVerdict.verdict === "reject") {
      throw new EthicsRejectedError(ethicsVerdict);
    }

    const ethicsFlags =
      ethicsVerdict.verdict === "flag" ? ethicsVerdict.risks : undefined;

    // Step 2: Re-decompose dimensions (LLM) using existing goal + context
    const availableDataSources = this.observationEngine.getAvailableDimensionInfo();
    const redecompPrompt = buildDecompositionPrompt(
      `${existingGoal.description}${context ? ` (Renegotiation context: ${context})` : ""}`,
      existingGoal.constraints,
      availableDataSources
    );
    const decompositionResponse = await this.llmClient.sendMessage(
      [{ role: "user", content: redecompPrompt }],
      { temperature: 0 }
    );

    const dimensions = this.llmClient.parseJSON(
      decompositionResponse.content,
      z.array(DimensionDecompositionSchema)
    );

    // Post-process: map dimension names to DataSource dimensions when similar
    if (availableDataSources.length > 0) {
      const allDsNames = availableDataSources.flatMap(ds => ds.dimensions);
      for (const dim of dimensions) {
        if (!allDsNames.includes(dim.name)) {
          // Try to find a similar DataSource dimension
          const match = findBestDimensionMatch(dim.name, allDsNames);
          if (match) {
            dim.name = match;
          }
        }
      }
    }

    // Post-process: ensure all dimension keys are unique (LLM may return duplicates)
    deduplicateDimensionKeys(dimensions);

    log.step2_decomposition = { dimensions, method: "llm" };

    // Step 3: Baseline from existing goal state
    const baselineObservations = dimensions.map((dim) => {
      const existingDim = existingGoal.dimensions.find((d) => d.name === dim.name);
      return {
        dimension: dim.name,
        value: existingDim?.current_value ?? null,
        confidence: existingDim?.confidence ?? 0,
        method: "existing_observation",
      };
    });

    log.step3_baseline = { observations: baselineObservations };

    // Step 4: Feasibility re-evaluation
    const feasibilityResults: FeasibilityResult[] = [];
    const timeHorizonDays = DEFAULT_TIME_HORIZON_DAYS;

    for (const dim of dimensions) {
      const baseline = baselineObservations.find((o) => o.dimension === dim.name);
      const baselineValue = baseline?.value ?? null;

      // Check for quantitative path with change rate from history
      const existingDim = existingGoal.dimensions.find((d) => d.name === dim.name);
      const changeRate = existingDim ? this.estimateChangeRate(existingDim) : null;

      if (
        typeof baselineValue === "number" &&
        typeof dim.threshold_value === "number" &&
        changeRate !== null &&
        changeRate > 0
      ) {
        // Quantitative path
        const necessaryChangeRate =
          Math.abs(dim.threshold_value - baselineValue) / timeHorizonDays;
        const feasibilityRatio = necessaryChangeRate / changeRate;

        let assessment: "realistic" | "ambitious" | "infeasible";
        if (feasibilityRatio <= FEASIBILITY_RATIO_THRESHOLD_REALISTIC) {
          assessment = "realistic";
        } else if (feasibilityRatio <= this.getFeasibilityThreshold()) {
          assessment = "ambitious";
        } else {
          assessment = "infeasible";
        }

        feasibilityResults.push(
          FeasibilityResultSchema.parse({
            dimension: dim.name,
            path: "quantitative",
            feasibility_ratio: feasibilityRatio,
            assessment,
            confidence: assessment === "realistic" ? "high" : assessment === "ambitious" ? "medium" : "low",
            reasoning: `Feasibility ratio: ${feasibilityRatio.toFixed(2)}`,
            key_assumptions: [`Change rate: ${changeRate.toFixed(4)}/day`],
            main_risks: assessment === "infeasible" ? ["Target may be unreachable in time horizon"] : [],
          })
        );
      } else {
        // Qualitative fallback
        const result = await this.evaluateQualitatively(
          dim.name,
          existingGoal.description,
          baselineValue,
          dim.threshold_value,
          timeHorizonDays
        );
        feasibilityResults.push(result);
      }
    }

    log.step4_evaluation = {
      path: feasibilityResults.some((r) => r.path === "quantitative") ? "hybrid" : "qualitative",
      dimensions: feasibilityResults,
    };

    // Step 4b: Capability Check
    if (this.adapterCapabilities && this.adapterCapabilities.length > 0) {
      try {
        const capCheckPrompt = buildCapabilityCheckPrompt(
          existingGoal.description,
          dimensions,
          this.adapterCapabilities
        );
        const capCheckResponse = await this.llmClient.sendMessage(
          [{ role: "user", content: capCheckPrompt }],
          { temperature: 0 }
        );
        const capCheckResult = this.llmClient.parseJSON(
          capCheckResponse.content,
          CapabilityCheckResultSchema
        );

        const allCapabilities = this.adapterCapabilities.flatMap((ac) => ac.capabilities);
        const infeasibleDimensions: string[] = [];

        for (const gap of capCheckResult.gaps) {
          if (!gap.acquirable) {
            const existing = feasibilityResults.find((r) => r.dimension === gap.dimension);
            if (existing) {
              existing.assessment = "infeasible";
              existing.reasoning = `Capability gap: ${gap.reason}`;
            }
            infeasibleDimensions.push(gap.dimension);
          }
        }

        log.step4_capability_check = CapabilityCheckLogSchema.parse({
          capabilities_available: allCapabilities,
          gaps_detected: capCheckResult.gaps.map((g) => ({
            dimension: g.dimension,
            required_capability: g.required_capability,
            acquirable: g.acquirable,
          })),
          infeasible_dimensions: infeasibleDimensions,
        });
      } catch {
        // Non-critical: capability check failure should not block renegotiation
        console.warn("[GoalNegotiator] Step 4b capability check failed, continuing without it");
      }
    }

    // Step 5: Response generation
    const { responseType, counterProposal, initialConfidence } =
      this.determineResponseType(feasibilityResults, baselineObservations, timeHorizonDays);

    const responsePrompt = buildResponsePrompt(
      existingGoal.description,
      responseType,
      feasibilityResults,
      counterProposal
    );
    const responseMessage = await this.llmClient.sendMessage(
      [{ role: "user", content: responsePrompt }],
      { temperature: 0 }
    );

    const negotiationResponse: NegotiationResponse = {
      type: responseType,
      message: responseMessage.content.trim(),
      accepted: responseType === "accept" || responseType === "flag_as_ambitious",
      initial_confidence: initialConfidence,
      ...(counterProposal ? { counter_proposal: counterProposal } : {}),
      ...(ethicsFlags ? { flags: ethicsFlags } : {}),
    };

    log.step5_response = {
      type: responseType,
      accepted: negotiationResponse.accepted,
      initial_confidence: initialConfidence,
      user_acknowledged: false,
      counter_proposal: counterProposal
        ? {
            realistic_target: counterProposal.realistic_target,
            reasoning: counterProposal.reasoning,
            alternatives: counterProposal.alternatives,
          }
        : null,
    };

    // Update goal
    const goalDimensions = dimensions.map(decompositionToDimension);
    const updatedGoal = GoalSchema.parse({
      ...existingGoal,
      dimensions: goalDimensions,
      confidence_flag: initialConfidence === "low" ? "low" : initialConfidence === "medium" ? "medium" : "high",
      feasibility_note:
        responseType === "counter_propose"
          ? `Renegotiation counter-proposal: target=${counterProposal?.realistic_target}`
          : null,
      updated_at: now,
    });

    this.stateManager.saveGoal(updatedGoal);
    this.saveNegotiationLog(goalId, log);

    return { goal: updatedGoal, response: negotiationResponse, log };
  }

  // ─── decomposeIntoSubgoals() ───

  /**
   * Decompose a negotiated goal into subgoals using GoalTreeManager.
   * For depth >= 2, skip negotiation and auto-accept.
   * Returns null if goalTreeManager is not injected.
   */
  async decomposeIntoSubgoals(
    goalId: string,
    config?: GoalDecompositionConfig
  ): Promise<DecompositionResult | null> {
    return decomposeIntoSubgoalsImpl(
      goalId,
      {
        stateManager: this.stateManager,
        llmClient: this.llmClient,
        ethicsGate: this.ethicsGate,
        satisficingJudge: this.satisficingJudge,
        goalTreeManager: this.goalTreeManager,
      },
      config
    );
  }

  // ─── suggestGoals() ───

  /**
   * Suggest measurable improvement goals based on the given context.
   * Does NOT save goals — it only suggests. Use negotiate() to register a suggestion.
   */
  async suggestGoals(
    context: string,
    options?: {
      maxSuggestions?: number;
      existingGoals?: string[];
      repoPath?: string;
      capabilityDetector?: CapabilityDetector;
    }
  ): Promise<import("./goal-suggest.js").GoalSuggestion[]> {
    return suggestGoalsImpl(
      context,
      this.llmClient,
      this.ethicsGate,
      this.adapterCapabilities,
      options,
    );
  }

  // ─── getNegotiationLog() ───

  getNegotiationLog(goalId: string): NegotiationLog | null {
    const raw = this.stateManager.readRaw(`goals/${goalId}/negotiation-log.json`);
    if (raw === null) return null;
    return NegotiationLogSchema.parse(raw);
  }

  // ─── Private helpers ───

  private saveNegotiationLog(goalId: string, log: NegotiationLog): void {
    const parsed = NegotiationLogSchema.parse(log);
    this.stateManager.writeRaw(`goals/${goalId}/negotiation-log.json`, parsed);
  }

  private async evaluateQualitatively(
    dimensionName: string,
    goalDescription: string,
    baselineValue: number | string | boolean | null,
    thresholdValue: number | string | boolean | (number | string)[] | null,
    timeHorizonDays: number
  ): Promise<FeasibilityResult> {
    const prompt = buildFeasibilityPrompt(
      dimensionName,
      goalDescription,
      baselineValue,
      thresholdValue,
      timeHorizonDays
    );

    const response = await this.llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      { temperature: 0 }
    );

    try {
      const parsed = this.llmClient.parseJSON(
        response.content,
        QualitativeFeasibilitySchema
      );

      return FeasibilityResultSchema.parse({
        dimension: dimensionName,
        path: "qualitative",
        feasibility_ratio: null,
        assessment: parsed.assessment,
        confidence: parsed.confidence,
        reasoning: parsed.reasoning,
        key_assumptions: parsed.key_assumptions,
        main_risks: parsed.main_risks,
      });
    } catch {
      // Conservative fallback on parse failure
      return FeasibilityResultSchema.parse({
        dimension: dimensionName,
        path: "qualitative",
        feasibility_ratio: null,
        assessment: "ambitious",
        confidence: "low",
        reasoning: "Failed to parse feasibility assessment, defaulting to ambitious.",
        key_assumptions: [],
        main_risks: ["Unable to assess feasibility"],
      });
    }
  }

  private determineResponseType(
    feasibilityResults: FeasibilityResult[],
    baselineObservations: Array<{
      dimension: string;
      value: number | string | boolean | null;
      confidence: number;
      method: string;
    }>,
    timeHorizonDays: number
  ): {
    responseType: "accept" | "counter_propose" | "flag_as_ambitious";
    counterProposal?: {
      realistic_target: number;
      reasoning: string;
      alternatives: string[];
    };
    initialConfidence: "high" | "medium" | "low";
  } {
    const hasInfeasible = feasibilityResults.some((r) => r.assessment === "infeasible");
    const hasLowConfidence = feasibilityResults.some((r) => r.confidence === "low");
    const allRealisticOrAmbitious = feasibilityResults.every(
      (r) => r.assessment === "realistic" || r.assessment === "ambitious"
    );

    let initialConfidence: "high" | "medium" | "low";
    if (hasLowConfidence) {
      initialConfidence = "low";
    } else if (feasibilityResults.some((r) => r.confidence === "medium")) {
      initialConfidence = "medium";
    } else {
      initialConfidence = "high";
    }

    if (hasInfeasible) {
      // Find the first infeasible dimension to build counter-proposal
      const infeasible = feasibilityResults.find((r) => r.assessment === "infeasible")!;
      const baseline = baselineObservations.find((o) => o.dimension === infeasible.dimension);
      const baselineValue = typeof baseline?.value === "number" ? baseline.value : 0;

      // Calculate realistic target
      // If we have a feasibility_ratio, we can compute a change rate
      // realistic_target = baseline + (observed_change_rate * timeHorizonDays * 1.3)
      // Since observed_change_rate = necessary_change_rate / feasibility_ratio
      // and necessary_change_rate = |target - baseline| / timeHorizonDays
      // realistic_target = baseline + (|target - baseline| / feasibility_ratio) * 1.3
      let realisticTarget: number;
      if (infeasible.feasibility_ratio !== null && infeasible.feasibility_ratio > 0) {
        const gap = infeasible.feasibility_ratio > 0
          ? (timeHorizonDays * REALISTIC_TARGET_ACCELERATION_FACTOR) / infeasible.feasibility_ratio
          : 0;
        // Actually: observed_change_rate = necessary_rate / ratio
        // necessary_rate = |target - baseline| / timeHorizon
        // observed * timeHorizon * 1.3 = (necessary_rate / ratio) * timeHorizon * 1.3
        //   = (|target - baseline| / ratio) * 1.3
        // Not exactly right without knowing the target. Let's use a simpler formula.
        // From the spec: realistic_target = baseline + (observed_change_rate * timeHorizonDays * 1.3)
        // observed_change_rate is not available for new goals. Use qualitative fallback.
        realisticTarget = baselineValue;
      } else {
        realisticTarget = baselineValue;
      }

      return {
        responseType: "counter_propose",
        counterProposal: {
          realistic_target: realisticTarget,
          reasoning: infeasible.reasoning,
          alternatives: infeasible.main_risks.length > 0
            ? [`Address risks: ${infeasible.main_risks.join(", ")}`]
            : ["Consider reducing scope or extending timeline"],
        },
        initialConfidence: "low",
      };
    }

    if (hasLowConfidence && allRealisticOrAmbitious) {
      return {
        responseType: "flag_as_ambitious",
        initialConfidence: "low",
      };
    }

    if (allRealisticOrAmbitious) {
      return {
        responseType: "accept",
        initialConfidence,
      };
    }

    return {
      responseType: "accept",
      initialConfidence,
    };
  }

  /**
   * Estimate daily change rate from dimension history.
   * Returns null if insufficient data.
   */
  private estimateChangeRate(dimension: Dimension): number | null {
    const history = dimension.history;
    if (history.length < 2) return null;

    const numericEntries = history.filter(
      (h): h is typeof h & { value: number } => typeof h.value === "number"
    );
    if (numericEntries.length < 2) return null;

    const first = numericEntries[0]!;
    const last = numericEntries[numericEntries.length - 1]!;

    const timeDiffMs =
      new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime();
    const timeDiffDays = timeDiffMs / (1000 * 60 * 60 * 24);
    if (timeDiffDays <= 0) return null;

    return Math.abs(last.value - first.value) / timeDiffDays;
  }

  /**
   * Calculate counter-proposal target given baseline, change rate, and time horizon.
   * Uses acceleration factor from character.md.
   */
  static calculateRealisticTarget(
    baseline: number,
    changeRate: number,
    timeHorizonDays: number
  ): number {
    return baseline + changeRate * timeHorizonDays * REALISTIC_TARGET_ACCELERATION_FACTOR;
  }
}
