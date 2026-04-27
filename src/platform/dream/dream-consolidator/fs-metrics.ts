import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { readJsonFileOrNull } from "../../../base/utils/json-io.js";
import { WatermarkStateSchema } from "../dream-types.js";

export async function countGoalDirs(baseDir: string, tier: "light" | "deep"): Promise<number> {
  const goalsDir = path.join(baseDir, "goals");
  const entries = await fsp.readdir(goalsDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).length * (tier === "deep" ? 1 : 1);
}

export async function countGoalPairs(baseDir: string): Promise<number> {
  const count = await countGoalDirs(baseDir, "deep");
  return count < 2 ? 0 : (count * (count - 1)) / 2;
}

export async function countLearnedPatterns(baseDir: string): Promise<number> {
  const learningDir = path.join(baseDir, "learning");
  const files = await fsp.readdir(learningDir).catch(() => [] as string[]);
  let total = 0;
  for (const fileName of files.filter((file) => file.endsWith("_patterns.json"))) {
    const raw = await readJsonFileOrNull(path.join(learningDir, fileName));
    if (Array.isArray(raw)) {
      total += raw.length;
    }
  }
  return total;
}

export async function collectBacklogMetrics(baseDir: string): Promise<{
  iteration_lines_pending: number;
  event_lines_pending: number;
  importance_entries_pending: number;
}> {
  const raw = await readJsonFileOrNull(path.join(baseDir, "dream", "watermarks.json"));
  const watermarks = raw === null ? WatermarkStateSchema.parse({}) : WatermarkStateSchema.safeParse(raw).success
    ? WatermarkStateSchema.parse(raw)
    : WatermarkStateSchema.parse({});
  let iterationLinesPending = 0;
  const goalsDir = path.join(baseDir, "goals");
  const goalEntries = await fsp.readdir(goalsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of goalEntries.filter((candidate) => candidate.isDirectory())) {
    const total = await countFileLines(path.join(goalsDir, entry.name, "iteration-logs.jsonl"));
    const lastProcessed = watermarks.goals[entry.name]?.lastProcessedLine ?? 0;
    iterationLinesPending += Math.max(0, total - Math.min(lastProcessed, total));
  }

  let eventLinesPending = 0;
  const eventDir = path.join(baseDir, "dream", "events");
  const eventFiles = await fsp.readdir(eventDir).catch(() => [] as string[]);
  for (const fileName of eventFiles.filter((file) => file.endsWith(".jsonl"))) {
    const total = await countFileLines(path.join(eventDir, fileName));
    const lastProcessed = watermarks.goals[`event:${fileName}`]?.lastProcessedLine ?? 0;
    eventLinesPending += Math.max(0, total - Math.min(lastProcessed, total));
  }

  const importanceLines = await countFileLines(path.join(baseDir, "dream", "importance-buffer.jsonl"));
  const importanceProcessed = watermarks.importanceBuffer.lastProcessedLine ?? 0;
  const importanceEntriesPending = Math.max(0, importanceLines - Math.min(importanceProcessed, importanceLines));

  return {
    iteration_lines_pending: iterationLinesPending,
    event_lines_pending: eventLinesPending,
    importance_entries_pending: importanceEntriesPending,
  };
}

export async function countFileLines(filePath: string): Promise<number> {
  const raw = await fsp.readFile(filePath, "utf8").catch(() => "");
  return raw.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

export async function countFilesNamed(root: string, fileName: string): Promise<number> {
  let count = 0;
  for await (const filePath of walk(root)) {
    if (path.basename(filePath) === fileName) {
      count += 1;
    }
  }
  return count;
}

export async function countJsonFiles(root: string): Promise<number> {
  let count = 0;
  for await (const filePath of walk(root)) {
    if (filePath.endsWith(".json")) {
      count += 1;
    }
  }
  return count;
}

export async function countJsonlLines(baseDir: string, relativePath: string): Promise<number> {
  return countFileLines(path.join(baseDir, relativePath));
}

export async function countAgentMemoryEntries(baseDir: string): Promise<number> {
  const filePath = path.join(baseDir, "memory", "agent-memory", "entries.json");
  const raw = await fsp.readFile(filePath, "utf8").catch(() => "");
  if (!raw) return 0;
  const parsed = JSON.parse(raw) as { entries?: unknown[] };
  return Array.isArray(parsed.entries) ? parsed.entries.length : 0;
}

export async function countEventLines(baseDir: string, eventType: string): Promise<number> {
  const dreamDir = path.join(baseDir, "dream", "events");
  let total = 0;
  for await (const filePath of walk(dreamDir)) {
    if (!filePath.endsWith(".jsonl")) continue;
    const raw = await fsp.readFile(filePath, "utf8").catch(() => "");
    total += raw
      .split(/\r?\n/)
      .filter((line) => line.includes(`"eventType":"${eventType}"`)).length;
  }
  return total;
}

export async function countTrustDomains(baseDir: string): Promise<number> {
  const filePath = path.join(baseDir, "trust", "trust-store.json");
  const raw = await fsp.readFile(filePath, "utf8").catch(() => "");
  if (!raw) return 0;
  const parsed = JSON.parse(raw) as { balances?: Record<string, unknown> };
  return parsed.balances ? Object.keys(parsed.balances).length : 0;
}

export async function countVerificationArtifacts(baseDir: string): Promise<number> {
  const verificationDir = path.join(baseDir, "verification");
  let count = 0;
  for await (const _ of walk(verificationDir)) {
    count += 1;
  }
  return count;
}

export async function *walk(root: string): AsyncGenerator<string> {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else {
      yield fullPath;
    }
  }
}
