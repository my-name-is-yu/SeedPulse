import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StateManager } from "../state-manager.js";
import type { ILLMClient } from "../llm/llm-client.js";
import type { EthicsGate } from "../traits/ethics-gate.js";
import type { GoalDependencyGraph } from "./goal-dependency-graph.js";
import type { GoalNegotiator } from "./goal-negotiator.js";
import { GoalSchema } from "../types/goal.js";
import type { Goal } from "../types/goal.js";
import type {
  GoalDecompositionConfig,
  DecompositionResult,
  GoalTreeState,
  PruneDecision,
  PruneReason,
  ConcretenessScore,
  DecompositionQualityMetrics,
  PruneRecord,
} from "../types/goal-tree.js";
import { ConcretenessScoreSchema, DecompositionQualityMetricsSchema } from "../types/goal-tree.js";

// ─── LLM Response Schemas ───

const SpecificityResponseSchema = z.object({
  specificity_score: z.number().min(0).max(1),
  reasoning: z.string(),
});

const SubgoalItemSchema = z.object({
  hypothesis: z.string(),
  dimensions: z
    .array(
      z.object({
        name: z.string(),
        label: z.string(),
        threshold_type: z.enum(["min", "max", "range", "present", "match"]),
        threshold_value: z.union([z.number(), z.string(), z.boolean(), z.null()]).nullable(),
        observation_method_hint: z.string().optional().default(""),
      })
    )
    .default([]),
  constraints: z.array(z.string()).default([]),
  expected_specificity: z.number().min(0).max(1).optional(),
});

const SubgoalsResponseSchema = z.array(SubgoalItemSchema);

const CoverageResponseSchema = z.object({
  covers_parent: z.boolean(),
  missing_dimensions: z.array(z.string()).default([]),
  reasoning: z.string(),
});

const RestructureSuggestionSchema = z.object({
  action: z.enum(["move", "merge", "split", "reorder"]),
  goal_ids: z.array(z.string()),
  reasoning: z.string(),
});
const RestructureResponseSchema = z.array(RestructureSuggestionSchema);

const ConcretenessLLMResponseSchema = z.object({
  hasQuantitativeThreshold: z.boolean(),
  hasObservableOutcome: z.boolean(),
  hasTimebound: z.boolean(),
  hasClearScope: z.boolean(),
  reason: z.string(),
});

const QualityEvaluationResponseSchema = z.object({
  coverage: z.number().min(0).max(1),
  overlap: z.number().min(0).max(1),
  actionability: z.number().min(0).max(1),
  reasoning: z.string(),
});

// ─── Prompt Builders ───

function buildSpecificityPrompt(goal: Goal): string {
  const dimNames = goal.dimensions.map((d) => d.name).join(", ");
  const constraintLines =
    goal.constraints.length > 0
      ? `\nConstraints: ${goal.constraints.join(", ")}`
      : "";
  return `Evaluate the specificity of this goal. A high specificity score (>= 0.7) means the goal is already a single, atomic task with no meaningful sub-components that could be worked on independently. A low score (< 0.7) means it has multiple distinct aspects that should be broken down into separate subgoals.

Goal title: ${goal.title}
Goal description: ${goal.description}
Dimensions: ${dimNames || "(none defined)"}${constraintLines}
Current decomposition depth: ${goal.decomposition_depth}

Output JSON:
{
  "specificity_score": <number 0.0 to 1.0>,
  "reasoning": "<brief explanation>"
}

Return ONLY the JSON object, no other text.`;
}

function buildSubgoalPrompt(
  goal: Goal,
  depth: number,
  maxDepth: number,
  maxChildren: number
): string {
  const constraintLines =
    goal.constraints.length > 0
      ? `Constraints:\n${goal.constraints.map((c) => `- ${c}`).join("\n")}`
      : "Constraints: none";

  const dimLines =
    goal.dimensions.length > 0
      ? `Existing dimensions:\n${goal.dimensions.map((d) => `- ${d.name}: ${d.label}`).join("\n")}`
      : "Existing dimensions: none";

  return `Decompose this goal into ${maxChildren} or fewer concrete subgoals. Each subgoal should address a distinct aspect of the parent goal and be more specific.

Parent goal: ${goal.title}
Description: ${goal.description}
${dimLines}
${constraintLines}
Current depth: ${depth} (max allowed depth: ${maxDepth})
Remaining decomposition levels: ${maxDepth - depth}

For each subgoal, provide:
- hypothesis: what this subgoal achieves (1-2 sentences)
- dimensions: array of measurable dimensions with fields:
    - name: string (snake_case identifier)
    - label: string (human-readable)
    - threshold_type: MUST be one of "min" | "max" | "range" | "present" | "match" (no other values allowed)
    - threshold_value: number or string or boolean or null
    - observation_method_hint: string (optional)
- constraints: array of constraints specific to this subgoal
- expected_specificity: estimated specificity score after decomposition (0.0-1.0)

Output JSON array of subgoal objects. Maximum ${maxChildren} items.
Return ONLY a JSON array, no other text.`;
}

