import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../src/state-manager.js";
import { EthicsGate } from "../src/ethics-gate.js";
import { GoalDependencyGraph } from "../src/goal-dependency-graph.js";
import { GoalTreeManager } from "../src/goal-tree-manager.js";
import { GoalSchema } from "../src/types/goal.js";
import type { Goal } from "../src/types/goal.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";

// ─── Fixtures ───

const PASS_VERDICT = JSON.stringify({
  verdict: "pass",
  category: "safe",
  reasoning: "Safe goal.",
  risks: [],
  confidence: 0.95,
});

// Quality evaluation responses
const GOOD_QUALITY_RESPONSE = JSON.stringify({
  coverage: 0.9,
  overlap: 0.1,
  actionability: 0.85,
  reasoning: "Good decomposition with high coverage and low overlap",
});

const HIGH_OVERLAP_RESPONSE = JSON.stringify({
  coverage: 0.8,
  overlap: 0.8,
  actionability: 0.7,
  reasoning: "Subgoals are highly redundant with each other",
});

const LOW_COVERAGE_RESPONSE = JSON.stringify({
  coverage: 0.3,
  overlap: 0.1,
  actionability: 0.8,
  reasoning: "Subgoals only cover a small portion of the parent goal",
});

const MEDIUM_QUALITY_RESPONSE = JSON.stringify({
  coverage: 0.6,
  overlap: 0.3,
  actionability: 0.65,
  reasoning: "Moderate quality decomposition",
});

// Restructure responses
const RESTRUCTURE_EMPTY = JSON.stringify([]);
const RESTRUCTURE_MERGE = (id1: string, id2: string) =>
  JSON.stringify([
    {
      action: "merge",
      goal_ids: [id1, id2],
      reasoning: "These goals overlap significantly",
    },
  ]);

// Specificity/concreteness responses
const HIGH_CONCRETENESS = JSON.stringify({
  hasQuantitativeThreshold: true,
  hasObservableOutcome: true,
  hasTimebound: true,
  hasClearScope: true,
  reason: "Very concrete and specific goal",
});

const LOW_CONCRETENESS = JSON.stringify({
  hasQuantitativeThreshold: false,
  hasObservableOutcome: false,
  hasTimebound: false,
  hasClearScope: false,
  reason: "Vague and abstract goal",
});

// ─── Helpers ───

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-goal-quality-test-"));
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return GoalSchema.parse({
    id: overrides.id ?? crypto.randomUUID(),
    parent_id: overrides.parent_id ?? null,
    node_type: overrides.node_type ?? "goal",
    title: overrides.title ?? "Test Goal",
    description: overrides.description ?? "A goal for testing quality evaluation",
    status: overrides.status ?? "active",
    dimensions: overrides.dimensions ?? [
      {
        name: "metric_a",
        label: "Metric A",
        current_value: 30,
        threshold: { type: "min", value: 80 },
        confidence: 0.7,
        observation_method: {
          type: "manual",
          source: "test",
          schedule: null,
          endpoint: null,
          confidence_tier: "self_report",
        },
        last_updated: now,
        history: [],
        weight: 1.0,
        uncertainty_weight: null,
        state_integrity: "ok",
        dimension_mapping: null,
      },
    ],
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: overrides.constraints ?? [],
    children_ids: overrides.children_ids ?? [],
    target_date: null,
    origin: overrides.origin ?? null,
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    decomposition_depth: overrides.decomposition_depth ?? 0,
    specificity_score: overrides.specificity_score ?? null,
    loop_status: overrides.loop_status ?? "idle",
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  });
}

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;
let ethicsGate: EthicsGate;
let dependencyGraph: GoalDependencyGraph;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
  const ethicsLLM = createMockLLMClient(Array(50).fill(PASS_VERDICT));
  ethicsGate = new EthicsGate(stateManager, ethicsLLM);
  dependencyGraph = new GoalDependencyGraph(stateManager);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ─── 1. evaluateDecompositionQuality ───

