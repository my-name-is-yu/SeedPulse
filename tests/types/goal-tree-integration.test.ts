import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../../src/state-manager.js";
import { SatisficingJudge } from "../../src/drive/satisficing-judge.js";
import type { Goal, Dimension } from "../../src/types/goal.js";

// ─── Fixtures ───

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-goal-tree-integration-"));
}

function makeDimension(overrides: Partial<Dimension> = {}): Dimension {
  return {
    name: "test_dim",
    label: "Test Dimension",
    current_value: 100,
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
    id: overrides.id ?? crypto.randomUUID(),
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

// ─── Shared Setup ───

let tempDir: string;
let stateManager: StateManager;
let judge: SatisficingJudge;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
  judge = new SatisficingJudge(stateManager);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── judgeTreeCompletion ───

describe("judgeTreeCompletion", () => {
  it("leaf goal with no children_ids delegates to isGoalComplete (satisfied)", () => {
    const goal = makeGoal({
      id: "leaf-1",
      dimensions: [makeDimension({ current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 })],
    });
    stateManager.saveGoal(goal);

    const result = judge.judgeTreeCompletion("leaf-1");
    expect(result.is_complete).toBe(true);
    expect(result.blocking_dimensions).toHaveLength(0);
  });

  it("leaf goal with no children_ids delegates to isGoalComplete (not satisfied)", () => {
    const goal = makeGoal({
      id: "leaf-incomplete",
      dimensions: [makeDimension({ current_value: 50, threshold: { type: "min", value: 100 }, confidence: 0.9 })],
    });
    stateManager.saveGoal(goal);

    const result = judge.judgeTreeCompletion("leaf-incomplete");
    expect(result.is_complete).toBe(false);
    expect(result.blocking_dimensions).toContain("test_dim");
  });

  it("all children complete → parent complete", () => {
    const child1 = makeGoal({
      id: "child-1",
      dimensions: [makeDimension({ current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 })],
    });
    const child2 = makeGoal({
      id: "child-2",
      dimensions: [makeDimension({ current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 })],
    });
    const parent = makeGoal({
      id: "parent-complete",
      children_ids: ["child-1", "child-2"],
      dimensions: [],
    });

    stateManager.saveGoal(child1);
    stateManager.saveGoal(child2);
    stateManager.saveGoal(parent);

    const result = judge.judgeTreeCompletion("parent-complete");
    expect(result.is_complete).toBe(true);
  });

  it("one child incomplete → parent incomplete", () => {
    const child1 = makeGoal({
      id: "child-done",
      dimensions: [makeDimension({ current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 })],
    });
    const child2 = makeGoal({
      id: "child-not-done",
      dimensions: [makeDimension({ current_value: 40, threshold: { type: "min", value: 100 }, confidence: 0.9 })],
    });
    const parent = makeGoal({
      id: "parent-blocked",
      children_ids: ["child-done", "child-not-done"],
      dimensions: [],
    });

    stateManager.saveGoal(child1);
    stateManager.saveGoal(child2);
    stateManager.saveGoal(parent);

    const result = judge.judgeTreeCompletion("parent-blocked");
    expect(result.is_complete).toBe(false);
    expect(result.blocking_dimensions).toContain("test_dim");
  });

  it("cancelled child counts as complete", () => {
    const child1 = makeGoal({
      id: "child-cancelled",
      status: "cancelled",
      dimensions: [makeDimension({ current_value: 0, threshold: { type: "min", value: 100 } })],
    });
    const child2 = makeGoal({
      id: "child-ok",
      dimensions: [makeDimension({ current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 })],
    });
    const parent = makeGoal({
      id: "parent-with-cancelled",
      children_ids: ["child-cancelled", "child-ok"],
      dimensions: [],
    });

    stateManager.saveGoal(child1);
    stateManager.saveGoal(child2);
    stateManager.saveGoal(parent);

    const result = judge.judgeTreeCompletion("parent-with-cancelled");
    expect(result.is_complete).toBe(true);
  });

  it("deep tree (3 levels) completion — all complete", () => {
    const leaf = makeGoal({
      id: "deep-leaf",
      dimensions: [makeDimension({ current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 })],
    });
    const mid = makeGoal({
      id: "deep-mid",
      children_ids: ["deep-leaf"],
      dimensions: [],
    });
    const root = makeGoal({
      id: "deep-root",
      children_ids: ["deep-mid"],
      dimensions: [],
    });

    stateManager.saveGoal(leaf);
    stateManager.saveGoal(mid);
    stateManager.saveGoal(root);

    const result = judge.judgeTreeCompletion("deep-root");
    expect(result.is_complete).toBe(true);
  });

  it("mixed completed and cancelled children → parent complete", () => {
    const childCompleted = makeGoal({
      id: "mixed-complete",
      status: "completed",
      dimensions: [makeDimension({ current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 })],
    });
    const childCancelled = makeGoal({
      id: "mixed-cancelled",
      status: "cancelled",
      dimensions: [],
    });
    const parent = makeGoal({
      id: "mixed-parent",
      children_ids: ["mixed-complete", "mixed-cancelled"],
      dimensions: [],
    });

    stateManager.saveGoal(childCompleted);
    stateManager.saveGoal(childCancelled);
    stateManager.saveGoal(parent);

    const result = judge.judgeTreeCompletion("mixed-parent");
    expect(result.is_complete).toBe(true);
  });

  it("blocking dimensions aggregated from children", () => {
    const dim1 = makeDimension({ name: "dim_a", current_value: 10, threshold: { type: "min", value: 100 }, confidence: 0.9 });
    const dim2 = makeDimension({ name: "dim_b", current_value: 20, threshold: { type: "min", value: 100 }, confidence: 0.9 });

    const child1 = makeGoal({ id: "agg-child-1", dimensions: [dim1] });
    const child2 = makeGoal({ id: "agg-child-2", dimensions: [dim2] });
    const parent = makeGoal({
      id: "agg-parent",
      children_ids: ["agg-child-1", "agg-child-2"],
      dimensions: [],
    });

    stateManager.saveGoal(child1);
    stateManager.saveGoal(child2);
    stateManager.saveGoal(parent);

    const result = judge.judgeTreeCompletion("agg-parent");
    expect(result.is_complete).toBe(false);
    expect(result.blocking_dimensions).toContain("dim_a");
    expect(result.blocking_dimensions).toContain("dim_b");
  });

  it("low_confidence_dimensions aggregated from children", () => {
    // Low confidence (< 0.50) dimension that is met threshold-wise but is low confidence
    const lowConfDim = makeDimension({
      name: "low_conf_dim",
      current_value: 100,
      threshold: { type: "min", value: 100 },
      confidence: 0.3,
    });

    const child = makeGoal({ id: "low-conf-child", dimensions: [lowConfDim] });
    const parent = makeGoal({
      id: "low-conf-parent",
      children_ids: ["low-conf-child"],
      dimensions: [],
    });

    stateManager.saveGoal(child);
    stateManager.saveGoal(parent);

    const result = judge.judgeTreeCompletion("low-conf-parent");
    expect(result.is_complete).toBe(false);
    expect(result.low_confidence_dimensions).toContain("low_conf_dim");
  });
});

// ─── getGoalTree ───

describe("getGoalTree", () => {
  it("returns all goals in tree (BFS order, root first)", () => {
    const child1 = makeGoal({ id: "gt-child-1" });
    const child2 = makeGoal({ id: "gt-child-2" });
    const root = makeGoal({ id: "gt-root", children_ids: ["gt-child-1", "gt-child-2"] });

    stateManager.saveGoal(child1);
    stateManager.saveGoal(child2);
    stateManager.saveGoal(root);

    const result = stateManager.getGoalTree("gt-root");
    expect(result).not.toBeNull();
    const ids = result!.map(g => g.id);
    expect(ids).toContain("gt-root");
    expect(ids).toContain("gt-child-1");
    expect(ids).toContain("gt-child-2");
    expect(ids[0]).toBe("gt-root");
  });

  it("returns null for non-existent root", () => {
    const result = stateManager.getGoalTree("non-existent-root");
    expect(result).toBeNull();
  });
});

// ─── getSubtree ───

describe("getSubtree", () => {
  it("returns single node for leaf goal", () => {
    const leaf = makeGoal({ id: "sub-leaf" });
    stateManager.saveGoal(leaf);

    const result = stateManager.getSubtree("sub-leaf");
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("sub-leaf");
  });

  it("returns full subtree for parent with children", () => {
    const child1 = makeGoal({ id: "sub-child-1" });
    const child2 = makeGoal({ id: "sub-child-2" });
    const parent = makeGoal({ id: "sub-parent", children_ids: ["sub-child-1", "sub-child-2"] });

    stateManager.saveGoal(child1);
    stateManager.saveGoal(child2);
    stateManager.saveGoal(parent);

    const result = stateManager.getSubtree("sub-parent");
    expect(result).toHaveLength(3);
    const ids = result.map(g => g.id);
    expect(ids).toContain("sub-parent");
    expect(ids).toContain("sub-child-1");
    expect(ids).toContain("sub-child-2");
  });

  it("returns empty array for non-existent goal", () => {
    const result = stateManager.getSubtree("does-not-exist");
    expect(result).toHaveLength(0);
  });

  it("handles deep subtree (3 levels)", () => {
    const deepLeaf = makeGoal({ id: "deep-sub-leaf" });
    const deepMid = makeGoal({ id: "deep-sub-mid", children_ids: ["deep-sub-leaf"] });
    const deepRoot = makeGoal({ id: "deep-sub-root", children_ids: ["deep-sub-mid"] });

    stateManager.saveGoal(deepLeaf);
    stateManager.saveGoal(deepMid);
    stateManager.saveGoal(deepRoot);

    const result = stateManager.getSubtree("deep-sub-root");
    expect(result).toHaveLength(3);
    const ids = result.map(g => g.id);
    expect(ids).toContain("deep-sub-root");
    expect(ids).toContain("deep-sub-mid");
    expect(ids).toContain("deep-sub-leaf");
  });

  it("handles missing child gracefully (skips missing)", () => {
    // Parent references a child that doesn't exist
    const parent = makeGoal({ id: "partial-parent", children_ids: ["missing-child"] });
    stateManager.saveGoal(parent);

    const result = stateManager.getSubtree("partial-parent");
    // Should still return parent, just not the missing child
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("partial-parent");
  });
});

// ─── updateGoalInTree ───

describe("updateGoalInTree", () => {
  it("basic field update persists correctly", () => {
    const goal = makeGoal({ id: "upd-basic", title: "Original Title" });
    stateManager.saveGoal(goal);

    stateManager.updateGoalInTree("upd-basic", { title: "Updated Title" });

    const loaded = stateManager.loadGoal("upd-basic");
    expect(loaded!.title).toBe("Updated Title");
  });

  it("status update persists correctly", () => {
    const goal = makeGoal({ id: "upd-status", status: "active" });
    stateManager.saveGoal(goal);

    stateManager.updateGoalInTree("upd-status", { status: "completed" });

    const loaded = stateManager.loadGoal("upd-status");
    expect(loaded!.status).toBe("completed");
  });

  it("preserves existing fields not included in update", () => {
    const goal = makeGoal({
      id: "upd-preserve",
      title: "Original",
      description: "Keep this",
    });
    stateManager.saveGoal(goal);

    stateManager.updateGoalInTree("upd-preserve", { title: "New Title" });

    const loaded = stateManager.loadGoal("upd-preserve");
    expect(loaded!.title).toBe("New Title");
    expect(loaded!.description).toBe("Keep this");
    expect(loaded!.id).toBe("upd-preserve");  // id must not change
  });

  it("multiple updates work correctly", () => {
    const goal = makeGoal({ id: "upd-multi", title: "Start", status: "active" });
    stateManager.saveGoal(goal);

    stateManager.updateGoalInTree("upd-multi", { title: "Middle", status: "waiting" });
    stateManager.updateGoalInTree("upd-multi", { title: "Final", status: "completed" });

    const loaded = stateManager.loadGoal("upd-multi");
    expect(loaded!.title).toBe("Final");
    expect(loaded!.status).toBe("completed");
  });

  it("throws when goal not found", () => {
    expect(() => {
      stateManager.updateGoalInTree("does-not-exist", { title: "X" });
    }).toThrow();
  });
});
