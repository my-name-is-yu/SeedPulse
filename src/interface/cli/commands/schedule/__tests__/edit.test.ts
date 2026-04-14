import { describe, expect, it } from "vitest";
import { buildScheduleEditPatch } from "../edit.js";

describe("buildScheduleEditPatch", () => {
  it("builds name, enabled, and cron trigger updates", () => {
    const patch = buildScheduleEditPatch({
      name: "Morning brief",
      enabled: true,
      cron: "0 9 * * *",
      timezone: "Asia/Tokyo",
    });

    expect(patch).toEqual({
      name: "Morning brief",
      enabled: true,
      trigger: { type: "cron", expression: "0 9 * * *", timezone: "Asia/Tokyo" },
    });
  });

  it("parses layer config and retry policy JSON", () => {
    const patch = buildScheduleEditPatch({
      "heartbeat-json": JSON.stringify({
        check_type: "custom",
        check_config: { command: "echo ok" },
        failure_threshold: 5,
        timeout_ms: 1000,
      }),
      "retry-policy-json": JSON.stringify({
        enabled: true,
        initial_delay_ms: 1000,
        max_delay_ms: 5000,
        multiplier: 2,
        jitter_factor: 0,
        max_attempts: 2,
        max_retry_window_ms: 10000,
        retryable_failure_kinds: ["transient"],
      }),
    });

    expect(patch.heartbeat).toEqual({
      check_type: "custom",
      check_config: { command: "echo ok" },
      failure_threshold: 5,
      timeout_ms: 1000,
    });
    expect(patch.retry_policy).toEqual(expect.objectContaining({
      initial_delay_ms: 1000,
      max_attempts: 2,
    }));
  });

  it("rejects conflicting enabled flags", () => {
    expect(() => buildScheduleEditPatch({ enabled: true, disabled: true })).toThrow(
      "Use only one of --enabled or --disabled",
    );
  });

  it("rejects conflicting trigger flags", () => {
    expect(() => buildScheduleEditPatch({ cron: "0 9 * * *", interval: "60" })).toThrow(
      "Use only one of --cron or --interval",
    );
  });

  it("rejects invalid JSON config", () => {
    expect(() => buildScheduleEditPatch({ "cron-json": "{bad" })).toThrow("--cron-json is not valid JSON");
  });
});
