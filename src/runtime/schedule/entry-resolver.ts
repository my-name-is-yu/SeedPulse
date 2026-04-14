import type { ScheduleEntry } from "../types/schedule.js";

export class ScheduleEntryResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleEntryResolutionError";
  }
}

export function resolveScheduleEntry(entries: ScheduleEntry[], scheduleId: string): ScheduleEntry | null {
  const exact = entries.find((entry) => entry.id === scheduleId);
  if (exact) {
    return exact;
  }

  const matches = entries.filter((entry) => entry.id.startsWith(scheduleId));
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new ScheduleEntryResolutionError(`Schedule ID prefix is ambiguous: ${scheduleId}`);
  }

  return null;
}
