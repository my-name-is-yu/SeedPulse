import { z } from "zod";

const PID_EPOCH_ISO = "1970-01-01T00:00:00.000Z";

// Daemon configuration
export const DaemonConfigSchema = z.object({
  // Deprecated compatibility flag. Durable runtime recovery is always enabled.
  runtime_journal_v2: z.boolean().default(true),
  check_interval_ms: z.number().int().positive().default(300_000), // 5 min default
  pid_file: z.string().default("pulseed.pid"),
  log_dir: z.string().default("logs"),
  runtime_root: z.string().optional(),
  workspace_path: z.string().optional(),
  log_rotation: z.object({
    max_size_mb: z.number().positive().default(10),
    max_files: z.number().int().positive().default(5),
  }).default({}),
  crash_recovery: z.object({
    enabled: z.boolean().default(true),
    max_retries: z.number().int().nonnegative().default(3),
    retry_delay_ms: z.number().int().positive().default(10_000),
    graceful_shutdown_timeout_ms: z.number().int().positive().optional(),
  }).default({}),
  goal_intervals: z.record(z.string(), z.number().int().positive()).optional(), // goal_id -> interval_ms override
  iterations_per_cycle: z.number().int().positive().default(10), // max CoreLoop iterations per daemon cycle
  max_concurrent_goals: z.number().int().positive().default(4), // max goals the supervisor may execute at once
  event_server_port: z.number().int().nonnegative().default(41700), // EventServer HTTP port (0 = OS-assigned, safe for tests)
  gateway: z.object({
    slack: z.object({
      enabled: z.boolean().default(false),
      signing_secret: z.string().optional(),
      path: z.string().default("/slack/events"),
      channel_goal_map: z.record(z.string()).default({}),
    }).default({}),
  }).default({}),
  proactive_mode: z.boolean().default(false),
  proactive_interval_ms: z.number().default(3_600_000), // 1 hour minimum between proactive ticks
  goal_review_interval_ms: z.number().int().nonnegative().default(7 * 24 * 60 * 60 * 1000), // weekly goal review cadence
  adaptive_sleep: z.object({
    enabled: z.boolean().default(false),
    min_interval_ms: z.number().default(60_000),      // 1 minute minimum
    max_interval_ms: z.number().default(1_800_000),    // 30 minutes maximum
    night_start_hour: z.number().default(22),           // 22:00
    night_end_hour: z.number().default(7),              // 07:00
    night_multiplier: z.number().default(2.0),          // 2x interval at night
  }).default({}),
});
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;

export const ResidentActivitySchema = z.object({
  kind: z.enum(["sleep", "suggestion", "negotiation", "curiosity", "dream", "observation", "skipped", "error"]),
  trigger: z.enum(["proactive_tick", "schedule", "external"]).default("proactive_tick"),
  summary: z.string(),
  recorded_at: z.string().datetime(),
  suggestion_title: z.string().optional(),
  goal_id: z.string().optional(),
});
export type ResidentActivity = z.infer<typeof ResidentActivitySchema>;

// Daemon runtime state
export const DaemonStateSchema = z.object({
  pid: z.number().int().positive(),
  started_at: z.string().datetime(),
  last_loop_at: z.string().datetime().nullable(),
  loop_count: z.number().int().nonnegative(),
  active_goals: z.array(z.string()),
  status: z.enum(["idle", "running", "stopping", "stopped", "crashed"]),
  crash_count: z.number().int().nonnegative().default(0),
  last_error: z.string().nullable().default(null),
  interrupted_goals: z.array(z.string()).optional(),
  last_resident_at: z.string().datetime().nullable().default(null),
  resident_activity: ResidentActivitySchema.nullable().default(null),
});
export type DaemonState = z.infer<typeof DaemonStateSchema>;

// PID file info
export const PIDInfoSchema = z.object({
  // Authoritative runtime PID. When a watchdog is present, this is the child daemon PID.
  pid: z.number().int().positive(),
  started_at: z.string().datetime().default(PID_EPOCH_ISO),
  runtime_started_at: z.string().datetime().optional(),
  // Process that should receive lifecycle signals. When a watchdog is present, this is the parent PID.
  owner_pid: z.number().int().positive().optional(),
  owner_started_at: z.string().datetime().optional(),
  // Explicit watchdog parent PID when running under the watchdog.
  watchdog_pid: z.number().int().positive().optional(),
  watchdog_started_at: z.string().datetime().optional(),
  // Explicit daemon/runtime child PID when running under the watchdog.
  runtime_pid: z.number().int().positive().optional(),
  version: z.string().optional(),
});
export type PIDInfo = z.infer<typeof PIDInfoSchema>;
