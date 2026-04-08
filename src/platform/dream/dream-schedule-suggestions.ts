import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../../base/utils/json-io.js";
import { ScheduleEngine } from "../../runtime/schedule-engine.js";
import {
  ScheduleTriggerSchema,
  type ScheduleEntry,
  type ScheduleEntryInput,
  type ScheduleTriggerInput,
} from "../../runtime/types/schedule.js";
import {
  ScheduleSuggestionFileSchema,
  ScheduleSuggestionSchema,
  type ScheduleSuggestion,
} from "./dream-types.js";

const DREAM_SCHEDULE_SUGGESTIONS_FILE = path.join("dream", "schedule-suggestions.json");

type CreateScheduleEntryInput = Omit<
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

export interface ResolvedScheduleSuggestion extends ScheduleSuggestion {
  id: string;
  status: "pending" | "applied" | "rejected" | "dismissed";
}

function normalizeSuggestion(input: ScheduleSuggestion): ResolvedScheduleSuggestion {
  return {
    ...input,
    id: input.id ?? randomUUID(),
    status: input.status ?? "pending",
  };
}

function normalizeTrigger(trigger: ScheduleTriggerInput): ScheduleTriggerInput {
  const parsed = ScheduleTriggerSchema.parse(trigger);
  return parsed.type === "cron"
    ? { type: "cron", expression: parsed.expression, timezone: parsed.timezone }
    : { type: "interval", seconds: parsed.seconds, jitter_factor: parsed.jitter_factor };
}

function resolveSuggestionTrigger(suggestion: ResolvedScheduleSuggestion): ScheduleTriggerInput {
  if (suggestion.trigger) {
    return normalizeTrigger(suggestion.trigger);
  }
  const trimmed = suggestion.proposal.trim();
  if (trimmed.length === 0) {
    throw new Error("Dream suggestion does not include a trigger proposal");
  }
  return {
    type: "cron",
    expression: trimmed,
    timezone: "UTC",
  };
}

function triggersEqual(left: ScheduleTriggerInput, right: ScheduleTriggerInput): boolean {
  const a = normalizeTrigger(left);
  const b = normalizeTrigger(right);
  if (a.type !== b.type) return false;
  if (a.type === "cron" && b.type === "cron") {
    return a.expression === b.expression && (a.timezone ?? "UTC") === (b.timezone ?? "UTC");
  }
  if (a.type === "interval" && b.type === "interval") {
    return a.seconds === b.seconds && (a.jitter_factor ?? 0) === (b.jitter_factor ?? 0);
  }
  return false;
}

function entriesEquivalent(existing: ScheduleEntry, candidate: CreateScheduleEntryInput): boolean {
  if (existing.layer !== candidate.layer) return false;
  if (!triggersEqual(existing.trigger, candidate.trigger)) return false;

  if (existing.metadata?.dream_suggestion_id && existing.metadata.dream_suggestion_id === candidate.metadata?.dream_suggestion_id) {
    return true;
  }

  if (existing.layer === "goal_trigger" && candidate.layer === "goal_trigger") {
    return existing.goal_trigger?.goal_id === candidate.goal_trigger?.goal_id;
  }

  if (existing.layer === "cron" && candidate.layer === "cron") {
    return existing.name === candidate.name && existing.cron?.report_type === candidate.cron?.report_type;
  }

  if (existing.layer === "probe" && candidate.layer === "probe") {
    return existing.probe?.data_source_id === candidate.probe?.data_source_id;
  }

  return existing.name === candidate.name;
}

function buildEntryFromSuggestion(suggestion: ResolvedScheduleSuggestion): CreateScheduleEntryInput {
  const trigger = resolveSuggestionTrigger(suggestion);

  if ((suggestion.type === "goal_trigger" || suggestion.type === "cron") && suggestion.goalId) {
    return {
      name: suggestion.name ?? `Dream goal trigger: ${suggestion.goalId}`,
      layer: "goal_trigger",
      trigger,
      enabled: true,
      metadata: {
        source: "dream",
        dream_suggestion_id: suggestion.id,
        dependency_hints: ["core_loop", "state_manager"],
        note: suggestion.reason,
      },
      goal_trigger: {
        goal_id: suggestion.goalId,
        max_iterations: 10,
        skip_if_active: true,
      },
    };
  }

  return {
    name: suggestion.name ?? "Dream scheduled follow-up",
    layer: "cron",
    trigger,
    enabled: true,
    metadata: {
      source: "dream",
      dream_suggestion_id: suggestion.id,
      dependency_hints: ["llm_client", "notification_dispatcher"],
      note: suggestion.reason,
    },
    cron: {
      job_kind: "prompt",
      prompt_template: `Review this dream-generated schedule suggestion and act if appropriate:\n${suggestion.reason}`,
      context_sources: [],
      output_format: "notification",
      report_type: "dream_schedule_followup",
      max_tokens: 800,
    },
  };
}

