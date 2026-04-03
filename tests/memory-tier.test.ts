import { describe, it, expect, vi } from "vitest";
import { classifyTier, sortByTier, filterByTierBudget, computeDynamicBudget, llmClassifyTier } from "../src/knowledge/memory/memory-tier.js";
import type { ShortTermEntry, MemoryIndexEntry } from "../src/types/memory-lifecycle.js";

// ─── Helpers ───

function makeTimestamp(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

function makeShortTermEntry(
  overrides: Partial<ShortTermEntry> = {}
): ShortTermEntry {
  return {
    id: "st-1",
    goal_id: "goal-active",
    data_type: "observation",
    loop_number: 100,
    timestamp: makeTimestamp(1), // 1 hour ago → recent
    dimensions: ["dim-a"],
    tags: [],
    data: {},
    embedding_id: null,
    memory_tier: "recall",
    ...overrides,
  };
}

function makeIndexEntry(
  overrides: Partial<MemoryIndexEntry> = {}
): MemoryIndexEntry {
  return {
    id: "idx-1",
    goal_id: "goal-active",
    dimensions: ["dim-a"],
    tags: [],
    timestamp: makeTimestamp(1),
    data_file: "goals/goal-active.json",
    entry_id: "st-1",
    last_accessed: makeTimestamp(1), // 1 hour ago → recent
    access_count: 0,
    embedding_id: null,
    memory_tier: "recall",
    ...overrides,
  };
}

// ─── classifyTier ───

describe("classifyTier — ShortTermEntry", () => {
  const active = ["goal-active"];
  const completed = ["goal-done"];

  it("returns core for active goal + observation type + recent timestamp", () => {
    const entry = makeShortTermEntry({
      goal_id: "goal-active",
      data_type: "observation",
      timestamp: makeTimestamp(1), // 1 hour ago < 5 hours
    });
    expect(classifyTier(entry, active, completed)).toBe("core");
  });

  it("returns core for active goal + strategy type + recent timestamp", () => {
    const entry = makeShortTermEntry({
      goal_id: "goal-active",
      data_type: "strategy",
      timestamp: makeTimestamp(2),
    });
    expect(classifyTier(entry, active, completed)).toBe("core");
  });

  it("returns core for active goal + observation + 'recent' tag (even if old timestamp)", () => {
    const entry = makeShortTermEntry({
      goal_id: "goal-active",
      data_type: "observation",
      timestamp: makeTimestamp(100), // old
      tags: ["recent"],
    });
    expect(classifyTier(entry, active, completed)).toBe("core");
  });

  it("returns recall for active goal + observation type + old timestamp", () => {
    const entry = makeShortTermEntry({
      goal_id: "goal-active",
      data_type: "observation",
      timestamp: makeTimestamp(10), // 10 hours ago > 5 hours
    });
    expect(classifyTier(entry, active, completed)).toBe("recall");
  });

  it("returns recall for active goal + task type (not core-eligible data type)", () => {
    const entry = makeShortTermEntry({
      goal_id: "goal-active",
      data_type: "task",
      timestamp: makeTimestamp(1),
    });
    expect(classifyTier(entry, active, completed)).toBe("recall");
  });

  it("returns recall for active goal + experience_log type", () => {
    const entry = makeShortTermEntry({
      goal_id: "goal-active",
      data_type: "experience_log",
      timestamp: makeTimestamp(1),
    });
    expect(classifyTier(entry, active, completed)).toBe("recall");
  });

  it("returns archival for completed goal", () => {
    const entry = makeShortTermEntry({
      goal_id: "goal-done",
      data_type: "observation",
      timestamp: makeTimestamp(1),
    });
    expect(classifyTier(entry, active, completed)).toBe("archival");
  });

  it("returns archival for unknown goal (not in active or completed)", () => {
    const entry = makeShortTermEntry({
      goal_id: "goal-unknown",
      data_type: "observation",
      timestamp: makeTimestamp(1),
    });
    expect(classifyTier(entry, active, completed)).toBe("archival");
  });
});

describe("classifyTier — MemoryIndexEntry", () => {
  const active = ["goal-active"];
  const completed = ["goal-done"];

  it("returns core for active goal + recently accessed (within 5h)", () => {
    const entry = makeIndexEntry({
      goal_id: "goal-active",
      last_accessed: makeTimestamp(2),
    });
    expect(classifyTier(entry, active, completed)).toBe("core");
  });

  it("returns core for active goal + 'recent' tag (even if old last_accessed)", () => {
    const entry = makeIndexEntry({
      goal_id: "goal-active",
      last_accessed: makeTimestamp(20),
      tags: ["recent"],
    });
    expect(classifyTier(entry, active, completed)).toBe("core");
  });

  it("returns recall for active goal + old last_accessed (> 5h)", () => {
    const entry = makeIndexEntry({
      goal_id: "goal-active",
      last_accessed: makeTimestamp(10),
    });
    expect(classifyTier(entry, active, completed)).toBe("recall");
  });

  it("returns archival for completed goal", () => {
    const entry = makeIndexEntry({
      goal_id: "goal-done",
      last_accessed: makeTimestamp(1),
    });
    expect(classifyTier(entry, active, completed)).toBe("archival");
  });

  it("returns archival for unknown goal", () => {
    const entry = makeIndexEntry({
      goal_id: "goal-mystery",
      last_accessed: makeTimestamp(1),
    });
    expect(classifyTier(entry, active, completed)).toBe("archival");
  });
});

// ─── sortByTier ───

describe("sortByTier", () => {
  it("sorts core → recall → archival", () => {
    const entries: MemoryIndexEntry[] = [
      makeIndexEntry({ id: "a", memory_tier: "archival" }),
      makeIndexEntry({ id: "b", memory_tier: "recall" }),
      makeIndexEntry({ id: "c", memory_tier: "core" }),
    ];
    const sorted = sortByTier(entries);
    expect(sorted.map((e) => e.memory_tier)).toEqual(["core", "recall", "archival"]);
  });

  it("preserves original order within the same tier (stable)", () => {
    const entries: MemoryIndexEntry[] = [
      makeIndexEntry({ id: "r1", memory_tier: "recall" }),
      makeIndexEntry({ id: "r2", memory_tier: "recall" }),
      makeIndexEntry({ id: "r3", memory_tier: "recall" }),
    ];
    const sorted = sortByTier(entries);
    expect(sorted.map((e) => e.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("handles mix of tiers while preserving intra-tier order", () => {
    const entries: MemoryIndexEntry[] = [
      makeIndexEntry({ id: "a1", memory_tier: "archival" }),
      makeIndexEntry({ id: "c1", memory_tier: "core" }),
      makeIndexEntry({ id: "r1", memory_tier: "recall" }),
      makeIndexEntry({ id: "a2", memory_tier: "archival" }),
      makeIndexEntry({ id: "c2", memory_tier: "core" }),
    ];
    const sorted = sortByTier(entries);
    const ids = sorted.map((e) => e.id);
    // core first (c1 before c2 per original order), recall next, archival last (a1 before a2)
    expect(ids).toEqual(["c1", "c2", "r1", "a1", "a2"]);
  });

  it("handles empty array", () => {
    expect(sortByTier([])).toEqual([]);
  });

  it("handles all same tier", () => {
    const entries: MemoryIndexEntry[] = [
      makeIndexEntry({ id: "x1", memory_tier: "recall" }),
      makeIndexEntry({ id: "x2", memory_tier: "recall" }),
    ];
    const sorted = sortByTier(entries);
    expect(sorted.map((e) => e.id)).toEqual(["x1", "x2"]);
  });
});

// ─── filterByTierBudget ───

describe("filterByTierBudget", () => {
  function makeTieredEntries(): MemoryIndexEntry[] {
    return [
      makeIndexEntry({ id: "c1", memory_tier: "core" }),
      makeIndexEntry({ id: "c2", memory_tier: "core" }),
      makeIndexEntry({ id: "c3", memory_tier: "core" }),
      makeIndexEntry({ id: "r1", memory_tier: "recall" }),
      makeIndexEntry({ id: "r2", memory_tier: "recall" }),
      makeIndexEntry({ id: "r3", memory_tier: "recall" }),
      makeIndexEntry({ id: "a1", memory_tier: "archival" }),
      makeIndexEntry({ id: "a2", memory_tier: "archival" }),
    ];
  }

  it("respects per-tier limits (fractions of total)", () => {
    const entries = makeTieredEntries(); // 8 total: 3c, 3r, 2a
    // budget: core=0.25 → 2, recall=0.5 → 4, archival=0.25 → 2
    // But only 3 core exist → takes 2; only 3 recall exist → up to 4; 2 archival → 2
    const result = filterByTierBudget(entries, { core: 0.25, recall: 0.5, archival: 0.25 });
    const tierCounts = {
      core: result.filter((e) => e.memory_tier === "core").length,
      recall: result.filter((e) => e.memory_tier === "recall").length,
      archival: result.filter((e) => e.memory_tier === "archival").length,
    };
    expect(tierCounts.core).toBeLessThanOrEqual(Math.round(0.25 * 8));
    expect(tierCounts.recall).toBeLessThanOrEqual(Math.round(0.5 * 8));
    expect(tierCounts.archival).toBeLessThanOrEqual(Math.round(0.25 * 8));
  });

  it("core entries appear before recall and archival in result", () => {
    const entries = makeTieredEntries();
    const result = filterByTierBudget(entries, { core: 0.5, recall: 0.375, archival: 0.125 });
    // Find first non-core entry
    const firstNonCoreIdx = result.findIndex((e) => e.memory_tier !== "core");
    if (firstNonCoreIdx >= 0) {
      // All entries before that index should be core
      const beforeNonCore = result.slice(0, firstNonCoreIdx);
      expect(beforeNonCore.every((e) => e.memory_tier === "core")).toBe(true);
    }
  });

  it("budget of 0 for a tier excludes that tier entirely", () => {
    const entries = makeTieredEntries();
    // archival budget = 0 → no archival entries
    const result = filterByTierBudget(entries, { core: 0.5, recall: 0.5, archival: 0 });
    expect(result.filter((e) => e.memory_tier === "archival")).toHaveLength(0);
  });

  it("handles empty entries array", () => {
    expect(filterByTierBudget([], { core: 0.5, recall: 0.4, archival: 0.1 })).toEqual([]);
  });

  it("handles all-core entries with full core budget", () => {
    const entries = [
      makeIndexEntry({ id: "c1", memory_tier: "core" }),
      makeIndexEntry({ id: "c2", memory_tier: "core" }),
    ];
    const result = filterByTierBudget(entries, { core: 1, recall: 0, archival: 0 });
    expect(result.map((e) => e.id)).toEqual(["c1", "c2"]);
  });
});

// ─── Sub-stage 2.1: core→recall demotion ───

describe("classifyTier — satisfiedDimensions demotion (2.1)", () => {
  const active = ["goal-active"];
  const completed: string[] = [];

  it("demotes core→recall when ALL dimensions are satisfied", () => {
    const entry = makeIndexEntry({
      goal_id: "goal-active",
      dimensions: ["dim-a", "dim-b"],
      last_accessed: makeTimestamp(1), // recent → would be core
      tags: [],
    });
    // Both dim-a and dim-b satisfied → demote to recall
    expect(classifyTier(entry, active, completed, ["dim-a", "dim-b"])).toBe("recall");
  });

  it("stays core when only SOME dimensions are satisfied", () => {
    const entry = makeIndexEntry({
      goal_id: "goal-active",
      dimensions: ["dim-a", "dim-b"],
      last_accessed: makeTimestamp(1),
      tags: [],
    });
    // Only dim-a satisfied, dim-b is not → stays core
    expect(classifyTier(entry, active, completed, ["dim-a"])).toBe("core");
  });

  it("no demotion when satisfiedDimensions is empty", () => {
    const entry = makeIndexEntry({
      goal_id: "goal-active",
      dimensions: ["dim-a"],
      last_accessed: makeTimestamp(1),
      tags: [],
    });
    expect(classifyTier(entry, active, completed, [])).toBe("core");
  });

  it("no demotion when satisfiedDimensions is undefined", () => {
    const entry = makeIndexEntry({
      goal_id: "goal-active",
      dimensions: ["dim-a"],
      last_accessed: makeTimestamp(1),
      tags: [],
    });
    expect(classifyTier(entry, active, completed, undefined)).toBe("core");
  });
});

// ─── Sub-stage 2.2: recall→core promotion ───

describe("classifyTier — highDissatisfactionDimensions promotion (2.2)", () => {
  const active = ["goal-active"];
  const completed: string[] = [];

  it("promotes recall→core when ANY dimension has high dissatisfaction", () => {
    const entry = makeIndexEntry({
      goal_id: "goal-active",
      dimensions: ["dim-a", "dim-b"],
      last_accessed: makeTimestamp(10), // old → would be recall
      tags: [],
    });
    // dim-a is highly dissatisfied → promote to core
    expect(classifyTier(entry, active, completed, undefined, ["dim-a"])).toBe("core");
  });

  it("stays recall when no dimension has high dissatisfaction", () => {
    const entry = makeIndexEntry({
      goal_id: "goal-active",
      dimensions: ["dim-a"],
      last_accessed: makeTimestamp(10),
      tags: [],
    });
    // dim-b not in entry dimensions → no promotion
    expect(classifyTier(entry, active, completed, undefined, ["dim-b"])).toBe("recall");
  });

  it("stays recall when highDissatisfactionDimensions is empty", () => {
    const entry = makeIndexEntry({
      goal_id: "goal-active",
      dimensions: ["dim-a"],
      last_accessed: makeTimestamp(10),
      tags: [],
    });
    expect(classifyTier(entry, active, completed, undefined, [])).toBe("recall");
  });
});

// ─── Sub-stage 2.3: computeDynamicBudget ───

describe("computeDynamicBudget (2.3)", () => {
  it("returns high-core budget when dissatisfaction > 0.7", () => {
    const budget = computeDynamicBudget(0.8);
    expect(budget).toEqual({ core: 0.70, recall: 0.25, archival: 0.05 });
  });

  it("returns mid-core budget when dissatisfaction in (0.4, 0.7]", () => {
    const budget = computeDynamicBudget(0.5);
    expect(budget).toEqual({ core: 0.60, recall: 0.30, archival: 0.10 });
  });

  it("returns default budget when dissatisfaction <= 0.4", () => {
    const budget = computeDynamicBudget(0.2);
    expect(budget).toEqual({ core: 0.50, recall: 0.35, archival: 0.15 });
  });

  it("boundary: dissatisfaction exactly 0.7 → mid-core bucket (not high)", () => {
    // 0.7 is NOT > 0.7, so falls to mid check: 0.7 > 0.4 → mid
    const budget = computeDynamicBudget(0.7);
    expect(budget).toEqual({ core: 0.60, recall: 0.30, archival: 0.10 });
  });

  it("boundary: dissatisfaction exactly 0.4 → default bucket", () => {
    // 0.4 is NOT > 0.4
    const budget = computeDynamicBudget(0.4);
    expect(budget).toEqual({ core: 0.50, recall: 0.35, archival: 0.15 });
  });
});

// ─── Sub-stage 2.5: llmClassifyTier ───

describe("llmClassifyTier (2.5)", () => {
  function makeEntries(count: number): MemoryIndexEntry[] {
    return Array.from({ length: count }, (_, i) =>
      makeIndexEntry({
        id: `idx-${i}`,
        entry_id: `entry-${i}`,
        goal_id: "goal-active",
        dimensions: ["dim-a"],
      })
    );
  }

  it("returns empty map for empty entries", async () => {
    const llmClient = { generateStructured: vi.fn() };
    const result = await llmClassifyTier([], { goalId: "goal-1", dimensions: [] }, llmClient);
    expect(result.size).toBe(0);
    expect(llmClient.generateStructured).not.toHaveBeenCalled();
  });

  it("returns LLM-classified tiers on success", async () => {
    const entries = makeEntries(2);
    const llmClient = {
      generateStructured: vi.fn().mockResolvedValue({
        classifications: [
          { entry_id: "entry-0", tier: "core" },
          { entry_id: "entry-1", tier: "archival" },
        ],
      }),
    };
    const result = await llmClassifyTier(entries, { goalId: "goal-active", dimensions: ["dim-a"] }, llmClient);
    expect(result.get("entry-0")).toBe("core");
    expect(result.get("entry-1")).toBe("archival");
  });

  it("sanitizes out-of-enum tier values to archival", async () => {
    const entries = makeEntries(1);
    const llmClient = {
      generateStructured: vi.fn().mockResolvedValue({
        classifications: [{ entry_id: "entry-0", tier: "unknown-tier" }],
      }),
    };
    const result = await llmClassifyTier(entries, { goalId: "goal-active", dimensions: [] }, llmClient);
    expect(result.get("entry-0")).toBe("archival");
  });

  it("falls back to rule-based on parse error", async () => {
    const entries = makeEntries(1);
    // Return malformed response that fails Zod parse
    const llmClient = {
      generateStructured: vi.fn().mockResolvedValue({ invalid: true }),
    };
    const result = await llmClassifyTier(entries, { goalId: "goal-active", dimensions: [] }, llmClient);
    // Fallback returns a map with rule-based tier for entry
    expect(result.size).toBe(1);
    expect(["core", "recall", "archival"]).toContain(result.get("entry-0"));
  });

  it("falls back to rule-based on LLM error/timeout", async () => {
    const entries = makeEntries(1);
    const llmClient = {
      generateStructured: vi.fn().mockRejectedValue(new Error("timeout")),
    };
    const result = await llmClassifyTier(entries, { goalId: "goal-active", dimensions: [] }, llmClient);
    expect(result.size).toBe(1);
    expect(["core", "recall", "archival"]).toContain(result.get("entry-0"));
  });
});
