/**
 * Tests for Issue #476: required_tools field in StrategySchema and
 * tool-availability scoring in activateBestCandidate.
 *
 * Tests cover:
 * - Schema accepts required_tools field (default [])
 * - activateBestCandidate prefers candidates with available tools
 * - activateBestCandidate falls back to first candidate when no registry available
 * - setToolRegistry wires up scoring
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../../../base/state/state-manager.js";
import { StrategyManager } from "../strategy-manager.js";
import { StrategySchema } from "../types/strategy.js";
import { ToolRegistry } from "../../../tools/registry.js";
import type { ITool } from "../../../tools/types.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";

// ─── Helpers ───

function makeMockTool(name: string): ITool {
  return {
    metadata: {
      name,
      aliases: [],
      permissionLevel: "read_only",
      isReadOnly: true,
      isDestructive: false,
      shouldDefer: false,
      alwaysLoad: false,
      maxConcurrency: 0,
      maxOutputChars: 8000,
      tags: [],
    },
    inputSchema: { parse: (x: unknown) => x } as never,
    description: () => `Mock tool: ${name}`,
    execute: async () => ({ success: true, data: null, summary: "ok", durationMs: 1 }),
  } as unknown as ITool;
}

/** Build a JSON response string with optional required_tools */
function makeCandidateResponse(hypothesis: string, requiredTools: string[]): string {
  return `\`\`\`json
[
  {
    "hypothesis": "${hypothesis}",
    "expected_effect": [
      { "dimension": "test_coverage", "direction": "increase", "magnitude": "medium" }
    ],
    "resource_estimate": {
      "sessions": 3,
      "duration": { "value": 2, "unit": "days" },
      "llm_calls": null
    },
    "allocation": 0.8,
    "required_tools": ${JSON.stringify(requiredTools)}
  }
]
\`\`\``;
}

/** Build a JSON response with two candidates in one array */
function makeTwoCandidatesResponse(
  hyp1: string, tools1: string[],
  hyp2: string, tools2: string[],
): string {
  return `\`\`\`json
[
  {
    "hypothesis": "${hyp1}",
    "expected_effect": [
      { "dimension": "test_coverage", "direction": "increase", "magnitude": "medium" }
    ],
    "resource_estimate": {
      "sessions": 3,
      "duration": { "value": 2, "unit": "days" },
      "llm_calls": null
    },
    "allocation": 0.5,
    "required_tools": ${JSON.stringify(tools1)}
  },
  {
    "hypothesis": "${hyp2}",
    "expected_effect": [
      { "dimension": "test_coverage", "direction": "increase", "magnitude": "small" }
    ],
    "resource_estimate": {
      "sessions": 2,
      "duration": { "value": 1, "unit": "days" },
      "llm_calls": null
    },
    "allocation": 0.5,
    "required_tools": ${JSON.stringify(tools2)}
  }
]
\`\`\``;
}

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

// ─── Schema tests ───

describe("StrategySchema: required_tools field", () => {
  const baseStrategy = {
    id: "s-1",
    goal_id: "g-1",
    target_dimensions: ["coverage"],
    primary_dimension: "coverage",
    hypothesis: "Test hypothesis",
    expected_effect: [],
    resource_estimate: { sessions: 1, duration: { value: 1, unit: "days" }, llm_calls: null },
    state: "candidate",
    allocation: 0,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    gap_snapshot_at_start: null,
    tasks_generated: [],
    effectiveness_score: null,
    consecutive_stall_count: 0,
    source_template_id: null,
    cross_goal_context: null,
    rollback_target_id: null,
    max_pivot_count: 2,
    pivot_count: 0,
    toolset_locked: false,
    allowed_tools: [],
  };

  it("defaults required_tools to empty array when not provided", () => {
    const parsed = StrategySchema.parse(baseStrategy);
    expect(parsed.required_tools).toEqual([]);
  });

  it("accepts required_tools array of strings", () => {
    const parsed = StrategySchema.parse({ ...baseStrategy, required_tools: ["glob", "shell"] });
    expect(parsed.required_tools).toEqual(["glob", "shell"]);
  });

  it("accepts empty required_tools array explicitly", () => {
    const parsed = StrategySchema.parse({ ...baseStrategy, required_tools: [] });
    expect(parsed.required_tools).toEqual([]);
  });
});

// ─── activateBestCandidate without registry (fallback) ───