function buildCoveragePrompt(parent: Goal, children: Goal[]): string {
  const parentDims = parent.dimensions.map((d) => d.name).join(", ");
  const childSummaries = children
    .map((c, i) => `  ${i + 1}. "${c.title}": dimensions=[${c.dimensions.map((d) => d.name).join(", ")}]`)
    .join("\n");

  return `Do these subgoals collectively cover all dimensions of the parent goal?

Parent goal: ${parent.title}
Parent dimensions: ${parentDims || "(none)"}

Subgoals:
${childSummaries}

Output JSON:
{
  "covers_parent": <true|false>,
  "missing_dimensions": ["<dim1>", ...],
  "reasoning": "<brief explanation>"
}

Return ONLY the JSON object, no other text.`;
}

function buildConcretenessPrompt(description: string): string {
  return `Evaluate the concreteness of this goal description on four dimensions.

Goal description: "${description}"

Answer each question:
1. hasQuantitativeThreshold: Does the goal specify quantitative/measurable success criteria or thresholds? (e.g., "achieve 80% coverage", "response time < 200ms")
2. hasObservableOutcome: Does the goal describe an observable, verifiable outcome? (e.g., "a working API endpoint", "passing CI build")
3. hasTimebound: Does the goal have a time constraint or deadline? (e.g., "by end of sprint", "within 2 weeks")
4. hasClearScope: Does the goal have a clearly defined scope with no ambiguity about what is included or excluded?

Output JSON:
{
  "hasQuantitativeThreshold": <true|false>,
  "hasObservableOutcome": <true|false>,
  "hasTimebound": <true|false>,
  "hasClearScope": <true|false>,
  "reason": "<brief explanation covering all four dimensions>"
}

Return ONLY the JSON object, no other text.`;
}

function buildQualityEvaluationPrompt(parentDescription: string, subgoalDescriptions: string[]): string {
  const subgoalList = subgoalDescriptions
    .map((desc, i) => `  ${i + 1}. "${desc}"`)
    .join("\n");

  return `Evaluate the quality of this goal decomposition.

Parent goal: "${parentDescription}"

Subgoals:
${subgoalList}

Evaluate:
1. coverage (0.0-1.0): How well do the subgoals collectively cover all aspects of the parent goal? 1.0 = complete coverage, 0.0 = no coverage.
2. overlap (0.0-1.0): How much redundancy/overlap exists between subgoals? 0.0 = no overlap (ideal), 1.0 = all subgoals are identical.
3. actionability (0.0-1.0): Average concreteness/actionability of the subgoals. 1.0 = all are immediately actionable, 0.0 = all are too abstract.

Output JSON:
{
  "coverage": <number 0.0 to 1.0>,
  "overlap": <number 0.0 to 1.0>,
  "actionability": <number 0.0 to 1.0>,
  "reasoning": "<brief explanation>"
}

Return ONLY the JSON object, no other text.`;
}

function buildRestructurePrompt(rootId: string, treeState: GoalTreeState, goals: Goal[]): string {
  const goalSummaries = goals
    .map((g) => `  - id="${g.id}" title="${g.title}" depth=${g.decomposition_depth} status=${g.status}`)
    .join("\n");

  return `Suggest restructuring actions for this goal tree to improve efficiency.

Root goal ID: ${rootId}
Total nodes: ${treeState.total_nodes}
Max depth reached: ${treeState.max_depth_reached}
Active loops: ${treeState.active_loops.length}
Pruned nodes: ${treeState.pruned_nodes.length}

Goals in tree:
${goalSummaries}

Suggest restructuring actions. Each action should specify:
- action: "move" | "merge" | "split" | "reorder"
- goal_ids: array of goal IDs involved
- reasoning: why this restructuring would help

Output JSON array. Return empty array [] if no restructuring needed.
Return ONLY a JSON array, no other text.`;
}

// ─── Helper: Build a Goal from subgoal spec ───

