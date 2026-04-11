import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import type { Report } from "../../../base/types/report.js";
import { writeJsonFileAtomic } from "../../../base/utils/json-io.js";
import { ScheduleEntrySchema } from "../../../runtime/types/schedule.js";
import { projectReportToSoil, projectSchedulesToSoil } from "../projections.js";
import { readSoilMarkdownFile } from "../io.js";

function fixedClock(): Date {
  return new Date("2026-04-11T10:00:00.000Z");
}

describe("Soil projections", () => {
  it("projects saved reports into soil/report markdown", async () => {
    const baseDir = makeTempDir("soil-report-projection-");
    try {
      const report: Report = {
        id: "report-1",
        report_type: "weekly_report",
        goal_id: "goal-1",
        title: "Weekly Review",
        content: "A concise weekly summary.",
        verbosity: "standard",
        generated_at: "2026-04-11T09:00:00.000Z",
        delivered_at: null,
        read: false,
      };
      await writeJsonFileAtomic(path.join(baseDir, "reports", "goal-1", "report-1.json"), report);

      await projectReportToSoil({ report, baseDir, clock: fixedClock });

      const pagePath = path.join(baseDir, "soil", "report", "weekly", "goal-1", "report-1.md");
      const page = await readSoilMarkdownFile(pagePath);
      expect(page?.frontmatter.soil_id).toBe("report/weekly/goal-1/report-1");
      expect(page?.frontmatter.source_truth).toBe("runtime_json");
      expect(page?.frontmatter.generation_watermark.input_checksums).toHaveProperty(
        path.join(baseDir, "reports", "goal-1", "report-1.json")
      );
      expect(page?.body).toContain("A concise weekly summary.");
    } finally {
      cleanupTempDir(baseDir);
    }
  });

  it("projects current schedules into soil/schedule/current.md", async () => {
    const baseDir = makeTempDir("soil-schedule-projection-");
    try {
      const entry = ScheduleEntrySchema.parse({
        id: "11111111-1111-4111-8111-111111111111",
        name: "Daily brief",
        layer: "cron",
        trigger: { type: "cron", expression: "0 9 * * *", timezone: "Asia/Tokyo" },
        enabled: true,
        cron: {
          job_kind: "reflection",
          reflection_kind: "morning_planning",
          prompt_template: "Run morning planning",
          context_sources: [],
          output_format: "report",
          max_tokens: 4000,
        },
        created_at: "2026-04-10T09:00:00.000Z",
        updated_at: "2026-04-11T09:00:00.000Z",
        last_fired_at: null,
        next_fire_at: "2026-04-12T09:00:00.000Z",
        consecutive_failures: 0,
        last_escalation_at: null,
        baseline_results: [],
        total_executions: 0,
        total_tokens_used: 0,
        max_tokens_per_day: 100000,
        tokens_used_today: 0,
        budget_reset_at: null,
        escalation_timestamps: [],
      });
      await writeJsonFileAtomic(path.join(baseDir, "schedules.json"), [entry]);

      await projectSchedulesToSoil({ entries: [entry], baseDir, clock: fixedClock });

      const page = await readSoilMarkdownFile(path.join(baseDir, "soil", "schedule", "current.md"));
      expect(page?.frontmatter.soil_id).toBe("schedule/current");
      expect(page?.frontmatter.summary).toBe("1/1 schedules enabled");
      expect(page?.body).toContain("Daily brief");
      expect(page?.body).toContain("cron 0 9 * * * (Asia/Tokyo)");
    } finally {
      cleanupTempDir(baseDir);
    }
  });
});
