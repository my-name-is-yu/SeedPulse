import { describe, expect, it } from "vitest";
import { resolveScheduleEntry, ScheduleEntryResolutionError } from "../entry-resolver.js";
import { ScheduleEntrySchema } from "../../types/schedule.js";

function makeEntry(id: string) {
  return ScheduleEntrySchema.parse({
    id,
    name: `schedule-${id.slice(0, 4)}`,
    layer: "heartbeat",
    trigger: { type: "interval", seconds: 60, jitter_factor: 0 },
    enabled: true,
    heartbeat: {
      check_type: "custom",
      check_config: { command: "echo ok" },
      failure_threshold: 3,
      timeout_ms: 5000,
    },
    baseline_results: [],
    created_at: "2026-04-08T00:00:00.000Z",
    updated_at: "2026-04-08T00:00:00.000Z",
    last_fired_at: null,
    next_fire_at: "2026-04-08T00:01:00.000Z",
    consecutive_failures: 0,
    last_escalation_at: null,
    escalation_timestamps: [],
    total_executions: 0,
    total_tokens_used: 0,
    max_tokens_per_day: 100000,
    tokens_used_today: 0,
    budget_reset_at: null,
  });
}

describe("resolveScheduleEntry", () => {
  it("prefers exact id matches over prefix matches", () => {
    const exact = makeEntry("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const longerPrefix = makeEntry("aaaaaaaa-bbbb-4aaa-8aaa-aaaaaaaaaaaa");

    expect(resolveScheduleEntry([longerPrefix, exact], exact.id)).toBe(exact);
  });

  it("resolves unique prefixes", () => {
    const entry = makeEntry("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

    expect(resolveScheduleEntry([entry], "bbbbbbbb")).toBe(entry);
  });

  it("returns null for missing ids", () => {
    const entry = makeEntry("cccccccc-cccc-4ccc-8ccc-cccccccccccc");

    expect(resolveScheduleEntry([entry], "missing")).toBeNull();
  });

  it("throws a typed error for ambiguous prefixes", () => {
    const first = makeEntry("dddd0000-0000-4000-8000-000000000000");
    const second = makeEntry("dddd1111-1111-4111-8111-111111111111");

    expect(() => resolveScheduleEntry([first, second], "dddd")).toThrow(ScheduleEntryResolutionError);
    expect(() => resolveScheduleEntry([first, second], "dddd")).toThrow("ambiguous");
  });
});
