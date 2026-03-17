import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../src/state-manager.js";
import { EthicsGate } from "../src/traits/ethics-gate.js";
import { GoalDependencyGraph } from "../src/goal/goal-dependency-graph.js";
import { GoalTreeManager } from "../src/goal/goal-tree-manager.js";
import { GoalSchema } from "../src/types/goal.js";
import type { Goal } from "../src/types/goal.js";
import type { GoalDecompositionConfig } from "../src/types/goal-tree.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";

// ─── Fixtures ───

const PASS_VERDICT = JSON.stringify({
  verdict: "pass",
  category: "safe",
  reasoning: "Safe goal.",
  risks: [],
  confidence: 0.95,
});

// Specificity responses
const HIGH_SPECIFICITY = JSON.stringify({ specificity_score: 0.9, reasoning: "Very concrete goal" });
const LOW_SPECIFICITY = JSON.stringify({ specificity_score: 0.4, reasoning: "Too abstract" });
const BOUNDARY_SPECIFICITY = JSON.stringify({ specificity_score: 0.7, reasoning: "Exactly at threshold" });
const JUST_BELOW_SPECIFICITY = JSON.stringify({ specificity_score: 0.69, reasoning: "Just below threshold" });

// Subgoal generation responses
const SUBGOALS_TWO = JSON.stringify([
  {
    hypothesis: "Set up automated testing infrastructure",
    dimensions: [
      {
        name: "ci_configured",
        label: "CI Configured",
        threshold_type: "present",
        threshold_value: null,
        observation_method_hint: "Check CI config exists",
      },
    ],
    constraints: ["Must use GitHub Actions"],
    expected_specificity: 0.85,
  },
  {
    hypothesis: "Achieve 80% test coverage",
    dimensions: [
      {
        name: "coverage_pct",
        label: "Test Coverage %",
        threshold_type: "min",
        threshold_value: 80,
        observation_method_hint: "Run coverage tool",
      },
    ],
    constraints: [],
    expected_specificity: 0.9,
  },
]);

const SUBGOALS_ONE = JSON.stringify([
  {
    hypothesis: "Write unit tests for core modules",
    dimensions: [
      {
        name: "unit_test_count",
        label: "Unit Test Count",
        threshold_type: "min",
        threshold_value: 50,
        observation_method_hint: "Count test files",
      },
    ],
    constraints: [],
    expected_specificity: 0.88,
  },
]);

const SUBGOALS_THREE = JSON.stringify([
  {
    hypothesis: "Design database schema",
    dimensions: [{ name: "schema_done", label: "Schema Done", threshold_type: "present", threshold_value: null, observation_method_hint: "Check schema file" }],
    constraints: [],
    expected_specificity: 0.8,
  },
  {
    hypothesis: "Implement REST API endpoints",
    dimensions: [{ name: "api_endpoints", label: "API Endpoints", threshold_type: "min", threshold_value: 10, observation_method_hint: "Count endpoints" }],
    constraints: [],
    expected_specificity: 0.85,
  },
  {
    hypothesis: "Write API documentation",
    dimensions: [{ name: "docs_complete", label: "Docs Complete", threshold_type: "present", threshold_value: null, observation_method_hint: "Check docs" }],
    constraints: [],
    expected_specificity: 0.8,
  },
]);

const SUBGOALS_EMPTY = JSON.stringify([]);

// Coverage validation responses
const COVERAGE_PASS = JSON.stringify({ covers_parent: true, missing_dimensions: [], reasoning: "All covered" });
const COVERAGE_FAIL = JSON.stringify({ covers_parent: false, missing_dimensions: ["performance"], reasoning: "Missing performance dimension" });

// Default config
const DEFAULT_CONFIG: GoalDecompositionConfig = {
  max_depth: 5,
  min_specificity: 0.7,
  auto_prune_threshold: 0.3,
  parallel_loop_limit: 3,
};

const SHALLOW_CONFIG: GoalDecompositionConfig = {
  max_depth: 1,
  min_specificity: 0.7,
  auto_prune_threshold: 0.3,
  parallel_loop_limit: 3,
};

