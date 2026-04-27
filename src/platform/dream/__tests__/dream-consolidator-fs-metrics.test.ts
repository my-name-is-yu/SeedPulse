import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import {
  collectBacklogMetrics,
  countAgentMemoryEntries,
  countEventLines,
  countFileLines,
  countFilesNamed,
  countGoalPairs,
  countJsonFiles,
  countJsonlLines,
  countLearnedPatterns,
  countTrustDomains,
  countVerificationArtifacts,
} from "../dream-consolidator/fs-metrics.js";

describe("dream consolidator fs metrics", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
    tmpDir = "";
  });

  it("counts goal pairs and learned patterns", async () => {
    tmpDir = makeTempDir("dream-fs-metrics-");
    await fs.mkdir(path.join(tmpDir, "goals", "goal-a"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "goals", "goal-b"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "goals", "goal-c"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "learning"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "learning", "alpha_patterns.json"), JSON.stringify([1, 2]), "utf8");
    await fs.writeFile(path.join(tmpDir, "learning", "ignored.json"), JSON.stringify([1, 2, 3]), "utf8");

    expect(await countGoalPairs(tmpDir)).toBe(3);
    expect(await countLearnedPatterns(tmpDir)).toBe(2);
  });

  it("collects backlog, file, and artifact counts", async () => {
    tmpDir = makeTempDir("dream-fs-backlog-");
    await fs.mkdir(path.join(tmpDir, "goals", "goal-1"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "dream", "events"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "memory", "agent-memory"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "trust"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "verification", "nested"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "goals", "goal-1", "iteration-logs.jsonl"), "a\nb\nc\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "dream", "events", "goal-1.jsonl"), '{"eventType":"StallDetected"}\n{"eventType":"Other"}\n', "utf8");
    await fs.writeFile(path.join(tmpDir, "dream", "importance-buffer.jsonl"), "x\ny\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "dream", "watermarks.json"), JSON.stringify({
      goals: {
        "goal-1": { lastProcessedLine: 1 },
        "event:goal-1.jsonl": { lastProcessedLine: 1 },
      },
      importanceBuffer: { lastProcessedLine: 1 },
    }), "utf8");
    await fs.writeFile(path.join(tmpDir, "memory", "agent-memory", "entries.json"), JSON.stringify({ entries: [{ id: 1 }, { id: 2 }] }), "utf8");
    await fs.writeFile(path.join(tmpDir, "trust", "trust-store.json"), JSON.stringify({ balances: { a: 1, b: 2 } }), "utf8");
    await fs.writeFile(path.join(tmpDir, "verification", "nested", "artifact.json"), "{}", "utf8");
    await fs.writeFile(path.join(tmpDir, "root.json"), "{}", "utf8");
    await fs.writeFile(path.join(tmpDir, "log.jsonl"), "1\n2\n", "utf8");

    expect(await collectBacklogMetrics(tmpDir)).toEqual({
      iteration_lines_pending: 2,
      event_lines_pending: 1,
      importance_entries_pending: 1,
    });
    expect(await countFileLines(path.join(tmpDir, "log.jsonl"))).toBe(2);
    expect(await countJsonlLines(tmpDir, "log.jsonl")).toBe(2);
    expect(await countFilesNamed(tmpDir, "artifact.json")).toBe(1);
    expect(await countJsonFiles(tmpDir)).toBeGreaterThanOrEqual(2);
    expect(await countAgentMemoryEntries(tmpDir)).toBe(2);
    expect(await countEventLines(tmpDir, "StallDetected")).toBe(1);
    expect(await countTrustDomains(tmpDir)).toBe(2);
    expect(await countVerificationArtifacts(tmpDir)).toBe(1);
  });
});
