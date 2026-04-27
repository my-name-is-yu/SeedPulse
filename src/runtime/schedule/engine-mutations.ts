import { randomUUID } from "node:crypto";
import {
  CronExpressionParser,
} from "cron-parser";
import {
  ScheduleEntrySchema,
  type CronConfig,
  type EscalationConfig,
  type GoalTriggerConfig,
  type HeartbeatConfig,
  type ProbeConfig,
  type ScheduleEntry,
  type ScheduleEntryInput,
  type ScheduleTriggerInput,
  type ScheduleRetryPolicy,
} from "../types/schedule.js";
import {
  CronConfigSchema,
  GoalTriggerConfigSchema,
  HeartbeatConfigSchema,
  ProbeConfigSchema,
} from "../types/schedule.js";
import { ExternalScheduleEntrySchema, type ExternalScheduleEntry, type IScheduleSource } from "./source.js";

export type ScheduleEntryUpdateInput = Partial<{
  name: string;
  enabled: boolean;
  trigger: ScheduleTriggerInput;
  heartbeat: HeartbeatConfig;
  probe: ProbeConfig;
  cron: CronConfig;
  goal_trigger: GoalTriggerConfig;
  escalation: EscalationConfig | null;
  retry_policy: ScheduleRetryPolicy;
}>;

type MutableScheduleEntryInput = Omit<
  ScheduleEntryInput,
  | "id"
  | "created_at"
  | "updated_at"
  | "last_fired_at"
  | "next_fire_at"
  | "consecutive_failures"
  | "last_escalation_at"
  | "baseline_results"
  | "total_executions"
  | "total_tokens_used"
  | "max_tokens_per_day"
  | "tokens_used_today"
  | "budget_reset_at"
  | "escalation_timestamps"
>;

export interface ScheduleMutationHost {
  entries: ScheduleEntry[];
  saveEntries(): Promise<void>;
  refreshEntriesForMutation(): Promise<void>;
  withScheduleMutation<T>(mutate: () => Promise<T>): Promise<T>;
}

export function computeNextFireAt(trigger: ScheduleTriggerInput): string {
  if (trigger.type === "cron") {
    const next = CronExpressionParser.parse(trigger.expression, { tz: trigger.timezone || "UTC" }).next();
    return next.toISOString() ?? new Date().toISOString();
  }
  let nextTime = new Date(Date.now() + trigger.seconds * 1000);
  if (trigger.jitter_factor && trigger.jitter_factor > 0) {
    const jitterMs = trigger.seconds * 1000 * trigger.jitter_factor * (Math.random() * 2 - 1);
    nextTime = new Date(nextTime.getTime() + jitterMs);
  }
  const minTime = Date.now() + 1000;
  if (nextTime.getTime() < minTime) {
    nextTime = new Date(minTime);
  }
  return nextTime.toISOString();
}