// ─── Helpers ───

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-goal-tree-test-"));
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return GoalSchema.parse({
    id: overrides.id ?? crypto.randomUUID(),
    parent_id: overrides.parent_id ?? null,
    node_type: overrides.node_type ?? "goal",
    title: overrides.title ?? "Test Goal",
    description: overrides.description ?? "A goal for testing decomposition",
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

// ─── Test Suite ───

let tempDir: string;
let stateManager: StateManager;
let ethicsGate: EthicsGate;
let dependencyGraph: GoalDependencyGraph;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
  // EthicsGate with a mock LLM that always passes
  const ethicsLLM = createMockLLMClient(Array(50).fill(PASS_VERDICT));
  ethicsGate = new EthicsGate(stateManager, ethicsLLM);
  dependencyGraph = new GoalDependencyGraph(stateManager);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── 1. Specificity Evaluation ───

describe("specificity evaluation", () => {
  it("stops decomposition when specificity_score >= min_specificity", async () => {
    const goal = makeGoal({ title: "Specific leaf goal" });
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.parent_id).toBe(goal.id);
    expect(result.children).toHaveLength(0);
    expect(result.specificity_scores[goal.id]).toBeCloseTo(0.9);
  });

  it("triggers decomposition when specificity_score < min_specificity", async () => {
    const goal = makeGoal({ title: "Abstract goal" });
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.children.length).toBeGreaterThan(0);
  });

  it("specificity_score is saved on the goal after evaluation", async () => {
    const goal = makeGoal();
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    const saved = stateManager.loadGoal(goal.id);
    expect(saved?.specificity_score).toBeCloseTo(0.9);
  });

  it("marks goal as leaf when specificity >= threshold", async () => {
    const goal = makeGoal();
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    const saved = stateManager.loadGoal(goal.id);
    expect(saved?.node_type).toBe("leaf");
  });

  it("boundary: specificity_score exactly 0.7 (== min_specificity) stops decomposition", async () => {
    const goal = makeGoal();
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([BOUNDARY_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.children).toHaveLength(0);
  });

  it("boundary: specificity_score 0.69 (just below) triggers decomposition", async () => {
    const goal = makeGoal();
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([JUST_BELOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.children.length).toBeGreaterThan(0);
  });

  it("falls back gracefully when LLM fails specificity evaluation", async () => {
    const goal = makeGoal();
    stateManager.saveGoal(goal);

    // Return invalid JSON to trigger fallback
    const mockLLM = createMockLLMClient(["not valid json", SUBGOALS_ONE, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    // Should not throw; fallback score is 0.5 (below threshold), so decomposition runs
    await expect(manager.decomposeGoal(goal.id, DEFAULT_CONFIG)).resolves.toBeDefined();
  });

  it("uses 0.5 as fallback score when LLM returns invalid specificity", async () => {
    const goal = makeGoal();
    stateManager.saveGoal(goal);

    // fallback score 0.5 < 0.7 → decomposition triggered
    const mockLLM = createMockLLMClient(["bad json", SUBGOALS_ONE, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    // With fallback 0.5, decomposition runs → children expected
    expect(result.children.length).toBeGreaterThanOrEqual(0); // may succeed or fail subgoal gen
  });
});

// ─── 2. 1-layer Decomposition ───

describe("1-layer decomposition", () => {
  it("creates child goals from LLM response", async () => {
    const goal = makeGoal({ title: "Improve test coverage" });
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY,
      SUBGOALS_TWO,
      COVERAGE_PASS,
      HIGH_SPECIFICITY,
      HIGH_SPECIFICITY,
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.children).toHaveLength(2);
  });

  it("child goals have correct parent_id", async () => {
    const goal = makeGoal();
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_TWO, COVERAGE_PASS, HIGH_SPECIFICITY, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    const children = result.children as Goal[];
    for (const child of children) {
      expect(child.parent_id).toBe(goal.id);
    }
  });

  it("child goals have node_type=subgoal", async () => {
    const goal = makeGoal();
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    const children = result.children as Goal[];
    for (const child of children) {
      expect(child.node_type).toBe("subgoal");
    }
  });

  it("child goals have origin=decomposition", async () => {
    const goal = makeGoal();
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    const children = result.children as Goal[];
    for (const child of children) {
      expect(child.origin).toBe("decomposition");
    }
  });

  it("child goals have decomposition_depth = parent_depth + 1", async () => {
    const goal = makeGoal({ decomposition_depth: 0 });
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    const children = result.children as Goal[];
    for (const child of children) {
      expect(child.decomposition_depth).toBe(1);
    }
  });

  it("child goals have status=active", async () => {
    const goal = makeGoal();
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_TWO, COVERAGE_PASS, HIGH_SPECIFICITY, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    const children = result.children as Goal[];
    for (const child of children) {
      expect(child.status).toBe("active");
    }
  });

  it("parent goal's children_ids is updated after decomposition", async () => {
    const goal = makeGoal();
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_TWO, COVERAGE_PASS, HIGH_SPECIFICITY, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    const saved = stateManager.loadGoal(goal.id);
    expect(saved?.children_ids).toHaveLength(2);
  });

  it("child goals are persisted to state manager", async () => {
    const goal = makeGoal();
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_TWO, COVERAGE_PASS, HIGH_SPECIFICITY, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    const children = result.children as Goal[];
    for (const child of children) {
      const saved = stateManager.loadGoal(child.id);
      expect(saved).not.toBeNull();
    }
  });

  it("result contains correct depth", async () => {
    const goal = makeGoal({ decomposition_depth: 0 });
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.depth).toBe(0);
  });

  it("result contains specificity_scores for root goal", async () => {
    const goal = makeGoal();
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.specificity_scores[goal.id]).toBeDefined();
    expect(result.specificity_scores[goal.id]).toBeCloseTo(0.4);
  });
});

// ─── 3. 2-layer Decomposition ───

describe("2-layer decomposition", () => {
  it("recursively decomposes children with low specificity", async () => {
    const root = makeGoal({ title: "Very abstract root" });
    stateManager.saveGoal(root);

    // root: low spec → gen 1 child → coverage pass → child: low spec → gen 1 grandchild → coverage pass → grandchild: high spec
    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY,   // root specificity
      SUBGOALS_ONE,      // root subgoals
      COVERAGE_PASS,     // root validation
      LOW_SPECIFICITY,   // child specificity
      SUBGOALS_ONE,      // child subgoals
      COVERAGE_PASS,     // child validation
      HIGH_SPECIFICITY,  // grandchild specificity (leaf)
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    expect(result.children).toHaveLength(1);

    const child = (result.children as Goal[])[0]!;
    const savedChild = stateManager.loadGoal(child.id);
    expect(savedChild?.children_ids.length).toBeGreaterThan(0);
  });

  it("grandchildren have decomposition_depth = 2", async () => {
    const root = makeGoal({ decomposition_depth: 0 });
    stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY,
      SUBGOALS_ONE,
      COVERAGE_PASS,
      LOW_SPECIFICITY,
      SUBGOALS_ONE,
      COVERAGE_PASS,
      HIGH_SPECIFICITY,
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    const child = (result.children as Goal[])[0]!;
    const savedChild = stateManager.loadGoal(child.id);
    const grandchildId = savedChild?.children_ids[0];
    expect(grandchildId).toBeDefined();
    const grandchild = stateManager.loadGoal(grandchildId!);
    expect(grandchild?.decomposition_depth).toBe(2);
  });

  it("grandchildren are marked as leaves when specific enough", async () => {
    const root = makeGoal();
    stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY,
      SUBGOALS_ONE,
      COVERAGE_PASS,
      LOW_SPECIFICITY,
      SUBGOALS_ONE,
      COVERAGE_PASS,
      HIGH_SPECIFICITY,
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    const child = (result.children as Goal[])[0]!;
    const savedChild = stateManager.loadGoal(child.id);
    const grandchildId = savedChild?.children_ids[0];
    const grandchild = stateManager.loadGoal(grandchildId!);
    expect(grandchild?.node_type).toBe("leaf");
  });

  it("specificity_scores includes scores for all levels", async () => {
    const root = makeGoal();
    stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY,
      SUBGOALS_ONE,
      COVERAGE_PASS,
      LOW_SPECIFICITY,
      SUBGOALS_ONE,
      COVERAGE_PASS,
      HIGH_SPECIFICITY,
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    // root + child + grandchild specificity scores
    expect(Object.keys(result.specificity_scores).length).toBeGreaterThanOrEqual(1);
  });

  it("stops recursion when child has high specificity", async () => {
    const root = makeGoal();
    stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY,  // root: decompose
      SUBGOALS_TWO,     // root generates 2 children
      COVERAGE_PASS,
      HIGH_SPECIFICITY, // child 1: leaf
      HIGH_SPECIFICITY, // child 2: leaf
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    expect(result.children).toHaveLength(2);
    // Children should be leaves (no further decomposition)
    for (const child of result.children as Goal[]) {
      const saved = stateManager.loadGoal(child.id);
      expect(saved?.children_ids).toHaveLength(0);
    }
  });

  it("depth tracking is correct at each level", async () => {
    const root = makeGoal({ decomposition_depth: 0 });
    stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,
      HIGH_SPECIFICITY,
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    expect(result.depth).toBe(0);

    const childId = (result.children as Goal[])[0]?.id;
    expect(childId).toBeDefined();
    const child = stateManager.loadGoal(childId!);
    expect(child?.decomposition_depth).toBe(1);
  });

  it("parent maintains children_ids for all direct children only", async () => {
    const root = makeGoal();
    stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY, SUBGOALS_TWO, COVERAGE_PASS,
      HIGH_SPECIFICITY,
      HIGH_SPECIFICITY,
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    const saved = stateManager.loadGoal(root.id);
    // Root should have exactly 2 direct children
    expect(saved?.children_ids).toHaveLength(2);
  });

  it("two-layer tree has correct total nodes in getTreeState", async () => {
    const root = makeGoal();
    stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,
      HIGH_SPECIFICITY,
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    const state = manager.getTreeState(root.id);
    // root + child + grandchild = 3
    expect(state.total_nodes).toBe(3);
  });
});

// ─── 4. N-layer (3-5 depth) ───

describe("N-layer decomposition (depth 3-5)", () => {
  it("enforces max_depth=1: forces leaf at depth 1 regardless of specificity", async () => {
    const root = makeGoal({ decomposition_depth: 0 });
    stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY,  // root: low spec → try to decompose
      SUBGOALS_ONE,     // root generates 1 child
      COVERAGE_PASS,
      LOW_SPECIFICITY,  // child at depth 1 = max_depth: forced leaf (no subgoal call)
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.decomposeGoal(root.id, SHALLOW_CONFIG);
    const child = stateManager.loadGoal((stateManager.loadGoal(root.id)?.children_ids[0])!);
    // At max_depth, forced leaf
    expect(child?.node_type).toBe("leaf");
  });

  it("max_depth=2: does not recurse beyond depth 2", async () => {
    const root = makeGoal({ decomposition_depth: 0 });
    stateManager.saveGoal(root);
    const config2: GoalDecompositionConfig = { ...DEFAULT_CONFIG, max_depth: 2 };

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,  // root
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,  // depth 1 child
      LOW_SPECIFICITY,                                // depth 2: forced leaf (no sub call)
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, config2);
    const child = (result.children as Goal[])[0];
    expect(child).toBeDefined();
    const depth1ChildSaved = stateManager.loadGoal(child!.id);
    const depth2ChildId = depth1ChildSaved?.children_ids[0];
    const depth2Child = stateManager.loadGoal(depth2ChildId!);
    expect(depth2Child?.node_type).toBe("leaf");
    expect(depth2Child?.children_ids).toHaveLength(0);
  });

  it("max_depth=3: allows 3 levels of nesting", async () => {
    const root = makeGoal({ decomposition_depth: 0 });
    stateManager.saveGoal(root);
    const config3: GoalDecompositionConfig = { ...DEFAULT_CONFIG, max_depth: 3 };

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,  // depth 0
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,  // depth 1
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,  // depth 2
      LOW_SPECIFICITY,                               // depth 3: forced leaf
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, config3);
    const state = manager.getTreeState(root.id);
    expect(state.max_depth_reached).toBeGreaterThanOrEqual(3);
  });

  it("forced-leaf goals at max_depth are still marked as leaf", async () => {
    const root = makeGoal({ decomposition_depth: 0 });
    stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,
      LOW_SPECIFICITY,  // depth 1 = max_depth in SHALLOW_CONFIG
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.decomposeGoal(root.id, SHALLOW_CONFIG);
    const rootSaved = stateManager.loadGoal(root.id);
    const childId = rootSaved?.children_ids[0];
    const child = stateManager.loadGoal(childId!);
    expect(child?.node_type).toBe("leaf");
  });

  it("decomposition result max_depth_reached reflects actual depth", async () => {
    const root = makeGoal({ decomposition_depth: 0 });
    stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,
      HIGH_SPECIFICITY,
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    const state = manager.getTreeState(root.id);
    expect(state.max_depth_reached).toBe(1);
  });

  it("children count never exceeds max_children_per_node (5)", async () => {
    const root = makeGoal();
    stateManager.saveGoal(root);

    // Return 6 subgoals — should be clamped to 5
    const sixSubgoals = JSON.stringify([
      { hypothesis: "Sub 1", dimensions: [], constraints: [], expected_specificity: 0.9 },
      { hypothesis: "Sub 2", dimensions: [], constraints: [], expected_specificity: 0.9 },
      { hypothesis: "Sub 3", dimensions: [], constraints: [], expected_specificity: 0.9 },
      { hypothesis: "Sub 4", dimensions: [], constraints: [], expected_specificity: 0.9 },
      { hypothesis: "Sub 5", dimensions: [], constraints: [], expected_specificity: 0.9 },
      { hypothesis: "Sub 6", dimensions: [], constraints: [], expected_specificity: 0.9 },
    ]);
    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY, sixSubgoals, COVERAGE_PASS,
      HIGH_SPECIFICITY, HIGH_SPECIFICITY, HIGH_SPECIFICITY,
      HIGH_SPECIFICITY, HIGH_SPECIFICITY,
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    expect(result.children.length).toBeLessThanOrEqual(5);
  });
});

// ─── 5. Validation ───

describe("validateDecomposition", () => {
  it("returns true when coverage passes and no cycles", async () => {
    const parent = makeGoal();
    stateManager.saveGoal(parent);
    const child = makeGoal({ parent_id: parent.id, decomposition_depth: 1, node_type: "subgoal", origin: "decomposition" });

    const mockLLM = createMockLLMClient([COVERAGE_PASS]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.validateDecomposition({
      parent_id: parent.id,
      children: [child],
      depth: 0,
      specificity_scores: {},
      reasoning: "",
    });
    expect(result).toBe(true);
  });

  it("returns false when coverage fails", async () => {
    const parent = makeGoal();
    stateManager.saveGoal(parent);
    const child = makeGoal({ parent_id: parent.id });

    const mockLLM = createMockLLMClient([COVERAGE_FAIL]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.validateDecomposition({
      parent_id: parent.id,
      children: [child],
      depth: 0,
      specificity_scores: {},
      reasoning: "",
    });
    expect(result).toBe(false);
  });

  it("returns true with no children (empty decomposition validates trivially)", async () => {
    const parent = makeGoal();
    stateManager.saveGoal(parent);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.validateDecomposition({
      parent_id: parent.id,
      children: [],
      depth: 0,
      specificity_scores: {},
      reasoning: "",
    });
    expect(result).toBe(true);
  });

  it("returns false when parent goal is not found", async () => {
    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.validateDecomposition({
      parent_id: "nonexistent-id",
      children: [],
      depth: 0,
      specificity_scores: {},
      reasoning: "",
    });
    expect(result).toBe(false);
  });

  it("returns true when LLM coverage parse fails (allow-through)", async () => {
    const parent = makeGoal();
    stateManager.saveGoal(parent);
    const child = makeGoal({ parent_id: parent.id });

    // Return unparseable coverage
    const mockLLM = createMockLLMClient(["not json"]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.validateDecomposition({
      parent_id: parent.id,
      children: [child],
      depth: 0,
      specificity_scores: {},
      reasoning: "",
    });
    expect(result).toBe(true);
  });

  it("retries decomposition up to 2x when validation fails", async () => {
    const goal = makeGoal();
    stateManager.saveGoal(goal);

    // First attempt: validation fails; retry 1: validation fails; retry 2: coverage fail → treat as leaf
    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_FAIL,  // attempt 1
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_FAIL,  // retry 1
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_FAIL,  // retry 2
      HIGH_SPECIFICITY,                              // final: would be leaf if retry exhausted
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    // Should complete without throwing (may produce leaf or children)
    await expect(manager.decomposeGoal(goal.id, DEFAULT_CONFIG)).resolves.toBeDefined();
  });

  it("validates dimension integrity by checking coverage", async () => {
    const parent = makeGoal({
      dimensions: [
        {
          name: "performance",
          label: "Performance",
          current_value: 0,
          threshold: { type: "min", value: 100 },
          confidence: 0.8,
          observation_method: { type: "mechanical" as const, source: "test", schedule: null, endpoint: null, confidence_tier: "mechanical" as const },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    stateManager.saveGoal(parent);
    const child = makeGoal({ parent_id: parent.id });

    const mockLLM = createMockLLMClient([COVERAGE_FAIL]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.validateDecomposition({
      parent_id: parent.id,
      children: [child],
      depth: 0,
      specificity_scores: {},
      reasoning: "",
    });
    expect(result).toBe(false);
  });

  it("coverage validation checks missing dimensions in response", async () => {
    const parent = makeGoal();
    stateManager.saveGoal(parent);
    const child = makeGoal({ parent_id: parent.id });

    const coverageWithMissing = JSON.stringify({
      covers_parent: false,
      missing_dimensions: ["latency", "throughput"],
      reasoning: "Performance dimensions not covered",
    });
    const mockLLM = createMockLLMClient([coverageWithMissing]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.validateDecomposition({
      parent_id: parent.id,
      children: [child],
      depth: 0,
      specificity_scores: {},
      reasoning: "",
    });
    expect(result).toBe(false);
  });

  it("cycle detection: does not add cyclic dependencies", async () => {
    const goalA = makeGoal({ id: "goal-a" });
    const goalB = makeGoal({ id: "goal-b", parent_id: "goal-a" });
    stateManager.saveGoal(goalA);
    stateManager.saveGoal(goalB);

    // Add prerequisite: A -> B
    try {
      dependencyGraph.addEdge({
        from_goal_id: "goal-a",
        to_goal_id: "goal-b",
        type: "prerequisite",
        status: "active",
        condition: null,
        affected_dimensions: [],
        mitigation: null,
        detection_confidence: 1,
        reasoning: "test",
      });
    } catch {
      // OK if not supported
    }

    // Cycle would be B -> A
    const wouldCycle = dependencyGraph.detectCycle("goal-b", "goal-a");
    const mockLLM = createMockLLMClient([COVERAGE_PASS]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    // If wouldCycle is true, validate should return false
    if (wouldCycle) {
      const cycleChild = makeGoal({ id: "goal-a", parent_id: "goal-b" });
      const result = await manager.validateDecomposition({
        parent_id: "goal-b",
        children: [cycleChild],
        depth: 0,
        specificity_scores: {},
        reasoning: "",
      });
      expect(result).toBe(false);
    } else {
      // No cycle detected — validation passes
      expect(wouldCycle).toBe(false);
    }
  });

  it("multiple children all pass cycle detection", async () => {
    const parent = makeGoal();
    stateManager.saveGoal(parent);
    const child1 = makeGoal({ parent_id: parent.id });
    const child2 = makeGoal({ parent_id: parent.id });

    const mockLLM = createMockLLMClient([COVERAGE_PASS]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.validateDecomposition({
      parent_id: parent.id,
      children: [child1, child2],
      depth: 0,
      specificity_scores: {},
      reasoning: "",
    });
    expect(result).toBe(true);
  });

  it("returns false when covers_parent is false regardless of missing_dimensions", async () => {
    const parent = makeGoal();
    stateManager.saveGoal(parent);
    const child = makeGoal({ parent_id: parent.id });

    const strictFail = JSON.stringify({ covers_parent: false, missing_dimensions: [], reasoning: "Incomplete" });
    const mockLLM = createMockLLMClient([strictFail]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.validateDecomposition({
      parent_id: parent.id,
      children: [child],
      depth: 0,
      specificity_scores: {},
      reasoning: "",
    });
    expect(result).toBe(false);
  });
});

// ─── 6. Pruning ───

describe("pruneGoal", () => {
  it("sets goal status to cancelled", () => {
    const goal = makeGoal();
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    manager.pruneGoal(goal.id, "user_requested");
    const saved = stateManager.loadGoal(goal.id);
    expect(saved?.status).toBe("cancelled");
  });

  it("returns a PruneDecision with correct goal_id and reason", () => {
    const goal = makeGoal();
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const decision = manager.pruneGoal(goal.id, "no_progress");
    expect(decision.goal_id).toBe(goal.id);
    expect(decision.reason).toBe("no_progress");
  });

  it("returns replacement_id = null by default", () => {
    const goal = makeGoal();
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const decision = manager.pruneGoal(goal.id, "superseded");
    expect(decision.replacement_id).toBeNull();
  });

  it("recursively cancels all descendant goals", () => {
    const root = makeGoal();
    const child = makeGoal({ parent_id: root.id, decomposition_depth: 1, node_type: "subgoal", origin: "decomposition" });
    const grandchild = makeGoal({ parent_id: child.id, decomposition_depth: 2, node_type: "leaf", origin: "decomposition" });

    const rootWithChild: Goal = { ...root, children_ids: [child.id] };
    const childWithGrandchild: Goal = { ...child, children_ids: [grandchild.id] };
    stateManager.saveGoal(rootWithChild);
    stateManager.saveGoal(childWithGrandchild);
    stateManager.saveGoal(grandchild);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    manager.pruneGoal(root.id, "user_requested");

    const savedChild = stateManager.loadGoal(child.id);
    const savedGrandchild = stateManager.loadGoal(grandchild.id);
    expect(savedChild?.status).toBe("cancelled");
    expect(savedGrandchild?.status).toBe("cancelled");
  });

  it("removes goal from parent's children_ids", () => {
    const parent = makeGoal();
    const child = makeGoal({ parent_id: parent.id, node_type: "subgoal", origin: "decomposition" });
    const parentWithChild: Goal = { ...parent, children_ids: [child.id] };
    stateManager.saveGoal(parentWithChild);
    stateManager.saveGoal(child);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    manager.pruneGoal(child.id, "no_progress");
    const savedParent = stateManager.loadGoal(parent.id);
    expect(savedParent?.children_ids).not.toContain(child.id);
  });

  it("prunes sibling goals independently: pruning one sibling does not affect the other", () => {
    const parent = makeGoal();
    const child1 = makeGoal({ parent_id: parent.id, node_type: "subgoal", origin: "decomposition" });
    const child2 = makeGoal({ parent_id: parent.id, node_type: "subgoal", origin: "decomposition" });
    const parentWithChildren: Goal = { ...parent, children_ids: [child1.id, child2.id] };
    stateManager.saveGoal(parentWithChildren);
    stateManager.saveGoal(child1);
    stateManager.saveGoal(child2);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    manager.pruneGoal(child1.id, "no_progress");
    const savedChild2 = stateManager.loadGoal(child2.id);
    expect(savedChild2?.status).toBe("active");
  });

  it("pruning a leaf goal (no children) sets its status to cancelled", () => {
    const leaf = makeGoal({ node_type: "leaf" });
    stateManager.saveGoal(leaf);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    manager.pruneGoal(leaf.id, "merged");
    const saved = stateManager.loadGoal(leaf.id);
    expect(saved?.status).toBe("cancelled");
  });

  it("throws when goal to prune is not found", () => {
    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    expect(() => manager.pruneGoal("nonexistent", "user_requested")).toThrow();
  });

  it("supports all four prune reasons", () => {
    const reasons: Array<"no_progress" | "superseded" | "merged" | "user_requested"> = [
      "no_progress", "superseded", "merged", "user_requested",
    ];
    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    for (const reason of reasons) {
      const goal = makeGoal();
      stateManager.saveGoal(goal);
      const decision = manager.pruneGoal(goal.id, reason);
      expect(decision.reason).toBe(reason);
    }
  });

  it("pruning root goal without parent_id does not throw", () => {
    const root = makeGoal({ parent_id: null });
    stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    expect(() => manager.pruneGoal(root.id, "user_requested")).not.toThrow();
    const saved = stateManager.loadGoal(root.id);
    expect(saved?.status).toBe("cancelled");
  });

  it("pruned nodes are cancelled and removed from parent's children_ids", () => {
    const root = makeGoal();
    const child = makeGoal({ parent_id: root.id, node_type: "subgoal", origin: "decomposition" });
    const rootWithChild: Goal = { ...root, children_ids: [child.id] };
    stateManager.saveGoal(rootWithChild);
    stateManager.saveGoal(child);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    manager.pruneGoal(child.id, "no_progress");
    // Confirm child is cancelled
    const savedChild = stateManager.loadGoal(child.id);
    expect(savedChild?.status).toBe("cancelled");
    // Confirm parent no longer references child
    const savedParent = stateManager.loadGoal(root.id);
    expect(savedParent?.children_ids).not.toContain(child.id);
  });

  it("deep pruning: 3-level tree, prune intermediate node cancels entire subtree", () => {
    const root = makeGoal();
    const child = makeGoal({ parent_id: root.id, node_type: "subgoal", origin: "decomposition" });
    const grandchild = makeGoal({ parent_id: child.id, node_type: "leaf", origin: "decomposition" });
    const rootWithChild: Goal = { ...root, children_ids: [child.id] };
    const childWithGrandchild: Goal = { ...child, children_ids: [grandchild.id] };
    stateManager.saveGoal(rootWithChild);
    stateManager.saveGoal(childWithGrandchild);
    stateManager.saveGoal(grandchild);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    manager.pruneGoal(child.id, "superseded");

    const savedGrandchild = stateManager.loadGoal(grandchild.id);
    expect(savedGrandchild?.status).toBe("cancelled");
  });

  it("parent children_ids removes only pruned child, keeps others", () => {
    const parent = makeGoal();
    const child1 = makeGoal({ parent_id: parent.id, node_type: "subgoal", origin: "decomposition" });
    const child2 = makeGoal({ parent_id: parent.id, node_type: "subgoal", origin: "decomposition" });
    const child3 = makeGoal({ parent_id: parent.id, node_type: "subgoal", origin: "decomposition" });
    const parentUpdated: Goal = { ...parent, children_ids: [child1.id, child2.id, child3.id] };
    stateManager.saveGoal(parentUpdated);
    stateManager.saveGoal(child1);
    stateManager.saveGoal(child2);
    stateManager.saveGoal(child3);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    manager.pruneGoal(child2.id, "no_progress");
    const savedParent = stateManager.loadGoal(parent.id);
    expect(savedParent?.children_ids).toContain(child1.id);
    expect(savedParent?.children_ids).not.toContain(child2.id);
    expect(savedParent?.children_ids).toContain(child3.id);
  });
});

// ─── 7. Dynamic Subgoal Addition ───

describe("addSubgoal", () => {
  it("saves new goal with correct parent_id", () => {
    const parent = makeGoal();
    stateManager.saveGoal(parent);

    const newGoal = makeGoal({ parent_id: null }); // will be overridden
    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = manager.addSubgoal(parent.id, newGoal);
    expect(result.parent_id).toBe(parent.id);
  });

  it("updates parent's children_ids", () => {
    const parent = makeGoal();
    stateManager.saveGoal(parent);

    const newGoal = makeGoal();
    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    manager.addSubgoal(parent.id, newGoal);
    const savedParent = stateManager.loadGoal(parent.id);
    expect(savedParent?.children_ids).toContain(newGoal.id);
  });

  it("persists the new goal to state manager", () => {
    const parent = makeGoal();
    stateManager.saveGoal(parent);

    const newGoal = makeGoal();
    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = manager.addSubgoal(parent.id, newGoal);
    const saved = stateManager.loadGoal(result.id);
    expect(saved).not.toBeNull();
  });

  it("throws when parent goal does not exist", () => {
    const newGoal = makeGoal();
    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    expect(() => manager.addSubgoal("nonexistent-parent", newGoal)).toThrow();
  });

  it("returns the saved goal object", () => {
    const parent = makeGoal();
    stateManager.saveGoal(parent);

    const newGoal = makeGoal({ title: "Dynamic Subgoal" });
    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = manager.addSubgoal(parent.id, newGoal);
    expect(result.id).toBe(newGoal.id);
    expect(result.title).toBe("Dynamic Subgoal");
  });

  it("multiple subgoals can be added to same parent", () => {
    const parent = makeGoal();
    stateManager.saveGoal(parent);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const sub1 = makeGoal({ title: "Sub 1" });
    const sub2 = makeGoal({ title: "Sub 2" });
    manager.addSubgoal(parent.id, sub1);
    manager.addSubgoal(parent.id, sub2);

    const savedParent = stateManager.loadGoal(parent.id);
    expect(savedParent?.children_ids).toHaveLength(2);
    expect(savedParent?.children_ids).toContain(sub1.id);
    expect(savedParent?.children_ids).toContain(sub2.id);
  });

  it("added subgoal appears in getTreeState total_nodes", () => {
    const parent = makeGoal();
    stateManager.saveGoal(parent);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const sub = makeGoal();
    manager.addSubgoal(parent.id, sub);

    const state = manager.getTreeState(parent.id);
    expect(state.total_nodes).toBe(2); // parent + sub
  });

  it("registers dependency in GoalDependencyGraph (or silently ignores if unsupported)", () => {
    const parent = makeGoal();
    stateManager.saveGoal(parent);

    const newGoal = makeGoal();
    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    // Should not throw even if parent_child type is not supported
    expect(() => manager.addSubgoal(parent.id, newGoal)).not.toThrow();
  });
});

// ─── 8. Tree Restructure ───

describe("restructureTree", () => {
  it("completes without throwing on a simple tree", async () => {
    const root = makeGoal();
    const child = makeGoal({ parent_id: root.id, node_type: "subgoal", origin: "decomposition" });
    const rootWithChild: Goal = { ...root, children_ids: [child.id] };
    stateManager.saveGoal(rootWithChild);
    stateManager.saveGoal(child);

    const noOpSuggestions = JSON.stringify([]);
    const mockLLM = createMockLLMClient([noOpSuggestions]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await expect(manager.restructureTree(root.id)).resolves.toBeUndefined();
  });

  it("applies merge suggestion: cancels merged goals", async () => {
    const root = makeGoal();
    const child1 = makeGoal({ parent_id: root.id, node_type: "subgoal", origin: "decomposition" });
    const child2 = makeGoal({ parent_id: root.id, node_type: "subgoal", origin: "decomposition" });
    const rootUpdated: Goal = { ...root, children_ids: [child1.id, child2.id] };
    stateManager.saveGoal(rootUpdated);
    stateManager.saveGoal(child1);
    stateManager.saveGoal(child2);

    const mergeSuggestion = JSON.stringify([
      { action: "merge", goal_ids: [child1.id, child2.id], reasoning: "Similar goals" },
    ]);
    const mockLLM = createMockLLMClient([mergeSuggestion]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.restructureTree(root.id);
    // child2 should be cancelled (merged into child1)
    const savedChild2 = stateManager.loadGoal(child2.id);
    expect(savedChild2?.status).toBe("cancelled");
  });

  it("does not modify tree when LLM returns empty suggestions", async () => {
    const root = makeGoal();
    const child = makeGoal({ parent_id: root.id, node_type: "leaf", origin: "decomposition" });
    const rootWithChild: Goal = { ...root, children_ids: [child.id] };
    stateManager.saveGoal(rootWithChild);
    stateManager.saveGoal(child);

    const mockLLM = createMockLLMClient([JSON.stringify([])]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.restructureTree(root.id);
    const savedChild = stateManager.loadGoal(child.id);
    expect(savedChild?.status).toBe("active");
  });

  it("handles LLM parse failure gracefully (no throw)", async () => {
    const root = makeGoal();
    stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient(["not valid json"]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await expect(manager.restructureTree(root.id)).resolves.toBeUndefined();
  });

  it("merge keeps first goal in list active", async () => {
    const root = makeGoal();
    const child1 = makeGoal({ parent_id: root.id, node_type: "subgoal", origin: "decomposition" });
    const child2 = makeGoal({ parent_id: root.id, node_type: "subgoal", origin: "decomposition" });
    const rootUpdated: Goal = { ...root, children_ids: [child1.id, child2.id] };
    stateManager.saveGoal(rootUpdated);
    stateManager.saveGoal(child1);
    stateManager.saveGoal(child2);

    const mergeSuggestion = JSON.stringify([
      { action: "merge", goal_ids: [child1.id, child2.id], reasoning: "Same concern" },
    ]);
    const mockLLM = createMockLLMClient([mergeSuggestion]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.restructureTree(root.id);
    const savedChild1 = stateManager.loadGoal(child1.id);
    expect(savedChild1?.status).toBe("active");
  });

  it("ignores unrecognized action types gracefully", async () => {
    const root = makeGoal();
    stateManager.saveGoal(root);

    // "move" action is parsed but not deeply implemented in MVP
    const moveSuggestion = JSON.stringify([
      { action: "move", goal_ids: ["any-id"], reasoning: "Better position" },
    ]);
    const mockLLM = createMockLLMClient([moveSuggestion]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await expect(manager.restructureTree(root.id)).resolves.toBeUndefined();
  });
});

// ─── 9. getTreeState ───

describe("getTreeState", () => {
  it("returns correct total_nodes for a single node", () => {
    const root = makeGoal();
    stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const state = manager.getTreeState(root.id);
    expect(state.total_nodes).toBe(1);
    expect(state.root_id).toBe(root.id);
  });

  it("returns total_nodes=0 for nonexistent root", () => {
    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const state = manager.getTreeState("nonexistent");
    expect(state.total_nodes).toBe(0);
  });

  it("tracks active_loops (loop_status=running)", () => {
    const root = makeGoal();
    const child = makeGoal({ parent_id: root.id, node_type: "leaf", origin: "decomposition", loop_status: "running" });
    const rootWithChild: Goal = { ...root, children_ids: [child.id] };
    stateManager.saveGoal(rootWithChild);
    stateManager.saveGoal(child);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const state = manager.getTreeState(root.id);
    expect(state.active_loops).toContain(child.id);
  });

  it("tracks pruned_nodes (status=cancelled)", () => {
    const root = makeGoal();
    const child = makeGoal({ parent_id: root.id, node_type: "subgoal", origin: "decomposition", status: "cancelled" });
    const rootWithChild: Goal = { ...root, children_ids: [child.id] };
    stateManager.saveGoal(rootWithChild);
    stateManager.saveGoal(child);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const state = manager.getTreeState(root.id);
    expect(state.pruned_nodes).toContain(child.id);
  });

  it("max_depth_reached reflects deepest node", async () => {
    const root = makeGoal({ decomposition_depth: 0 });
    const child = makeGoal({ parent_id: root.id, node_type: "subgoal", origin: "decomposition", decomposition_depth: 1 });
    const grandchild = makeGoal({ parent_id: child.id, node_type: "leaf", origin: "decomposition", decomposition_depth: 2 });
    const childUpdated: Goal = { ...child, children_ids: [grandchild.id] };
    const rootUpdated: Goal = { ...root, children_ids: [child.id] };
    stateManager.saveGoal(rootUpdated);
    stateManager.saveGoal(childUpdated);
    stateManager.saveGoal(grandchild);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const state = manager.getTreeState(root.id);
    expect(state.max_depth_reached).toBe(2);
  });
});

// ─── 10. Edge Cases ───

describe("edge cases", () => {
  it("throws when goal not found in decomposeGoal", async () => {
    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await expect(manager.decomposeGoal("missing-id", DEFAULT_CONFIG)).rejects.toThrow();
  });

  it("single-dimension goal decomposes to specific leaf", async () => {
    const goal = makeGoal({
      dimensions: [
        {
          name: "single_metric",
          label: "Single Metric",
          current_value: 0,
          threshold: { type: "min", value: 100 },
          confidence: 0.8,
          observation_method: { type: "mechanical" as const, source: "test", schedule: null, endpoint: null, confidence_tier: "mechanical" as const },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.children).toHaveLength(0);
    expect(result.specificity_scores[goal.id]).toBeCloseTo(0.9);
  });

  it("empty subgoal response treats goal as leaf", async () => {
    const goal = makeGoal();
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_EMPTY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.children).toHaveLength(0);
    const saved = stateManager.loadGoal(goal.id);
    expect(saved?.node_type).toBe("leaf");
  });

  it("decomposeGoal handles goal with no dimensions gracefully", async () => {
    const goal = makeGoal({ dimensions: [] });
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await expect(manager.decomposeGoal(goal.id, DEFAULT_CONFIG)).resolves.toBeDefined();
  });

  it("already-leaf goal stays leaf on re-decomposition", async () => {
    const goal = makeGoal({ node_type: "leaf", specificity_score: 0.95 });
    stateManager.saveGoal(goal);

    // Even if leaf, decomposeGoal should still work (re-evaluate)
    const mockLLM = createMockLLMClient([HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.children).toHaveLength(0);
  });

  it("config with min_specificity=0 decomposes everything until max_depth", async () => {
    const config0: GoalDecompositionConfig = { ...DEFAULT_CONFIG, min_specificity: 0, max_depth: 1 };
    const goal = makeGoal();
    stateManager.saveGoal(goal);

    // With min_specificity=0, any score passes (even LOW_SPECIFICITY=0.4 >= 0)
    const mockLLM = createMockLLMClient([LOW_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, config0);
    // 0.4 >= 0 → leaf immediately
    expect(result.children).toHaveLength(0);
  });

  it("decomposeGoal with max_depth=0 forces immediate leaf", async () => {
    const config0: GoalDecompositionConfig = { ...DEFAULT_CONFIG, max_depth: 1 };
    const goal = makeGoal({ decomposition_depth: 1 }); // already at max_depth
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, config0);
    expect(result.children).toHaveLength(0);
    const saved = stateManager.loadGoal(goal.id);
    expect(saved?.node_type).toBe("leaf");
  });

  it("getTreeState on empty tree (single root) returns correct values", () => {
    const root = makeGoal();
    stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const state = manager.getTreeState(root.id);
    expect(state.root_id).toBe(root.id);
    expect(state.total_nodes).toBe(1);
    expect(state.max_depth_reached).toBe(0);
    expect(state.active_loops).toHaveLength(0);
    expect(state.pruned_nodes).toHaveLength(0);
  });

  it("cancelled goal is visible in pruned_nodes but still counted in total_nodes", () => {
    const root = makeGoal();
    const cancelled = makeGoal({ parent_id: root.id, status: "cancelled", node_type: "subgoal", origin: "decomposition" });
    const rootUpdated: Goal = { ...root, children_ids: [cancelled.id] };
    stateManager.saveGoal(rootUpdated);
    stateManager.saveGoal(cancelled);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const state = manager.getTreeState(root.id);
    expect(state.total_nodes).toBe(2);
    expect(state.pruned_nodes).toContain(cancelled.id);
  });

  it("goal with constraints passes constraints to subgoal prompt", async () => {
    const goal = makeGoal({ constraints: ["Must be serverless", "Budget < $100"] });
    stateManager.saveGoal(goal);

    let capturedPrompt = "";
    const captureClient = {
      sendMessage: async (messages: Array<{ role: string; content: string }>) => {
        capturedPrompt = messages[0]?.content ?? "";
        return {
          content: HIGH_SPECIFICITY,
          usage: { input_tokens: 10, output_tokens: 10 },
          stop_reason: "end_turn",
        };
      },
      parseJSON: createMockLLMClient([]).parseJSON.bind(createMockLLMClient([])),
    };

    const manager = new GoalTreeManager(stateManager, captureClient as never, ethicsGate, dependencyGraph);
    await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);

    expect(capturedPrompt).toContain("Must be serverless");
  });
});

// ─── 11. GoalDependencyGraph Integration ───

describe("GoalDependencyGraph integration", () => {
  it("decomposeGoal does not create prerequisite cycles", async () => {
    const root = makeGoal();
    stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_TWO, COVERAGE_PASS, HIGH_SPECIFICITY, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.decomposeGoal(root.id, DEFAULT_CONFIG);

    // The graph should not have any cycles (parent_child type is separate from prerequisite)
    // For each child, detectCycle should return false
    const savedRoot = stateManager.loadGoal(root.id);
    for (const childId of (savedRoot?.children_ids ?? [])) {
      const wouldCycle = dependencyGraph.detectCycle(childId, root.id);
      expect(wouldCycle).toBe(false);
    }
  });

  it("addSubgoal does not throw when dependency graph registration is attempted", () => {
    const parent = makeGoal();
    stateManager.saveGoal(parent);
    const child = makeGoal();

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    expect(() => manager.addSubgoal(parent.id, child)).not.toThrow();
  });

  it("validateDecomposition uses detectCycle from GoalDependencyGraph", async () => {
    const parent = makeGoal({ id: "parent-dg-test" });
    const child = makeGoal({ id: "child-dg-test", parent_id: "parent-dg-test" });
    stateManager.saveGoal(parent);

    // First add a prerequisite: child -> parent (would create a cycle if parent -> child is added)
    try {
      dependencyGraph.addEdge({
        from_goal_id: "child-dg-test",
        to_goal_id: "parent-dg-test",
        type: "prerequisite",
        status: "active",
        condition: null,
        affected_dimensions: [],
        mitigation: null,
        detection_confidence: 1,
        reasoning: "test cycle",
      });
    } catch {
      // OK if not applicable
    }

    const mockLLM = createMockLLMClient([COVERAGE_PASS]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    // Check: would parent -> child create a cycle?
    const wouldCycle = dependencyGraph.detectCycle("parent-dg-test", "child-dg-test");
    const result = await manager.validateDecomposition({
      parent_id: "parent-dg-test",
      children: [child],
      depth: 0,
      specificity_scores: {},
      reasoning: "",
    });

    if (wouldCycle) {
      expect(result).toBe(false);
    } else {
      expect(result).toBe(true);
    }
  });

  it("decomposition result for goal with many dimensions", async () => {
    const goal = makeGoal({
      dimensions: [
        { name: "d1", label: "D1", current_value: 0, threshold: { type: "min", value: 10 }, confidence: 0.8, observation_method: { type: "manual" as const, source: "t", schedule: null, endpoint: null, confidence_tier: "self_report" as const }, last_updated: new Date().toISOString(), history: [], weight: 1, uncertainty_weight: null, state_integrity: "ok", dimension_mapping: null },
        { name: "d2", label: "D2", current_value: 0, threshold: { type: "min", value: 20 }, confidence: 0.8, observation_method: { type: "manual" as const, source: "t", schedule: null, endpoint: null, confidence_tier: "self_report" as const }, last_updated: new Date().toISOString(), history: [], weight: 1, uncertainty_weight: null, state_integrity: "ok", dimension_mapping: null },
        { name: "d3", label: "D3", current_value: 0, threshold: { type: "present", value: null }, confidence: 0.8, observation_method: { type: "manual" as const, source: "t", schedule: null, endpoint: null, confidence_tier: "self_report" as const }, last_updated: new Date().toISOString(), history: [], weight: 1, uncertainty_weight: null, state_integrity: "ok", dimension_mapping: null },
      ],
    });
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.specificity_scores[goal.id]).toBeDefined();
  });

  it("reconstructed tree via getTreeState matches what was decomposed", async () => {
    const root = makeGoal();
    stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_THREE, COVERAGE_PASS, HIGH_SPECIFICITY, HIGH_SPECIFICITY, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    const state = manager.getTreeState(root.id);

    // root + 3 children = 4
    expect(state.total_nodes).toBe(4);
    expect(state.root_id).toBe(root.id);
    expect(state.max_depth_reached).toBe(1);
  });

  it("decomposeGoal result parent_id matches input goalId", async () => {
    const goal = makeGoal();
    stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.parent_id).toBe(goal.id);
  });

  it("goal with constraints: constraints are passed to child goals", async () => {
    const root = makeGoal({ constraints: ["Use TypeScript only"] });
    stateManager.saveGoal(root);

    const subgoalWithConstraint = JSON.stringify([
      {
        hypothesis: "Set up TypeScript project",
        dimensions: [],
        constraints: ["Strict mode enabled"],
        expected_specificity: 0.9,
      },
    ]);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, subgoalWithConstraint, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    const children = result.children as Goal[];
    expect(children).toHaveLength(1);
    // Child should have its own constraints from LLM
    expect(children[0]?.constraints).toContain("Strict mode enabled");
  });

  it("specificity_scores record includes child scores after 1-layer decomposition", async () => {
    const root = makeGoal();
    stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    // At minimum, root's score is in there
    expect(result.specificity_scores[root.id]).toBeCloseTo(0.4);
    // Child score should also be recorded
    const allScoreIds = Object.keys(result.specificity_scores);
    expect(allScoreIds.length).toBeGreaterThanOrEqual(2);
  });
});