function buildGoalFromSubgoalSpec(
  spec: z.infer<typeof SubgoalItemSchema>,
  parentId: string,
  parentDepth: number,
  now: string
): Goal {
  const id = randomUUID();
  const dims = spec.dimensions.map((d) => ({
    name: d.name,
    label: d.label,
    current_value: null,
    threshold: {
      type: d.threshold_type,
      value: d.threshold_value ?? null,
    },
    confidence: 0.5,
    observation_method: {
      type: "manual" as const,
      source: "decomposition",
      schedule: null,
      endpoint: null,
      confidence_tier: "self_report" as const,
    },
    last_updated: now,
    history: [],
    weight: 1.0,
    uncertainty_weight: null,
    state_integrity: "ok" as const,
    dimension_mapping: null,
  }));

  return GoalSchema.parse({
    id,
    parent_id: parentId,
    node_type: "subgoal",
    title: spec.hypothesis.slice(0, 200),
    description: spec.hypothesis,
    status: "active",
    dimensions: dims,
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: spec.constraints,
    children_ids: [],
    target_date: null,
    origin: "decomposition",
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    decomposition_depth: parentDepth + 1,
    specificity_score: spec.expected_specificity ?? null,
    loop_status: "idle",
    created_at: now,
    updated_at: now,
  });
}

// ─── GoalTreeManager ───

/**
 * GoalTreeManager handles recursive goal decomposition, pruning,
 * dynamic subgoal addition, tree restructuring, and tree state queries.
 *
 * Responsibilities:
 *   - Specificity evaluation (LLM)
 *   - N-layer recursive decomposition
 *   - Decomposition validation (coverage + cycle check)
 *   - Pruning (cancel goal + all descendants)
 *   - Dynamic subgoal addition
 *   - Tree state queries
 */
export interface GoalTreeManagerOptions {
  concretenesThreshold?: number;
  maxDepth?: number;
}

export class GoalTreeManager {
  private readonly concretenesThreshold: number | null;
  private readonly maxDepth: number;
  private readonly pruneHistory: Map<string, PruneRecord[]> = new Map();

  constructor(
    private readonly stateManager: StateManager,
    private readonly llmClient: ILLMClient,
    private readonly ethicsGate: EthicsGate,
    private readonly goalDependencyGraph: GoalDependencyGraph,
    private readonly goalNegotiator?: GoalNegotiator,
    options?: GoalTreeManagerOptions
  ) {
    // null means concreteness auto-stop is disabled (backward compatible)
    this.concretenesThreshold = options?.concretenesThreshold ?? null;
    this.maxDepth = options?.maxDepth ?? 5;
  }

  // ─── Concreteness Scoring ───

