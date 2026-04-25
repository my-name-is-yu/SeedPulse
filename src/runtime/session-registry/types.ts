import { z } from "zod";

export const RuntimeSessionKindSchema = z.enum(["conversation", "agent", "coreloop"]);
export type RuntimeSessionKind = z.infer<typeof RuntimeSessionKindSchema>;

export const RuntimeSessionStatusSchema = z.enum(["active", "idle", "ended", "lost", "unknown"]);
export type RuntimeSessionStatus = z.infer<typeof RuntimeSessionStatusSchema>;

export const BackgroundRunKindSchema = z.enum(["agent_run", "coreloop_run", "process_run"]);
export type BackgroundRunKind = z.infer<typeof BackgroundRunKindSchema>;

export const BackgroundRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "lost",
  "unknown",
]);
export type BackgroundRunStatus = z.infer<typeof BackgroundRunStatusSchema>;

export const BackgroundRunReplyTargetSourceSchema = z.enum(["pinned_run", "parent_session", "none"]);
export type BackgroundRunReplyTargetSource = z.infer<typeof BackgroundRunReplyTargetSourceSchema>;

export const RuntimeSessionRefKindSchema = z.enum([
  "chat_session",
  "agentloop_state",
  "agentloop_trace",
  "daemon_snapshot",
  "supervisor_state",
  "task_ledger",
  "process_session",
  "runtime_health",
  "artifact",
]);
export type RuntimeSessionRefKind = z.infer<typeof RuntimeSessionRefKindSchema>;

export const RuntimeArtifactKindSchema = z.enum(["log", "metrics", "report", "diff", "url", "other"]);
export type RuntimeArtifactKind = z.infer<typeof RuntimeArtifactKindSchema>;

export const RuntimeSessionWarningCodeSchema = z.enum([
  "source_unavailable",
  "source_parse_failed",
  "stale_source",
  "conflicting_status",
  "missing_parent_join",
  "dead_process_sidecar",
  "reply_target_not_durable",
]);
export type RuntimeSessionWarningCode = z.infer<typeof RuntimeSessionWarningCodeSchema>;

export const RuntimeSessionRefSchema = z.object({
  kind: RuntimeSessionRefKindSchema,
  id: z.string().nullable(),
  path: z.string().nullable(),
  relative_path: z.string().nullable(),
  updated_at: z.string().nullable(),
});
export type RuntimeSessionRef = z.infer<typeof RuntimeSessionRefSchema>;

export const RuntimeArtifactRefSchema = z.object({
  label: z.string(),
  path: z.string().nullable(),
  url: z.string().nullable(),
  kind: RuntimeArtifactKindSchema,
});
export type RuntimeArtifactRef = z.infer<typeof RuntimeArtifactRefSchema>;

export const RuntimeReplyTargetSchema = z.object({
  channel: z.string(),
  target_id: z.string().nullable().optional(),
  thread_id: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
}).passthrough();
export type RuntimeReplyTarget = z.infer<typeof RuntimeReplyTargetSchema>;

export const RuntimeSessionSchema = z.object({
  schema_version: z.literal("runtime-session-v1"),
  id: z.string(),
  kind: RuntimeSessionKindSchema,
  parent_session_id: z.string().nullable(),
  title: z.string().nullable(),
  workspace: z.string().nullable(),
  status: RuntimeSessionStatusSchema,
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  last_event_at: z.string().nullable(),
  transcript_ref: RuntimeSessionRefSchema.nullable(),
  state_ref: RuntimeSessionRefSchema.nullable(),
  reply_target: RuntimeReplyTargetSchema.nullable(),
  resumable: z.boolean(),
  attachable: z.boolean(),
  source_refs: z.array(RuntimeSessionRefSchema),
});
export type RuntimeSession = z.infer<typeof RuntimeSessionSchema>;

export const BackgroundRunSchema = z.object({
  schema_version: z.literal("background-run-v1"),
  id: z.string(),
  kind: BackgroundRunKindSchema,
  parent_session_id: z.string().nullable(),
  child_session_id: z.string().nullable(),
  process_session_id: z.string().nullable(),
  status: BackgroundRunStatusSchema,
  notify_policy: z.enum(["silent", "done_only", "state_changes"]),
  reply_target_source: BackgroundRunReplyTargetSourceSchema,
  pinned_reply_target: RuntimeReplyTargetSchema.nullable(),
  title: z.string().nullable(),
  workspace: z.string().nullable(),
  created_at: z.string().nullable(),
  started_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  artifacts: z.array(RuntimeArtifactRefSchema),
  source_refs: z.array(RuntimeSessionRefSchema),
});
export type BackgroundRun = z.infer<typeof BackgroundRunSchema>;

export const RuntimeSessionRegistryWarningSchema = z.object({
  code: RuntimeSessionWarningCodeSchema,
  source: RuntimeSessionRefSchema.nullable(),
  message: z.string(),
});
export type RuntimeSessionRegistryWarning = z.infer<typeof RuntimeSessionRegistryWarningSchema>;

export const RuntimeSessionRegistrySnapshotSchema = z.object({
  schema_version: z.literal("runtime-session-registry-v1"),
  generated_at: z.string(),
  sessions: z.array(RuntimeSessionSchema),
  background_runs: z.array(BackgroundRunSchema),
  warnings: z.array(RuntimeSessionRegistryWarningSchema),
});
export type RuntimeSessionRegistrySnapshot = z.infer<typeof RuntimeSessionRegistrySnapshotSchema>;

export interface RuntimeSessionFilter {
  kind?: RuntimeSessionKind;
  status?: RuntimeSessionStatus;
  activeOnly?: boolean;
}

export interface BackgroundRunFilter {
  kind?: BackgroundRunKind;
  status?: BackgroundRunStatus;
  activeOnly?: boolean;
  attentionOnly?: boolean;
}
