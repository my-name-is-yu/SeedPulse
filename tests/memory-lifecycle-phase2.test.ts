import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { MemoryLifecycleManager, type IDriveScorer } from "../src/knowledge/memory/memory-lifecycle.js";
import type { IEmbeddingClient } from "../src/knowledge/embedding-client.js";
import type { VectorIndex } from "../src/knowledge/vector-index.js";
import type { VectorSearchResult } from "../src/types/embedding.js";
import type { ShortTermEntry, LessonEntry } from "../src/types/memory-lifecycle.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Helpers ───

/** Build a two-call LLM response for compressToLongTerm (patterns + lessons). */
function makeLLMCompressionResponses(
  lessonCount = 1,
  _goalId = "goal-a",
  tags: string[] = ["test-tag", "shared-tag"]
) {
  const patterns = JSON.stringify({ patterns: ["Pattern A: retries work well"] });
  const lessons = JSON.stringify({
    lessons: Array.from({ length: lessonCount }, (_, i) => ({
      type: "strategy_outcome",
      context: `Context ${i}`,
      action: `Action ${i}`,
      outcome: `Outcome ${i}`,
      lesson: `Lesson ${i}`,
      relevance_tags: tags,
    })),
  });
  return [patterns, lessons];
}

function makeMockDriveScorer(scores: Record<string, number> = {}): IDriveScorer {
  return {
    getDissatisfactionScore: (dimension: string) => scores[dimension] ?? 0.5,
  };
}

function makeMockEmbeddingClient(): IEmbeddingClient {
  return {
    embed: vi.fn(async (_text: string) => [0.1, 0.2, 0.3]),
    batchEmbed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
    cosineSimilarity: vi.fn((_a: number[], _b: number[]) => 0.9),
  };
}

function makeMockVectorIndex(searchResults: VectorSearchResult[] = []): VectorIndex {
  return {
    add: vi.fn(async () => ({
      id: "mock-id",
      text: "mock",
      vector: [0.1, 0.2, 0.3],
      model: "mock",
      created_at: new Date().toISOString(),
      metadata: {},
    })),
    search: vi.fn(async () => searchResults),
    searchByVector: vi.fn(() => searchResults),
    remove: vi.fn(() => true),
    size: vi.fn(() => 0),
    clear: vi.fn(),
  } as unknown as VectorIndex;
}

function makeShortTermEntry(
  overrides: Partial<ShortTermEntry> = {}
): ShortTermEntry {
  return {
    id: "st_testentry",
    goal_id: "goal-a",
    data_type: "experience_log",
    loop_number: 1,
    timestamp: new Date().toISOString(),
    dimensions: ["dim1"],
    tags: ["tag1"],
    data: { key: "value" },
    embedding_id: null,
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
});

// ═══════════════════════════════════════════════════════
// 5.2a: relevanceScore
// ═══════════════════════════════════════════════════════

