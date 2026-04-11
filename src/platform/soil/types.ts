import { z } from "zod";

export const SoilRouteSchema = z.enum([
  "index",
  "status",
  "health",
  "report",
  "schedule",
  "memory",
  "knowledge",
  "decision",
  "identity",
  "goal",
  "task",
  "timeline",
  "operations",
  "inbox",
]);
export type SoilRoute = z.infer<typeof SoilRouteSchema>;

export const SoilKindSchema = z.enum([
  "index",
  "status",
  "health",
  "report",
  "schedule",
  "memory",
  "knowledge",
  "decision",
  "identity",
  "goal",
  "task",
  "timeline",
  "operations",
  "inbox",
  "overlay",
  "note",
]);
export type SoilKind = z.infer<typeof SoilKindSchema>;

export const SoilStatusSchema = z.enum([
  "draft",
  "candidate",
  "confirmed",
  "stale",
  "superseded",
  "rejected",
  "deprecated",
  "archived",
]);
export type SoilStatus = z.infer<typeof SoilStatusSchema>;

export const SoilSourceSchema = z.enum(["runtime", "compiled", "manual", "imported"]);
export type SoilSource = z.infer<typeof SoilSourceSchema>;

export const SoilSourceTruthSchema = z.enum(["runtime_json", "soil", "mixed"]);
export type SoilSourceTruth = z.infer<typeof SoilSourceTruthSchema>;

export const SoilImportStatusSchema = z.enum(["none", "pending", "approved", "rejected"]);
export type SoilImportStatus = z.infer<typeof SoilImportStatusSchema>;

export const SoilApprovalStatusSchema = z.enum(["none", "pending", "approved", "rejected"]);
export type SoilApprovalStatus = z.infer<typeof SoilApprovalStatusSchema>;

export const SoilSourceTypeSchema = z.enum([
  "runtime_json",
  "controlled_md",
  "soil_md",
  "manual_overlay",
  "web",
  "tool_output",
  "log",
]);
export type SoilSourceType = z.infer<typeof SoilSourceTypeSchema>;

const datetimeSchema = z.preprocess((value) => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}, z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Must be a valid ISO-8601 datetime string"));

export const SoilSourceRefSchema = z.object({
  source_type: SoilSourceTypeSchema,
  source_path: z.string().min(1),
  source_id: z.string().min(1).optional(),
  source_hash: z.string().min(1).optional(),
  source_version: z.string().min(1).optional(),
  source_uri: z.string().min(1).optional(),
  fetched_at: datetimeSchema.optional(),
  committed_at: datetimeSchema.optional(),
  reliability: z.enum(["high", "medium", "low"]).optional(),
});
export type SoilSourceRef = z.infer<typeof SoilSourceRefSchema>;

export const SoilGenerationWatermarkSchema = z.object({
  scope: z.string().min(1),
  source_path: z.string().min(1).optional(),
  source_paths: z.array(z.string().min(1)).default([]),
  source_hash: z.string().min(1).optional(),
  source_hashes: z.array(z.string().min(1)).default([]),
  source_version: z.string().min(1).optional(),
  source_updated_at: datetimeSchema.optional(),
  generated_at: datetimeSchema,
  projection_version: z.string().min(1),
  input_commit_ids: z.array(z.string().min(1)).default([]),
  input_checksums: z.record(z.string()).default({}),
});
export type SoilGenerationWatermark = z.infer<typeof SoilGenerationWatermarkSchema>;

export const SoilManualOverlayStatusSchema = z.enum([
  "candidate",
  "confirmed",
  "rejected",
  "superseded",
]);
export type SoilManualOverlayStatus = z.infer<typeof SoilManualOverlayStatusSchema>;

export const SoilManualOverlaySchema = z.object({
  enabled: z.boolean().default(false),
  status: SoilManualOverlayStatusSchema.default("candidate"),
  overlay_id: z.string().min(1).optional(),
  author: z.string().min(1).optional(),
  target_ref: z.string().min(1).optional(),
  created_at: datetimeSchema.optional(),
  updated_at: datetimeSchema.optional(),
  notes: z.string().optional(),
});
export type SoilManualOverlay = z.infer<typeof SoilManualOverlaySchema>;

export const SoilPageFrontmatterSchema = z
  .object({
    soil_id: z.string().min(1),
    kind: SoilKindSchema,
    status: SoilStatusSchema,
    title: z.string().min(1),
    route: SoilRouteSchema,
    source: SoilSourceSchema,
    version: z.string().min(1),
    created_at: datetimeSchema,
    updated_at: datetimeSchema,
    generated_at: datetimeSchema,
    source_refs: z.array(SoilSourceRefSchema).default([]),
    generation_watermark: SoilGenerationWatermarkSchema,
    stale: z.boolean().default(false),
    manual_overlay: SoilManualOverlaySchema.default({ enabled: false, status: "candidate" }),
    goal_id: z.string().min(1).optional(),
    task_id: z.string().min(1).optional(),
    schedule_id: z.string().min(1).optional(),
    decision_id: z.string().min(1).optional(),
    entry_id: z.string().min(1).optional(),
    domain: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    priority: z.number().int().optional(),
    summary: z.string().optional(),
    owner: z.string().min(1).optional(),
    source_truth: SoilSourceTruthSchema.optional(),
    rendered_from: z.string().min(1).optional(),
    import_status: SoilImportStatusSchema.default("none"),
    approval_status: SoilApprovalStatusSchema.default("none"),
    approved_at: datetimeSchema.optional(),
    approved_by: z.string().min(1).optional(),
    supersedes: z.array(z.string().min(1)).default([]),
    superseded_by: z.string().min(1).optional(),
    checksum: z.string().min(1).optional(),
    page_format_version: z.string().min(1).optional(),
  })
  .passthrough();
export type SoilPageFrontmatter = z.infer<typeof SoilPageFrontmatterSchema>;

export function isSoilDatetime(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}