describe("evaluateDecompositionQuality", () => {
  it("returns high quality metrics for a good decomposition", async () => {
    const llm = createMockLLMClient([GOOD_QUALITY_RESPONSE]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph);

    const metrics = await manager.evaluateDecompositionQuality(
      "Build a reliable web application",
      [
        "Set up CI/CD pipeline with automated tests achieving 80% coverage",
        "Implement error monitoring with Sentry capturing all production errors",
        "Deploy to production with zero-downtime deployments using blue-green strategy",
      ]
    );

    expect(metrics.coverage).toBeCloseTo(0.9, 2);
    expect(metrics.overlap).toBeCloseTo(0.1, 2);
    expect(metrics.actionability).toBeCloseTo(0.85, 2);
    // depthEfficiency = 1 - overlap * 0.5 = 1 - 0.1 * 0.5 = 0.95
    expect(metrics.depthEfficiency).toBeCloseTo(0.95, 2);
  });

  it("detects high overlap in subgoals", async () => {
    const llm = createMockLLMClient([HIGH_OVERLAP_RESPONSE]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph);

    const metrics = await manager.evaluateDecompositionQuality(
      "Improve code quality",
      [
        "Write unit tests to improve code quality",
        "Write tests to verify code quality",
        "Add automated tests for code quality assurance",
      ]
    );

    expect(metrics.overlap).toBeGreaterThan(0.7);
    // depthEfficiency should be reduced: 1 - 0.8 * 0.5 = 0.6
    expect(metrics.depthEfficiency).toBeCloseTo(0.6, 2);
  });

  it("detects low coverage in subgoals", async () => {
    const llm = createMockLLMClient([LOW_COVERAGE_RESPONSE]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph);

    const metrics = await manager.evaluateDecompositionQuality(
      "Launch a complete e-commerce platform",
      [
        "Set up product listing page",
      ]
    );

    expect(metrics.coverage).toBeLessThan(0.5);
  });

  it("logs a warning when coverage is below 0.5", async () => {
    const llm = createMockLLMClient([LOW_COVERAGE_RESPONSE]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph);
    const warnSpy = vi.spyOn(console, "warn");

    await manager.evaluateDecompositionQuality(
      "Launch a complete e-commerce platform",
      ["Set up product listing page"]
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("poor quality detected")
    );
  });

  it("logs a warning when overlap is above 0.7", async () => {
    const llm = createMockLLMClient([HIGH_OVERLAP_RESPONSE]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph);
    const warnSpy = vi.spyOn(console, "warn");

    await manager.evaluateDecompositionQuality(
      "Improve code quality",
      [
        "Write unit tests to improve code quality",
        "Write tests to verify code quality",
      ]
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("poor quality detected")
    );
  });

  it("does NOT log a warning for good quality", async () => {
    const llm = createMockLLMClient([GOOD_QUALITY_RESPONSE]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph);
    const warnSpy = vi.spyOn(console, "warn");

    await manager.evaluateDecompositionQuality(
      "Build a reliable web application",
      [
        "Set up CI/CD pipeline achieving 80% test coverage",
        "Implement error monitoring",
        "Deploy with zero-downtime strategy",
      ]
    );

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("poor quality detected")
    );
  });

  it("handles empty subgoals — returns zero coverage and warns", async () => {
    const llm = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph);
    const warnSpy = vi.spyOn(console, "warn");

    const metrics = await manager.evaluateDecompositionQuality(
      "Build a reliable web application",
      []
    );

    expect(metrics.coverage).toBe(0);
    expect(metrics.overlap).toBe(0);
    expect(metrics.actionability).toBe(0);
    expect(metrics.depthEfficiency).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("handles single subgoal without throwing", async () => {
    const llm = createMockLLMClient([GOOD_QUALITY_RESPONSE]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph);

    const metrics = await manager.evaluateDecompositionQuality(
      "Build a reliable web application",
      ["Set up CI/CD pipeline achieving 80% test coverage"]
    );

    expect(metrics).toBeDefined();
    expect(metrics.coverage).toBeGreaterThanOrEqual(0);
    expect(metrics.coverage).toBeLessThanOrEqual(1);
  });

  it("returns conservative metrics on LLM failure", async () => {
    // No responses configured — will throw when LLM is called
    const llm = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph);

    // This triggers the empty-subgoals path, not LLM failure — use a single description
    // to test LLM failure path
    const llmFail = createMockLLMClient(["invalid json {{{"]);
    const manager2 = new GoalTreeManager(stateManager, llmFail, ethicsGate, dependencyGraph);

    const metrics = await manager2.evaluateDecompositionQuality(
      "Build a reliable web application",
      ["Set up CI/CD pipeline"]
    );

    // Falls back to conservative zeros
    expect(metrics.coverage).toBe(0);
    expect(metrics.overlap).toBe(0);
    expect(metrics.actionability).toBe(0);
  });

  it("computes depthEfficiency correctly: 1 - (overlap * 0.5)", async () => {
    const overlapValue = 0.4;
    const response = JSON.stringify({
      coverage: 0.7,
      overlap: overlapValue,
      actionability: 0.7,
      reasoning: "Moderate overlap",
    });
    const llm = createMockLLMClient([response]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph);

    const metrics = await manager.evaluateDecompositionQuality(
      "Improve system performance",
      ["Optimize database queries", "Add response caching"]
    );

    expect(metrics.depthEfficiency).toBeCloseTo(1 - overlapValue * 0.5, 5);
  });
});

