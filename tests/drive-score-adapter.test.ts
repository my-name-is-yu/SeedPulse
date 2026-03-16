import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DriveScoreAdapter, MemoryLifecycleManager } from "../src/memory-lifecycle.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";

// ─── Helpers ───

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-dsa-test-"));
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════
// DriveScoreAdapter unit tests
// ═══════════════════════════════════════════════════════

describe("DriveScoreAdapter", () => {
  it("update() stores dissatisfaction scores by dimension name", () => {
    const adapter = new DriveScoreAdapter();
    adapter.update([
      { dimension_name: "code_quality", dissatisfaction: 0.8 },
      { dimension_name: "test_coverage", dissatisfaction: 0.3 },
    ]);
    expect(adapter.getDissatisfactionScore("code_quality")).toBe(0.8);
    expect(adapter.getDissatisfactionScore("test_coverage")).toBe(0.3);
  });

  it("getDissatisfactionScore() returns stored score for a known dimension", () => {
    const adapter = new DriveScoreAdapter();
    adapter.update([{ dimension_name: "perf", dissatisfaction: 0.55 }]);
    expect(adapter.getDissatisfactionScore("perf")).toBe(0.55);
  });

  it("getDissatisfactionScore() returns 0 for an unknown dimension", () => {
    const adapter = new DriveScoreAdapter();
    adapter.update([{ dimension_name: "known", dissatisfaction: 0.9 }]);
    expect(adapter.getDissatisfactionScore("unknown_dim")).toBe(0);
  });

  it("getDissatisfactionScore() returns 0 before any update()", () => {
    const adapter = new DriveScoreAdapter();
    expect(adapter.getDissatisfactionScore("anything")).toBe(0);
  });

  it("multiple update() calls replace previous scores entirely", () => {
    const adapter = new DriveScoreAdapter();
    adapter.update([
      { dimension_name: "dim_a", dissatisfaction: 0.9 },
      { dimension_name: "dim_b", dissatisfaction: 0.5 },
    ]);
    // Second update: dim_a replaced, dim_b removed
    adapter.update([
      { dimension_name: "dim_a", dissatisfaction: 0.2 },
      { dimension_name: "dim_c", dissatisfaction: 0.7 },
    ]);
    expect(adapter.getDissatisfactionScore("dim_a")).toBe(0.2);
    expect(adapter.getDissatisfactionScore("dim_b")).toBe(0);  // was cleared
    expect(adapter.getDissatisfactionScore("dim_c")).toBe(0.7);
  });

  it("update() with empty array clears all scores", () => {
    const adapter = new DriveScoreAdapter();
    adapter.update([{ dimension_name: "dim_x", dissatisfaction: 0.6 }]);
    adapter.update([]);
    expect(adapter.getDissatisfactionScore("dim_x")).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════
// Integration: MemoryLifecycleManager uses DriveScoreAdapter
// ═══════════════════════════════════════════════════════

describe("MemoryLifecycleManager + DriveScoreAdapter integration", () => {
  it("compressionDelay() uses DriveScoreAdapter dissatisfaction > 0.7 → 2x retention", () => {
    const adapter = new DriveScoreAdapter();
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient([]),
      undefined,
      undefined,
      undefined,
      adapter
    );
    mgr.initializeDirectories();

    // Set high dissatisfaction for the dimension
    adapter.update([{ dimension_name: "reliability", dissatisfaction: 0.9 }]);

    const baseDelay = mgr.compressionDelay("goal-1", "other-dim");  // no drive score → base
    const boostedDelay = mgr.compressionDelay("goal-1", "reliability");  // 0.9 > 0.7 → 2x

    expect(boostedDelay).toBe(baseDelay * 2.0);
  });

  it("compressionDelay() uses DriveScoreAdapter dissatisfaction in (0.4, 0.7] → 1.5x retention", () => {
    const adapter = new DriveScoreAdapter();
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient([]),
      undefined,
      undefined,
      undefined,
      adapter
    );
    mgr.initializeDirectories();

    adapter.update([{ dimension_name: "latency", dissatisfaction: 0.6 }]);

    const baseDelay = mgr.compressionDelay("goal-2", "other-dim");
    const boostedDelay = mgr.compressionDelay("goal-2", "latency");

    expect(boostedDelay).toBe(baseDelay * 1.5);
  });

  it("compressionDelay() reflects updated adapter values after a second update()", () => {
    const adapter = new DriveScoreAdapter();
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient([]),
      undefined,
      undefined,
      undefined,
      adapter
    );
    mgr.initializeDirectories();

    // First update: low dissatisfaction → base retention
    adapter.update([{ dimension_name: "coverage", dissatisfaction: 0.2 }]);
    const baseDelay = mgr.compressionDelay("goal-3", "coverage");

    // Second update: high dissatisfaction → 2x retention
    adapter.update([{ dimension_name: "coverage", dissatisfaction: 0.85 }]);
    const boostedDelay = mgr.compressionDelay("goal-3", "coverage");

    expect(boostedDelay).toBe(baseDelay * 2.0);
  });

  it("getCompressionDelay() returns delay factors based on dissatisfaction thresholds", () => {
    const adapter = new DriveScoreAdapter();
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient([]),
      undefined,
      undefined,
      undefined,
      adapter
    );

    const delayMap = mgr.getCompressionDelay([
      { dimension: "high_urgency", dissatisfaction: 0.85 },
      { dimension: "low_urgency", dissatisfaction: 0.3 },
    ]);

    // High dissatisfaction (> 0.7): delay_factor = min(2.0, 1 + 0.85) = 1.85
    expect(delayMap.get("high_urgency")).toBeCloseTo(1.85);
    // Low dissatisfaction (<= 0.7): delay_factor = 1.0
    expect(delayMap.get("low_urgency")).toBe(1.0);
  });
});
