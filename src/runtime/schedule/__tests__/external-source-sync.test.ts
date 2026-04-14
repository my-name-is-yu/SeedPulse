import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { ScheduleEngine } from "../engine.js";
import type { IScheduleSource } from "../source.js";

function makeSource(entries: Awaited<ReturnType<IScheduleSource["fetchEntries"]>>): IScheduleSource {
  return {
    id: "calendar",
    name: "Calendar",
    async healthCheck() {
      return { healthy: true };
    },
    async fetchEntries() {
      return entries;
    },
  };
}

describe("ScheduleEngine external source sync", () => {
  it("adds and disables entries from schedule source plugins", async () => {
    const tempDir = makeTempDir("schedule-source-sync-");
    try {
      const engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();

      const first = await engine.syncExternalSources([
        makeSource([
          {
            external_id: "standup",
            source_id: "calendar",
            name: "Calendar standup",
            layer: "cron",
            trigger: { type: "interval", seconds: 3600 },
            enabled: true,
            cron: {
              job_kind: "prompt",
              prompt_template: "Summarize standup notes",
              context_sources: [],
              output_format: "notification",
              max_tokens: 100,
            },
            metadata: {},
            synced_at: "2026-04-14T00:00:00.000Z",
          },
        ]),
      ]);

      expect(first).toMatchObject({ added: 1, updated: 0, disabled: 0, skipped: 0 });
      expect(engine.getEntries()[0]).toMatchObject({
        name: "Calendar standup",
        metadata: {
          source: "external",
          external_source_id: "calendar",
          external_id: "standup",
        },
      });

      const second = await engine.syncExternalSources([makeSource([])]);

      expect(second.disabled).toBe(1);
      expect(engine.getEntries()[0]?.enabled).toBe(false);
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("does not disable existing entries when a source cannot be reconciled", async () => {
    const tempDir = makeTempDir("schedule-source-sync-");
    try {
      const engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();

      await engine.syncExternalSources([
        makeSource([
          {
            external_id: "standup",
            source_id: "calendar",
            name: "Calendar standup",
            layer: "cron",
            trigger: { type: "interval", seconds: 3600 },
            enabled: true,
            cron: {
              job_kind: "prompt",
              prompt_template: "Summarize standup notes",
              context_sources: [],
              output_format: "notification",
              max_tokens: 100,
            },
            metadata: {},
            synced_at: "2026-04-14T00:00:00.000Z",
          },
        ]),
      ]);

      const failed = await engine.syncExternalSources([
        {
          id: "calendar",
          name: "Calendar",
          async healthCheck() {
            return { healthy: false, error: "temporarily unavailable" };
          },
          async fetchEntries() {
            throw new Error("should not fetch unhealthy source");
          },
        },
      ]);

      expect(failed.disabled).toBe(0);
      expect(failed.errors[0]).toMatchObject({
        source_id: "calendar",
        message: "temporarily unavailable",
      });
      expect(engine.getEntries()[0]?.enabled).toBe(true);
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});