// ─── 2. pruneSubgoal with reason tracking ───

describe("pruneSubgoal with reason tracking", () => {
  it("prunes a subgoal and records the reason", () => {
    const parent = makeGoal({ description: "Parent goal" });
    const child = makeGoal({ parent_id: parent.id, description: "Child goal" });
    stateManager.saveGoal(parent);
    stateManager.saveGoal(child);

    // Link child to parent
    stateManager.saveGoal({ ...parent, children_ids: [child.id] });

    const llm = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph);

    const decision = manager.pruneSubgoal(child.id, "no longer relevant", parent.id);

    expect(decision.goal_id).toBe(child.id);
    const cancelled = stateManager.loadGoal(child.id);
    expect(cancelled?.status).toBe("cancelled");
  });

  it("records prune history with correct subgoalId, reason, and timestamp", () => {
    const parent = makeGoal({ description: "Parent goal" });
    const child = makeGoal({ parent_id: parent.id, description: "Child goal" });
    stateManager.saveGoal({ ...parent, children_ids: [child.id] });
    stateManager.saveGoal(child);

    const llm = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph);

    manager.pruneSubgoal(child.id, "superseded by new approach", parent.id);

    const history = manager.getPruneHistory(parent.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.subgoalId).toBe(child.id);
    expect(history[0]!.reason).toBe("superseded by new approach");
    expect(history[0]!.timestamp).toBeTruthy();
    // Timestamp should be a valid ISO string
    expect(() => new Date(history[0]!.timestamp)).not.toThrow();
  });

  it("accumulates multiple prune records for the same parent", () => {
    const parent = makeGoal({ description: "Parent goal" });
    const child1 = makeGoal({ parent_id: parent.id, description: "Child 1" });
    const child2 = makeGoal({ parent_id: parent.id, description: "Child 2" });
    stateManager.saveGoal({ ...parent, children_ids: [child1.id, child2.id] });
    stateManager.saveGoal(child1);
    stateManager.saveGoal(child2);

    const llm = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph);

    manager.pruneSubgoal(child1.id, "no longer needed", parent.id);
    manager.pruneSubgoal(child2.id, "merged into sibling", parent.id);

    const history = manager.getPruneHistory(parent.id);
    expect(history).toHaveLength(2);
    expect(history.map((r) => r.subgoalId)).toContain(child1.id);
    expect(history.map((r) => r.subgoalId)).toContain(child2.id);
    expect(history.map((r) => r.reason)).toContain("no longer needed");
    expect(history.map((r) => r.reason)).toContain("merged into sibling");
  });

  it("uses parent_id from goal when parentGoalId not supplied", () => {
    const parent = makeGoal({ description: "Parent goal" });
    const child = makeGoal({ parent_id: parent.id, description: "Child goal" });
    stateManager.saveGoal({ ...parent, children_ids: [child.id] });
    stateManager.saveGoal(child);

    const llm = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph);

    // Do not pass parentGoalId — should infer from goal.parent_id
    manager.pruneSubgoal(child.id, "auto-pruned");

    const history = manager.getPruneHistory(parent.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.subgoalId).toBe(child.id);
  });

  it("throws when pruning a non-existent subgoal", () => {
    const llm = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph);

    expect(() => manager.pruneSubgoal("non-existent-id", "reason")).toThrow(
      /pruneSubgoal.*not found/
    );
  });
});

