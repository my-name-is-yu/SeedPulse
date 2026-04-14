import { parseArgs } from "node:util";
import type { ScheduleEntryUpdateInput, ScheduleEngine } from "../../../../runtime/schedule/engine.js";
import {
  CronConfigSchema,
  EscalationConfigSchema,
  GoalTriggerConfigSchema,
  HeartbeatConfigSchema,
  ProbeConfigSchema,
  ScheduleRetryPolicySchema,
} from "../../../../runtime/types/schedule.js";
import { getScheduleOrPrintError, parseJsonConfig, resolveTriggerPatch } from "./shared.js";

export async function scheduleEdit(engine: ScheduleEngine, argv: string[]): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        name: { type: "string" },
        cron: { type: "string" },
        interval: { type: "string" },
        timezone: { type: "string" },
        enabled: { type: "boolean" },
        disabled: { type: "boolean" },
        "heartbeat-json": { type: "string" },
        "probe-json": { type: "string" },
        "cron-json": { type: "string" },
        "goal-trigger-json": { type: "string" },
        "escalation-json": { type: "string" },
        "clear-escalation": { type: "boolean" },
        "retry-policy-json": { type: "string" },
      },
      strict: false,
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return;
  }

  const id = parsed.positionals[0];
  const entry = getScheduleOrPrintError(engine, id);
  if (!entry) return;

  try {
    const patch = buildScheduleEditPatch(parsed.values as Record<string, unknown>);
    const updated = await engine.updateEntry(entry.id, patch);
    if (!updated) {
      console.error(`No schedule entry found matching: ${id}`);
      return;
    }
    console.log(`Updated schedule entry: ${updated.id} (${updated.name})`);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
  }
}

export function buildScheduleEditPatch(values: Record<string, unknown>): ScheduleEntryUpdateInput {
  if (values.enabled === true && values.disabled === true) {
    throw new Error("Use only one of --enabled or --disabled");
  }
  if (values["escalation-json"] !== undefined && values["clear-escalation"] === true) {
    throw new Error("Use only one of --escalation-json or --clear-escalation");
  }

  const patch: ScheduleEntryUpdateInput = {};
  if (typeof values.name === "string") patch.name = values.name;
  if (values.enabled === true) patch.enabled = true;
  if (values.disabled === true) patch.enabled = false;

  const trigger = resolveTriggerPatch({
    cron: typeof values.cron === "string" ? values.cron : undefined,
    interval: typeof values.interval === "string" ? values.interval : undefined,
    timezone: typeof values.timezone === "string" ? values.timezone : undefined,
  });
  if (trigger) patch.trigger = trigger;

  const heartbeat = parseJsonConfig(values["heartbeat-json"], HeartbeatConfigSchema, "--heartbeat-json");
  if (heartbeat) patch.heartbeat = heartbeat;
  const probe = parseJsonConfig(values["probe-json"], ProbeConfigSchema, "--probe-json");
  if (probe) patch.probe = probe;
  const cron = parseJsonConfig(values["cron-json"], CronConfigSchema, "--cron-json");
  if (cron) patch.cron = cron;
  const goalTrigger = parseJsonConfig(values["goal-trigger-json"], GoalTriggerConfigSchema, "--goal-trigger-json");
  if (goalTrigger) patch.goal_trigger = goalTrigger;
  const escalation = parseJsonConfig(values["escalation-json"], EscalationConfigSchema, "--escalation-json");
  if (escalation) patch.escalation = escalation;
  if (values["clear-escalation"] === true) patch.escalation = null;
  const retryPolicy = parseJsonConfig(values["retry-policy-json"], ScheduleRetryPolicySchema, "--retry-policy-json");
  if (retryPolicy) patch.retry_policy = retryPolicy;

  return patch;
}