export class DreamScheduleSuggestionStore {
  private readonly filePath: string;

  constructor(private readonly baseDir: string) {
    this.filePath = path.join(baseDir, DREAM_SCHEDULE_SUGGESTIONS_FILE);
  }

  async load(): Promise<{ generated_at: string; suggestions: ResolvedScheduleSuggestion[] }> {
    const raw = await readJsonFileOrNull(this.filePath);
    if (raw === null) {
      return {
        generated_at: new Date(0).toISOString(),
        suggestions: [],
      };
    }

    const parsed = ScheduleSuggestionFileSchema.parse(raw);
    return {
      generated_at: parsed.generated_at,
      suggestions: parsed.suggestions.map(normalizeSuggestion),
    };
  }

  async list(): Promise<ResolvedScheduleSuggestion[]> {
    const data = await this.load();
    return data.suggestions;
  }

  async save(suggestions: ResolvedScheduleSuggestion[], generatedAt?: string): Promise<void> {
    await writeJsonFileAtomic(this.filePath, {
      generated_at: generatedAt ?? new Date().toISOString(),
      suggestions: suggestions.map((suggestion) => ScheduleSuggestionSchema.parse(suggestion)),
    });
  }

  async resolveSuggestion(idOrPrefix: string): Promise<ResolvedScheduleSuggestion | null> {
    const suggestions = await this.list();
    return suggestions.find((item) => item.id === idOrPrefix || item.id.startsWith(idOrPrefix)) ?? null;
  }

  async markDecision(
    idOrPrefix: string,
    status: "rejected" | "dismissed",
    reason?: string,
  ): Promise<ResolvedScheduleSuggestion> {
    const data = await this.load();
    const index = data.suggestions.findIndex((item) => item.id === idOrPrefix || item.id.startsWith(idOrPrefix));
    if (index === -1) {
      throw new Error(`Dream suggestion not found: ${idOrPrefix}`);
    }

    const current = data.suggestions[index]!;
    if (current.status === "applied") {
      throw new Error(`Dream suggestion ${current.id} was already applied`);
    }

    const next: ResolvedScheduleSuggestion = {
      ...current,
      status,
      decided_at: new Date().toISOString(),
      decision_reason: reason,
    };
    data.suggestions[index] = next;
    await this.save(data.suggestions, data.generated_at);
    return next;
  }

  async applySuggestion(
    idOrPrefix: string,
    scheduleEngine: ScheduleEngine,
  ): Promise<{ suggestion: ResolvedScheduleSuggestion; entry: ScheduleEntry; duplicate: boolean }> {
    const data = await this.load();
    const index = data.suggestions.findIndex((item) => item.id === idOrPrefix || item.id.startsWith(idOrPrefix));
    if (index === -1) {
      throw new Error(`Dream suggestion not found: ${idOrPrefix}`);
    }

    const suggestion = data.suggestions[index]!;
    if (suggestion.status === "applied") {
      throw new Error(`Dream suggestion ${suggestion.id} was already applied`);
    }
    if (suggestion.status === "rejected" || suggestion.status === "dismissed") {
      throw new Error(`Dream suggestion ${suggestion.id} is already ${suggestion.status}`);
    }

    const entryInput = buildEntryFromSuggestion(suggestion);
    const existing = scheduleEngine.getEntries().find((entry) => entriesEquivalent(entry, entryInput));
    const entry = existing ?? await scheduleEngine.addEntry(entryInput);
    const nextSuggestion: ResolvedScheduleSuggestion = {
      ...suggestion,
      status: "applied",
      applied_entry_id: entry.id,
      decided_at: new Date().toISOString(),
      decision_reason: existing ? "matched_existing_schedule" : suggestion.decision_reason,
    };
    data.suggestions[index] = nextSuggestion;
    await this.save(data.suggestions, data.generated_at);

    return {
      suggestion: nextSuggestion,
      entry,
      duplicate: Boolean(existing),
    };
  }
}