// ─── 3. getPruneHistory ───

describe("getPruneHistory", () => {
  it("returns empty array when no prunes have been recorded", () => {
    const llm = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph);

    const history = manager.getPruneHistory("any-goal-id");
    expect(history).toEqual([]);
  });

  it("returns all prune records for a goal", () => {
    const parent = makeGoal({ description: "Parent goal" });
    const child1 = makeGoal({ parent_id: parent.id, description: "Child 1" });
    const child2 = makeGoal({ parent_id: parent.id, description: "Child 2" });
    const child3 = makeGoal({ parent_id: parent.id, description: "Child 3" });
    stateManager.saveGoal({ ...parent, children_ids: [child1.id, child2.id, child3.id] });
    stateManager.saveGoal(child1);
    stateManager.saveGoal(child2);
    stateManager.saveGoal(child3);

    const llm = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph);

    manager.pruneSubgoal(child1.id, "reason 1", parent.id);
    manager.pruneSubgoal(child2.id, "reason 2", parent.id);
    manager.pruneSubgoal(child3.id, "reason 3", parent.id);

    const history = manager.getPruneHistory(parent.id);
    expect(history).toHaveLength(3);
  });

  it("keeps histories for different parents separate", () => {
    const parent1 = makeGoal({ description: "Parent 1" });
    const parent2 = makeGoal({ description: "Parent 2" });
    const child1 = makeGoal({ parent_id: parent1.id, description: "Child of P1" });
    const child2 = makeGoal({ parent_id: parent2.id, description: "Child of P2" });
    stateManager.saveGoal({ ...parent1, children_ids: [child1.id] });
    stateManager.saveGoal({ ...parent2, children_ids: [child2.id] });
    stateManager.saveGoal(child1);
    stateManager.saveGoal(child2);

    const llm = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph);

    manager.pruneSubgoal(child1.id, "reason for P1", parent1.id);
    manager.pruneSubgoal(child2.id, "reason for P2", parent2.id);

    expect(manager.getPruneHistory(parent1.id)).toHaveLength(1);
    expect(manager.getPruneHistory(parent2.id)).toHaveLength(1);
    expect(manager.getPruneHistory(parent1.id)[0]!.reason).toBe("reason for P1");
    expect(manager.getPruneHistory(parent2.id)[0]!.reason).toBe("reason for P2");
  });
});

// ─── 4. restructureTree with quality evaluation ───