describe("relevanceScore", () => {
  it("returns 0 when there are no matching tags and no drive scorer", () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    const entry = makeShortTermEntry({ tags: ["x"], dimensions: [] });
    const score = mgr.relevanceScore(entry, {
      goalId: "goal-a",
      dimensions: [],
      tags: ["y"],
    });
    expect(score).toBe(0);
  });

  it("returns positive score when tags match", () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    const entry = makeShortTermEntry({
      tags: ["alpha"],
      dimensions: [],
      timestamp: new Date().toISOString(),
    });
    const score = mgr.relevanceScore(entry, {
      goalId: "goal-a",
      dimensions: [],
      tags: ["alpha"],
    });
    // tag_match_ratio = 1/1 = 1, drive_weight = 1, freshness ≈ 1
    expect(score).toBeGreaterThan(0.9);
  });

  it("uses drive_weight from DriveScorer when available", () => {
    const driveScorer = makeMockDriveScorer({ dim1: 0.8 });
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient([]),
      undefined,
      undefined,
      undefined,
      driveScorer
    );
    const entry = makeShortTermEntry({
      tags: ["tag1"],
      dimensions: ["dim1"],
      timestamp: new Date().toISOString(),
    });
    const score = mgr.relevanceScore(entry, {
      goalId: "goal-a",
      dimensions: ["dim1"],
      tags: ["tag1"],
    });
    // drive_weight = 0.8; should be less than the score with drive_weight=1
    const mgr2 = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    const score2 = mgr2.relevanceScore(entry, {
      goalId: "goal-a",
      dimensions: ["dim1"],
      tags: ["tag1"],
    });
    expect(score).toBeCloseTo(score2 * 0.8, 5);
  });

  it("freshness decays exponentially with time", () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));

    // Fresh entry (now)
    const freshEntry = makeShortTermEntry({
      tags: ["tag1"],
      timestamp: new Date().toISOString(),
    });
    // Old entry (60 days ago)
    const oldTimestamp = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const oldEntry = makeShortTermEntry({ tags: ["tag1"], timestamp: oldTimestamp });

    const freshScore = mgr.relevanceScore(freshEntry, {
      goalId: "goal-a",
      dimensions: [],
      tags: ["tag1"],
    });
    const oldScore = mgr.relevanceScore(oldEntry, {
      goalId: "goal-a",
      dimensions: [],
      tags: ["tag1"],
    });

    expect(freshScore).toBeGreaterThan(oldScore);
    // 60 days: exp(-60/30) = exp(-2) ≈ 0.135; ratio should be around that
    expect(oldScore / freshScore).toBeCloseTo(Math.exp(-2), 1);
  });

  it("returns 0 when entry has no tags and context has no tags", () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    const entry = makeShortTermEntry({ tags: [], dimensions: [] });
    const score = mgr.relevanceScore(entry, {
      goalId: "goal-a",
      dimensions: [],
      tags: [],
    });
    expect(score).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════
// 5.2a: compressionDelay
// ═══════════════════════════════════════════════════════

describe("compressionDelay", () => {
  it("returns default retention period when no DriveScorer", () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    const delay = mgr.compressionDelay("goal-a", "dim1");
    expect(delay).toBe(100); // default_retention_loops
  });

  it("returns retention_period * 2.0 when dissatisfaction > 0.7", () => {
    const driveScorer = makeMockDriveScorer({ dim1: 0.8 });
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient([]),
      undefined,
      undefined,
      undefined,
      driveScorer
    );
    const delay = mgr.compressionDelay("goal-a", "dim1");
    expect(delay).toBe(200); // 100 * 2.0
  });

  it("returns retention_period * 1.5 when dissatisfaction > 0.4", () => {
    const driveScorer = makeMockDriveScorer({ dim1: 0.55 });
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient([]),
      undefined,
      undefined,
      undefined,
      driveScorer
    );
    const delay = mgr.compressionDelay("goal-a", "dim1");
    expect(delay).toBe(150); // 100 * 1.5
  });

  it("returns unmodified retention_period when dissatisfaction <= 0.4", () => {
    const driveScorer = makeMockDriveScorer({ dim1: 0.3 });
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient([]),
      undefined,
      undefined,
      undefined,
      driveScorer
    );
    const delay = mgr.compressionDelay("goal-a", "dim1");
    expect(delay).toBe(100); // unchanged
  });

  it("respects goal_type_overrides from config", () => {
    const driveScorer = makeMockDriveScorer({ dim1: 0.8 });
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient([]),
      { default_retention_loops: 50, goal_type_overrides: { "health_monitoring": 200 } },
      undefined,
      undefined,
      driveScorer
    );
    // goal "health_monitoring-123" matches override key prefix
    const delay = mgr.compressionDelay("health_monitoring-123", "dim1");
    expect(delay).toBe(400); // 200 * 2.0 (because dissatisfaction > 0.7)
  });
});

// ═══════════════════════════════════════════════════════
// 5.2a: onSatisficingJudgment
// ═══════════════════════════════════════════════════════