describe("activateBestCandidate: fallback when no registry", () => {
  it("picks first candidate when no toolRegistry is set", async () => {
    const response = makeTwoCandidatesResponse(
      "Strategy A", ["glob", "shell"],
      "Strategy B", [],
    );
    const mock = createMockLLMClient([response]);
    const manager = new StrategyManager(stateManager, mock);

    const candidates = await manager.generateCandidates("goal-1", "test_coverage", ["test_coverage"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    const activated = await manager.activateBestCandidate("goal-1");
    // Without registry, first candidate is always picked
    expect(activated.id).toBe(candidates[0]!.id);
    expect(activated.hypothesis).toBe("Strategy A");
  });
});

// ─── activateBestCandidate with registry ───

describe("activateBestCandidate: tool-availability scoring", () => {
  it("prefers candidate whose required_tools are all available", async () => {
    // Strategy A (first in list) needs "missing-tool" which is not registered
    // Strategy B needs only "glob" which is registered -> should win
    const response = makeTwoCandidatesResponse(
      "Strategy A - needs missing tool", ["missing-tool"],
      "Strategy B - all tools available", ["glob"],
    );
    const mock = createMockLLMClient([response]);
    const manager = new StrategyManager(stateManager, mock);

    const registry = new ToolRegistry();
    registry.register(makeMockTool("glob"));
    manager.setToolRegistry(registry);

    await manager.generateCandidates("goal-1", "test_coverage", ["test_coverage"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    const activated = await manager.activateBestCandidate("goal-1");
    expect(activated.hypothesis).toBe("Strategy B - all tools available");
  });

  it("falls back to first candidate when all have equal tool availability", async () => {
    const response = makeTwoCandidatesResponse(
      "Strategy A", ["glob"],
      "Strategy B", ["glob"],
    );
    const mock = createMockLLMClient([response]);
    const manager = new StrategyManager(stateManager, mock);

    const registry = new ToolRegistry();
    registry.register(makeMockTool("glob"));
    manager.setToolRegistry(registry);

    const candidates = await manager.generateCandidates("goal-1", "test_coverage", ["test_coverage"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    const activated = await manager.activateBestCandidate("goal-1");
    // Tie: stable sort preserves original order, so first candidate wins
    expect(activated.id).toBe(candidates[0]!.id);
  });

  it("skips scoring when all candidates have empty required_tools", async () => {
    const response = makeTwoCandidatesResponse(
      "Strategy A", [],
      "Strategy B", [],
    );
    const mock = createMockLLMClient([response]);
    const manager = new StrategyManager(stateManager, mock);

    const registry = new ToolRegistry();
    registry.register(makeMockTool("glob"));
    manager.setToolRegistry(registry);

    const candidates = await manager.generateCandidates("goal-1", "test_coverage", ["test_coverage"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    const activated = await manager.activateBestCandidate("goal-1");
    // No required_tools -> scoring skipped -> first candidate picked
    expect(activated.id).toBe(candidates[0]!.id);
  });

  it("prefers candidate with fewer missing tools (partial availability)", async () => {
    // Strategy A needs 2 missing tools, Strategy B needs only 1 missing tool
    const response = makeTwoCandidatesResponse(
      "Strategy A - 2 missing", ["missing-1", "missing-2"],
      "Strategy B - 1 missing", ["glob", "missing-2"],
    );
    const mock = createMockLLMClient([response]);
    const manager = new StrategyManager(stateManager, mock);

    const registry = new ToolRegistry();
    registry.register(makeMockTool("glob"));
    manager.setToolRegistry(registry);

    await manager.generateCandidates("goal-1", "test_coverage", ["test_coverage"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    const activated = await manager.activateBestCandidate("goal-1");
    expect(activated.hypothesis).toBe("Strategy B - 1 missing");
  });
});

// ─── generateCandidates: required_tools parsed from LLM response ───

describe("generateCandidates: required_tools in LLM response", () => {
  it("captures required_tools from LLM response", async () => {
    const response = makeCandidateResponse("Use shell for analysis", ["shell", "glob"]);
    const mock = createMockLLMClient([response]);
    const manager = new StrategyManager(stateManager, mock);

    const candidates = await manager.generateCandidates("goal-1", "test_coverage", ["test_coverage"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    expect(candidates[0]!.required_tools).toEqual(["shell", "glob"]);
  });

  it("defaults required_tools to [] when not in LLM response", async () => {
    // Response without required_tools field
    const responseWithout = `\`\`\`json
[
  {
    "hypothesis": "Use Pomodoro technique",
    "expected_effect": [
      { "dimension": "test_coverage", "direction": "increase", "magnitude": "medium" }
    ],
    "resource_estimate": {
      "sessions": 3,
      "duration": { "value": 2, "unit": "days" },
      "llm_calls": null
    },
    "allocation": 0.8
  }
]
\`\`\``;
    const mock = createMockLLMClient([responseWithout]);
    const manager = new StrategyManager(stateManager, mock);

    const candidates = await manager.generateCandidates("goal-1", "test_coverage", ["test_coverage"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    expect(candidates[0]!.required_tools).toEqual([]);
  });
});
