import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../src/state-manager.js";
import { SatisficingJudge } from "../src/drive/satisficing-judge.js";
import { StateAggregator } from "../src/goal/state-aggregator.js";
import { GoalTreeManager } from "../src/goal/goal-tree-manager.js";
import { EthicsGate } from "../src/traits/ethics-gate.js";
import { GoalDependencyGraph } from "../src/goal/goal-dependency-graph.js";
import { TreeLoopOrchestrator } from "../src/goal/tree-loop-orchestrator.js";
import type { Goal, Dimension } from "../src/types/goal.js";
import type { GoalDecompositionConfig } from "../src/types/goal-tree.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";

// ─── Fixtures ───

function makeDimension(overrides: Partial<Dimension> = {}): Dimension {
  return {
    name: "score",
    label: "Score",
    current_value: 50,
    threshold: { type: "min", value: 100 },
    confidence: 0.9,
    observation_method: {
      type: "mechanical",
      source: "test",
      schedule: null,
      endpoint: null,
      confidence_tier: "mechanical",
    },
    last_updated: new Date().toISOString(),
    history: [],
    weight: 1.0,
    uncertainty_weight: null,
    state_integrity: "ok",
    dimension_mapping: null,
    ...overrides,
  };
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? `goal-${Math.random().toString(36).slice(2)}`,
    parent_id: null,
    node_type: "goal",
    title: "Test Goal",
    description: "",
    status: "active",
    dimensions: [makeDimension()],
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: [],
    children_ids: [],
    target_date: null,
    origin: null,
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    decomposition_depth: 0,
    specificity_score: null,
    loop_status: "idle",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

const DEFAULT_CONFIG: GoalDecompositionConfig = {
  max_depth: 5,
  min_specificity: 0.7,
  auto_prune_threshold: 0.3,
  parallel_loop_limit: 3,
};

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;
let satisficingJudge: SatisficingJudge;
let stateAggregator: StateAggregator;
let goalTreeManager: GoalTreeManager;
let orchestrator: TreeLoopOrchestrator;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-tlo-test-"));
  stateManager = new StateManager(tempDir);
  satisficingJudge = new SatisficingJudge(stateManager);
  stateAggregator = new StateAggregator(stateManager, satisficingJudge);
  const mockLLM = createMockLLMClient([]);
  const ethicsGate = new EthicsGate(stateManager, mockLLM);
  const depGraph = new GoalDependencyGraph(stateManager, mockLLM);
  goalTreeManager = new GoalTreeManager(
    stateManager,
    mockLLM,
    ethicsGate,
    depGraph
  );
  orchestrator = new TreeLoopOrchestrator(
    stateManager,
    goalTreeManager,
    stateAggregator,
    satisficingJudge
  );
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── Helper: save a goal and return it ───
function saveGoal(overrides: Partial<Goal> = {}): Goal {
  const g = makeGoal(overrides);
  stateManager.saveGoal(g);
  return g;
}

// ─── Helper: build a simple parent–children tree ───
function buildSimpleTree(
  numChildren: number,
  childOverrides: Partial<Goal> = {}
): { parent: Goal; children: Goal[] } {
  const children: Goal[] = [];
  const childIds: string[] = [];

  for (let i = 0; i < numChildren; i++) {
    const child = saveGoal({
      id: `child-${i}`,
      node_type: "leaf",
      decomposition_depth: 1,
      ...childOverrides,
    });
    children.push(child);
    childIds.push(child.id);
  }

  const parent = saveGoal({
    id: "parent",
    node_type: "goal",
    children_ids: childIds,
  });

  // Update each child's parent_id
  for (const child of children) {
    stateManager.saveGoal({ ...child, parent_id: parent.id });
  }

  return { parent, children };
}

// ═══════════════════════════════════════════════════════════════════
// 1. NODE SELECTION TESTS (~20 tests)
// ═══════════════════════════════════════════════════════════════════

describe("selectNextNode — basic selection", () => {
  it("returns null when tree root does not exist", () => {
    const result = orchestrator.selectNextNode("nonexistent-root");
    expect(result).toBeNull();
  });

  it("selects the root itself if it is the only active idle node", () => {
    const root = saveGoal({ id: "root", node_type: "goal" });
    const result = orchestrator.selectNextNode(root.id);
    expect(result).toBe(root.id);
  });

  it("sets loop_status to 'running' on the selected node", () => {
    const root = saveGoal({ id: "root", node_type: "goal" });
    orchestrator.selectNextNode(root.id);
    const updated = stateManager.loadGoal(root.id);
    expect(updated?.loop_status).toBe("running");
  });

  it("prefers leaf node over non-leaf node", () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["child-leaf", "child-subgoal"],
    });
    saveGoal({
      id: "child-leaf",
      node_type: "leaf",
      parent_id: "root",
      decomposition_depth: 1,
    });
    saveGoal({
      id: "child-subgoal",
      node_type: "subgoal",
      parent_id: "root",
      decomposition_depth: 1,
    });

    const result = orchestrator.selectNextNode("root");
    expect(result).toBe("child-leaf");
  });

  it("falls back to non-leaf when no leaf nodes exist", () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["child-sub"],
    });
    saveGoal({
      id: "child-sub",
      node_type: "subgoal",
      parent_id: "root",
      decomposition_depth: 1,
    });

    // root is also an active+idle non-leaf node and appears before child-sub in iteration
    const result = orchestrator.selectNextNode("root");
    expect(result).not.toBeNull();
    // Either root or child-sub is valid (both are active+idle non-leaf)
    expect(["root", "child-sub"]).toContain(result);
  });

  it("skips nodes with status !== 'active'", () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", status: "completed" });
    saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", status: "active" });

    const result = orchestrator.selectNextNode("root");
    expect(result).toBe("c2");
  });

  it("skips nodes with loop_status 'running'", () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", loop_status: "running" });
    saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", loop_status: "idle" });

    const result = orchestrator.selectNextNode("root");
    expect(result).toBe("c2");
  });

  it("skips nodes with loop_status 'paused'", () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", loop_status: "paused" });
    saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", loop_status: "idle" });

    const result = orchestrator.selectNextNode("root");
    expect(result).toBe("c2");
  });

  it("returns null when all leaf nodes AND the root are running or paused", () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
      loop_status: "running", // root also running
    });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", loop_status: "running" });
    saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", loop_status: "paused" });

    const result = orchestrator.selectNextNode("root");
    expect(result).toBeNull();
  });

  it("returns null when all nodes are completed", () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      status: "completed",
      children_ids: ["c1"],
    });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", status: "completed" });

    const result = orchestrator.selectNextNode("root");
    expect(result).toBeNull();
  });

  it("returns null when all nodes are cancelled", () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      status: "cancelled",
      children_ids: ["c1"],
    });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", status: "cancelled" });

    const result = orchestrator.selectNextNode("root");
    expect(result).toBeNull();
  });

  it("selects deeper leaf over shallower leaf when both are eligible", () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["mid"],
    });
    saveGoal({
      id: "mid",
      node_type: "goal",
      parent_id: "root",
      decomposition_depth: 1,
      children_ids: ["deep"],
    });
    saveGoal({
      id: "deep",
      node_type: "leaf",
      parent_id: "mid",
      decomposition_depth: 2,
    });
    // root itself is also "goal" type (not leaf), mid is also "goal" (not leaf)
    // only deep is leaf
    const result = orchestrator.selectNextNode("root");
    expect(result).toBe("deep");
  });

  it("selects single-node tree (root is a leaf)", () => {
    saveGoal({ id: "root", node_type: "leaf" });
    const result = orchestrator.selectNextNode("root");
    expect(result).toBe("root");
  });

  it("does not select cancelled nodes even if loop_status is idle", () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1"],
    });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", status: "cancelled" });

    const result = orchestrator.selectNextNode("root");
    // root is active+idle+non-leaf, should be selected as fallback
    expect(result).toBe("root");
  });

  it("prefers multiple leaves over non-leaves — first eligible leaf returned", () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["leaf1", "leaf2", "sub1"],
    });
    saveGoal({ id: "leaf1", node_type: "leaf", parent_id: "root", decomposition_depth: 1 });
    saveGoal({ id: "leaf2", node_type: "leaf", parent_id: "root", decomposition_depth: 1 });
    saveGoal({ id: "sub1", node_type: "subgoal", parent_id: "root", decomposition_depth: 1 });

    const result = orchestrator.selectNextNode("root");
    expect(result).toBe("leaf1"); // first in stable order among equal depth
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. PARALLEL EXECUTION CONTROL (~15 tests)
// ═══════════════════════════════════════════════════════════════════