  /**
   * Scores the concreteness of a goal description on four dimensions using an LLM.
   * Score = weighted average of 4 boolean dimensions (each 0.25).
   * Falls back to zero score on LLM/parse failures.
   */
  async scoreConcreteness(description: string): Promise<ConcretenessScore> {
    if (!description || description.trim() === "") {
      return ConcretenessScoreSchema.parse({
        score: 0,
        dimensions: {
          hasQuantitativeThreshold: false,
          hasObservableOutcome: false,
          hasTimebound: false,
          hasClearScope: false,
        },
        reason: "Empty description provided",
      });
    }

    const prompt = buildConcretenessPrompt(description);
    try {
      const response = await this.llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { temperature: 0 }
      );
      const parsed = this.llmClient.parseJSON(response.content, ConcretenessLLMResponseSchema);
      const dims = {
        hasQuantitativeThreshold: parsed.hasQuantitativeThreshold,
        hasObservableOutcome: parsed.hasObservableOutcome,
        hasTimebound: parsed.hasTimebound,
        hasClearScope: parsed.hasClearScope,
      };
      const trueCount = Object.values(dims).filter(Boolean).length;
      const score = trueCount * 0.25;
      return ConcretenessScoreSchema.parse({
        score,
        dimensions: dims,
        reason: parsed.reason,
      });
    } catch {
      return ConcretenessScoreSchema.parse({
        score: 0,
        dimensions: {
          hasQuantitativeThreshold: false,
          hasObservableOutcome: false,
          hasTimebound: false,
          hasClearScope: false,
        },
        reason: "LLM evaluation failed, defaulting to zero score",
      });
    }
  }

  // ─── Decomposition Quality ───

  /**
   * Evaluates the quality of a decomposition using an LLM.
   * Measures coverage, overlap, actionability, and computes depthEfficiency.
   * Logs a warning when quality is poor (coverage < 0.5 or overlap > 0.7).
   */
  async evaluateDecompositionQuality(
    parentDescription: string,
    subgoalDescriptions: string[]
  ): Promise<DecompositionQualityMetrics> {
    if (subgoalDescriptions.length === 0) {
      const metrics = DecompositionQualityMetricsSchema.parse({
        coverage: 0,
        overlap: 0,
        actionability: 0,
        depthEfficiency: 1,
      });
      console.warn(
        "GoalTreeManager.evaluateDecompositionQuality: no subgoals provided — coverage=0"
      );
      return metrics;
    }

    const prompt = buildQualityEvaluationPrompt(parentDescription, subgoalDescriptions);
    let coverage = 0;
    let overlap = 0;
    let actionability = 0;

    try {
      const response = await this.llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { temperature: 0 }
      );
      const parsed = this.llmClient.parseJSON(response.content, QualityEvaluationResponseSchema);
      coverage = parsed.coverage;
      overlap = parsed.overlap;
      actionability = parsed.actionability;
    } catch {
      // On failure return conservative metrics
      coverage = 0;
      overlap = 0;
      actionability = 0;
    }

    const depthEfficiency = Math.max(0, Math.min(1, 1 - overlap * 0.5));

    const metrics = DecompositionQualityMetricsSchema.parse({
      coverage,
      overlap,
      actionability,
      depthEfficiency,
    });

    if (coverage < 0.5 || overlap > 0.7) {
      console.warn(
        `GoalTreeManager.evaluateDecompositionQuality: poor quality detected — coverage=${coverage.toFixed(2)}, overlap=${overlap.toFixed(2)}`
      );
    }

    return metrics;
  }

  // ─── Specificity Evaluation ───

  /**
   * Evaluates the specificity of a goal using an LLM.
   * Returns a score between 0 (very abstract) and 1 (very concrete).
   * Falls back to 0.5 on parse failures.
   */
  private async evaluateSpecificity(
    goal: Goal
  ): Promise<{ score: number; reasoning: string }> {
    const prompt = buildSpecificityPrompt(goal);
    try {
      const response = await this.llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { temperature: 0 }
      );
      const parsed = this.llmClient.parseJSON(
        response.content,
        SpecificityResponseSchema
      );
      return { score: parsed.specificity_score, reasoning: parsed.reasoning };
    } catch {
      // Conservative fallback: treat as needing decomposition
      return { score: 0.5, reasoning: "LLM evaluation failed, defaulting to 0.5" };
    }
  }

  // ─── Core Decomposition ───

  /**
   * Recursively decomposes a goal into subgoals until each subgoal either:
   *   (a) has specificity_score >= config.min_specificity → leaf node
   *   (b) has decomposition_depth >= config.max_depth → forced leaf
   *   (c) concreteness score >= concretenesThreshold (auto-stop)
   *   (d) current depth >= maxDepth (depth guard)
   *
   * Options override instance-level defaults when provided.
   * Returns a DecompositionResult for the top-level call.
   */
  async decomposeGoal(
    goalId: string,
    config: GoalDecompositionConfig,
    options?: { concretenesThreshold?: number; maxDepth?: number }
  ): Promise<DecompositionResult> {
    const goal = this.stateManager.loadGoal(goalId);
    if (!goal) {
      throw new Error(`GoalTreeManager.decomposeGoal: goal "${goalId}" not found`);
    }

    const effectiveConcretenesThreshold =
      options?.concretenesThreshold ?? this.concretenesThreshold;
    const effectiveMaxDepth = options?.maxDepth ?? this.maxDepth;

    // Auto-stop: check concreteness before decomposing (only when threshold is explicitly set)
    if (effectiveConcretenesThreshold !== null) {
      const concretenessResult = await this.scoreConcreteness(goal.description);
      if (concretenessResult.score >= effectiveConcretenesThreshold) {
        const now = new Date().toISOString();
        const leafGoal: Goal = {
          ...goal,
          node_type: "leaf",
          specificity_score: concretenessResult.score,
          updated_at: now,
        };
        this.stateManager.saveGoal(leafGoal);
        return {
          parent_id: goal.id,
          children: [],
          depth: goal.decomposition_depth,
          specificity_scores: { [goal.id]: concretenessResult.score },
          reasoning: `Auto-stop: concreteness score ${concretenessResult.score.toFixed(2)} >= threshold ${effectiveConcretenesThreshold}. ${concretenessResult.reason}`,
        };
      }
    }

    return this._decomposeGoalInternal(goal, config, 0, effectiveMaxDepth);
  }

  private async _decomposeGoalInternal(
    goal: Goal,
    config: GoalDecompositionConfig,
    retryCount: number,
    depthLimit?: number
  ): Promise<DecompositionResult> {
    const now = new Date().toISOString();
    const effectiveMaxDepth = depthLimit ?? config.max_depth;

    // Step 1: Evaluate specificity
    const { score: specificityScore, reasoning } = await this.evaluateSpecificity(goal);

    // Update goal with specificity score
    const updatedGoal: Goal = {
      ...goal,
      specificity_score: specificityScore,
      updated_at: now,
    };

    // Step 2: Determine if this is a leaf node
    const isLeaf =
      (goal.decomposition_depth > 0 && specificityScore >= config.min_specificity) ||
      goal.decomposition_depth >= effectiveMaxDepth;

    if (isLeaf) {
      // Mark as leaf node
      const leafGoal: Goal = {
        ...updatedGoal,
        node_type: "leaf",
        updated_at: now,
      };
      this.stateManager.saveGoal(leafGoal);

      return {
        parent_id: goal.id,
        children: [],
        depth: goal.decomposition_depth,
        specificity_scores: { [goal.id]: specificityScore },
        reasoning:
          specificityScore >= config.min_specificity
            ? `Goal is specific enough (score=${specificityScore.toFixed(2)}): ${reasoning}`
            : `Max depth ${effectiveMaxDepth} reached, forced leaf`,
      };
    }

    // Step 3: Generate subgoals via LLM
    const maxChildren = 5;
    const subgoalPrompt = buildSubgoalPrompt(
      updatedGoal,
      goal.decomposition_depth,
      effectiveMaxDepth,
      maxChildren
    );

    let subgoalSpecs: z.infer<typeof SubgoalsResponseSchema> = [];
    try {
      const subgoalResponse = await this.llmClient.sendMessage(
        [{ role: "user", content: subgoalPrompt }],
        { temperature: 0 }
      );
      // Sanitize threshold_type values before schema validation —
      // LLMs sometimes return "exact", "scale", "qualitative" etc.
      const THRESHOLD_TYPE_MAP: Record<string, string> = {
        exact: "match",
        scale: "min",
        qualitative: "min",
        boolean: "present",
        percentage: "min",
        count: "min",
      };
      const VALID_TYPES = new Set(["min", "max", "range", "present", "match"]);
      const rawContent = subgoalResponse.content;
      const sanitized = rawContent.replace(
        /"threshold_type"\s*:\s*"([^"]+)"/g,
        (_match: string, val: string) => {
          if (VALID_TYPES.has(val)) return `"threshold_type": "${val}"`;
          const mapped = THRESHOLD_TYPE_MAP[val] ?? "min";
          return `"threshold_type": "${mapped}"`;
        }
      );
      const parsed = this.llmClient.parseJSON(
        sanitized,
        SubgoalsResponseSchema
      );
      subgoalSpecs = parsed.map((sg: (typeof parsed)[number]) => ({
        ...sg,
        dimensions: (sg.dimensions ?? []).map((d) => ({
          ...d,
          observation_method_hint: d.observation_method_hint ?? "",
        })),
        constraints: sg.constraints ?? [],
      }));
      // Clamp to max_children_per_node
      subgoalSpecs = subgoalSpecs.slice(0, maxChildren);
    } catch (err) {
      // If subgoal generation fails, treat as leaf — but log the error for diagnostics
      console.error(`[GoalTreeManager] Subgoal generation failed for "${goal.id}":`, err instanceof Error ? err.message : String(err));
      const leafGoal: Goal = {
        ...updatedGoal,
        node_type: "leaf",
        updated_at: now,
      };
      this.stateManager.saveGoal(leafGoal);
      return {
        parent_id: goal.id,
        children: [],
        depth: goal.decomposition_depth,
        specificity_scores: { [goal.id]: specificityScore },
        reasoning: `Subgoal generation failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Handle empty decomposition
    if (subgoalSpecs.length === 0) {
      const leafGoal: Goal = {
        ...updatedGoal,
        node_type: "leaf",
        updated_at: now,
      };
      this.stateManager.saveGoal(leafGoal);
      return {
        parent_id: goal.id,
        children: [],
        depth: goal.decomposition_depth,
        specificity_scores: { [goal.id]: specificityScore },
        reasoning: "LLM returned empty subgoal list, treating as leaf",
      };
    }

    // Step 4: Build child Goal objects
    const childGoals: Goal[] = subgoalSpecs.map((spec) =>
      buildGoalFromSubgoalSpec(spec, goal.id, goal.decomposition_depth, now)
    );

    // Step 5: Build the provisional decomposition result for validation
    const provisionalResult: DecompositionResult = {
      parent_id: goal.id,
      children: childGoals,
      depth: goal.decomposition_depth,
      specificity_scores: { [goal.id]: specificityScore },
      reasoning,
    };

    // Step 6: Validate decomposition (retry up to 2 times)
    const isValid = await this.validateDecomposition(provisionalResult);
    if (!isValid && retryCount < 2) {
      // Retry decomposition
      return this._decomposeGoalInternal(goal, config, retryCount + 1, depthLimit);
    }

    // Step 7: Save parent goal (updated specificity_score, node_type stays as-is for non-leaf)
    this.stateManager.saveGoal(updatedGoal);

    // Step 8: Save each child goal and update parent's children_ids
    const childIds: string[] = [];
    for (const child of childGoals) {
      this.stateManager.saveGoal(child);
      childIds.push(child.id);

      // Register parent->child dependency in GoalDependencyGraph
      try {
        this.goalDependencyGraph.addEdge({
          from_goal_id: goal.id,
          to_goal_id: child.id,
          type: "parent_child" as never, // type extended in 14A
          status: "active",
          condition: null,
          affected_dimensions: child.dimensions.map((d) => d.name),
          mitigation: null,
          detection_confidence: 1.0,
          reasoning: `Parent-child relationship from goal decomposition`,
        });
      } catch {
        // Dependency graph may not support parent_child type — skip silently
      }
    }

    // Update parent goal's children_ids
    const parentWithChildren: Goal = {
      ...updatedGoal,
      children_ids: [...updatedGoal.children_ids, ...childIds],
      updated_at: now,
    };
    this.stateManager.saveGoal(parentWithChildren);

    // Step 9: Collect specificity scores for result
    const specificityScores: Record<string, number> = {
      [goal.id]: specificityScore,
    };

    // Step 10: Recursively decompose each child
    for (const child of childGoals) {
      const childResult = await this._decomposeGoalInternal(child, config, 0, depthLimit);
      // Merge child specificity scores
      Object.assign(specificityScores, childResult.specificity_scores);
      // Merge children into child's record
      if (childResult.children.length > 0) {
        const reloadedChild = this.stateManager.loadGoal(child.id);
        if (reloadedChild) {
          // child was saved with updated children_ids from recursive call
          void reloadedChild; // already persisted by recursive call
        }
      }
    }

    return {
      parent_id: goal.id,
      children: childGoals,
      depth: goal.decomposition_depth,
      specificity_scores: specificityScores,
      reasoning,
    };
  }

  // ─── Validation ───

  /**
   * Validates a decomposition result by checking:
   *   1. Coverage: subgoals cover all parent dimensions (LLM)
   *   2. Cycle detection: no circular dependencies introduced
   *
   * Returns true only if both checks pass.
   */
  async validateDecomposition(result: DecompositionResult): Promise<boolean> {
    const parent = this.stateManager.loadGoal(result.parent_id);
    if (!parent) return false;

    const children = result.children as Goal[];

    // Check 1: Coverage validation via LLM
    if (children.length > 0) {
      const coveragePrompt = buildCoveragePrompt(parent, children);
      try {
        const coverageResponse = await this.llmClient.sendMessage(
          [{ role: "user", content: coveragePrompt }],
          { temperature: 0 }
        );
        const coverage = this.llmClient.parseJSON(
          coverageResponse.content,
          CoverageResponseSchema
        );
        if (!coverage.covers_parent) {
          return false;
        }
      } catch {
        // On parse failure, allow decomposition to proceed
      }
    }

    // Check 2: Cycle detection
    for (const child of children as Goal[]) {
      const wouldCycle = this.goalDependencyGraph.detectCycle(
        result.parent_id,
        child.id
      );
      if (wouldCycle) {
        return false;
      }
    }

    return true;
  }

  // ─── Pruning ───

  /**
   * Prunes a goal and all its descendants by setting status = "cancelled".
   * Removes the goal from its parent's children_ids.
   * Returns a PruneDecision.
   */
  pruneGoal(goalId: string, reason: PruneReason): PruneDecision {
    const goal = this.stateManager.loadGoal(goalId);
    if (!goal) {
      throw new Error(`GoalTreeManager.pruneGoal: goal "${goalId}" not found`);
    }

    const now = new Date().toISOString();

    // Cancel the goal and all descendants
    this._cancelGoalAndDescendants(goal, now);

    // Remove from parent's children_ids
    if (goal.parent_id) {
      const parent = this.stateManager.loadGoal(goal.parent_id);
      if (parent) {
        const updatedParent: Goal = {
          ...parent,
          children_ids: parent.children_ids.filter((id) => id !== goalId),
          updated_at: now,
        };
        this.stateManager.saveGoal(updatedParent);
      }
    }

    return {
      goal_id: goalId,
      reason,
      replacement_id: null,
    };
  }

  /**
   * Prunes a subgoal with a free-form reason string for tracking.
   * Records a PruneRecord in the history for the parent goal tree.
   * The parentGoalId is the root goal whose history you want to track.
   */
  pruneSubgoal(
    subgoalId: string,
    reason: string,
    parentGoalId?: string
  ): PruneDecision {
    const goal = this.stateManager.loadGoal(subgoalId);
    if (!goal) {
      throw new Error(`GoalTreeManager.pruneSubgoal: goal "${subgoalId}" not found`);
    }

    const now = new Date().toISOString();

    // Cancel the goal and all descendants
    this._cancelGoalAndDescendants(goal, now);

    // Remove from parent's children_ids
    if (goal.parent_id) {
      const parent = this.stateManager.loadGoal(goal.parent_id);
      if (parent) {
        const updatedParent: Goal = {
          ...parent,
          children_ids: parent.children_ids.filter((id) => id !== subgoalId),
          updated_at: now,
        };
        this.stateManager.saveGoal(updatedParent);
      }
    }

    // Record prune history keyed by parentGoalId or the goal's own parent_id
    const trackingKey = parentGoalId ?? goal.parent_id ?? subgoalId;
    const record: PruneRecord = { subgoalId, reason, timestamp: now };
    const existing = this.pruneHistory.get(trackingKey) ?? [];
    this.pruneHistory.set(trackingKey, [...existing, record]);

    return {
      goal_id: subgoalId,
      reason: "user_requested",
      replacement_id: null,
    };
  }

  /**
   * Returns the prune history for a given goal tree root ID.
   * Returns an empty array if no prunes have been recorded.
   */
  getPruneHistory(goalId: string): PruneRecord[] {
    return this.pruneHistory.get(goalId) ?? [];
  }

  private _cancelGoalAndDescendants(goal: Goal, now: string): void {
    // Recursively cancel all children first
    for (const childId of goal.children_ids) {
      const child = this.stateManager.loadGoal(childId);
      if (child) {
        this._cancelGoalAndDescendants(child, now);
      }
    }

    // Cancel this goal
    const cancelled: Goal = {
      ...goal,
      status: "cancelled",
      updated_at: now,
    };
    this.stateManager.saveGoal(cancelled);
  }

  // ─── Dynamic Subgoal Addition ───

  /**
   * Adds a new subgoal to a parent goal.
   * - Validates the parent exists
   * - Saves the new goal with parent_id set
   * - Adds child ID to parent's children_ids
   * - Registers the dependency in GoalDependencyGraph
   * Returns the saved goal.
   */
  addSubgoal(parentId: string, goal: Goal): Goal {
    const parent = this.stateManager.loadGoal(parentId);
    if (!parent) {
      throw new Error(`GoalTreeManager.addSubgoal: parent goal "${parentId}" not found`);
    }

    const now = new Date().toISOString();

    // Ensure parent_id is set on the new goal
    const goalWithParent: Goal = GoalSchema.parse({
      ...goal,
      parent_id: parentId,
      updated_at: now,
    });

    // Save the new goal
    this.stateManager.saveGoal(goalWithParent);

    // Update parent's children_ids
    const updatedParent: Goal = {
      ...parent,
      children_ids: [...parent.children_ids, goalWithParent.id],
      updated_at: now,
    };
    this.stateManager.saveGoal(updatedParent);

    // Register dependency
    try {
      this.goalDependencyGraph.addEdge({
        from_goal_id: parentId,
        to_goal_id: goalWithParent.id,
        type: "parent_child" as never,
        status: "active",
        condition: null,
        affected_dimensions: goalWithParent.dimensions.map((d) => d.name),
        mitigation: null,
        detection_confidence: 1.0,
        reasoning: `Parent-child relationship (dynamic subgoal addition)`,
      });
    } catch {
      // Dependency graph may not support parent_child type — skip silently
    }

    return goalWithParent;
  }

  // ─── Tree Restructure ───

  /**
   * Asks an LLM for restructuring suggestions on the current tree rooted at goalId,
   * then applies them. Currently supports identifying merge/move candidates.
   *
   * After restructuring, evaluates quality of the new structure. If quality
   * metrics do not show improvement (overall score degraded), reverts changes
   * by restoring the snapshot taken before restructuring.
   *
   * Returns the quality metrics of the final (kept) structure.
   */
  async restructureTree(goalId: string): Promise<DecompositionQualityMetrics | null | undefined> {
    const allGoalIdsBefore = this._collectAllDescendantIds(goalId);
    allGoalIdsBefore.unshift(goalId);

    const qualityEnabled = this.concretenesThreshold !== null;

    // Snapshot state before restructuring (needed for quality-based revert)
    const snapshot = new Map<string, Goal>();
    if (qualityEnabled) {
      for (const id of allGoalIdsBefore) {
        const g = this.stateManager.loadGoal(id);
        if (g) snapshot.set(id, g);
      }
    }

    // Evaluate quality before restructuring (only when concreteness feature is enabled)
    const rootGoalBefore = this.stateManager.loadGoal(goalId);
    let qualityBefore: DecompositionQualityMetrics | null = null;
    if (qualityEnabled) {
      const beforeSubgoalDescs = allGoalIdsBefore
        .slice(1)
        .map((id) => snapshot.get(id)?.description ?? "")
        .filter(Boolean);
      qualityBefore =
        beforeSubgoalDescs.length > 0 && rootGoalBefore
          ? await this.evaluateDecompositionQuality(
              rootGoalBefore.description,
              beforeSubgoalDescs
            )
          : null;
    }

    const treeState = this.getTreeState(goalId);
    const goals: Goal[] = [];
    for (const id of allGoalIdsBefore) {
      const g = this.stateManager.loadGoal(id);
      if (g) goals.push(g);
    }

    const prompt = buildRestructurePrompt(goalId, treeState, goals);
    let restructuringApplied = false;
    try {
      const response = await this.llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { temperature: 0 }
      );
      const suggestions = this.llmClient.parseJSON(
        response.content,
        RestructureResponseSchema
      );

      const now = new Date().toISOString();

      for (const suggestion of suggestions) {
        if (suggestion.action === "merge" && suggestion.goal_ids.length >= 2) {
          // Merge: cancel all but first goal in the list
          const [keepId, ...mergeIds] = suggestion.goal_ids;
          if (keepId) {
            for (const mergeId of mergeIds) {
              const mergeGoal = this.stateManager.loadGoal(mergeId);
              if (mergeGoal && mergeGoal.status !== "cancelled") {
                this._cancelGoalAndDescendants(mergeGoal, now);
                restructuringApplied = true;
                // Remove from parent
                if (mergeGoal.parent_id) {
                  const parent = this.stateManager.loadGoal(mergeGoal.parent_id);
                  if (parent) {
                    const updatedParent: Goal = {
                      ...parent,
                      children_ids: parent.children_ids.filter((id) => id !== mergeId),
                      updated_at: now,
                    };
                    this.stateManager.saveGoal(updatedParent);
                  }
                }
              }
            }
          }
        }
        // Other actions (move, split, reorder) are logged but not fully automated in MVP
      }
    } catch {
      // Restructure is best-effort; silently ignore errors
    }

    // Quality evaluation after restructuring (only when concreteness feature is enabled)
    if (!qualityEnabled || !restructuringApplied || !rootGoalBefore) {
      // When quality evaluation is not enabled, return undefined
      // to maintain backward compatibility with pre-M7 void return
      return qualityEnabled ? qualityBefore : undefined;
    }

    const allGoalIdsAfter = this._collectAllDescendantIds(goalId);
    allGoalIdsAfter.unshift(goalId);
    const afterSubgoalDescs = allGoalIdsAfter
      .slice(1)
      .map((id) => {
        const g = this.stateManager.loadGoal(id);
        return g?.description ?? "";
      })
      .filter(Boolean);

    const qualityAfter =
      afterSubgoalDescs.length > 0
        ? await this.evaluateDecompositionQuality(
            rootGoalBefore.description,
            afterSubgoalDescs
          )
        : DecompositionQualityMetricsSchema.parse({
            coverage: 0,
            overlap: 0,
            actionability: 0,
            depthEfficiency: 1,
          });

    // Compute an overall score: higher coverage + lower overlap + higher actionability is better
    const scoreBefore = qualityBefore
      ? qualityBefore.coverage * 0.4 +
        (1 - qualityBefore.overlap) * 0.3 +
        qualityBefore.actionability * 0.3
      : 0;
    const scoreAfter =
      qualityAfter.coverage * 0.4 +
      (1 - qualityAfter.overlap) * 0.3 +
      qualityAfter.actionability * 0.3;

    if (scoreAfter < scoreBefore) {
      // Revert: restore all goals from snapshot
      for (const [, savedGoal] of snapshot) {
        this.stateManager.saveGoal(savedGoal);
      }
      return qualityBefore;
    }

    return qualityAfter;
  }

  // ─── Tree State ───

  /**
   * Computes the current GoalTreeState for the tree rooted at rootId.
   * Traverses all descendants recursively.
   */
  getTreeState(rootId: string): GoalTreeState {
    const root = this.stateManager.loadGoal(rootId);
    if (!root) {
      return {
        root_id: rootId,
        total_nodes: 0,
        max_depth_reached: 0,
        active_loops: [],
        pruned_nodes: [],
      };
    }

    let totalNodes = 0;
    let maxDepthReached = 0;
    const activeLoops: string[] = [];
    const prunedNodes: string[] = [];

    const visit = (goal: Goal): void => {
      totalNodes++;

      if (goal.decomposition_depth > maxDepthReached) {
        maxDepthReached = goal.decomposition_depth;
      }

      if (goal.loop_status === "running") {
        activeLoops.push(goal.id);
      }

      if (goal.status === "cancelled") {
        prunedNodes.push(goal.id);
      }

      for (const childId of goal.children_ids) {
        const child = this.stateManager.loadGoal(childId);
        if (child) {
          visit(child);
        }
      }
    };

    visit(root);

    return {
      root_id: rootId,
      total_nodes: totalNodes,
      max_depth_reached: maxDepthReached,
      active_loops: activeLoops,
      pruned_nodes: prunedNodes,
    };
  }

  // ─── Private Helpers ───

  private _collectAllDescendantIds(goalId: string): string[] {
    const goal = this.stateManager.loadGoal(goalId);
    if (!goal) return [];
    const result: string[] = [];
    for (const childId of goal.children_ids) {
      result.push(childId);
      result.push(...this._collectAllDescendantIds(childId));
    }
    return result;
  }
}
