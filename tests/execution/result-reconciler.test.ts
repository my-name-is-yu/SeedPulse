import { describe, it, expect, vi } from "vitest";
import {
  reconcileResults,
  buildReconciliationPrompt,
} from "../../src/execution/result-reconciler.js";
import type { ReconcilerDeps } from "../../src/execution/result-reconciler.js";
import type { SubtaskResult } from "../../src/execution/parallel-executor.js";

// ─── Helpers ───

function makeResult(overrides: Partial<SubtaskResult> = {}): SubtaskResult {
  return {
    task_id: "task-1",
    verdict: "pass",
    output: "Some task output",
    ...overrides,
  };
}

function makeDeps(llmResponse: string | Error): ReconcilerDeps {
  return {
    llmClient: {
      sendMessage: vi.fn(async () => {
        if (llmResponse instanceof Error) throw llmResponse;
        return {
          content: llmResponse,
          usage: { input_tokens: 10, output_tokens: 20 },
          stop_reason: "end_turn",
        };
      }),
      parseJSON: vi.fn(),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as ReconcilerDeps["logger"],
  };
}

// ─── Tests ───

describe("reconcileResults", () => {
  it("single result returns no contradictions with confidence 1.0", async () => {
    const deps = makeDeps('{"contradictions":[]}');
    const result = await reconcileResults(deps, [makeResult()]);

    expect(result.has_contradictions).toBe(false);
    expect(result.contradictions).toHaveLength(0);
    expect(result.confidence).toBe(1.0);
    expect(deps.llmClient.sendMessage).not.toHaveBeenCalled();
  });

  it("two compatible results return no contradictions", async () => {
    const deps = makeDeps('{"contradictions":[]}');
    const results = [
      makeResult({ task_id: "task-1", output: "Added feature A" }),
      makeResult({ task_id: "task-2", output: "Added feature B" }),
    ];

    const report = await reconcileResults(deps, results);

    expect(report.has_contradictions).toBe(false);
    expect(report.contradictions).toHaveLength(0);
    expect(report.confidence).toBe(1.0);
    expect(deps.llmClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("two contradicting results are detected", async () => {
    const llmResponse = JSON.stringify({
      contradictions: [
        {
          description: "Task A disables caching while Task B enables it",
          severity: "critical",
        },
      ],
    });
    const deps = makeDeps(llmResponse);
    const results = [
      makeResult({ task_id: "task-a", output: "Disabled caching" }),
      makeResult({ task_id: "task-b", output: "Enabled caching" }),
    ];

    const report = await reconcileResults(deps, results);

    expect(report.has_contradictions).toBe(true);
    expect(report.contradictions).toHaveLength(1);
    expect(report.contradictions[0].task_a_id).toBe("task-a");
    expect(report.contradictions[0].task_b_id).toBe("task-b");
    expect(report.contradictions[0].severity).toBe("critical");
    expect(report.confidence).toBe(1.0);
  });

  it("LLM failure returns fail-open: no contradictions, confidence 0", async () => {
    const deps = makeDeps(new Error("LLM timeout"));
    const results = [
      makeResult({ task_id: "task-1" }),
      makeResult({ task_id: "task-2" }),
    ];

    const report = await reconcileResults(deps, results);

    expect(report.has_contradictions).toBe(false);
    expect(report.contradictions).toHaveLength(0);
    expect(report.confidence).toBe(0.0);
  });

  it("pairwise comparison count is correct for 3 results (3 pairs)", async () => {
    const deps = makeDeps('{"contradictions":[]}');
    const results = [
      makeResult({ task_id: "task-1" }),
      makeResult({ task_id: "task-2" }),
      makeResult({ task_id: "task-3" }),
    ];

    await reconcileResults(deps, results);

    // n*(n-1)/2 = 3*(3-1)/2 = 3 pairs
    expect(deps.llmClient.sendMessage).toHaveBeenCalledTimes(3);
  });
});

describe("buildReconciliationPrompt", () => {
  it("includes both task IDs and outputs in the prompt", () => {
    const resultA = makeResult({ task_id: "task-a", output: "Output A" });
    const resultB = makeResult({ task_id: "task-b", output: "Output B" });

    const prompt = buildReconciliationPrompt(resultA, resultB);

    expect(prompt).toContain("task-a");
    expect(prompt).toContain("task-b");
    expect(prompt).toContain("Output A");
    expect(prompt).toContain("Output B");
  });
});