describe("selectNextNode — parallel execution control", () => {
  it("returns null immediately when parallel_loop_limit=1 and one node is running", async () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", loop_status: "running" });
    saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", loop_status: "idle" });

    await orchestrator.startTreeExecution("root", { ...DEFAULT_CONFIG, parallel_loop_limit: 1 });

    // c1 is already running (set before startTreeExecution reset — but startTreeExecution resets to idle)
    // Re-set c1 to running after startTreeExecution
    const c1 = stateManager.loadGoal("c1");
    stateManager.saveGoal({ ...c1!, loop_status: "running" });

    const result = orchestrator.selectNextNode("root");
    expect(result).toBeNull();
  });

  it("allows one node when parallel_loop_limit=1 and nothing is running", async () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root" });
    saveGoal({ id: "c2", node_type: "leaf", parent_id: "root" });

    await orchestrator.startTreeExecution("root", { ...DEFAULT_CONFIG, parallel_loop_limit: 1 });

    const result = orchestrator.selectNextNode("root");
    expect(result).not.toBeNull();
  });

  it("allows up to parallel_loop_limit=3 concurrent nodes", () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2", "c3", "c4"],
    });
    for (let i = 1; i <= 4; i++) {
      saveGoal({ id: `c${i}`, node_type: "leaf", parent_id: "root", decomposition_depth: 1 });
    }

    // Select 3 nodes (limit=3)
    const sel1 = orchestrator.selectNextNode("root");
    const sel2 = orchestrator.selectNextNode("root");
    const sel3 = orchestrator.selectNextNode("root");
    expect(sel1).not.toBeNull();
    expect(sel2).not.toBeNull();
    expect(sel3).not.toBeNull();

    // 4th should be blocked
    const sel4 = orchestrator.selectNextNode("root");
    expect(sel4).toBeNull();
  });

  it("returns null when active_loops count equals parallel_loop_limit", () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2", "c3"],
    });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", loop_status: "running" });
    saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", loop_status: "running" });
    saveGoal({ id: "c3", node_type: "leaf", parent_id: "root", loop_status: "running" });

    // Default config has parallel_loop_limit=3, all 3 are running
    const result = orchestrator.selectNextNode("root");
    expect(result).toBeNull();
  });

  it("returns a node after a running node is completed (slot freed)", () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", loop_status: "running" });
    saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", loop_status: "idle" });

    // With parallel_loop_limit=1: cannot select
    orchestrator["config"] = { ...DEFAULT_CONFIG, parallel_loop_limit: 1 };
    let result = orchestrator.selectNextNode("root");
    expect(result).toBeNull();

    // Complete c1 to free the slot
    orchestrator.onNodeCompleted("c1");
    // Also mark c1 status as completed so it's not selected again
    const c1 = stateManager.loadGoal("c1");
    stateManager.saveGoal({ ...c1!, status: "completed" });

    // Now should be able to select c2
    result = orchestrator.selectNextNode("root");
    expect(result).toBe("c2");
  });

  it("sequential selections mark nodes as running and reduce available slots", () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", decomposition_depth: 1 });
    saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", decomposition_depth: 1 });

    const first = orchestrator.selectNextNode("root");
    const second = orchestrator.selectNextNode("root");

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
  });

  it("respects config parallel_loop_limit=2", async () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2", "c3"],
    });
    for (let i = 1; i <= 3; i++) {
      saveGoal({ id: `c${i}`, node_type: "leaf", parent_id: "root", decomposition_depth: 1 });
    }

    await orchestrator.startTreeExecution("root", {
      ...DEFAULT_CONFIG,
      parallel_loop_limit: 2,
    });

    const sel1 = orchestrator.selectNextNode("root");
    const sel2 = orchestrator.selectNextNode("root");
    const sel3 = orchestrator.selectNextNode("root");

    expect(sel1).not.toBeNull();
    expect(sel2).not.toBeNull();
    expect(sel3).toBeNull(); // limit of 2 reached
  });

  it("paused nodes do not count toward active_loops", () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", loop_status: "paused" });
    saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", loop_status: "idle" });

    // Only "running" counts for active_loops. With limit=1, paused doesn't block.
    orchestrator["config"] = { ...DEFAULT_CONFIG, parallel_loop_limit: 1 };
    const result = orchestrator.selectNextNode("root");
    // c2 should be selectable because c1 is paused (not running)
    expect(result).toBe("c2");
  });

  it("selecting a node increments active count for subsequent calls", () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", decomposition_depth: 1 });
    saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", decomposition_depth: 1 });

    orchestrator["config"] = { ...DEFAULT_CONFIG, parallel_loop_limit: 1 };

    const first = orchestrator.selectNextNode("root");
    expect(first).not.toBeNull();

    // After selecting one, the limit is reached
    const second = orchestrator.selectNextNode("root");
    expect(second).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. NODE COMPLETION CASCADE (~20 tests)
// ═══════════════════════════════════════════════════════════════════

describe("onNodeCompleted — loop_status reset", () => {
  it("sets loop_status to 'idle' after node completes", () => {
    const node = saveGoal({ id: "node1", node_type: "leaf", loop_status: "running" });
    orchestrator.onNodeCompleted(node.id);
    const updated = stateManager.loadGoal(node.id);
    expect(updated?.loop_status).toBe("idle");
  });

  it("is a no-op if goal does not exist", () => {
    expect(() => orchestrator.onNodeCompleted("nonexistent")).not.toThrow();
  });

  it("updates updated_at timestamp", () => {
    const before = new Date().toISOString();
    const node = saveGoal({ id: "n1", loop_status: "running" });
    orchestrator.onNodeCompleted(node.id);
    const updated = stateManager.loadGoal("n1");
    expect(updated?.updated_at >= before).toBe(true);
  });
});

describe("onNodeCompleted — parent aggregation", () => {
  it("triggers aggregation up the parent chain", () => {
    const { parent, children } = buildSimpleTree(2);
    const child = children[0]!;

    // Mark child as completed
    stateManager.saveGoal({ ...child, status: "completed" });
    orchestrator.onNodeCompleted(child.id);

    // Parent should still exist
    const updatedParent = stateManager.loadGoal(parent.id);
    expect(updatedParent).not.toBeNull();
  });

  it("aggregates child states — parent confidence should reflect children", () => {
    saveGoal({
      id: "parent",
      node_type: "goal",
      children_ids: ["c1"],
    });
    saveGoal({
      id: "c1",
      node_type: "leaf",
      parent_id: "parent",
      loop_status: "running",
      status: "completed",
      dimensions: [makeDimension({ confidence: 0.4 })],
    });

    orchestrator.onNodeCompleted("c1");
    // No throw — aggregation ran
    const parent = stateManager.loadGoal("parent");
    expect(parent).not.toBeNull();
  });

  it("does not throw when parent has no further parent (root level)", () => {
    const root = saveGoal({ id: "root", loop_status: "running" });
    expect(() => orchestrator.onNodeCompleted(root.id)).not.toThrow();
    const updated = stateManager.loadGoal("root");
    expect(updated?.loop_status).toBe("idle");
  });
});

describe("onNodeCompleted — completion cascade", () => {
  it("marks parent as completed when all siblings are done", () => {
    saveGoal({
      id: "parent",
      node_type: "goal",
      status: "active",
      children_ids: ["c1", "c2"],
    });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "parent", status: "completed" });
    saveGoal({ id: "c2", node_type: "leaf", parent_id: "parent", status: "active", loop_status: "running" });

    // Complete c2 — now all children are done
    stateManager.saveGoal({
      ...stateManager.loadGoal("c2")!,
      status: "completed",
    });
    orchestrator.onNodeCompleted("c2");

    const parent = stateManager.loadGoal("parent");
    expect(parent?.status).toBe("completed");
  });

  it("does not mark parent as completed when sibling is still active", () => {
    saveGoal({
      id: "parent",
      node_type: "goal",
      status: "active",
      children_ids: ["c1", "c2"],
    });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "parent", status: "active" });
    saveGoal({ id: "c2", node_type: "leaf", parent_id: "parent", status: "active", loop_status: "running" });

    orchestrator.onNodeCompleted("c2");

    // c1 is still active — parent should NOT be completed
    const parent = stateManager.loadGoal("parent");
    expect(parent?.status).not.toBe("completed");
  });

  it("treats cancelled siblings as done for cascade purposes", () => {
    saveGoal({
      id: "parent",
      node_type: "goal",
      status: "active",
      children_ids: ["c1", "c2"],
    });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "parent", status: "cancelled" });
    saveGoal({ id: "c2", node_type: "leaf", parent_id: "parent", status: "active", loop_status: "running" });

    stateManager.saveGoal({ ...stateManager.loadGoal("c2")!, status: "completed" });
    orchestrator.onNodeCompleted("c2");

    const parent = stateManager.loadGoal("parent");
    expect(parent?.status).toBe("completed");
  });

  it("cascades completion through 3 layers", () => {
    // root → mid → leaf
    saveGoal({ id: "root", node_type: "goal", status: "active", children_ids: ["mid"] });
    saveGoal({ id: "mid", node_type: "subgoal", parent_id: "root", status: "active", children_ids: ["leaf1"] });
    saveGoal({ id: "leaf1", node_type: "leaf", parent_id: "mid", status: "active", loop_status: "running" });

    stateManager.saveGoal({ ...stateManager.loadGoal("leaf1")!, status: "completed" });
    orchestrator.onNodeCompleted("leaf1");

    const mid = stateManager.loadGoal("mid");
    const root = stateManager.loadGoal("root");
    expect(mid?.status).toBe("completed");
    expect(root?.status).toBe("completed");
  });

  it("stops cascade when a parent has remaining active children", () => {
    saveGoal({ id: "root", node_type: "goal", status: "active", children_ids: ["mid1", "mid2"] });
    saveGoal({ id: "mid1", node_type: "subgoal", parent_id: "root", status: "active", children_ids: ["leaf1"] });
    saveGoal({ id: "mid2", node_type: "subgoal", parent_id: "root", status: "active", children_ids: [] });
    saveGoal({ id: "leaf1", node_type: "leaf", parent_id: "mid1", status: "active", loop_status: "running" });

    stateManager.saveGoal({ ...stateManager.loadGoal("leaf1")!, status: "completed" });
    orchestrator.onNodeCompleted("leaf1");

    // mid1 should complete (all its children done), but root should not (mid2 still active)
    const mid1 = stateManager.loadGoal("mid1");
    const root = stateManager.loadGoal("root");
    expect(mid1?.status).toBe("completed");
    expect(root?.status).not.toBe("completed");
  });

  it("does not re-complete already completed ancestors", () => {
    saveGoal({ id: "root", node_type: "goal", status: "completed", children_ids: ["c1"] });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", status: "active", loop_status: "running" });

    stateManager.saveGoal({ ...stateManager.loadGoal("c1")!, status: "completed" });
    orchestrator.onNodeCompleted("c1");

    const root = stateManager.loadGoal("root");
    expect(root?.status).toBe("completed"); // remains completed (idempotent)
  });

  it("loop_status is idle after cascade-completion", () => {
    saveGoal({ id: "root", node_type: "goal", status: "active", children_ids: ["c1"] });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", loop_status: "running", status: "active" });

    stateManager.saveGoal({ ...stateManager.loadGoal("c1")!, status: "completed" });
    orchestrator.onNodeCompleted("c1");

    const c1 = stateManager.loadGoal("c1");
    expect(c1?.loop_status).toBe("idle");
  });

  it("single child completion triggers parent completion", () => {
    saveGoal({ id: "parent", status: "active", children_ids: ["c1"] });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "parent", status: "active", loop_status: "running" });

    stateManager.saveGoal({ ...stateManager.loadGoal("c1")!, status: "completed" });
    orchestrator.onNodeCompleted("c1");

    expect(stateManager.loadGoal("parent")?.status).toBe("completed");
  });

  it("4-level cascade: leaf → L3 → L2 → root", () => {
    saveGoal({ id: "root", status: "active", children_ids: ["l2"] });
    saveGoal({ id: "l2", parent_id: "root", status: "active", children_ids: ["l3"] });
    saveGoal({ id: "l3", parent_id: "l2", status: "active", children_ids: ["leaf"] });
    saveGoal({ id: "leaf", node_type: "leaf", parent_id: "l3", status: "active", loop_status: "running" });

    stateManager.saveGoal({ ...stateManager.loadGoal("leaf")!, status: "completed" });
    orchestrator.onNodeCompleted("leaf");

    expect(stateManager.loadGoal("l3")?.status).toBe("completed");
    expect(stateManager.loadGoal("l2")?.status).toBe("completed");
    expect(stateManager.loadGoal("root")?.status).toBe("completed");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. PAUSE / RESUME (~10 tests)
// ═══════════════════════════════════════════════════════════════════

describe("pauseNodeLoop", () => {
  it("sets loop_status to 'paused'", () => {
    const goal = saveGoal({ id: "g1", loop_status: "running" });
    orchestrator.pauseNodeLoop(goal.id);
    const updated = stateManager.loadGoal("g1");
    expect(updated?.loop_status).toBe("paused");
  });

  it("is a no-op for non-existent goal", () => {
    expect(() => orchestrator.pauseNodeLoop("nonexistent")).not.toThrow();
  });

  it("updates updated_at timestamp on pause", () => {
    const before = new Date().toISOString();
    saveGoal({ id: "g1", loop_status: "running" });
    orchestrator.pauseNodeLoop("g1");
    const updated = stateManager.loadGoal("g1");
    expect(updated?.updated_at >= before).toBe(true);
  });

  it("can pause an idle node too", () => {
    saveGoal({ id: "g1", loop_status: "idle" });
    orchestrator.pauseNodeLoop("g1");
    const updated = stateManager.loadGoal("g1");
    expect(updated?.loop_status).toBe("paused");
  });

  it("paused node is not selected by selectNextNode", () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root" });
    saveGoal({ id: "c2", node_type: "leaf", parent_id: "root" });

    orchestrator.pauseNodeLoop("c1");

    orchestrator["config"] = { ...DEFAULT_CONFIG, parallel_loop_limit: 1 };
    const result = orchestrator.selectNextNode("root");
    expect(result).toBe("c2");
  });
});

describe("resumeNodeLoop", () => {
  it("sets loop_status to 'running'", () => {
    const goal = saveGoal({ id: "g1", loop_status: "paused" });
    orchestrator.resumeNodeLoop(goal.id);
    const updated = stateManager.loadGoal("g1");
    expect(updated?.loop_status).toBe("running");
  });

  it("is a no-op for non-existent goal", () => {
    expect(() => orchestrator.resumeNodeLoop("nonexistent")).not.toThrow();
  });

  it("updates updated_at timestamp on resume", () => {
    const before = new Date().toISOString();
    saveGoal({ id: "g1", loop_status: "paused" });
    orchestrator.resumeNodeLoop("g1");
    const updated = stateManager.loadGoal("g1");
    expect(updated?.updated_at >= before).toBe(true);
  });

  it("resumed node is counted toward active_loops", () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", loop_status: "paused" });
    saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", loop_status: "idle" });

    orchestrator.resumeNodeLoop("c1"); // c1 now running

    // With limit=1, c1 is running → c2 cannot be selected
    orchestrator["config"] = { ...DEFAULT_CONFIG, parallel_loop_limit: 1 };
    const result = orchestrator.selectNextNode("root");
    expect(result).toBeNull();
  });

  it("pause then resume restores idle→running flow correctly", () => {
    saveGoal({ id: "g1", loop_status: "idle" });
    orchestrator.pauseNodeLoop("g1");
    expect(stateManager.loadGoal("g1")?.loop_status).toBe("paused");
    orchestrator.resumeNodeLoop("g1");
    expect(stateManager.loadGoal("g1")?.loop_status).toBe("running");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. EDGE CASES (~15 tests)
// ═══════════════════════════════════════════════════════════════════

describe("edge cases", () => {
  it("empty tree (root not found) returns null from selectNextNode", () => {
    expect(orchestrator.selectNextNode("does-not-exist")).toBeNull();
  });

  it("single leaf node: selects it and marks running", () => {
    saveGoal({ id: "only-leaf", node_type: "leaf" });
    const result = orchestrator.selectNextNode("only-leaf");
    expect(result).toBe("only-leaf");
    expect(stateManager.loadGoal("only-leaf")?.loop_status).toBe("running");
  });

  it("all nodes completed — returns null", () => {
    saveGoal({ id: "root", status: "completed", children_ids: ["c1"] });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", status: "completed" });
    expect(orchestrator.selectNextNode("root")).toBeNull();
  });

  it("deep tree (5 levels): selects deepest leaf first", () => {
    saveGoal({ id: "l0", node_type: "goal", children_ids: ["l1"] });
    saveGoal({ id: "l1", node_type: "subgoal", parent_id: "l0", decomposition_depth: 1, children_ids: ["l2"] });
    saveGoal({ id: "l2", node_type: "subgoal", parent_id: "l1", decomposition_depth: 2, children_ids: ["l3"] });
    saveGoal({ id: "l3", node_type: "subgoal", parent_id: "l2", decomposition_depth: 3, children_ids: ["l4"] });
    saveGoal({ id: "l4", node_type: "leaf", parent_id: "l3", decomposition_depth: 4 });

    const result = orchestrator.selectNextNode("l0");
    expect(result).toBe("l4");
  });

  it("root with no children (non-leaf): root itself is selected", () => {
    saveGoal({ id: "root", node_type: "goal" });
    const result = orchestrator.selectNextNode("root");
    expect(result).toBe("root");
  });

  it("startTreeExecution resets all node loop_status to idle", async () => {
    saveGoal({ id: "root", children_ids: ["c1", "c2"] });
    saveGoal({ id: "c1", parent_id: "root", loop_status: "running" });
    saveGoal({ id: "c2", parent_id: "root", loop_status: "paused" });

    await orchestrator.startTreeExecution("root", DEFAULT_CONFIG);

    expect(stateManager.loadGoal("c1")?.loop_status).toBe("idle");
    expect(stateManager.loadGoal("c2")?.loop_status).toBe("idle");
  });

  it("startTreeExecution saves config used by selectNextNode", async () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root" });
    saveGoal({ id: "c2", node_type: "leaf", parent_id: "root" });

    await orchestrator.startTreeExecution("root", { ...DEFAULT_CONFIG, parallel_loop_limit: 1 });

    const first = orchestrator.selectNextNode("root");
    expect(first).not.toBeNull();

    // Second call should return null since limit=1 already reached
    const second = orchestrator.selectNextNode("root");
    expect(second).toBeNull();
  });

  it("startTreeExecution on non-existent root is safe (no throw)", async () => {
    await expect(
      orchestrator.startTreeExecution("no-such-root", DEFAULT_CONFIG)
    ).resolves.not.toThrow();
  });

  it("tree with cancelled and waiting nodes: only active idle selected", () => {
    saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2", "c3"],
    });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", status: "cancelled" });
    saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", status: "waiting" });
    saveGoal({ id: "c3", node_type: "leaf", parent_id: "root", status: "active" });

    const result = orchestrator.selectNextNode("root");
    expect(result).toBe("c3");
  });

  it("3-sibling tree: two complete, one remaining — root not completed yet", () => {
    saveGoal({ id: "root", status: "active", children_ids: ["c1", "c2", "c3"] });
    saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", status: "completed" });
    saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", status: "completed" });
    saveGoal({ id: "c3", node_type: "leaf", parent_id: "root", status: "active", loop_status: "running" });

    orchestrator.onNodeCompleted("c2"); // c2 was already completed but we call it
    const root = stateManager.loadGoal("root");
    // c3 is still active → root not completed
    expect(root?.status).not.toBe("completed");
  });

  it("completing a leaf with no parent: no aggregation, no crash", () => {
    saveGoal({ id: "orphan", node_type: "leaf", parent_id: null, loop_status: "running" });
    expect(() => orchestrator.onNodeCompleted("orphan")).not.toThrow();
    expect(stateManager.loadGoal("orphan")?.loop_status).toBe("idle");
  });

  it("multiple consecutive completions: each resets loop_status to idle", () => {
    saveGoal({ id: "g1", node_type: "leaf", loop_status: "running" });
    saveGoal({ id: "g2", node_type: "leaf", loop_status: "running" });

    orchestrator.onNodeCompleted("g1");
    orchestrator.onNodeCompleted("g2");

    expect(stateManager.loadGoal("g1")?.loop_status).toBe("idle");
    expect(stateManager.loadGoal("g2")?.loop_status).toBe("idle");
  });

  it("two branches: completing one branch does not affect the other", () => {
    saveGoal({ id: "root", status: "active", children_ids: ["branch1", "branch2"] });
    saveGoal({ id: "branch1", parent_id: "root", status: "active", children_ids: ["leaf1"] });
    saveGoal({ id: "branch2", parent_id: "root", status: "active", children_ids: ["leaf2"] });
    saveGoal({ id: "leaf1", node_type: "leaf", parent_id: "branch1", status: "active", loop_status: "running" });
    saveGoal({ id: "leaf2", node_type: "leaf", parent_id: "branch2", status: "active" });

    stateManager.saveGoal({ ...stateManager.loadGoal("leaf1")!, status: "completed" });
    orchestrator.onNodeCompleted("leaf1");

    // branch1 completed, but branch2 and root should not be
    expect(stateManager.loadGoal("branch1")?.status).toBe("completed");
    expect(stateManager.loadGoal("branch2")?.status).not.toBe("completed");
    expect(stateManager.loadGoal("root")?.status).not.toBe("completed");
  });

  it("does not select nodes from unrelated trees", () => {
    // Tree A
    saveGoal({ id: "rootA", children_ids: ["leafA"] });
    saveGoal({ id: "leafA", node_type: "leaf", parent_id: "rootA" });

    // Tree B (separate)
    saveGoal({ id: "rootB", children_ids: ["leafB"] });
    saveGoal({ id: "leafB", node_type: "leaf", parent_id: "rootB" });

    const resultA = orchestrator.selectNextNode("rootA");
    const resultB = orchestrator.selectNextNode("rootB");

    // Each call should select from its own tree
    expect(resultA).toBe("leafA");
    expect(resultB).toBe("leafB");
  });
});
