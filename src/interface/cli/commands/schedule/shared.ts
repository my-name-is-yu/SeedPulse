import type { z } from "zod";
import type { ScheduleEngine } from "../../../../runtime/schedule/engine.js";
import { resolveScheduleEntry } from "../../../../runtime/schedule/entry-resolver.js";
import type { ScheduleEntry, ScheduleTriggerInput } from "../../../../runtime/types/schedule.js";

export function getScheduleOrPrintError(engine: ScheduleEngine, id: string | undefined): ScheduleEntry | null {
  if (!id) {
    console.error("Error: schedule entry ID is required");
    return null;
  }
  try {
    const match = resolveScheduleEntry(engine.getEntries(), id);
    if (!match) {
      console.error(`No schedule entry found matching: ${id}`);
      return null;
    }
    return match;
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return null;
  }
}

export function parsePositiveInteger(value: string | undefined, label: string): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export function parseJsonConfig<T>(
  raw: unknown,
  parser: Pick<z.ZodType<T>, "parse">,
  label: string,
): T | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`${label} must be a non-empty JSON string`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${(err as Error).message}`);
  }
  try {
    return parser.parse(parsed);
  } catch (err) {
    throw new Error(`${label} failed schema validation: ${(err as Error).message}`);
  }
}

export function resolveTriggerPatch(values: {
  cron?: string;
  interval?: string;
  timezone?: string;
}): ScheduleTriggerInput | undefined {
  if (values.cron && values.interval) {
    throw new Error("Use only one of --cron or --interval");
  }
  if (values.cron) {
    return { type: "cron", expression: values.cron, timezone: values.timezone ?? "UTC" };
  }
  if (values.interval) {
    return { type: "interval", seconds: parsePositiveInteger(values.interval, "--interval"), jitter_factor: 0 };
  }
  if (values.timezone) {
    throw new Error("--timezone can only be used with --cron");
  }
  return undefined;
}