export async function syncExternalSourcesForEngine(
  host: ScheduleMutationHost,
  sources: IScheduleSource[],
): Promise<{
  added: number;
  updated: number;
  disabled: number;
  skipped: number;
  errors: Array<{ source_id: string; message: string }>;
}> {
  return host.withScheduleMutation(async () => {
    const seenKeys = new Set<string>();
    const reconciledSourceIds = new Set<string>();
    const errors: Array<{ source_id: string; message: string }> = [];
    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (const source of sources) {
      try {
        const health = await source.healthCheck();
        if (!health.healthy) {
          errors.push({ source_id: source.id, message: health.error ?? "source is unhealthy" });
          continue;
        }

        const rawEntries = await source.fetchEntries();
        const sourceIdsFromFetchedEntries = new Set<string>([source.id]);
        let sourceHadEntryErrors = false;

        for (const raw of rawEntries) {
          const parsed = ExternalScheduleEntrySchema.safeParse(raw);
          if (!parsed.success) {
            sourceHadEntryErrors = true;
            skipped++;
            errors.push({ source_id: source.id, message: parsed.error.message });
            continue;
          }

          const external = parsed.data;
          sourceIdsFromFetchedEntries.add(external.source_id);
          const entryInput = buildExternalScheduleEntryInput(external);
          if (!entryInput) {
            sourceHadEntryErrors = true;
            skipped++;
            errors.push({ source_id: external.source_id, message: `missing ${external.layer} config for ${external.external_id}` });
            continue;
          }

          const key = externalEntryKey(external.source_id, external.external_id);
          seenKeys.add(key);
          const existingIndex = host.entries.findIndex((entry) =>
            entry.metadata?.source === "external" &&
            entry.metadata.external_source_id === external.source_id &&
            entry.metadata.external_id === external.external_id
          );

          if (existingIndex === -1) {
            host.entries.push(ScheduleEntrySchema.parse({
              ...entryInput,
              id: randomUUID(),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              last_fired_at: null,
              next_fire_at: computeNextFireAt(entryInput.trigger),
              consecutive_failures: 0,
              last_escalation_at: null,
              baseline_results: [],
              total_executions: 0,
              total_tokens_used: 0,
            }));
            added++;
            continue;
          }

          const existing = host.entries[existingIndex]!;
          const candidate = ScheduleEntrySchema.parse({
            ...existing,
            ...entryInput,
            id: existing.id,
            created_at: existing.created_at,
            updated_at: existing.updated_at,
            next_fire_at: JSON.stringify(existing.trigger) === JSON.stringify(entryInput.trigger)
              ? existing.next_fire_at
              : computeNextFireAt(entryInput.trigger),
          });
          if (JSON.stringify(existing) !== JSON.stringify(candidate)) {
            host.entries[existingIndex] = ScheduleEntrySchema.parse({
              ...candidate,
              updated_at: new Date().toISOString(),
            });
            updated++;
          }
        }

        if (!sourceHadEntryErrors) {
          for (const sourceId of sourceIdsFromFetchedEntries) {
            reconciledSourceIds.add(sourceId);
          }
        }
      } catch (error) {
        errors.push({ source_id: source.id, message: error instanceof Error ? error.message : String(error) });
      }
    }

    let disabled = 0;
    host.entries = host.entries.map((entry) => {
      if (
        entry.metadata?.source !== "external" ||
        !entry.enabled ||
        !entry.metadata.external_source_id ||
        !reconciledSourceIds.has(entry.metadata.external_source_id)
      ) {
        return entry;
      }

      const key = externalEntryKey(entry.metadata.external_source_id, entry.metadata.external_id ?? "");
      if (seenKeys.has(key)) {
        return entry;
      }

      disabled++;
      return ScheduleEntrySchema.parse({
        ...entry,
        enabled: false,
        updated_at: new Date().toISOString(),
      });
    });

    if (added > 0 || updated > 0 || disabled > 0) {
      await host.saveEntries();
    }

    return { added, updated, disabled, skipped, errors };
  });
}

export async function addEntryForEngine(
  host: ScheduleMutationHost,
  input: MutableScheduleEntryInput
): Promise<ScheduleEntry> {
  return host.withScheduleMutation(async () => addEntryInMemory(host, input));
}

export function addEntryInMemory(
  host: Pick<ScheduleMutationHost, "entries">,
  input: MutableScheduleEntryInput
): ScheduleEntry {
  const now = new Date().toISOString();
  const entry = ScheduleEntrySchema.parse({
    ...input,
    id: randomUUID(),
    created_at: now,
    updated_at: now,
    last_fired_at: null,
    next_fire_at: computeNextFireAt(input.trigger),
    consecutive_failures: 0,
    last_escalation_at: null,
    baseline_results: [],
    total_executions: 0,
    total_tokens_used: 0,
  });
  host.entries.push(entry);
  return entry;
}

export async function removeEntryForEngine(host: ScheduleMutationHost, id: string): Promise<boolean> {
  return host.withScheduleMutation(async () => {
    const before = host.entries.length;
    host.entries = host.entries.filter((e) => e.id !== id);
    return host.entries.length !== before;
  });
}

