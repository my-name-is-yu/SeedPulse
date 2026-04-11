import { describe, expect, it } from "vitest";
import {
  parseSoilMarkdown,
  parseSoilFrontmatter,
  serializeSoilMarkdown,
} from "../frontmatter.js";
import { SoilPageFrontmatterSchema } from "../types.js";

describe("Soil frontmatter schema", () => {
  it("parses a complete frontmatter object", () => {
    const frontmatter = SoilPageFrontmatterSchema.parse({
      soil_id: "report/daily/2026-04-11",
      kind: "report",
      status: "confirmed",
      title: "Daily report",
      route: "report",
      source: "compiled",
      version: "1",
      created_at: "2026-04-11T09:00:00.000Z",
      updated_at: "2026-04-11T09:30:00.000Z",
      generated_at: "2026-04-11T09:30:00.000Z",
      source_refs: [
        {
          source_type: "runtime_json",
          source_path: "reports/daily/2026-04-11.json",
          source_id: "report-001",
          source_hash: "sha256:abc123",
          source_version: "v1",
          source_uri: "file:///tmp/reports/daily/2026-04-11.json",
          fetched_at: "2026-04-11T09:00:00.000Z",
          committed_at: "2026-04-11T09:05:00.000Z",
          reliability: "high",
        },
      ],
      generation_watermark: {
        scope: "report/daily",
        source_path: "reports/daily/2026-04-11.json",
        source_paths: ["reports/daily/2026-04-11.json"],
        source_hash: "sha256:abc123",
        source_hashes: ["sha256:abc123"],
        source_version: "v1",
        source_updated_at: "2026-04-11T09:00:00.000Z",
        generated_at: "2026-04-11T09:30:00.000Z",
        projection_version: "soil-v1",
        input_commit_ids: ["commit-1"],
        input_checksums: { "reports/daily/2026-04-11.json": "sha256:abc123" },
      },
      stale: false,
      manual_overlay: {
        enabled: true,
        status: "confirmed",
        overlay_id: "overlay-1",
        author: "human",
        target_ref: "report/daily/2026-04-11#summary",
        created_at: "2026-04-11T09:10:00.000Z",
        updated_at: "2026-04-11T09:15:00.000Z",
        notes: "Keep this wording.",
      },
      goal_id: "goal-1",
      task_id: "task-1",
      schedule_id: "schedule-1",
      decision_id: "decision-1",
      entry_id: "entry-1",
      domain: "daily-ops",
      confidence: 0.92,
      priority: 2,
      summary: "A concise daily summary.",
      owner: "pulseed",
      source_truth: "runtime_json",
      rendered_from: "reporting-engine",
      import_status: "approved",
      approval_status: "approved",
      approved_at: "2026-04-11T09:20:00.000Z",
      approved_by: "human",
      supersedes: ["report/daily/2026-04-10"],
      superseded_by: "report/daily/2026-04-12",
      checksum: "sha256:def456",
      page_format_version: "soil-page-v1",
    });

    expect(frontmatter.kind).toBe("report");
    expect(frontmatter.manual_overlay.status).toBe("confirmed");
    expect(frontmatter.source_refs[0]?.source_type).toBe("runtime_json");
    expect(frontmatter.generation_watermark.input_commit_ids).toEqual(["commit-1"]);
  });

  it("round-trips markdown frontmatter and body", () => {
    const frontmatter = {
      soil_id: "schedule/active",
      kind: "schedule",
      status: "confirmed",
      title: "Active schedules",
      route: "schedule",
      source: "compiled",
      version: "1",
      created_at: "2026-04-11T09:00:00.000Z",
      updated_at: "2026-04-11T09:30:00.000Z",
      generated_at: "2026-04-11T09:30:00.000Z",
      source_refs: [
        {
          source_type: "soil_md",
          source_path: "soil/schedule/active.md",
          source_uri: "file:///tmp/soil/schedule/active.md",
          fetched_at: "2026-04-11T09:30:00.000Z",
          reliability: "medium",
        },
      ],
      generation_watermark: {
        scope: "schedule/active",
        source_paths: ["runtime/schedules.json"],
        source_hashes: ["sha256:fedcba"],
        generated_at: "2026-04-11T09:30:00.000Z",
        projection_version: "soil-v1",
      },
      stale: false,
      manual_overlay: {
        enabled: false,
        status: "candidate",
      },
      import_status: "none",
      approval_status: "none",
      supersedes: [],
    };

    const body = [
      "# Active schedules",
      "",
      "- Daily brief: morning planning",
      "- Dream consolidation: deep dream",
      "",
    ].join("\n");

    const markdown = serializeSoilMarkdown(SoilPageFrontmatterSchema.parse(frontmatter), body);
    const parsed = parseSoilMarkdown(markdown);

    expect(parsed.frontmatter).toEqual(SoilPageFrontmatterSchema.parse(frontmatter));
    expect(parsed.body).toBe(body);
  });

  it("parses frontmatter block directly", () => {
    const markdown = [
      "---",
      "soil_id: note/1",
      "kind: note",
      "status: draft",
      "title: note",
      "route: inbox",
      "source: manual",
      "version: \"1\"",
      "created_at: 2026-04-11T09:00:00.000Z",
      "updated_at: 2026-04-11T09:00:00.000Z",
      "generated_at: 2026-04-11T09:00:00.000Z",
      "source_refs: []",
      "generation_watermark:",
      "  scope: note/1",
      "  source_paths: []",
      "  source_hashes: []",
      "  generated_at: 2026-04-11T09:00:00.000Z",
      "  projection_version: soil-v1",
      "stale: false",
      "manual_overlay:",
      "  enabled: false",
      "  status: candidate",
      "---",
      "Body",
    ].join("\n");

    const frontmatter = parseSoilFrontmatter(markdown);
    expect(frontmatter.soil_id).toBe("note/1");
    expect(frontmatter.kind).toBe("note");
  });
});

