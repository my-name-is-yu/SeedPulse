import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Report } from "../../base/types/report.js";
import type { ScheduleEntry } from "../../runtime/types/schedule.js";
import { computeSoilChecksum } from "./checksum.js";
import { SoilCompiler } from "./compiler.js";
import { SoilPageFrontmatterSchema, type SoilPageFrontmatter } from "./types.js";

const SOIL_PROJECTION_VERSION = "soil-v1";
const SOIL_PAGE_FORMAT_VERSION = "soil-page-v1";

export interface SoilProjectionOptions {
  baseDir: string;
  rootDir?: string;
  clock?: () => Date;
}

export interface ProjectReportToSoilInput extends SoilProjectionOptions {
  report: Report;
}

export interface ProjectSchedulesToSoilInput extends SoilProjectionOptions {
  entries: ScheduleEntry[];
}

function soilRootFromBaseDir(input: SoilProjectionOptions): string {
  return input.rootDir ?? path.join(input.baseDir, "soil");
}

function nowIso(clock?: () => Date): string {
  return (clock?.() ?? new Date()).toISOString();
}

async function hashFile(filePath: string): Promise<string | undefined> {
  try {
    return computeSoilChecksum(await fsp.readFile(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

function summaryFromText(text: string, maxLength = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function reportBucket(reportType: string): string {
  if (reportType.includes("weekly")) {
    return "weekly";
  }
  if (reportType.includes("daily")) {
    return "daily";
  }
  if (reportType.includes("notification")) {
    return "notification";
  }
  return reportType.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function reportSourcePath(baseDir: string, report: Report): string {
  return path.join(baseDir, "reports", report.goal_id ?? "_global", `${report.id}.json`);
}

function baseFrontmatter(input: {
  soilId: string;
  title: string;
  kind: SoilPageFrontmatter["kind"];
  route: SoilPageFrontmatter["route"];
  createdAt: string;
  updatedAt: string;
  generatedAt: string;
  sourcePath: string;
  sourceHash?: string;
  summary?: string;
  goalId?: string | null;
  scheduleId?: string | null;
  domain?: string;
  renderedFrom: string;
}): SoilPageFrontmatter {
  const inputChecksums = input.sourceHash ? { [input.sourcePath]: input.sourceHash } : {};
  return SoilPageFrontmatterSchema.parse({
    soil_id: input.soilId,
    kind: input.kind,
    status: "confirmed",
    title: input.title,
    route: input.route,
    source: "compiled",
    version: "1",
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    generated_at: input.generatedAt,
    source_refs: [
      {
        source_type: "runtime_json",
        source_path: input.sourcePath,
        source_hash: input.sourceHash,
        reliability: "high",
      },
    ],
    generation_watermark: {
      scope: input.soilId,
      source_path: input.sourcePath,
      source_paths: [input.sourcePath],
      source_hash: input.sourceHash,
      source_hashes: input.sourceHash ? [input.sourceHash] : [],
      generated_at: input.generatedAt,
      projection_version: SOIL_PROJECTION_VERSION,
      input_checksums: inputChecksums,
    },
    stale: false,
    manual_overlay: {
      enabled: false,
      status: "candidate",
    },
    goal_id: input.goalId ?? undefined,
    schedule_id: input.scheduleId ?? undefined,
    domain: input.domain,
    summary: input.summary,
    owner: "pulseed",
    source_truth: "runtime_json",
    rendered_from: input.renderedFrom,
    import_status: "none",
    approval_status: "none",
    supersedes: [],
    page_format_version: SOIL_PAGE_FORMAT_VERSION,
  });
}

export async function projectReportToSoil(input: ProjectReportToSoilInput): Promise<void> {
  const generatedAt = nowIso(input.clock);
  const bucket = reportBucket(input.report.report_type);
  const goalSegment = input.report.goal_id ?? "_global";
  const soilId = `report/${bucket}/${goalSegment}/${input.report.id}`;
  const sourcePath = reportSourcePath(input.baseDir, input.report);
  const sourceHash = await hashFile(sourcePath);
  const frontmatter = baseFrontmatter({
    soilId,
    title: input.report.title,
    kind: "report",
    route: "report",
    createdAt: input.report.generated_at,
    updatedAt: input.report.generated_at,
    generatedAt,
    sourcePath,
    sourceHash,
    summary: summaryFromText(input.report.content),
    goalId: input.report.goal_id,
    domain: input.report.report_type,
    renderedFrom: "reporting-engine",
  });
  const body = [
    `# ${input.report.title}`,
    "",
    `- Type: ${input.report.report_type}`,
    `- Goal: ${input.report.goal_id ?? "_global"}`,
    `- Generated: ${input.report.generated_at}`,
    "",
    "## Content",
    "",
    input.report.content,
    "",
  ].join("\n");

  await SoilCompiler.create({ rootDir: soilRootFromBaseDir(input) }, { clock: input.clock }).write({
    frontmatter,
    body,
  });
}

function scheduleTriggerSummary(entry: ScheduleEntry): string {
  if (entry.trigger.type === "cron") {
    return `cron ${entry.trigger.expression} (${entry.trigger.timezone})`;
  }
  return `every ${entry.trigger.seconds}s`;
}

function scheduleBody(entries: ScheduleEntry[]): string {
  const lines = [
    "# Current schedules",
    "",
    `Total: ${entries.length}`,
    "",
    "| Name | Layer | Enabled | Trigger | Next fire | Last fired |",
    "| --- | --- | --- | --- | --- | --- |",
  ];

  for (const entry of entries) {
    lines.push(
      `| ${entry.name} | ${entry.layer} | ${entry.enabled ? "yes" : "no"} | ${scheduleTriggerSummary(entry)} | ${entry.next_fire_at} | ${entry.last_fired_at ?? ""} |`
    );
  }

  lines.push("");
  return lines.join("\n");
}

export async function projectSchedulesToSoil(input: ProjectSchedulesToSoilInput): Promise<void> {
  const generatedAt = nowIso(input.clock);
  const sourcePath = path.join(input.baseDir, "schedules.json");
  const sourceHash = await hashFile(sourcePath);
  const enabledCount = input.entries.filter((entry) => entry.enabled).length;
  const updatedAt = input.entries
    .map((entry) => entry.updated_at)
    .sort()
    .at(-1) ?? generatedAt;
  const createdAt = input.entries
    .map((entry) => entry.created_at)
    .sort()
    .at(0) ?? generatedAt;

  const frontmatter = baseFrontmatter({
    soilId: "schedule/current",
    title: "Current schedules",
    kind: "schedule",
    route: "schedule",
    createdAt,
    updatedAt,
    generatedAt,
    sourcePath,
    sourceHash,
    summary: `${enabledCount}/${input.entries.length} schedules enabled`,
    domain: "schedule",
    renderedFrom: "schedule-engine",
  });

  await SoilCompiler.create({ rootDir: soilRootFromBaseDir(input) }, { clock: input.clock }).write({
    frontmatter,
    body: scheduleBody(input.entries),
  });
}