export async function updateEntryForEngine(
  host: ScheduleMutationHost,
  id: string,
  patch: ScheduleEntryUpdateInput
): Promise<ScheduleEntry | null> {
  return host.withScheduleMutation(async () => {
    const idx = host.entries.findIndex((entry) => entry.id === id);
    if (idx === -1) return null;

    const hasUpdatableFields =
      patch.name !== undefined ||
      patch.enabled !== undefined ||
      patch.trigger !== undefined ||
      patch.heartbeat !== undefined ||
      patch.probe !== undefined ||
      patch.cron !== undefined ||
      patch.goal_trigger !== undefined ||
      patch.escalation !== undefined ||
      patch.retry_policy !== undefined;

    if (!hasUpdatableFields) {
      throw new Error("No updatable fields provided");
    }

    const current = host.entries[idx]!;
    const layerConfigFields = [
      ["heartbeat", patch.heartbeat],
      ["probe", patch.probe],
      ["cron", patch.cron],
      ["goal_trigger", patch.goal_trigger],
    ] as const;

    for (const [field, value] of layerConfigFields) {
      if (value === undefined) continue;
      if (current.layer !== field) {
        throw new Error(`Cannot update ${field} config for ${current.layer} entry`);
      }
    }

    const nextEntry: ScheduleEntryInput = { ...current };
    if (patch.name !== undefined) nextEntry.name = patch.name;
    if (patch.enabled !== undefined) nextEntry.enabled = patch.enabled;
    if (patch.trigger !== undefined) nextEntry.trigger = patch.trigger;
    if (patch.heartbeat !== undefined) nextEntry.heartbeat = patch.heartbeat;
    if (patch.probe !== undefined) nextEntry.probe = patch.probe;
    if (patch.cron !== undefined) nextEntry.cron = patch.cron;
    if (patch.goal_trigger !== undefined) nextEntry.goal_trigger = patch.goal_trigger;
    if (patch.retry_policy !== undefined) nextEntry.retry_policy = patch.retry_policy;

    if (patch.escalation !== undefined) {
      if (patch.escalation === null) {
        delete nextEntry.escalation;
      } else {
        nextEntry.escalation = patch.escalation;
      }
    }

    if (patch.trigger !== undefined || (current.enabled === false && patch.enabled === true)) {
      nextEntry.next_fire_at = computeNextFireAt(nextEntry.trigger);
      nextEntry.retry_state = null;
    }

    nextEntry.updated_at = new Date().toISOString();
    const parsedEntry = ScheduleEntrySchema.parse(nextEntry);
    const nextEntries = [...host.entries];
    nextEntries[idx] = parsedEntry;
    host.entries = nextEntries;
    return parsedEntry;
  });
}

function externalEntryKey(sourceId: string, externalId: string): string {
  return `${sourceId}:${externalId}`;
}

function buildExternalScheduleEntryInput(external: ExternalScheduleEntry): MutableScheduleEntryInput | null {
  const base = {
    name: external.name,
    layer: external.layer,
    trigger: external.trigger.type === "cron"
      ? { type: "cron" as const, expression: external.trigger.expression!, timezone: "UTC" }
      : { type: "interval" as const, seconds: external.trigger.seconds!, jitter_factor: 0 },
    enabled: external.enabled,
    metadata: {
      source: "external" as const,
      external_source_id: external.source_id,
      external_id: external.external_id,
      dependency_hints: [],
      note: typeof external.metadata["note"] === "string" ? external.metadata["note"] : undefined,
    },
  };

  if (external.layer === "heartbeat") {
    const parsed = HeartbeatConfigSchema.safeParse(external.heartbeat ?? external.metadata["heartbeat"]);
    return parsed.success ? { ...base, heartbeat: parsed.data } : null;
  }
  if (external.layer === "probe") {
    const parsed = ProbeConfigSchema.safeParse(external.probe ?? external.metadata["probe"]);
    return parsed.success ? { ...base, probe: parsed.data } : null;
  }
  if (external.layer === "cron") {
    const parsed = CronConfigSchema.safeParse(external.cron ?? external.metadata["cron"]);
    return parsed.success ? { ...base, cron: parsed.data } : null;
  }

  const parsed = GoalTriggerConfigSchema.safeParse(external.goal_trigger ?? external.metadata["goal_trigger"]);
  return parsed.success ? { ...base, goal_trigger: parsed.data } : null;
}