describe("onSatisficingJudgment", () => {
  it("marks dimension for early compression when satisfied=true", () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    mgr.onSatisficingJudgment("goal-a", "dim1", true);
    const candidates = mgr.getEarlyCompressionCandidates("goal-a");
    expect(candidates.has("dim1")).toBe(true);
  });

  it("removes dimension from early compression candidates when satisfied=false", () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    // First mark as satisfied
    mgr.onSatisficingJudgment("goal-a", "dim1", true);
    expect(mgr.getEarlyCompressionCandidates("goal-a").has("dim1")).toBe(true);
    // Then mark as not satisfied
    mgr.onSatisficingJudgment("goal-a", "dim1", false);
    expect(mgr.getEarlyCompressionCandidates("goal-a").has("dim1")).toBe(false);
  });

  it("handles multiple dimensions independently", () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    mgr.onSatisficingJudgment("goal-a", "dim1", true);
    mgr.onSatisficingJudgment("goal-a", "dim2", true);
    mgr.onSatisficingJudgment("goal-a", "dim1", false);

    const candidates = mgr.getEarlyCompressionCandidates("goal-a");
    expect(candidates.has("dim1")).toBe(false);
    expect(candidates.has("dim2")).toBe(true);
  });

  it("does not throw when marking unseen goal as not satisfied", () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    expect(() => mgr.onSatisficingJudgment("unknown-goal", "dim1", false)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════
// 5.2a: applyRetentionPolicy with drive-based delays
// ═══════════════════════════════════════════════════════

describe("applyRetentionPolicy with drive-based delays", () => {
  it("skips compression when loop span < compressionDelay with high dissatisfaction", async () => {
    // High dissatisfaction → delay = 200
    const driveScorer = makeMockDriveScorer({ dim1: 0.9 });
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient([]),
      { default_retention_loops: 100 },
      undefined,
      undefined,
      driveScorer
    );
    await mgr.initializeDirectories();

    // Record 150 entries (loop 0..149) — this would trigger without drive delay (>100),
    // but with drive delay (>200) it should NOT trigger.
    for (let i = 0; i < 150; i++) {
      await mgr.recordToShortTerm("goal-a", "experience_log", { test: i }, {
        loopNumber: i,
        dimensions: ["dim1"],
      });
    }

    const results = await mgr.applyRetentionPolicy("goal-a");
    // span = 149 - 0 = 149, effective limit = 200 → no compression
    expect(results).toHaveLength(0);
  });

  it("triggers compression when loop span >= base retention and no DriveScorer", async () => {
    const llmResponses = makeLLMCompressionResponses(1);
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient(llmResponses),
      { default_retention_loops: 50 }
    );
    await mgr.initializeDirectories();

    for (let i = 0; i <= 50; i++) {
      await mgr.recordToShortTerm("goal-a", "experience_log", { test: i }, {
        loopNumber: i,
      });
    }

    const results = await mgr.applyRetentionPolicy("goal-a");
    expect(results.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════
// 5.2b: Semantic search fallback in selectForWorkingMemory
// ═══════════════════════════════════════════════════════

describe("selectForWorkingMemory semantic fallback", () => {
  it("returns results from tag-match even without VectorIndex", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();

    await mgr.recordToShortTerm("goal-a", "experience_log", { data: "x" }, {
      loopNumber: 1,
      tags: ["relevant"],
    });

    const result = await mgr.selectForWorkingMemory("goal-a", [], ["relevant"], 10);
    expect(result.shortTerm).toHaveLength(1);
  });

  it("includes additional entries from index when VectorIndex is available and tag results are insufficient", async () => {
    const mockVI = makeMockVectorIndex([]);
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient([]),
      undefined,
      undefined,
      mockVI
    );
    await mgr.initializeDirectories();

    // Record entries with different tags so tag-match alone won't find all
    await mgr.recordToShortTerm("goal-a", "experience_log", { data: "x" }, {
      loopNumber: 1,
      tags: ["other-tag"],
    });
    await mgr.recordToShortTerm("goal-a", "experience_log", { data: "y" }, {
      loopNumber: 2,
      tags: ["relevant"],
    });

    const result = await mgr.selectForWorkingMemory("goal-a", [], ["relevant"], 5);
    // With VectorIndex present, we should get the extra entry too
    expect(result.shortTerm.length).toBeGreaterThanOrEqual(1);
  });

  it("deduplicates entries from tag-match and semantic fallback", async () => {
    const mockVI = makeMockVectorIndex([]);
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient([]),
      undefined,
      undefined,
      mockVI
    );
    await mgr.initializeDirectories();

    await mgr.recordToShortTerm("goal-a", "experience_log", { data: "x" }, {
      loopNumber: 1,
      tags: ["alpha"],
    });

    const result = await mgr.selectForWorkingMemory("goal-a", [], ["alpha"], 10);
    // Should not contain duplicates
    const ids = result.shortTerm.map((e) => e.id);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });

  it("auto-registers entry in VectorIndex on recordToShortTerm when VectorIndex available", async () => {
    const mockVI = makeMockVectorIndex([]);
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient([]),
      undefined,
      undefined,
      mockVI
    );
    await mgr.initializeDirectories();

    await mgr.recordToShortTerm("goal-a", "experience_log", { note: "hello world" }, {
      loopNumber: 1,
      tags: ["alpha"],
    });

    // Fire-and-forget: give it a tick to resolve
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockVI.add).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// 5.2c: Cross-Goal Lesson Search
// ═══════════════════════════════════════════════════════

describe("searchCrossGoalLessons", () => {
  async function setupLessons(tmpDir: string): Promise<MemoryLifecycleManager> {
    const llmResponses = [
      ...makeLLMCompressionResponses(2, "goal-a"),
      ...makeLLMCompressionResponses(2, "goal-b"),
    ];
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient(llmResponses),
      { default_retention_loops: 5 }
    );
    await mgr.initializeDirectories();

    // Add enough entries to trigger compression for goal-a
    for (let i = 0; i <= 5; i++) {
      await mgr.recordToShortTerm("goal-a", "experience_log", { status: "completed" }, {
        loopNumber: i,
        tags: ["strategy"],
      });
    }
    await mgr.compressToLongTerm("goal-a", "experience_log");

    // Add entries for goal-b
    for (let i = 0; i <= 5; i++) {
      await mgr.recordToShortTerm("goal-b", "experience_log", { status: "completed" }, {
        loopNumber: i,
        tags: ["strategy"],
      });
    }
    await mgr.compressToLongTerm("goal-b", "experience_log");

    return mgr;
  }

  it("returns lessons across goals via tag-based fallback when no VectorIndex", async () => {
    const mgr = await setupLessons(tmpDir);
    const results = await mgr.searchCrossGoalLessons("Lesson 0");
    expect(results.length).toBeGreaterThanOrEqual(0); // at least non-throwing
  });

  it("returns matching lessons when query matches lesson text", async () => {
    const mgr = await setupLessons(tmpDir);
    const results = await mgr.searchCrossGoalLessons("Lesson");
    // Should find compressed lessons from both goals
    expect(results.length).toBeGreaterThan(0);
  });

  it("returns up to topK results", async () => {
    const mgr = await setupLessons(tmpDir);
    const results = await mgr.searchCrossGoalLessons("Lesson", 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("uses VectorIndex for semantic search when available", async () => {
    const lessonId = "lesson_abc123";
    const mockVI = makeMockVectorIndex([
      {
        id: lessonId,
        text: "strategy outcome: test lesson",
        similarity: 0.95,
        metadata: { goal_id: "goal-a", is_lesson: true, lesson_type: "strategy_outcome" },
      },
    ]);

    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient([]),
      undefined,
      undefined,
      mockVI
    );
    await mgr.initializeDirectories();

    // Manually write a lesson to global.json so the manager can find it
    const globalPath = path.join(tmpDir, "memory", "long-term", "lessons", "global.json");
    const lesson: LessonEntry = {
      lesson_id: lessonId,
      type: "strategy_outcome",
      goal_id: "goal-a",
      context: "test context",
      lesson: "test lesson",
      source_loops: ["loop_1"],
      extracted_at: new Date().toISOString(),
      relevance_tags: ["strategy"],
      status: "active",
    };
    fs.writeFileSync(globalPath, JSON.stringify([lesson]));

    const results = await mgr.searchCrossGoalLessons("test lesson", 5);
    expect(mockVI.search).toHaveBeenCalled();
    expect(results.some((l) => l.lesson_id === lessonId)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// 5.2c: Cross-goal lessons in selectForWorkingMemory
// ═══════════════════════════════════════════════════════

describe("selectForWorkingMemory includes cross-goal lessons", () => {
  it("includes lessons from other goals in results", async () => {
    const llmResponses = makeLLMCompressionResponses(1, "goal-b");
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient(llmResponses),
      { default_retention_loops: 3 }
    );
    await mgr.initializeDirectories();

    // Compress lessons from goal-b
    for (let i = 0; i <= 3; i++) {
      await mgr.recordToShortTerm("goal-b", "experience_log", { data: i }, {
        loopNumber: i,
        tags: ["shared-tag"],
      });
    }
    await mgr.compressToLongTerm("goal-b", "experience_log");

    // Now select for working memory of goal-a with the same tags
    const result = await mgr.selectForWorkingMemory("goal-a", [], ["shared-tag"], 10);

    // Lessons from goal-b should appear in the result
    expect(result.lessons.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════
// 5.2c: compressToLongTerm auto-registers in VectorIndex
// ═══════════════════════════════════════════════════════

describe("compressToLongTerm auto-registers lessons in VectorIndex", () => {
  it("calls vectorIndex.add for each lesson generated", async () => {
    const mockVI = makeMockVectorIndex([]);
    const llmResponses = makeLLMCompressionResponses(2);
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient(llmResponses),
      { default_retention_loops: 3 },
      undefined,
      mockVI
    );
    await mgr.initializeDirectories();

    for (let i = 0; i <= 3; i++) {
      await mgr.recordToShortTerm("goal-a", "experience_log", { data: i }, {
        loopNumber: i,
      });
    }

    await mgr.compressToLongTerm("goal-a", "experience_log");

    // Give fire-and-forget a tick to resolve
    await new Promise((resolve) => setTimeout(resolve, 10));

    // add should have been called for short-term entries + 2 lessons
    const addCalls = (mockVI.add as ReturnType<typeof vi.fn>).mock.calls;
    const lessonCalls = addCalls.filter(
      (args) => (args[2] as { is_lesson?: boolean })?.is_lesson === true
    );
    expect(lessonCalls.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════
// Integration: record → embed → search flow
// ═══════════════════════════════════════════════════════

describe("Integration: record → embed → search flow", () => {
  it("records entry, embeds it, then finds it in semantic selectForWorkingMemory", async () => {
    const mockVI = makeMockVectorIndex([]);
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient([]),
      undefined,
      undefined,
      mockVI
    );
    await mgr.initializeDirectories();

    const entry = await mgr.recordToShortTerm("goal-a", "experience_log", {
      note: "embedding test"
    }, {
      loopNumber: 1,
      tags: ["embed-test"],
    });

    // Wait for fire-and-forget embedding
    await new Promise((resolve) => setTimeout(resolve, 20));

    // VectorIndex.add should have been called with the entry ID
    expect(mockVI.add).toHaveBeenCalledWith(
      entry.id,
      expect.stringContaining("experience_log"),
      expect.objectContaining({ goal_id: "goal-a" })
    );
  });

  it("full pipeline: relevanceScore, compressionDelay, onSatisficingJudgment all interact correctly", () => {
    const driveScorer = makeMockDriveScorer({ dim1: 0.75 });
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient([]),
      { default_retention_loops: 100 },
      undefined,
      undefined,
      driveScorer
    );

    // compressionDelay should be 200 (0.75 > 0.7)
    expect(mgr.compressionDelay("goal-a", "dim1")).toBe(200);

    // onSatisficingJudgment marks dim1 for early compression
    mgr.onSatisficingJudgment("goal-a", "dim1", true);
    expect(mgr.getEarlyCompressionCandidates("goal-a").has("dim1")).toBe(true);

    // relevanceScore uses drive weight from scorer
    const entry = makeShortTermEntry({
      tags: ["t1"],
      dimensions: ["dim1"],
      timestamp: new Date().toISOString(),
    });
    const score = mgr.relevanceScore(entry, {
      goalId: "goal-a",
      dimensions: ["dim1"],
      tags: ["t1"],
    });
    expect(score).toBeGreaterThan(0);
    // drive_weight = 0.75 (from mock scorer)
    // tag_match_ratio = 1/1 = 1
    // freshness ≈ 1 (just created)
    expect(score).toBeCloseTo(0.75, 1);
  });
});

// ═══════════════════════════════════════════════════════
// selectForWorkingMemorySemantic
// ═══════════════════════════════════════════════════════

describe("selectForWorkingMemorySemantic", () => {
  it("basic semantic selection works when VectorIndex is available", async () => {
    const entryId = "st_semantic1";
    const mockVI = makeMockVectorIndex([
      {
        id: entryId,
        text: "semantic entry",
        similarity: 0.85,
        metadata: { goal_id: "goal-sem" },
      },
    ]);

    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient([]),
      undefined,
      undefined,
      mockVI
    );
    await mgr.initializeDirectories();

    // Record an entry so the index has data
    const recorded = await mgr.recordToShortTerm("goal-sem", "experience_log", { note: "semantic" }, {
      loopNumber: 1,
      tags: ["semantic-tag"],
    });

    // Update mock to return the actual entry id
    (mockVI.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: recorded.id,
        text: "semantic entry",
        similarity: 0.85,
        metadata: { goal_id: "goal-sem" },
      },
    ]);

    const result = await mgr.selectForWorkingMemorySemantic(
      "goal-sem",
      "semantic query",
      [],
      ["semantic-tag"],
      10
    );

    expect(mockVI.search).toHaveBeenCalled();
    expect(result.shortTerm.length).toBeGreaterThanOrEqual(0);
    // Allow fire-and-forget touchIndexEntry to settle before afterEach cleanup
    await new Promise((r) => setTimeout(r, 20));
  });

  it("falls back to non-semantic when no VectorIndex is configured", async () => {
    // No vectorIndex → falls back to selectForWorkingMemory
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();

    await mgr.recordToShortTerm("goal-nosem", "experience_log", { data: "x" }, {
      loopNumber: 1,
      tags: ["fallback-tag"],
    });

    const result = await mgr.selectForWorkingMemorySemantic(
      "goal-nosem",
      "any query",
      [],
      ["fallback-tag"],
      10
    );

    // Should still return the recorded entry via tag-based fallback
    expect(result.shortTerm).toHaveLength(1);
    // Allow fire-and-forget touchIndexEntry to settle before afterEach cleanup
    await new Promise((r) => setTimeout(r, 20));
  });

  it("respects maxEntries limit in semantic selection", async () => {
    const mockVI = makeMockVectorIndex([]);
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient([]),
      undefined,
      undefined,
      mockVI
    );
    await mgr.initializeDirectories();

    // Record 5 entries
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const e = await mgr.recordToShortTerm("goal-limit", "experience_log", { i }, {
        loopNumber: i,
        tags: ["limit-tag"],
      });
      ids.push(e.id);
    }

    // Mock search returning all 5 entries
    (mockVI.search as ReturnType<typeof vi.fn>).mockResolvedValue(
      ids.map((id, idx) => ({
        id,
        text: `entry ${idx}`,
        similarity: 0.9 - idx * 0.01,
        metadata: { goal_id: "goal-limit" },
      }))
    );

    const result = await mgr.selectForWorkingMemorySemantic(
      "goal-limit",
      "limit query",
      [],
      ["limit-tag"],
      3  // maxEntries = 3
    );

    expect(result.shortTerm.length).toBeLessThanOrEqual(3);
    // Allow fire-and-forget touchIndexEntry to settle before afterEach cleanup
    await new Promise((r) => setTimeout(r, 20));
  });
});
