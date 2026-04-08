import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { ZodSchema } from "zod";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../../base/llm/llm-client.js";
import { StateManager } from "../../../base/state/state-manager.js";
import { LearningPipeline } from "../../knowledge/learning/learning-pipeline.js";
import { DreamAnalyzer } from "../dream-analyzer.js";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";

function makeMockLLM(patternBatches: unknown[][]): ILLMClient {
  let callIndex = 0;
  return {
    async sendMessage(_messages: LLMMessage[], _options?: LLMRequestOptions): Promise<LLMResponse> {
      const content = JSON.stringify({ patterns: patternBatches[callIndex] ?? [] });
      callIndex += 1;
      return {
        content,
        usage: { input_tokens: 100, output_tokens: 150 },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string, schema: ZodSchema<T>): T {
      return schema.parse(JSON.parse(content));
    },
  };
}

async function writeJsonl(filePath: string, records: unknown[]): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function makeIteration(goalId: string, iteration: number) {
  return {
    timestamp: `2026-04-07T00:${iteration.toString().padStart(2, "0")}:00.000Z`,
    goalId,
    iteration,
    sessionId: `${goalId}:session-1`,
    gapAggregate: Math.max(0, 1 - iteration * 0.05),
    taskId: `task-${iteration}`,
    taskAction: iteration % 2 === 0 ? "rerun_verification" : "collect_signal",
    strategyId: iteration < 12 ? "baseline" : "tight-loop",
    verificationResult: {
      verdict: iteration % 3 === 0 ? "pass" : "retry",
      confidence: 0.8,
      timestamp: `2026-04-07T00:${iteration.toString().padStart(2, "0")}:30.000Z`,
    },
    stallDetected: iteration % 7 === 0,
    stallSeverity: iteration % 7 === 0 ? 1 : null,
    tokensUsed: 40,
    elapsedMs: 500,
    completionJudgment: {
      is_complete: false,
      checked_at: `2026-04-07T00:${iteration.toString().padStart(2, "0")}:59.000Z`,
    },
  };
}

describe("DreamAnalyzer", () => {
  it("runs phase 2 analysis, persists patterns and schedule suggestions, and advances resumable watermarks", async () => {
    const tempDir = makeTempDir("dream-analyzer-");
    try {
      const goalA = "goal-a";
      const goalB = "goal-b";
      await writeJsonl(
        path.join(tempDir, "goals", goalA, "iteration-logs.jsonl"),
        Array.from({ length: 12 }, (_, index) => makeIteration(goalA, index))
      );
      await writeJsonl(
        path.join(tempDir, "goals", goalB, "iteration-logs.jsonl"),
        Array.from({ length: 15 }, (_, index) => makeIteration(goalB, index))
      );
      await writeJsonl(path.join(tempDir, "dream", "importance-buffer.jsonl"), [
        {
          id: "imp-1",
          timestamp: "2026-04-07T01:00:00.000Z",
          goalId: goalA,
          source: "verification",
          importance: 0.9,
          reason: "Repeated verification recovery",
          data_ref: `iter:${goalA}:5`,
          tags: ["verification"],
          processed: false,
        },
        "not-json",
        {
          id: "imp-2",
          timestamp: "2026-04-07T01:05:00.000Z",
          goalId: goalB,
          source: "stall",
          importance: 0.75,
          reason: "Recurring stall precursor",
          data_ref: `iter:${goalB}:7`,
          tags: ["stall"],
          processed: false,
        },
      ]);
      await writeJsonl(path.join(tempDir, "dream", "session-logs.jsonl"), [
        {
          timestamp: "2026-04-07T03:00:00.000Z",
          goalId: goalB,
          sessionId: "goal-b:1",
          iterationCount: 15,
          finalGapAggregate: 0.25,
          initialGapAggregate: 0.95,
          totalTokensUsed: 600,
          totalElapsedMs: 12000,
          stallCount: 1,
          outcome: "max_iterations",
          strategiesUsed: ["baseline", "tight-loop"],
        },
        {
          timestamp: "2026-04-08T03:20:00.000Z",
          goalId: goalB,
          sessionId: "goal-b:2",
          iterationCount: 14,
          finalGapAggregate: 0.2,
          initialGapAggregate: 0.9,
          totalTokensUsed: 550,
          totalElapsedMs: 11000,
          stallCount: 0,
          outcome: "max_iterations",
          strategiesUsed: ["tight-loop"],
        },
        {
          timestamp: "2026-04-09T03:40:00.000Z",
          goalId: goalB,
          sessionId: "goal-b:3",
          iterationCount: 16,
          finalGapAggregate: 0.1,
          initialGapAggregate: 0.88,
          totalTokensUsed: 530,
          totalElapsedMs: 10500,
          stallCount: 0,
          outcome: "goal_complete",
          strategiesUsed: ["tight-loop"],
        },
      ]);

      const stateManager = new StateManager(tempDir, undefined, { walEnabled: false });
      await stateManager.init();
      const learningPipeline = new LearningPipeline(makeMockLLM([[]]), null, stateManager);
      const analyzer = new DreamAnalyzer({
        baseDir: tempDir,
        llmClient: makeMockLLM([
          [],
          [
            {
              pattern_type: "recurring_task",
              confidence: 0.88,
              summary: "Retry verification after drift to recover progress.",
              evidence_refs: [`iter:${goalA}:5`, `iter:${goalA}:6`],
              metadata: { taskAction: "rerun_verification", applicable_domains: ["verification"] },
            },
          ],
        ]),
        learningPipeline,
        config: {
          minIterationsForAnalysis: 5,
          patternConfidenceThreshold: 0.7,
        },
      });

      const report = await analyzer.runDeep();

      expect(report.phasesCompleted).toEqual(["A", "B", "C"]);
      expect(report.patternsPersisted).toBeGreaterThan(0);
      expect(report.scheduleSuggestions).toBe(1);
      expect(report.goalsProcessed[0]).toBe(goalB);

      const patternsA = await learningPipeline.getPatterns(goalA);
      const patternsB = await learningPipeline.getPatterns(goalB);
      expect(patternsA).toHaveLength(1);
      expect(patternsB).toEqual([]);
      expect(patternsA[0]?.description).toContain("Retry verification");

      const scheduleSuggestions = JSON.parse(
        await fs.promises.readFile(path.join(tempDir, "dream", "schedule-suggestions.json"), "utf8")
      ) as { suggestions: Array<{ goalId?: string; proposal: string; type: string }> };
      expect(scheduleSuggestions.suggestions).toEqual([
        expect.objectContaining({
          goalId: goalB,
          proposal: "0 3 * * *",
          type: "goal_trigger",
          trigger: {
            type: "cron",
            expression: "0 3 * * *",
            timezone: "UTC",
          },
        }),
      ]);

      const watermarks = JSON.parse(
        await fs.promises.readFile(path.join(tempDir, "dream", "watermarks.json"), "utf8")
      ) as {
        goals: Record<string, { lastProcessedLine: number; lastProcessedTimestamp?: string }>;
        importanceBuffer: { lastProcessedLine: number; lastProcessedTimestamp?: string; lastProcessedId?: string };
      };
      expect(watermarks.goals[goalA]?.lastProcessedLine).toBe(12);
      expect(watermarks.goals[goalB]?.lastProcessedLine).toBe(15);
      expect(watermarks.goals[goalB]?.lastProcessedTimestamp).toBeTruthy();
      expect(watermarks.importanceBuffer.lastProcessedLine).toBe(3);
      expect(watermarks.importanceBuffer.lastProcessedId).toBe("imp-2");
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("falls back to timestamp-based resume when iteration logs were pruned", async () => {
    const tempDir = makeTempDir("dream-analyzer-pruned-");
    try {
      const goalId = "goal-pruned";
      await writeJsonl(
        path.join(tempDir, "goals", goalId, "iteration-logs.jsonl"),
        [makeIteration(goalId, 3), makeIteration(goalId, 4), makeIteration(goalId, 5)]
      );
      await fs.promises.mkdir(path.join(tempDir, "dream"), { recursive: true });
      await fs.promises.writeFile(
        path.join(tempDir, "dream", "watermarks.json"),
        JSON.stringify({
          goals: {
            [goalId]: {
              lastProcessedLine: 10,
              lastProcessedTimestamp: makeIteration(goalId, 4).timestamp,
            },
          },
          importanceBuffer: { lastProcessedLine: 0 },
        }),
        "utf8"
      );

      const stateManager = new StateManager(tempDir, undefined, { walEnabled: false });
      await stateManager.init();
      const learningPipeline = new LearningPipeline(makeMockLLM([[]]), null, stateManager);
      const analyzer = new DreamAnalyzer({
        baseDir: tempDir,
        llmClient: makeMockLLM([[{
          pattern_type: "strategy_effectiveness",
          confidence: 0.91,
          summary: "Recent post-prune iteration was analyzed.",
          evidence_refs: [`iter:${goalId}:5`],
          metadata: { applicable_domains: ["strategy"] },
        }]]),
        learningPipeline,
        config: { minIterationsForAnalysis: 1 },
      });

      const report = await analyzer.runDeep({ goalIds: [goalId], phases: ["A", "B"] });

      expect(report.stats.linesRead).toBe(1);
      expect(report.patternsPersisted).toBe(1);
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("does not advance importance watermark past excluded goals", async () => {
    const tempDir = makeTempDir("dream-analyzer-importance-");
    try {
      const goalA = "goal-a";
      const goalB = "goal-b";
      await writeJsonl(
        path.join(tempDir, "goals", goalA, "iteration-logs.jsonl"),
        Array.from({ length: 6 }, (_, index) => makeIteration(goalA, index))
      );
      await writeJsonl(
        path.join(tempDir, "goals", goalB, "iteration-logs.jsonl"),
        Array.from({ length: 6 }, (_, index) => makeIteration(goalB, index))
      );
      await writeJsonl(path.join(tempDir, "dream", "importance-buffer.jsonl"), [
        {
          id: "imp-a",
          timestamp: "2026-04-07T01:00:00.000Z",
          goalId: goalA,
          source: "verification",
          importance: 0.8,
          reason: "A",
          data_ref: `iter:${goalA}:2`,
          tags: [],
          processed: false,
        },
        {
          id: "imp-b",
          timestamp: "2026-04-07T01:01:00.000Z",
          goalId: goalB,
          source: "stall",
          importance: 0.9,
          reason: "B",
          data_ref: `iter:${goalB}:2`,
          tags: [],
          processed: false,
        },
      ]);

      const stateManager = new StateManager(tempDir, undefined, { walEnabled: false });
      await stateManager.init();
      const learningPipeline = new LearningPipeline(makeMockLLM([[]]), null, stateManager);
      const analyzer = new DreamAnalyzer({
        baseDir: tempDir,
        llmClient: makeMockLLM([[{
          pattern_type: "verification",
          confidence: 0.8,
          summary: "Goal A processed",
          evidence_refs: [`iter:${goalA}:2`],
          metadata: {},
        }]]),
        learningPipeline,
        config: { minIterationsForAnalysis: 1, maxGoalsPerRun: 1 },
      });

      await analyzer.runDeep({ phases: ["A", "B"] });

      const watermarks = JSON.parse(
        await fs.promises.readFile(path.join(tempDir, "dream", "watermarks.json"), "utf8")
      ) as {
        importanceBuffer: { lastProcessedLine: number; lastProcessedId?: string };
      };
      expect(watermarks.importanceBuffer.lastProcessedLine).toBe(1);
      expect(watermarks.importanceBuffer.lastProcessedId).toBe("imp-a");
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("marks the run partial and skips persistence when the token budget is exhausted before analysis", async () => {
    const tempDir = makeTempDir("dream-analyzer-budget-");
    try {
      const goalId = "goal-budget";
      await writeJsonl(
        path.join(tempDir, "goals", goalId, "iteration-logs.jsonl"),
        Array.from({ length: 25 }, (_, index) => makeIteration(goalId, index))
      );

      const stateManager = new StateManager(tempDir, undefined, { walEnabled: false });
      await stateManager.init();
      const learningPipeline = new LearningPipeline(makeMockLLM([[]]), null, stateManager);
      const analyzer = new DreamAnalyzer({
        baseDir: tempDir,
        llmClient: makeMockLLM([
          [
            {
              pattern_type: "strategy_effectiveness",
              confidence: 0.91,
              summary: "Tight loops outperform baseline strategy.",
              evidence_refs: [`iter:${goalId}:10`],
              metadata: { applicable_domains: ["strategy"] },
            },
          ],
        ]),
        learningPipeline,
        config: {
          minIterationsForAnalysis: 5,
        },
      });

      const report = await analyzer.runDeep({ tokenBudget: 10 });

      expect(report.partial).toBe(true);
      expect(report.phasesCompleted).toEqual(["A", "B"]);
      expect(report.patternsPersisted).toBe(0);
      expect(report.scheduleSuggestions).toBe(0);
      expect(await learningPipeline.getPatterns(goalId)).toEqual([]);
      expect(fs.existsSync(path.join(tempDir, "dream", "watermarks.json"))).toBe(false);
      expect(fs.existsSync(path.join(tempDir, "dream", "schedule-suggestions.json"))).toBe(false);
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});
