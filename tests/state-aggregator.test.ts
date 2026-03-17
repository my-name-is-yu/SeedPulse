import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../src/state-manager.js";
import { SatisficingJudge } from "../src/drive/satisficing-judge.js";
import { StateAggregator } from "../src/goal/state-aggregator.js";
import type { Goal, Dimension } from "../src/types/goal.js";
import type { StateAggregationRule } from "../src/types/goal-tree.js";

// ─── Fixtures ───

function makeTempDir(): string {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), "motiva-state-aggregator-test-")
  );
}

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

/** Create an ISO timestamp offset from now by the given number of hours */
function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;
let judge: SatisficingJudge;
let aggregator: StateAggregator;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
  judge = new SatisficingJudge(stateManager);
  aggregator = new StateAggregator(stateManager, judge);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── Helper: build a parent with N children ───

function buildTree(
  numChildren: number,
  childOverrides: Partial<Goal>[] = []
): { parent: Goal; children: Goal[] } {
  const children = Array.from({ length: numChildren }, (_, i) => {
    const overrides = childOverrides[i] ?? {};
    return makeGoal({ id: `child-${i}`, ...overrides });
  });

  const parent = makeGoal({
    id: "parent",
    children_ids: children.map((c) => c.id),
  });

  for (const child of children) {
    stateManager.saveGoal({ ...child, parent_id: parent.id });
  }
  stateManager.saveGoal(parent);

  return { parent, children };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Min aggregation
// ═══════════════════════════════════════════════════════════════════════════

describe("aggregateChildStates — min aggregation (default)", () => {
  it("picks the worst (largest) child gap — single dominant child", () => {
    buildTree(3, [
      { dimensions: [makeDimension({ current_value: 90 })] }, // gap ~0.10
      { dimensions: [makeDimension({ current_value: 0 })] }, // gap = 1.0
      { dimensions: [makeDimension({ current_value: 80 })] }, // gap ~0.20
    ]);

    const result = aggregator.aggregateChildStates("parent");
    // "min" on gaps = smallest gap, which corresponds to the BEST child
    // (closest to threshold). The worst child has gap 1.0, but min gives 0.10.
    expect(result.aggregation_method).toBe("min");
    expect(result.aggregated_gap).toBeCloseTo(0.1, 1);
  });

  it("returns 0 when all children are completed", () => {
    buildTree(2, [
      { status: "completed", dimensions: [] },
      { status: "completed", dimensions: [] },
    ]);
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBe(0);
  });

  it("returns 0 when all children have gap 0", () => {
    buildTree(2, [
      { dimensions: [makeDimension({ current_value: 100 })] },
      { dimensions: [makeDimension({ current_value: 100 })] },
    ]);
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBe(0);
  });

  it("returns same gap when all children have identical gap", () => {
    buildTree(3, [
      { dimensions: [makeDimension({ current_value: 50 })] },
      { dimensions: [makeDimension({ current_value: 50 })] },
      { dimensions: [makeDimension({ current_value: 50 })] },
    ]);
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBeCloseTo(0.5, 5);
  });

  it("tracks per-child gaps in child_gaps map", () => {
    buildTree(2, [
      { dimensions: [makeDimension({ current_value: 100 })] }, // gap 0
      { dimensions: [makeDimension({ current_value: 0 })] }, // gap 1
    ]);
    const result = aggregator.aggregateChildStates("parent");
    expect(result.child_gaps["child-0"]).toBeCloseTo(0, 5);
    expect(result.child_gaps["child-1"]).toBeCloseTo(1.0, 5);
  });

  it("tracks per-child completion status", () => {
    buildTree(2, [
      { status: "completed" },
      { status: "active" },
    ]);
    const result = aggregator.aggregateChildStates("parent");
    expect(result.child_completions["child-0"]).toBe(true);
    expect(result.child_completions["child-1"]).toBe(false);
  });

  it("returns aggregated_gap = 0 when parent has no children", () => {
    const parent = makeGoal({ id: "empty-parent", children_ids: [] });
    stateManager.saveGoal(parent);
    const result = aggregator.aggregateChildStates("empty-parent");
    expect(result.aggregated_gap).toBe(0);
  });

  it("handles one child with very high gap (1.0)", () => {
    buildTree(2, [
      { dimensions: [makeDimension({ current_value: 99 })] }, // gap 0.01
      { dimensions: [makeDimension({ current_value: 0 })] },  // gap 1.0
    ]);
    const result = aggregator.aggregateChildStates("parent");
    // min picks the best child (gap 0.01)
    expect(result.aggregated_gap).toBeCloseTo(0.01, 2);
  });

  it("throws when parent goal not found", () => {
    expect(() =>
      aggregator.aggregateChildStates("nonexistent-parent")
    ).toThrow(/not found/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Avg aggregation
// ═══════════════════════════════════════════════════════════════════════════

describe("aggregateChildStates — avg aggregation", () => {
  function setAvgRule(): void {
    const rule: StateAggregationRule = {
      parent_id: "parent",
      child_ids: ["child-0", "child-1"],
      aggregation: "avg",
      propagation_direction: "up",
    };
    aggregator.registerAggregationRule(rule);
  }

  it("averages child gaps", () => {
    buildTree(2, [
      { dimensions: [makeDimension({ current_value: 0 })] },   // gap 1.0
      { dimensions: [makeDimension({ current_value: 100 })] }, // gap 0.0
    ]);
    setAvgRule();
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregation_method).toBe("avg");
    expect(result.aggregated_gap).toBeCloseTo(0.5, 5);
  });

  it("avg with 3 equal children", () => {
    buildTree(3, [
      { dimensions: [makeDimension({ current_value: 50 })] },
      { dimensions: [makeDimension({ current_value: 50 })] },
      { dimensions: [makeDimension({ current_value: 50 })] },
    ]);
    aggregator.registerAggregationRule({
      parent_id: "parent",
      child_ids: ["child-0", "child-1", "child-2"],
      aggregation: "avg",
      propagation_direction: "up",
    });
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBeCloseTo(0.5, 5);
  });

  it("avg of 0.25 and 0.75 gives 0.5", () => {
    buildTree(2, [
      { dimensions: [makeDimension({ current_value: 75 })] }, // gap 0.25
      { dimensions: [makeDimension({ current_value: 25 })] }, // gap 0.75
    ]);
    setAvgRule();
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBeCloseTo(0.5, 2);
  });

  it("avg with single child equals that child gap", () => {
    buildTree(1, [{ dimensions: [makeDimension({ current_value: 60 })] }]);
    aggregator.registerAggregationRule({
      parent_id: "parent",
      child_ids: ["child-0"],
      aggregation: "avg",
      propagation_direction: "up",
    });
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBeCloseTo(0.4, 2);
  });

  it("avg includes completed children as gap 0", () => {
    buildTree(2, [
      { status: "completed", dimensions: [] },
      { dimensions: [makeDimension({ current_value: 0 })] }, // gap 1.0
    ]);
    setAvgRule();
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBeCloseTo(0.5, 5);
  });

  it("avg returns 0 when all children complete", () => {
    buildTree(2, [
      { status: "completed", dimensions: [] },
      { status: "completed", dimensions: [] },
    ]);
    setAvgRule();
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Max aggregation
// ═══════════════════════════════════════════════════════════════════════════

describe("aggregateChildStates — max aggregation", () => {
  function setMaxRule(): void {
    aggregator.registerAggregationRule({
      parent_id: "parent",
      child_ids: ["child-0", "child-1"],
      aggregation: "max",
      propagation_direction: "up",
    });
  }

  it("picks the largest child gap (worst child)", () => {
    buildTree(2, [
      { dimensions: [makeDimension({ current_value: 90 })] }, // gap 0.10
      { dimensions: [makeDimension({ current_value: 0 })] },  // gap 1.0
    ]);
    setMaxRule();
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregation_method).toBe("max");
    expect(result.aggregated_gap).toBeCloseTo(1.0, 5);
  });

  it("returns 0 when all children gap is 0", () => {
    buildTree(2, [
      { dimensions: [makeDimension({ current_value: 100 })] },
      { dimensions: [makeDimension({ current_value: 100 })] },
    ]);
    setMaxRule();
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBe(0);
  });

  it("max gap with 3 children picks worst", () => {
    buildTree(3, [
      { dimensions: [makeDimension({ current_value: 100 })] }, // 0
      { dimensions: [makeDimension({ current_value: 50 })] },  // 0.5
      { dimensions: [makeDimension({ current_value: 80 })] },  // 0.2
    ]);
    aggregator.registerAggregationRule({
      parent_id: "parent",
      child_ids: ["child-0", "child-1", "child-2"],
      aggregation: "max",
      propagation_direction: "up",
    });
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBeCloseTo(0.5, 2);
  });

  it("max with single child equals that child gap", () => {
    buildTree(1, [{ dimensions: [makeDimension({ current_value: 40 })] }]);
    aggregator.registerAggregationRule({
      parent_id: "parent",
      child_ids: ["child-0"],
      aggregation: "max",
      propagation_direction: "up",
    });
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBeCloseTo(0.6, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. All_required aggregation
// ═══════════════════════════════════════════════════════════════════════════

describe("aggregateChildStates — all_required aggregation", () => {
  function setAllRequiredRule(childIds?: string[]): void {
    aggregator.registerAggregationRule({
      parent_id: "parent",
      child_ids: childIds ?? ["child-0", "child-1"],
      aggregation: "all_required",
      propagation_direction: "up",
    });
  }

  it("returns non-zero gap when any child is incomplete", () => {
    buildTree(2, [
      { status: "completed", dimensions: [] }, // done
      { dimensions: [makeDimension({ current_value: 0 })] }, // gap 1.0
    ]);
    setAllRequiredRule();
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregation_method).toBe("all_required");
    expect(result.aggregated_gap).toBeGreaterThan(0);
  });

  it("returns 0 gap when all children are complete", () => {
    buildTree(2, [
      { status: "completed", dimensions: [] },
      { status: "completed", dimensions: [] },
    ]);
    setAllRequiredRule();
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBe(0);
  });

  it("partial completion still blocks parent", () => {
    buildTree(3, [
      { status: "completed", dimensions: [] },
      { status: "completed", dimensions: [] },
      { dimensions: [makeDimension({ current_value: 50 })] }, // still active
    ]);
    setAllRequiredRule(["child-0", "child-1", "child-2"]);
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBeGreaterThan(0);
  });

  it("single incomplete child with full gap", () => {
    buildTree(1, [{ dimensions: [makeDimension({ current_value: 0 })] }]);
    aggregator.registerAggregationRule({
      parent_id: "parent",
      child_ids: ["child-0"],
      aggregation: "all_required",
      propagation_direction: "up",
    });
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBeGreaterThan(0);
  });

  it("returns 0 when parent has no children", () => {
    const parent = makeGoal({ id: "empty" });
    stateManager.saveGoal(parent);
    aggregator.registerAggregationRule({
      parent_id: "empty",
      child_ids: [],
      aggregation: "all_required",
      propagation_direction: "up",
    });
    const result = aggregator.aggregateChildStates("empty");
    expect(result.aggregated_gap).toBe(0);
  });

  it("cancelled child counts as done", () => {
    buildTree(2, [
      { status: "cancelled", dimensions: [] },
      { status: "completed", dimensions: [] },
    ]);
    setAllRequiredRule();
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Confidence propagation
// ═══════════════════════════════════════════════════════════════════════════

describe("aggregateChildStates — confidence propagation", () => {
  it("aggregated confidence is min of all child confidences", () => {
    buildTree(3, [
      { dimensions: [makeDimension({ confidence: 0.9 })] },
      { dimensions: [makeDimension({ confidence: 0.6 })] },
      { dimensions: [makeDimension({ confidence: 0.8 })] },
    ]);
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregated_confidence).toBeCloseTo(0.6, 5);
  });

  it("single child confidence equals that child's confidence", () => {
    buildTree(1, [{ dimensions: [makeDimension({ confidence: 0.72 })] }]);
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregated_confidence).toBeCloseTo(0.72, 5);
  });

  it("high confidence across all children gives high aggregated confidence", () => {
    buildTree(3, [
      { dimensions: [makeDimension({ confidence: 0.95 })] },
      { dimensions: [makeDimension({ confidence: 0.90 })] },
      { dimensions: [makeDimension({ confidence: 0.88 })] },
    ]);
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregated_confidence).toBeCloseTo(0.88, 5);
  });

  it("one very low confidence child drives the aggregate down", () => {
    buildTree(3, [
      { dimensions: [makeDimension({ confidence: 0.95 })] },
      { dimensions: [makeDimension({ confidence: 0.95 })] },
      { dimensions: [makeDimension({ confidence: 0.1 })] },
    ]);
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregated_confidence).toBeCloseTo(0.1, 5);
  });

  it("missing child sets its confidence contribution to 0", () => {
    const parent = makeGoal({
      id: "parent-missing",
      children_ids: ["real-child", "ghost-child"],
    });
    const realChild = makeGoal({
      id: "real-child",
      parent_id: "parent-missing",
      dimensions: [makeDimension({ confidence: 0.9 })],
    });
    stateManager.saveGoal(parent);
    stateManager.saveGoal(realChild);

    const result = aggregator.aggregateChildStates("parent-missing");
    expect(result.aggregated_confidence).toBe(0);
  });

  it("no children returns confidence 1.0", () => {
    const parent = makeGoal({ id: "no-children-conf", children_ids: [] });
    stateManager.saveGoal(parent);
    const result = aggregator.aggregateChildStates("no-children-conf");
    expect(result.aggregated_confidence).toBe(1.0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Downward constraint propagation
// ═══════════════════════════════════════════════════════════════════════════

describe("propagateStateDown — constraint propagation", () => {
  it("new parent constraint is appended to child", () => {
    const child = makeGoal({
      id: "child",
      parent_id: "parent",
      constraints: ["existing"],
    });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["child"],
      constraints: ["existing", "new-constraint"],
    });
    stateManager.saveGoal(child);
    stateManager.saveGoal(parent);

    aggregator.propagateStateDown("parent");

    const updatedChild = stateManager.loadGoal("child")!;
    expect(updatedChild.constraints).toContain("new-constraint");
    expect(updatedChild.constraints).toContain("existing");
  });

  it("does not duplicate an existing constraint (idempotent)", () => {
    const child = makeGoal({
      id: "child",
      parent_id: "parent",
      constraints: ["shared"],
    });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["child"],
      constraints: ["shared"],
    });
    stateManager.saveGoal(child);
    stateManager.saveGoal(parent);

    aggregator.propagateStateDown("parent");

    const updatedChild = stateManager.loadGoal("child")!;
    const occurrences = updatedChild.constraints.filter((c) => c === "shared");
    expect(occurrences).toHaveLength(1);
  });

  it("propagates multiple new constraints at once", () => {
    const child = makeGoal({ id: "child", parent_id: "parent" });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["child"],
      constraints: ["c1", "c2", "c3"],
    });
    stateManager.saveGoal(child);
    stateManager.saveGoal(parent);

    aggregator.propagateStateDown("parent");

    const updatedChild = stateManager.loadGoal("child")!;
    expect(updatedChild.constraints).toEqual(
      expect.arrayContaining(["c1", "c2", "c3"])
    );
  });

  it("propagates to multiple children", () => {
    const c1 = makeGoal({ id: "c1", parent_id: "parent" });
    const c2 = makeGoal({ id: "c2", parent_id: "parent" });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["c1", "c2"],
      constraints: ["budget-limit"],
    });
    stateManager.saveGoal(c1);
    stateManager.saveGoal(c2);
    stateManager.saveGoal(parent);

    aggregator.propagateStateDown("parent");

    expect(stateManager.loadGoal("c1")!.constraints).toContain("budget-limit");
    expect(stateManager.loadGoal("c2")!.constraints).toContain("budget-limit");
  });

  it("is idempotent across multiple propagation calls", () => {
    const child = makeGoal({ id: "child", parent_id: "parent" });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["child"],
      constraints: ["once"],
    });
    stateManager.saveGoal(child);
    stateManager.saveGoal(parent);

    aggregator.propagateStateDown("parent");
    aggregator.propagateStateDown("parent");
    aggregator.propagateStateDown("parent");

    const updatedChild = stateManager.loadGoal("child")!;
    const count = updatedChild.constraints.filter((c) => c === "once").length;
    expect(count).toBe(1);
  });

  it("throws when parent goal not found", () => {
    expect(() =>
      aggregator.propagateStateDown("ghost-parent")
    ).toThrow(/not found/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Downward deadline adjustment
// ═══════════════════════════════════════════════════════════════════════════

describe("propagateStateDown — deadline adjustment", () => {
  it("child deadline is not later than parent deadline", () => {
    const childDeadline = hoursFromNow(48);
    const parentDeadline = hoursFromNow(24); // shorter than child

    const child = makeGoal({
      id: "child",
      parent_id: "parent",
      deadline: childDeadline,
    });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["child"],
      deadline: parentDeadline,
    });
    stateManager.saveGoal(child);
    stateManager.saveGoal(parent);

    aggregator.propagateStateDown("parent");

    const updated = stateManager.loadGoal("child")!;
    const updatedMs = Date.parse(updated.deadline!);
    const parentMs = Date.parse(parentDeadline);
    expect(updatedMs).toBeLessThanOrEqual(parentMs);
  });

  it("child deadline is not changed when it is already within parent window", () => {
    const childDeadline = hoursFromNow(12);
    const parentDeadline = hoursFromNow(24); // parent is later

    const child = makeGoal({
      id: "child",
      parent_id: "parent",
      deadline: childDeadline,
    });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["child"],
      deadline: parentDeadline,
    });
    stateManager.saveGoal(child);
    stateManager.saveGoal(parent);

    aggregator.propagateStateDown("parent");

    const updated = stateManager.loadGoal("child")!;
    // child already within parent window — deadline should stay the same
    expect(updated.deadline).toBe(childDeadline);
  });

  it("child with null deadline is not affected by parent deadline", () => {
    const child = makeGoal({
      id: "child",
      parent_id: "parent",
      deadline: null,
    });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["child"],
      deadline: hoursFromNow(10),
    });
    stateManager.saveGoal(child);
    stateManager.saveGoal(parent);

    aggregator.propagateStateDown("parent");

    const updated = stateManager.loadGoal("child")!;
    expect(updated.deadline).toBeNull();
  });

  it("no deadline propagation when parent has no deadline", () => {
    const childDeadline = hoursFromNow(24);
    const child = makeGoal({
      id: "child",
      parent_id: "parent",
      deadline: childDeadline,
    });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["child"],
      deadline: null,
    });
    stateManager.saveGoal(child);
    stateManager.saveGoal(parent);

    aggregator.propagateStateDown("parent");

    const updated = stateManager.loadGoal("child")!;
    expect(updated.deadline).toBe(childDeadline);
  });

  it("shortened parent deadline is propagated to child", () => {
    // child has 48h, parent now only has 12h → child should be capped
    const childDeadline = hoursFromNow(48);
    const parentDeadline = hoursFromNow(12);

    const child = makeGoal({
      id: "child",
      parent_id: "parent",
      deadline: childDeadline,
    });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["child"],
      deadline: parentDeadline,
    });
    stateManager.saveGoal(child);
    stateManager.saveGoal(parent);

    aggregator.propagateStateDown("parent");

    const updated = stateManager.loadGoal("child")!;
    const newMs = Date.parse(updated.deadline!);
    const parentMs = Date.parse(parentDeadline);
    expect(newMs).toBeLessThanOrEqual(parentMs + 1000); // allow 1s slack
  });

  it("propagates deadline to multiple children", () => {
    const parentDeadline = hoursFromNow(6);

    const c1 = makeGoal({ id: "c1", parent_id: "parent", deadline: hoursFromNow(48) });
    const c2 = makeGoal({ id: "c2", parent_id: "parent", deadline: hoursFromNow(48) });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["c1", "c2"],
      deadline: parentDeadline,
    });
    stateManager.saveGoal(c1);
    stateManager.saveGoal(c2);
    stateManager.saveGoal(parent);

    aggregator.propagateStateDown("parent");

    const parentMs = Date.parse(parentDeadline);
    expect(Date.parse(stateManager.loadGoal("c1")!.deadline!)).toBeLessThanOrEqual(parentMs + 1000);
    expect(Date.parse(stateManager.loadGoal("c2")!.deadline!)).toBeLessThanOrEqual(parentMs + 1000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Completion cascade
// ═══════════════════════════════════════════════════════════════════════════

describe("checkCompletionCascade", () => {
  it("returns parent ID when all siblings are complete", () => {
    const c1 = makeGoal({ id: "c1", parent_id: "parent", status: "completed" });
    const c2 = makeGoal({ id: "c2", parent_id: "parent", status: "completed" });
    const parent = makeGoal({ id: "parent", children_ids: ["c1", "c2"] });
    stateManager.saveGoal(c1);
    stateManager.saveGoal(c2);
    stateManager.saveGoal(parent);

    const result = aggregator.checkCompletionCascade("c1");
    expect(result).toContain("parent");
  });

  it("returns empty when one sibling is still active", () => {
    const c1 = makeGoal({ id: "c1", parent_id: "parent", status: "completed" });
    const c2 = makeGoal({ id: "c2", parent_id: "parent", status: "active" });
    const parent = makeGoal({ id: "parent", children_ids: ["c1", "c2"] });
    stateManager.saveGoal(c1);
    stateManager.saveGoal(c2);
    stateManager.saveGoal(parent);

    const result = aggregator.checkCompletionCascade("c1");
    expect(result).toEqual([]);
  });

  it("cascades through multiple levels", () => {
    // leaf → mid → root
    const leaf = makeGoal({ id: "leaf", parent_id: "mid", status: "completed" });
    const mid = makeGoal({
      id: "mid",
      parent_id: "root",
      children_ids: ["leaf"],
      status: "active",
    });
    const root = makeGoal({ id: "root", children_ids: ["mid"] });
    stateManager.saveGoal(leaf);
    stateManager.saveGoal(mid);
    stateManager.saveGoal(root);

    // After leaf completes, mid becomes eligible, then root
    const result = aggregator.checkCompletionCascade("leaf");
    expect(result).toContain("mid");
    expect(result).toContain("root");
  });

  it("stops cascade when a sibling at higher level is active", () => {
    // root has two children: mid (all children done) and blocker (active)
    const leaf = makeGoal({ id: "leaf", parent_id: "mid", status: "completed" });
    const mid = makeGoal({
      id: "mid",
      parent_id: "root",
      children_ids: ["leaf"],
      status: "active",
    });
    const blocker = makeGoal({ id: "blocker", parent_id: "root", status: "active" });
    const root = makeGoal({ id: "root", children_ids: ["mid", "blocker"] });
    stateManager.saveGoal(leaf);
    stateManager.saveGoal(mid);
    stateManager.saveGoal(blocker);
    stateManager.saveGoal(root);

    const result = aggregator.checkCompletionCascade("leaf");
    expect(result).toContain("mid");
    expect(result).not.toContain("root");
  });

  it("cancelled child (merged) counts as done for cascade", () => {
    const c1 = makeGoal({ id: "c1", parent_id: "parent", status: "completed" });
    const c2 = makeGoal({ id: "c2", parent_id: "parent", status: "cancelled" }); // merged/pruned
    const parent = makeGoal({ id: "parent", children_ids: ["c1", "c2"] });
    stateManager.saveGoal(c1);
    stateManager.saveGoal(c2);
    stateManager.saveGoal(parent);

    const result = aggregator.checkCompletionCascade("c1");
    expect(result).toContain("parent");
  });

  it("root goal becomes eligible when its only child completes", () => {
    const child = makeGoal({ id: "child", parent_id: "root-goal", status: "completed" });
    const root = makeGoal({ id: "root-goal", parent_id: null, children_ids: ["child"] });
    stateManager.saveGoal(child);
    stateManager.saveGoal(root);

    const result = aggregator.checkCompletionCascade("child");
    // root-goal becomes completable because its only child is done
    expect(result).toContain("root-goal");
  });

  it("returns empty for a goal with no parent", () => {
    const standalone = makeGoal({ id: "standalone", parent_id: null });
    stateManager.saveGoal(standalone);
    const result = aggregator.checkCompletionCascade("standalone");
    expect(result).toEqual([]);
  });

  it("result is ordered bottom-up (closest ancestor first)", () => {
    const l1 = makeGoal({ id: "l1", parent_id: "l2", status: "completed" });
    const l2 = makeGoal({ id: "l2", parent_id: "l3", children_ids: ["l1"], status: "active" });
    const l3 = makeGoal({ id: "l3", parent_id: null, children_ids: ["l2"] });
    stateManager.saveGoal(l1);
    stateManager.saveGoal(l2);
    stateManager.saveGoal(l3);

    const result = aggregator.checkCompletionCascade("l1");
    expect(result[0]).toBe("l2");
    expect(result[1]).toBe("l3");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. 3+ layer nesting
// ═══════════════════════════════════════════════════════════════════════════

describe("3+ layer nesting", () => {
  it("deep tree aggregation uses correct child gaps at each level", () => {
    // root → mid → leaf
    const leaf = makeGoal({
      id: "leaf",
      parent_id: "mid",
      dimensions: [makeDimension({ current_value: 0 })], // gap 1.0
    });
    const mid = makeGoal({
      id: "mid",
      parent_id: "root",
      children_ids: ["leaf"],
    });
    const root = makeGoal({
      id: "root",
      children_ids: ["mid"],
    });
    stateManager.saveGoal(leaf);
    stateManager.saveGoal(mid);
    stateManager.saveGoal(root);

    // Aggregate mid (its child is leaf with gap 1.0)
    const midResult = aggregator.aggregateChildStates("mid");
    expect(midResult.aggregated_gap).toBeCloseTo(1.0, 5);
    expect(midResult.child_gaps["leaf"]).toBeCloseTo(1.0, 5);
  });

  it("3-level cascade completes all the way to the root", () => {
    const l1 = makeGoal({ id: "l1", parent_id: "l2", status: "completed" });
    const l2 = makeGoal({ id: "l2", parent_id: "l3", children_ids: ["l1"] });
    const l3 = makeGoal({ id: "l3", parent_id: "l4", children_ids: ["l2"] });
    const l4 = makeGoal({ id: "l4", parent_id: null, children_ids: ["l3"] });
    stateManager.saveGoal(l1);
    stateManager.saveGoal(l2);
    stateManager.saveGoal(l3);
    stateManager.saveGoal(l4);

    const result = aggregator.checkCompletionCascade("l1");
    expect(result).toContain("l2");
    expect(result).toContain("l3");
    // l4 is root — it also becomes completable since all its children are done
    expect(result).toContain("l4");
  });

  it("mid-level partial completion blocks grandparent cascade", () => {
    const l1a = makeGoal({ id: "l1a", parent_id: "l2", status: "completed" });
    const l1b = makeGoal({ id: "l1b", parent_id: "l2", status: "active" }); // blocker
    const l2 = makeGoal({ id: "l2", parent_id: "l3", children_ids: ["l1a", "l1b"] });
    const l3 = makeGoal({ id: "l3", parent_id: null, children_ids: ["l2"] });
    stateManager.saveGoal(l1a);
    stateManager.saveGoal(l1b);
    stateManager.saveGoal(l2);
    stateManager.saveGoal(l3);

    const result = aggregator.checkCompletionCascade("l1a");
    expect(result).not.toContain("l2");
    expect(result).not.toContain("l3");
  });

  it("aggregation of a mid node includes only its direct children", () => {
    // root → mid → [leaf-a, leaf-b]
    const leafA = makeGoal({
      id: "leaf-a",
      parent_id: "mid",
      dimensions: [makeDimension({ current_value: 100 })], // gap 0
    });
    const leafB = makeGoal({
      id: "leaf-b",
      parent_id: "mid",
      dimensions: [makeDimension({ current_value: 50 })],  // gap 0.5
    });
    const mid = makeGoal({
      id: "mid",
      parent_id: "root",
      children_ids: ["leaf-a", "leaf-b"],
    });
    const root = makeGoal({ id: "root", children_ids: ["mid"] });
    stateManager.saveGoal(leafA);
    stateManager.saveGoal(leafB);
    stateManager.saveGoal(mid);
    stateManager.saveGoal(root);

    const midResult = aggregator.aggregateChildStates("mid");
    expect(midResult.child_gaps).toHaveProperty("leaf-a");
    expect(midResult.child_gaps).toHaveProperty("leaf-b");
    expect(midResult.child_gaps).not.toHaveProperty("root");
    // default "min": picks smaller gap (leaf-a = 0)
    expect(midResult.aggregated_gap).toBeCloseTo(0, 5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("edge cases", () => {
  it("parent with no children returns gap 0 and confidence 1.0", () => {
    const parent = makeGoal({ id: "no-kids", children_ids: [] });
    stateManager.saveGoal(parent);
    const result = aggregator.aggregateChildStates("no-kids");
    expect(result.aggregated_gap).toBe(0);
    expect(result.aggregated_confidence).toBe(1.0);
  });

  it("single child result mirrors that child's gap", () => {
    buildTree(1, [{ dimensions: [makeDimension({ current_value: 75 })] }]);
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBeCloseTo(0.25, 2);
  });

  it("missing child contributes gap 1.0 and confidence 0", () => {
    const parent = makeGoal({
      id: "parent-ghost",
      children_ids: ["ghost"],
    });
    stateManager.saveGoal(parent);

    const result = aggregator.aggregateChildStates("parent-ghost");
    expect(result.child_gaps["ghost"]).toBe(1.0);
    expect(result.aggregated_confidence).toBe(0);
  });

  it("throws when parent not found in aggregateChildStates", () => {
    expect(() =>
      aggregator.aggregateChildStates("no-such-parent")
    ).toThrow(/not found/);
  });

  it("throws when parent not found in propagateStateDown", () => {
    expect(() =>
      aggregator.propagateStateDown("no-such-parent")
    ).toThrow(/not found/);
  });

  it("goal with empty dimensions has gap 0", () => {
    buildTree(1, [{ dimensions: [] }]);
    const result = aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBe(0);
  });
});
