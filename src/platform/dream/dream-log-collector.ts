import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { writeJsonFileAtomic } from "../../base/utils/json-io.js";
import type { Logger } from "../../runtime/logger.js";
import type { LoopIterationResult, LoopResult } from "../../orchestrator/loop/core-loop-types.js";
import type { DriveScore } from "../../base/types/drive.js";
import {
  EventLogSchema,
  ImportanceEntrySchema,
  IterationLogSchema,
  SessionLogSchema,
  WatermarkStateSchema,
  type EventLog,
  type ImportanceEntry,
  type IterationLog,
  type SessionLog,
  type WatermarkState,
} from "./dream-types.js";

export interface DreamCollectorConfig {
  enabled?: boolean;
  iterationLoggingEnabled?: boolean;
  sessionSummariesEnabled?: boolean;
  eventPersistenceEnabled?: boolean;
  maxFileSizeBytes?: number;
  pruneTargetRatio?: number;
  rotateByDate?: boolean;
  importanceThreshold?: number;
}

const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const DEFAULT_PRUNE_TARGET_RATIO = 0.8;
const DEFAULT_IMPORTANCE_THRESHOLD = 0.5;

type QueueTask<T> = () => Promise<T>;

/**
 * Best-effort append-only collector for Dream Mode Phase 1.
 *
 * It intentionally avoids overwriting runtime state. When it has to prune a log,
 * it keeps the newest lines only and preserves JSONL semantics.
 */
export class DreamLogCollector {
  private readonly baseDir: string;
  private readonly logger?: Logger;
  private readonly config: Required<DreamCollectorConfig>;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(baseDir: string, logger?: Logger, config: DreamCollectorConfig = {}) {
    this.baseDir = baseDir;
    this.logger = logger;
    this.config = {
      enabled: config.enabled ?? true,
      iterationLoggingEnabled: config.iterationLoggingEnabled ?? true,
      sessionSummariesEnabled: config.sessionSummariesEnabled ?? true,
      eventPersistenceEnabled: config.eventPersistenceEnabled ?? true,
      maxFileSizeBytes: config.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES,
      pruneTargetRatio: config.pruneTargetRatio ?? DEFAULT_PRUNE_TARGET_RATIO,
      rotateByDate: config.rotateByDate ?? false,
      importanceThreshold: config.importanceThreshold ?? DEFAULT_IMPORTANCE_THRESHOLD,
    };
  }

  async appendIterationLog(entry: IterationLog): Promise<void> {
    if (!this.config.enabled || !this.config.iterationLoggingEnabled) return;
    const parsed = IterationLogSchema.parse(entry);
    await this.appendJsonl(this.goalIterationPath(parsed.goalId), parsed);
  }

  async appendSessionLog(entry: SessionLog): Promise<void> {
    if (!this.config.enabled || !this.config.sessionSummariesEnabled) return;
    const parsed = SessionLogSchema.parse(entry);
    await this.appendJsonl(this.sessionLogPath(), parsed);
  }

  async appendEventLog(entry: EventLog): Promise<void> {
    if (!this.config.enabled || !this.config.eventPersistenceEnabled) return;
    const parsed = EventLogSchema.parse(entry);
    await this.appendJsonl(this.eventLogPath(parsed.goalId), parsed);
  }

  async appendImportanceEntry(entry: ImportanceEntry, options?: { force?: boolean }): Promise<boolean> {
    const parsed = ImportanceEntrySchema.parse(entry);
    if (!options?.force && parsed.importance < this.config.importanceThreshold) {
      return false;
    }
    await this.appendJsonl(this.importanceBufferPath(), parsed);
    return true;
  }

  async loadWatermarks(): Promise<WatermarkState> {
    const raw = await this.readWatermarksFile();
    if (raw === null) {
      return WatermarkStateSchema.parse({});
    }
    return WatermarkStateSchema.parse(raw);
  }