describe("restructureTree with quality evaluation", () => {
  it("returns quality metrics after restructuring when no changes are made", async () => {
    const root = makeGoal({ description: "Root goal for restructuring" });
    const child1 = makeGoal({ parent_id: root.id, description: "Child goal 1 for restructuring" });
    const child2 = makeGoal({ parent_id: root.id, description: "Child goal 2 for restructuring" });
    stateManager.saveGoal({ ...root, children_ids: [child1.id, child2.id] });
    stateManager.saveGoal(child1);
    stateManager.saveGoal(child2);

    // LLM responses:
    // 1. evaluateDecompositionQuality before (no restructuring applied, only 1 quality call)
    // 2. restructureTree prompt -> no suggestions
    const llm = createMockLLMClient([
      GOOD_QUALITY_RESPONSE,  // quality before
      RESTRUCTURE_EMPTY,       // restructure suggestions (none)
    ]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph, undefined, { concretenesThreshold: 0.7 });

    const metrics = await manager.restructureTree(root.id);

    // When no restructuring was applied, qualityBefore is returned
    expect(metrics).not.toBeNull();
    expect(metrics!.coverage).toBeCloseTo(0.9, 2);
  });

  it("evaluates quality after restructuring and keeps changes when quality improves", async () => {
    const root = makeGoal({ description: "Root goal for restructuring" });
    const child1 = makeGoal({ parent_id: root.id, description: "Redundant child A" });
    const child2 = makeGoal({ parent_id: root.id, description: "Redundant child B" });
    stateManager.saveGoal({ ...root, children_ids: [child1.id, child2.id] });
    stateManager.saveGoal(child1);
    stateManager.saveGoal(child2);

    // LLM responses:
    // 1. quality before: medium quality
    // 2. restructure suggestions: merge child1 and child2
    // 3. quality after: better quality (higher coverage + lower overlap)
    const llm = createMockLLMClient([
      MEDIUM_QUALITY_RESPONSE,                    // quality before
      RESTRUCTURE_MERGE(child1.id, child2.id),    // merge suggestion
      GOOD_QUALITY_RESPONSE,                       // quality after (better)
    ]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph, undefined, { concretenesThreshold: 0.7 });

    const metrics = await manager.restructureTree(root.id);

    // After restructuring, child2 should be cancelled
    const merged = stateManager.loadGoal(child2.id);
    expect(merged?.status).toBe("cancelled");
    // Metrics returned should be from after
    expect(metrics).not.toBeNull();
    expect(metrics!.coverage).toBeCloseTo(0.9, 2);
  });

  it("reverts changes when quality degrades after restructuring", async () => {
    const root = makeGoal({ description: "Root goal for restructuring" });
    const child1 = makeGoal({ parent_id: root.id, description: "Distinct child A" });
    const child2 = makeGoal({ parent_id: root.id, description: "Distinct child B" });
    stateManager.saveGoal({ ...root, children_ids: [child1.id, child2.id] });
    stateManager.saveGoal(child1);
    stateManager.saveGoal(child2);

    // LLM responses:
    // 1. quality before: good
    // 2. restructure: merge (applied)
    // 3. quality after: low coverage (degraded)
    const llm = createMockLLMClient([
      GOOD_QUALITY_RESPONSE,                       // quality before (good)
      RESTRUCTURE_MERGE(child1.id, child2.id),     // merge suggestion
      LOW_COVERAGE_RESPONSE,                        // quality after (degraded)
    ]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph, undefined, { concretenesThreshold: 0.7 });

    const metrics = await manager.restructureTree(root.id);

    // Should have reverted — child2 should be restored to active
    const restored = stateManager.loadGoal(child2.id);
    expect(restored?.status).toBe("active");

    // Returns the before metrics (good quality)
    expect(metrics).not.toBeNull();
    expect(metrics!.coverage).toBeCloseTo(0.9, 2);
  });

  it("returns null when tree has no goals", async () => {
    const llm = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph, undefined, { concretenesThreshold: 0.7 });

    // No goals saved — should return null
    const metrics = await manager.restructureTree("nonexistent-root");
    expect(metrics).toBeNull();
  });

  it("returns qualityBefore when restructure produces no changes (RESTRUCTURE_EMPTY)", async () => {
    const root = makeGoal({ description: "Stable root goal" });
    const child = makeGoal({ parent_id: root.id, description: "Well-defined child task with clear acceptance criteria" });
    stateManager.saveGoal({ ...root, children_ids: [child.id] });
    stateManager.saveGoal(child);

    // quality before + restructure empty (no restructuring applied)
    const llm = createMockLLMClient([
      GOOD_QUALITY_RESPONSE,  // quality before
      RESTRUCTURE_EMPTY,       // no suggestions
    ]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph, undefined, { concretenesThreshold: 0.7 });

    const metrics = await manager.restructureTree(root.id);

    // No restructuring applied, returns qualityBefore
    expect(metrics).not.toBeNull();
    expect(metrics!.coverage).toBeCloseTo(0.9, 2);
    // Child should remain active
    const child2 = stateManager.loadGoal(child.id);
    expect(child2?.status).toBe("active");
  });
});
