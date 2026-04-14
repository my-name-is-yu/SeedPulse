import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cmdSchedule } from "../commands/schedule.js";
import { ScheduleEngine } from "../../../runtime/schedule-engine.js";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import type { StateManager } from "../../../base/state/state-manager.js";

function makeStateManager(baseDir: string): StateManager {
  return {
    getBaseDir: () => baseDir,
  } as unknown as StateManager;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cmdSchedule", () => {
  it("adds a preset-backed schedule entry", async () => {
    const tempDir = makeTempDir("schedule-command-");
    try {
      vi.spyOn(console, "log").mockImplementation(() => {});

      await cmdSchedule(makeStateManager(tempDir), ["add", "--preset", "daily_brief"]);

      const engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      expect(engine.getEntries()).toHaveLength(1);
      expect(engine.getEntries()[0]?.metadata).toEqual(expect.objectContaining({
        source: "preset",
        preset_key: "daily_brief",
      }));
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("passes probe_dimension through the goal_probe preset", async () => {
    const tempDir = makeTempDir("schedule-command-goal-probe-");
    try {
      vi.spyOn(console, "log").mockImplementation(() => {});

      await cmdSchedule(makeStateManager(tempDir), [
        "add",
        "--preset",
        "goal_probe",
        "--data-source-id",
        "db-source",
        "--probe-dimension",
        "open_issue_count",
      ]);

      const engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      expect(engine.getEntries()).toHaveLength(1);
      expect(engine.getEntries()[0]?.probe).toEqual(expect.objectContaining({
        data_source_id: "db-source",
        probe_dimension: "open_issue_count",
      }));
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("applies a dream suggestion through the CLI flow", async () => {
    const tempDir = makeTempDir("schedule-command-suggestion-");
    try {
      vi.spyOn(console, "log").mockImplementation(() => {});
      await fs.mkdir(path.join(tempDir, "dream"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, "dream", "schedule-suggestions.json"),
        JSON.stringify({
          generated_at: "2026-04-08T00:00:00.000Z",
          suggestions: [
            {
              id: "dream-1",
              type: "goal_trigger",
              goalId: "goal-123",
              confidence: 0.9,
              reason: "Morning runs perform best.",
              proposal: "0 9 * * *",
              status: "pending",
            },
          ],
        }),
        "utf8",
      );

      await cmdSchedule(makeStateManager(tempDir), ["suggestions", "apply", "dream-1"]);

      const engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      expect(engine.getEntries()).toHaveLength(1);
      expect(engine.getEntries()[0]?.goal_trigger?.goal_id).toBe("goal-123");
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("prints schedule token cost from history", async () => {
    const tempDir = makeTempDir("schedule-command-cost-");
    try {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      const entry = await engine.addEntry({
        name: "Daily digest",
        layer: "cron",
        trigger: { type: "interval", seconds: 3600 },
        metadata: {
          source: "manual",
          dependency_hints: [],
        },
        cron: {
          job_kind: "prompt",
          prompt_template: "Summarize work",
          context_sources: [],
          output_format: "notification",
          max_tokens: 500,
        },
      });
      const now = new Date().toISOString();
      await fs.writeFile(
        path.join(tempDir, "schedule-history.json"),
        JSON.stringify([
          {
            id: "11111111-1111-4111-8111-111111111111",
            entry_id: entry.id,
            entry_name: entry.name,
            layer: entry.layer,
            reason: "manual_run",
            attempt: 0,
            scheduled_for: now,
            started_at: now,
            finished_at: now,
            retry_at: null,
            status: "ok",
            duration_ms: 10,
            fired_at: now,
            tokens_used: 42,
            escalated_to: null,
          },
        ]),
        "utf8",
      );

      await cmdSchedule(makeStateManager(tempDir), ["cost", "--period", "7d"]);

      expect(logSpy.mock.calls.flat().join("\n")).toContain("tokens:     42");
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("pauses, resumes, and edits a schedule entry", async () => {
    const tempDir = makeTempDir("schedule-command-lifecycle-");
    try {
      vi.spyOn(console, "log").mockImplementation(() => {});

      await cmdSchedule(makeStateManager(tempDir), [
        "add",
        "--name",
        "custom-check",
        "--type",
        "custom",
        "--command",
        "echo ok",
        "--interval",
        "60",
      ]);

      let engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      const id = engine.getEntries()[0]!.id;

      await cmdSchedule(makeStateManager(tempDir), ["pause", id.slice(0, 8)]);
      engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      expect(engine.getEntries()[0]!.enabled).toBe(false);

      await cmdSchedule(makeStateManager(tempDir), ["resume", id.slice(0, 8)]);
      engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      expect(engine.getEntries()[0]!.enabled).toBe(true);

      await cmdSchedule(makeStateManager(tempDir), [
        "edit",
        id.slice(0, 8),
        "--name",
        "renamed-check",
        "--cron",
        "0 9 * * *",
        "--timezone",
        "Asia/Tokyo",
        "--disabled",
      ]);

      engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      expect(engine.getEntries()[0]).toEqual(expect.objectContaining({
        name: "renamed-check",
        enabled: false,
        trigger: { type: "cron", expression: "0 9 * * *", timezone: "Asia/Tokyo" },
      }));
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("runs a paused schedule entry immediately without resuming it and exposes history", async () => {
    const tempDir = makeTempDir("schedule-command-run-now-");
    try {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await cmdSchedule(makeStateManager(tempDir), [
        "add",
        "--name",
        "manual-run-check",
        "--type",
        "custom",
        "--command",
        "echo ok",
        "--interval",
        "60",
      ]);

      let engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      const id = engine.getEntries()[0]!.id;

      await cmdSchedule(makeStateManager(tempDir), ["pause", id]);
      await cmdSchedule(makeStateManager(tempDir), ["run", id]);

      engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      expect(engine.getEntries()[0]!.enabled).toBe(false);
      expect(engine.getEntries()[0]!.total_executions).toBe(1);

      const history = await engine.getRecentHistory(10, id);
      expect(history).toHaveLength(1);
      expect(history[0]!.reason).toBe("manual_run");
      expect(history[0]!.status).toBe("ok");

      await cmdSchedule(makeStateManager(tempDir), ["history", id, "--limit", "1"]);
      expect(logSpy.mock.calls.some((call) => String(call[0]).includes("manual_run"))).toBe(true);
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});
