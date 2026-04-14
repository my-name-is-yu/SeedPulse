import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../../base/utils/json-io.js";
import {
  ScheduleResultSchema,
  ScheduleLayerSchema,
  type ScheduleFailureKind,
  type ScheduleResult,
} from "../types/schedule.js";
import { z } from "zod";

const HISTORY_FILE = "schedule-history.json";
const DEFAULT_MAX_RECENT = 500;

export const ScheduleRunReasonSchema = z.enum(["cadence", "retry", "escalation_target", "manual_run"]);
export type ScheduleRunReason = z.infer<typeof ScheduleRunReasonSchema>;

export const ScheduleRunHistoryRecordSchema = ScheduleResultSchema.extend({
  id: z.string().uuid(),
  entry_name: z.string(),
  reason: ScheduleRunReasonSchema,
  attempt: z.number().int().nonnegative().default(0),
  scheduled_for: z.string().datetime().nullable().default(null),
  started_at: z.string().datetime(),
  finished_at: z.string().datetime(),
  retry_at: z.string().datetime().nullable().default(null),
});

export type ScheduleRunHistoryRecord = z.infer<typeof ScheduleRunHistoryRecordSchema>;

export interface ScheduleRunHistoryInput {
  entry_id: string;
  entry_name: string;
  layer: z.infer<typeof ScheduleLayerSchema>;
  result: ScheduleResult;
  reason: ScheduleRunReason;
  attempt?: number;
  scheduled_for?: string | null;
  started_at: string;
  finished_at: string;
  retry_at?: string | null;
  failure_kind?: ScheduleFailureKind | null;
}

export class ScheduleHistoryStore {
  private readonly historyPath: string;

  constructor(
    baseDir: string,
    private readonly maxRecent = DEFAULT_MAX_RECENT
  ) {
    this.historyPath = path.join(baseDir, HISTORY_FILE);
  }

  async load(): Promise<ScheduleRunHistoryRecord[]> {
    const raw = await readJsonFileOrNull(this.historyPath);
    if (!Array.isArray(raw)) {
      return [];
    }

    const parsed: ScheduleRunHistoryRecord[] = [];
    for (const item of raw) {
      const record = ScheduleRunHistoryRecordSchema.safeParse(item);
      if (record.success) {
        parsed.push(record.data);
      }
    }
    return parsed;
  }

  async save(records: ScheduleRunHistoryRecord[]): Promise<void> {
    const trimmed = records.slice(-this.maxRecent);
    await writeJsonFileAtomic(this.historyPath, trimmed);
  }

  async append(input: ScheduleRunHistoryInput): Promise<ScheduleRunHistoryRecord> {
    const existing = await this.load();
    const parsed = ScheduleRunHistoryRecordSchema.parse({
      ...input.result,
      id: randomUUID(),
      entry_id: input.entry_id,
      entry_name: input.entry_name,
      layer: input.layer,
      reason: input.reason,
      attempt: input.attempt ?? 0,
      scheduled_for: input.scheduled_for ?? null,
      started_at: input.started_at,
      finished_at: input.finished_at,
      retry_at: input.retry_at ?? null,
      failure_kind: input.failure_kind ?? input.result.failure_kind,
    });

    existing.push(parsed);
    await this.save(existing);
    return parsed;
  }

  async recent(limit = 20): Promise<ScheduleRunHistoryRecord[]> {
    const records = await this.load();
    return records.slice(-limit);
  }
}