  async saveWatermarks(state: WatermarkState): Promise<void> {
    const parsed = WatermarkStateSchema.parse(state);
    await this.withQueue("watermarks", async () => {
      await this.ensureDreamDir();
      await writeJsonFileAtomic(this.watermarksPath(), parsed);
    });
  }

  async markGoalProcessed(goalId: string, lastProcessedLine: number, lastProcessedTimestamp?: string): Promise<void> {
    const state = await this.loadWatermarks();
    state.goals[goalId] = {
      lastProcessedLine,
      ...(lastProcessedTimestamp ? { lastProcessedTimestamp } : {}),
    };
    await this.saveWatermarks(state);
  }

  async markImportanceProcessed(lastProcessedLine: number, lastProcessedTimestamp?: string): Promise<void> {
    const state = await this.loadWatermarks();
    state.importanceBuffer = {
      lastProcessedLine,
      ...(lastProcessedTimestamp ? { lastProcessedTimestamp } : {}),
    };
    await this.saveWatermarks(state);
  }

  async updateImportanceWatermark(lastProcessedLine: number, lastProcessedTimestamp?: string): Promise<void> {
    await this.markImportanceProcessed(lastProcessedLine, lastProcessedTimestamp);
  }

  async markImportanceCursorProcessed(cursor: {
    lastProcessedLine: number;
    lastProcessedTimestamp?: string;
    lastProcessedId?: string;
  }): Promise<void> {
    const state = await this.loadWatermarks();
    state.importanceBuffer = {
      lastProcessedLine: cursor.lastProcessedLine,
      ...(cursor.lastProcessedTimestamp ? { lastProcessedTimestamp: cursor.lastProcessedTimestamp } : {}),
      ...(cursor.lastProcessedId ? { lastProcessedId: cursor.lastProcessedId } : {}),
    };
    await this.saveWatermarks(state);
  }

  buildSessionId(goalId: string, startedAt: string): string {
    return `${goalId}:${startedAt}`;
  }

  async appendIterationResult(params: {
    goalId: string;
    sessionId: string;
    iterationResult: LoopIterationResult;
    timestamp?: string;
  }): Promise<void> {
    const { goalId, sessionId, iterationResult, timestamp } = params;
    await this.appendIterationLog({
      entryId: randomUUID(),
      timestamp: timestamp ?? new Date().toISOString(),
      goalId,
      iteration: iterationResult.loopIndex,
      sessionId,
      gapAggregate: iterationResult.gapAggregate,
      driveScores: this.toDriveScores(iterationResult.driveScores),
      taskId: iterationResult.taskResult?.task.id ?? null,
      taskAction: iterationResult.taskResult?.action ?? null,
      strategyId: iterationResult.taskResult?.task.strategy_id ?? null,
      verificationResult: iterationResult.taskResult
        ? {
            verdict: iterationResult.taskResult.verificationResult.verdict,
            confidence: iterationResult.taskResult.verificationResult.confidence,
            timestamp: iterationResult.taskResult.verificationResult.timestamp,
          }
        : null,
      stallDetected: iterationResult.stallDetected,
      stallSeverity: iterationResult.stallReport?.escalation_level ?? null,
      tokensUsed: iterationResult.tokensUsed ?? iterationResult.taskResult?.tokensUsed ?? null,
      elapsedMs: iterationResult.elapsedMs,
      skipped: iterationResult.skipped ?? false,
      skipReason: iterationResult.skipReason ?? null,
      completionJudgment: iterationResult.completionJudgment,
      waitSuppressed: iterationResult.waitSuppressed ?? false,
    });
  }

