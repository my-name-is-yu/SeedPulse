import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RunScheduleInputSchema,
  RunScheduleTool,
  type RunScheduleOutput,
} from "../RunScheduleTool/RunScheduleTool.js";
import type { ToolCallContext } from "../../types.js";
import type { ScheduleEngine } from "../../../runtime/schedule-engine.js";
import type { ScheduleEntry, ScheduleResult } from "../../../runtime/types/schedule.js";

function makeContext(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
    ...overrides,
  };
}

function makeEntry(
  id: string,
  overrides: Partial<ScheduleEntry> = {},
): ScheduleEntry {
  return {
    id,
    name: `Schedule ${id}`,
    layer: "heartbeat",
    trigger: { type: "interval", seconds: 60, jitter_factor: 0 },
    enabled: true,
    heartbeat: {
      check_type: "http",
      check_config: { url: "https://example.com/health" },
      failure_threshold: 3,
      timeout_ms: 5000,
    },
    probe: undefined,
    cron: undefined,
    goal_trigger: undefined,
    escalation: undefined,
    baseline_results: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_fired_at: null,
    next_fire_at: "2026-01-01T00:01:00.000Z",
    consecutive_failures: 0,
    last_escalation_at: null,
    escalation_timestamps: [],
    total_executions: 0,
    total_tokens_used: 0,
    max_tokens_per_day: 100000,
    tokens_used_today: 0,
    budget_reset_at: null,
    ...overrides,
  };
}

function makeResult(
  entryId: string,
  overrides: Partial<ScheduleResult> = {},
): ScheduleResult {
  return {
    entry_id: entryId,
    status: "ok",
    duration_ms: 3,
    fired_at: "2026-01-01T00:00:00.000Z",
    layer: "heartbeat",
    tokens_used: 0,
    escalated_to: null,
    ...overrides,
  };
}

describe("RunScheduleTool", () => {
  let scheduleEngine: ScheduleEngine;
  let tool: RunScheduleTool;

  beforeEach(() => {
    scheduleEngine = {
      getEntries: vi.fn().mockReturnValue([]),
      runEntryNow: vi.fn(),
    } as unknown as ScheduleEngine;
    tool = new RunScheduleTool(scheduleEngine);
  });

  it("has correct metadata", () => {
    expect(tool.metadata.name).toBe("run_schedule");
    expect(tool.metadata.permissionLevel).toBe("write_local");
    expect(tool.metadata.isDestructive).toBe(false);
    expect(tool.metadata.tags).toContain("execution");
  });

  it("description returns non-empty string", () => {
    expect(tool.description()).toContain("Run");
  });

  it("checkPermissions returns needs_approval when not pre-approved", async () => {
    const result = await tool.checkPermissions(
      RunScheduleInputSchema.parse({
        schedule_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
      makeContext(),
    );

    expect(result.status).toBe("needs_approval");
  });

  it("checkPermissions returns allowed when pre-approved", async () => {
    const result = await tool.checkPermissions(
      RunScheduleInputSchema.parse({
        schedule_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
      makeContext({ preApproved: true }),
    );

    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns false", () => {
    expect(
      tool.isConcurrencySafe(
        RunScheduleInputSchema.parse({
          schedule_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
      ),
    ).toBe(false);
  });

  it("resolves a unique prefix and runs the canonical schedule id", async () => {
    const entry = makeEntry("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
      name: "Heartbeat watch",
    });
    const result = makeResult(entry.id, { output_summary: "healthy" });
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      entry,
    ]);
    vi.mocked(scheduleEngine.runEntryNow).mockResolvedValue({
      entry,
      result,
      reason: "manual_run",
    });
    const approvalFn = vi.fn().mockResolvedValue(false);

    const toolResult = await tool.call(
      RunScheduleInputSchema.parse({
        schedule_id: "aaaaaaaa",
        allow_escalation: true,
      }),
      makeContext({ approvalFn }),
    );

    expect(approvalFn).not.toHaveBeenCalled();
    expect(scheduleEngine.runEntryNow).toHaveBeenCalledTimes(1);
    expect(scheduleEngine.runEntryNow).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      { allowEscalation: true, preserveEnabled: true },
    );
    expect(toolResult.success).toBe(true);
    expect((toolResult.data as RunScheduleOutput).result).toEqual(result);
    expect(toolResult.summary).toContain("healthy");
  });

  it("returns failure when the schedule id prefix is ambiguous", async () => {
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("eeee0000-0000-4000-8000-000000000000"),
      makeEntry("eeee1111-1111-4111-8111-111111111111"),
    ]);

    const result = await tool.call(
      RunScheduleInputSchema.parse({
        schedule_id: "eeee",
      }),
      makeContext({ preApproved: true }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("ambiguous");
    expect(scheduleEngine.runEntryNow).not.toHaveBeenCalled();
  });

  it("returns failure when the schedule is missing", async () => {
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
    ]);

    const result = await tool.call(
      RunScheduleInputSchema.parse({
        schedule_id: "missing",
      }),
      makeContext({ preApproved: true }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("missing");
    expect(scheduleEngine.runEntryNow).not.toHaveBeenCalled();
  });
});