  async appendSessionSummary(params: {
    goalId: string;
    sessionId: string;
    completedAt: string;
    finalStatus: LoopResult["finalStatus"];
    iterations: LoopIterationResult[];
    totalTokensUsed: number;
  }): Promise<void> {
    const { goalId, sessionId, completedAt, finalStatus, iterations, totalTokensUsed } = params;
    const strategiesUsed = Array.from(
      new Set(
        iterations
          .map((iteration) => iteration.taskResult?.task.strategy_id)
          .filter((strategyId): strategyId is string => typeof strategyId === "string" && strategyId.length > 0)
      )
    );
    await this.appendSessionLog({
      timestamp: completedAt,
      goalId,
      sessionId,
      iterationCount: iterations.length,
      initialGapAggregate: iterations[0]?.gapAggregate ?? 0,
      finalGapAggregate: iterations[iterations.length - 1]?.gapAggregate ?? 0,
      totalTokensUsed,
      totalElapsedMs: iterations.reduce((sum, iteration) => sum + iteration.elapsedMs, 0),
      stallCount: iterations.filter((iteration) => iteration.stallDetected).length,
      outcome: finalStatus,
      strategiesUsed,
    });
  }

  private goalIterationPath(goalId: string): string {
    return path.join(this.baseDir, "goals", goalId, "iteration-logs.jsonl");
  }

  private sessionLogPath(): string {
    return path.join(this.baseDir, "dream", "session-logs.jsonl");
  }

  private importanceBufferPath(): string {
    return path.join(this.baseDir, "dream", "importance-buffer.jsonl");
  }

  private eventLogPath(goalId: string): string {
    return path.join(this.baseDir, "dream", "events", `${goalId}.jsonl`);
  }

  private watermarksPath(): string {
    return path.join(this.baseDir, "dream", "watermarks.json");
  }

  private toDriveScores(driveScores: DriveScore[]): IterationLog["driveScores"] {
    if (driveScores.length === 0) return undefined;
    return driveScores.map((score) => ({
      dimensionName: score.dimension_name,
      score: score.final_score,
    }));
  }

  private async readWatermarksFile(): Promise<unknown | null> {
    try {
      const raw = await fsp.readFile(this.watermarksPath(), "utf8");
      return JSON.parse(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      this.logger?.warn(`[DreamLogCollector] Failed to read watermarks: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async appendJsonl(filePath: string, entry: unknown): Promise<void> {
    const line = JSON.stringify(entry);
    await this.withQueue(filePath, async () => {
      await this.ensureDirFor(filePath);
      await this.rotateIfNeeded(filePath, line);
      await fsp.appendFile(filePath, `${line}\n`, "utf8");
    });
  }

  private async rotateIfNeeded(filePath: string, nextLine: string): Promise<void> {
    const maxSizeBytes = this.config.maxFileSizeBytes;
    const currentSize = await fsp.stat(filePath).then((stat) => stat.size).catch(() => 0);
    const nextSize = Buffer.byteLength(nextLine + "\n", "utf8");
    if (currentSize + nextSize <= maxSizeBytes) {
      return;
    }

    const existing = await fsp.readFile(filePath, "utf8").catch(() => "");
    const lines = existing.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const targetBytes = Math.max(
      nextSize,
      Math.floor(maxSizeBytes * this.config.pruneTargetRatio)
    );

    const kept: string[] = [];
    let total = nextSize;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
      if (kept.length > 0 && total + lineBytes > targetBytes) {
        break;
      }
      kept.unshift(line);
      total += lineBytes;
    }

    const rotated = kept.length > 0 ? `${kept.join("\n")}\n` : "";
    await this.atomicWriteText(filePath, rotated);
  }

  private async atomicWriteText(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${filePath}.${randomUUID()}.tmp`;
    await fsp.writeFile(tmp, content, "utf8");
    await fsp.rename(tmp, filePath);
  }

  private async ensureDirFor(filePath: string): Promise<void> {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
  }

  private async ensureDreamDir(): Promise<void> {
    await fsp.mkdir(path.join(this.baseDir, "dream"), { recursive: true });
    await fsp.mkdir(path.join(this.baseDir, "dream", "events"), { recursive: true });
  }

  private async withQueue<T>(key: string, task: QueueTask<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task, task);
    this.queues.set(key, next.then(() => undefined, () => undefined));
    return next;
  }
}
