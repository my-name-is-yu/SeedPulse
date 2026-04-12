import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../../base/utils/json-io.js";
import { EventLogSchema, WatermarkStateSchema, type EventLog } from "./dream-types.js";

export const DreamWorkflowRecordSchema = z.object({
  workflow_id: z.string().min(1),
  type: z.enum(["stall_recovery", "verification_recovery"]),
  title: z.string().min(1),
  description: z.string().min(1),
  applicability: z.object({
    goal_ids: z.array(z.string().min(1)).default([]),
    task_ids: z.array(z.string().min(1)).default([]),
    event_types: z.array(z.string().min(1)).default([]),
    signals: z.array(z.string().min(1)).default([]),
    scopes: z.array(z.object({
      goal_id: z.string().min(1).nullable().default(null),
      task_id: z.string().min(1).nullable().default(null),
    })).default([]),
  }),
  preconditions: z.array(z.string().min(1)).default([]),
  steps: z.array(z.string().min(1)).default([]),
  failure_modes: z.array(z.string().min(1)).default([]),
  recovery_steps: z.array(z.string().min(1)).default([]),
  evidence_refs: z.array(z.string().min(1)).default([]),
  evidence_count: z.number().int().nonnegative(),
  success_count: z.number().int().nonnegative(),
  failure_count: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type DreamWorkflowRecord = z.infer<typeof DreamWorkflowRecordSchema>;

const DreamWorkflowFileSchema = z.object({
  version: z.literal("dream-workflows-v1").default("dream-workflows-v1"),
  generated_at: z.string().datetime(),
  workflows: z.array(DreamWorkflowRecordSchema).default([]),
});

export interface DreamEventWorkflowReport {
  eventsScanned: number;
  malformedEvents: number;
  workflowCandidates: number;
  workflowsWritten: number;
  eventWatermarksAdvanced: number;
}

interface EventCursor {
  lastProcessedLine: number;
  lastProcessedTimestamp?: string;
}

interface ParsedEvent {
  event: EventLog;
  line: number;
  fileName: string;
}

interface WorkflowAccumulator {
  type: DreamWorkflowRecord["type"];
  key: string;
  events: ParsedEvent[];
  goals: Set<string>;
  tasks: Set<string>;
  signals: Set<string>;
  eventTypes: Set<string>;
  scopes: Map<string, { goal_id: string | null; task_id: string | null }>;
  failureCount: number;
  successCount: number;
  firstTimestamp: string;
  lastTimestamp: string;
}

function workflowFilePath(baseDir: string): string {
  return path.join(baseDir, "dream", "workflows.json");
}

function watermarksFilePath(baseDir: string): string {
  return path.join(baseDir, "dream", "watermarks.json");
}

function eventDirPath(baseDir: string): string {
  return path.join(baseDir, "dream", "events");
}

function stableId(parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 16);
  return `dream-workflow:${hash}`;
}

function eventCursorKey(fileName: string): string {
  return `event:${fileName}`;
}

function eventRef(parsed: ParsedEvent): string {
  return `dream/events/${parsed.fileName}#L${parsed.line}`;
}

function readStringData(event: EventLog, key: string): string | null {
  const value = event.data[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readBooleanData(event: EventLog, key: string): boolean | null {
  const value = event.data[key];
  return typeof value === "boolean" ? value : null;
}

function eventTaskId(event: EventLog): string | null {
  return event.taskId ?? readStringData(event, "task_id");
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function workflowScopeKey(scope: { goal_id: string | null; task_id: string | null }): string {
  return `${scope.goal_id ?? ""}\u0000${scope.task_id ?? ""}`;
}

function buildFallbackScopes(goalIds: string[], taskIds: string[]): Array<{ goal_id: string | null; task_id: string | null }> {
  if (goalIds.length === 0 && taskIds.length === 0) {
    return [];
  }
  if (goalIds.length > 0) {
    return goalIds.map((goalId) => ({ goal_id: goalId, task_id: null }));
  }
  return taskIds.map((taskId) => ({ goal_id: null, task_id: taskId }));
}

function mergeWorkflowScopes(
  previous: DreamWorkflowRecord | undefined,
  nextScopes: Iterable<{ goal_id: string | null; task_id: string | null }>,
  goalIds: string[],
  taskIds: string[]
): Array<{ goal_id: string | null; task_id: string | null }> {
  const merged = new Map<string, { goal_id: string | null; task_id: string | null }>();
  const previousScopes = previous?.applicability.scopes.length
    ? previous.applicability.scopes
    : buildFallbackScopes(previous?.applicability.goal_ids ?? [], previous?.applicability.task_ids ?? []);
  for (const scope of [...previousScopes, ...nextScopes]) {
    merged.set(workflowScopeKey(scope), scope);
  }
  if (merged.size === 0) {
    for (const scope of buildFallbackScopes(goalIds, taskIds)) {
      merged.set(workflowScopeKey(scope), scope);
    }
  }
  return [...merged.values()].sort((left, right) =>
    workflowScopeKey(left).localeCompare(workflowScopeKey(right))
  );
}

async function loadEventWatermarks(baseDir: string): Promise<Record<string, EventCursor>> {
  const raw = await readJsonFileOrNull(watermarksFilePath(baseDir));
  const parsed = raw === null ? WatermarkStateSchema.parse({}) : WatermarkStateSchema.parse(raw);
  const cursors: Record<string, EventCursor> = {};
  for (const [key, cursor] of Object.entries(parsed.goals)) {
    if (key.startsWith("event:")) {
      cursors[key.slice("event:".length)] = cursor;
    }
  }
  return cursors;
}

async function saveEventWatermarks(baseDir: string, cursors: Record<string, EventCursor>): Promise<void> {
  const raw = await readJsonFileOrNull(watermarksFilePath(baseDir));
  const state = raw === null ? WatermarkStateSchema.parse({}) : WatermarkStateSchema.parse(raw);
  for (const [fileName, cursor] of Object.entries(cursors)) {
    state.goals[eventCursorKey(fileName)] = {
      lastProcessedLine: cursor.lastProcessedLine,
      ...(cursor.lastProcessedTimestamp ? { lastProcessedTimestamp: cursor.lastProcessedTimestamp } : {}),
    };
  }
  await writeJsonFileAtomic(watermarksFilePath(baseDir), state);
}

async function loadExistingWorkflows(baseDir: string): Promise<DreamWorkflowRecord[]> {
  const raw = await readJsonFileOrNull(workflowFilePath(baseDir));
  if (raw === null) return [];
  const parsed = DreamWorkflowFileSchema.safeParse(raw);
  return parsed.success ? parsed.data.workflows : [];
}

async function readNewEvents(baseDir: string): Promise<{
  events: ParsedEvent[];
  malformedEvents: number;
  cursors: Record<string, EventCursor>;
}> {
  const eventDir = eventDirPath(baseDir);
  const files = (await fsp.readdir(eventDir).catch(() => [] as string[]))
    .filter((fileName) => fileName.endsWith(".jsonl"))
    .sort();
  const previousCursors = await loadEventWatermarks(baseDir);
  const nextCursors: Record<string, EventCursor> = {};
  const events: ParsedEvent[] = [];
  let malformedEvents = 0;

  for (const fileName of files) {
    const filePath = path.join(eventDir, fileName);
    const raw = await fsp.readFile(filePath, "utf8").catch(() => "");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const previous = previousCursors[fileName] ?? { lastProcessedLine: 0 };
    const startLine = previous.lastProcessedLine <= lines.length ? previous.lastProcessedLine : 0;
    const useTimestampFallback = previous.lastProcessedLine > lines.length && Boolean(previous.lastProcessedTimestamp);
    let latestTimestamp = previous.lastProcessedTimestamp;

    for (let index = startLine; index < lines.length; index += 1) {
      try {
        const parsed = EventLogSchema.parse(JSON.parse(lines[index]!));
        if (useTimestampFallback && previous.lastProcessedTimestamp && parsed.timestamp <= previous.lastProcessedTimestamp) {
          continue;
        }
        events.push({ event: parsed, line: index + 1, fileName });
        latestTimestamp = parsed.timestamp;
      } catch {
        malformedEvents += 1;
      }
    }

    nextCursors[fileName] = {
      lastProcessedLine: lines.length,
      ...(latestTimestamp ? { lastProcessedTimestamp: latestTimestamp } : {}),
    };
  }

  return { events, malformedEvents, cursors: nextCursors };
}

function accumulatorFor(map: Map<string, WorkflowAccumulator>, type: DreamWorkflowRecord["type"], key: string, event: ParsedEvent): WorkflowAccumulator {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }
  const created: WorkflowAccumulator = {
    type,
    key,
    events: [],
    goals: new Set(),
    tasks: new Set(),
    signals: new Set(),
    eventTypes: new Set(),
    scopes: new Map(),
    failureCount: 0,
    successCount: 0,
    firstTimestamp: event.event.timestamp,
    lastTimestamp: event.event.timestamp,
  };
  map.set(key, created);
  return created;
}

function addEvent(accumulator: WorkflowAccumulator, parsed: ParsedEvent): void {
  const taskId = eventTaskId(parsed.event);
  accumulator.events.push(parsed);
  accumulator.goals.add(parsed.event.goalId);
  if (taskId) {
    accumulator.tasks.add(taskId);
  }
  const scope = { goal_id: parsed.event.goalId, task_id: taskId };
  accumulator.scopes.set(workflowScopeKey(scope), scope);
  accumulator.eventTypes.add(parsed.event.eventType);
  accumulator.firstTimestamp = parsed.event.timestamp < accumulator.firstTimestamp ? parsed.event.timestamp : accumulator.firstTimestamp;
  accumulator.lastTimestamp = parsed.event.timestamp > accumulator.lastTimestamp ? parsed.event.timestamp : accumulator.lastTimestamp;
}

function groupEvents(events: ParsedEvent[]): WorkflowAccumulator[] {
  const grouped = new Map<string, WorkflowAccumulator>();

  for (const parsed of events) {
    if (parsed.event.eventType === "StallDetected") {
      const stallType = readStringData(parsed.event, "stall_type") ?? "unknown";
      const cause = readStringData(parsed.event, "suggested_cause") ?? "unspecified";
      const key = `stall:${stallType}:${cause}`;
      const accumulator = accumulatorFor(grouped, "stall_recovery", key, parsed);
      accumulator.signals.add(stallType);
      if (cause !== "unspecified") {
        accumulator.signals.add(cause);
      }
      accumulator.failureCount += 1;
      addEvent(accumulator, parsed);
    }

    if (parsed.event.eventType === "PostExecute") {
      const success = readBooleanData(parsed.event, "success");
      const taskId = parsed.event.taskId ?? readStringData(parsed.event, "task_id") ?? "unknown-task";
      const key = `verification:${parsed.event.goalId}:${taskId}`;
      const accumulator = accumulatorFor(grouped, "verification_recovery", key, parsed);
      accumulator.signals.add(success ? "execution_success" : "execution_failure");
      if (success) {
        accumulator.successCount += 1;
      } else {
        accumulator.failureCount += 1;
      }
      addEvent(accumulator, parsed);
    }
  }

  return [...grouped.values()].filter((accumulator) => {
    if (accumulator.type === "stall_recovery") {
      return accumulator.failureCount >= 1;
    }
    return accumulator.failureCount > 0 || accumulator.successCount > 0;
  });
}

function toWorkflow(accumulator: WorkflowAccumulator, previous?: DreamWorkflowRecord): DreamWorkflowRecord {
  const workflowId = previous?.workflow_id ?? stableId([accumulator.type, accumulator.key]);
  const goals = uniqueSorted([...(previous?.applicability.goal_ids ?? []), ...accumulator.goals]);
  const tasks = uniqueSorted([...(previous?.applicability.task_ids ?? []), ...accumulator.tasks]);
  const eventTypes = uniqueSorted([...(previous?.applicability.event_types ?? []), ...accumulator.eventTypes]);
  const signals = uniqueSorted([...(previous?.applicability.signals ?? []), ...accumulator.signals]);
  const scopes = mergeWorkflowScopes(previous, accumulator.scopes.values(), goals, tasks);
  const evidenceRefs = uniqueSorted([...(previous?.evidence_refs ?? []), ...accumulator.events.map(eventRef)]);
  const successCount = (previous?.success_count ?? 0) + accumulator.successCount;
  const failureCount = (previous?.failure_count ?? 0) + accumulator.failureCount;
  const confidence = Math.min(0.9, 0.45 + evidenceRefs.length * 0.08 + successCount * 0.08);
  const updatedAt = previous && previous.updated_at > accumulator.lastTimestamp
    ? previous.updated_at
    : accumulator.lastTimestamp;

  if (accumulator.type === "stall_recovery") {
    const signalSummary = signals.length > 0 ? signals.join(", ") : "stall signal";
    return DreamWorkflowRecordSchema.parse({
      workflow_id: workflowId,
      type: accumulator.type,
      title: `Stall recovery: ${signalSummary}`,
      description: `Repeated stall signal observed: ${signalSummary}. Use this as a recovery workflow candidate before retrying the same loop.`,
      applicability: { goal_ids: goals, task_ids: tasks, event_types: eventTypes, signals, scopes },
      preconditions: ["A stall was detected during the execution loop."],
      steps: [
        "Pause repeated execution attempts.",
        "Inspect the stall type and suggested cause.",
        "Change strategy or task decomposition before continuing.",
      ],
      failure_modes: signals,
      recovery_steps: ["Re-plan the next task around the stall cause.", "Prefer a different strategy if the same stall repeats."],
      evidence_refs: evidenceRefs,
      evidence_count: evidenceRefs.length,
      success_count: successCount,
      failure_count: failureCount,
      confidence,
      created_at: previous?.created_at ?? accumulator.firstTimestamp,
      updated_at: updatedAt,
    });
  }

  return DreamWorkflowRecordSchema.parse({
    workflow_id: workflowId,
    type: accumulator.type,
    title: `Execution recovery: ${tasks[0] ?? goals[0] ?? "task"}`,
    description: `Execution outcome pattern observed for ${tasks[0] ?? goals[0] ?? "a task"}. Use this as a verification recovery workflow candidate.`,
    applicability: { goal_ids: goals, task_ids: tasks, event_types: eventTypes, signals, scopes },
    preconditions: ["A task execution produced a failure or success outcome worth retaining."],
    steps: [
      "Inspect the failed execution output and verification signal.",
      "Apply the smallest corrective change.",
      "Re-run the verification command before broadening scope.",
    ],
    failure_modes: failureCount > 0 ? ["execution_failure"] : [],
    recovery_steps: ["Retry only after evidence changes.", "Record the passing verification command if recovery succeeds."],
    evidence_refs: evidenceRefs,
    evidence_count: evidenceRefs.length,
    success_count: successCount,
    failure_count: failureCount,
    confidence,
    created_at: previous?.created_at ?? accumulator.firstTimestamp,
    updated_at: updatedAt,
  });
}

export async function consolidateDreamEventWorkflows(baseDir: string): Promise<DreamEventWorkflowReport> {
  const existing = await loadExistingWorkflows(baseDir);
  const existingById = new Map(existing.map((workflow) => [workflow.workflow_id, workflow]));
  const { events, malformedEvents, cursors } = await readNewEvents(baseDir);
  const accumulators = groupEvents(events);
  const nextById = new Map(existing.map((workflow) => [workflow.workflow_id, workflow]));

  for (const accumulator of accumulators) {
    const workflowId = stableId([accumulator.type, accumulator.key]);
    nextById.set(workflowId, toWorkflow(accumulator, existingById.get(workflowId)));
  }

  const workflows = [...nextById.values()].sort((left, right) => left.workflow_id.localeCompare(right.workflow_id));
  if (accumulators.length > 0 || events.length > 0 || malformedEvents > 0) {
    await writeJsonFileAtomic(workflowFilePath(baseDir), DreamWorkflowFileSchema.parse({
      generated_at: new Date().toISOString(),
      workflows,
    }));
    await saveEventWatermarks(baseDir, cursors);
  }

  return {
    eventsScanned: events.length,
    malformedEvents,
    workflowCandidates: accumulators.length,
    workflowsWritten: workflows.length,
    eventWatermarksAdvanced: Object.keys(cursors).length,
  };
}

export async function loadDreamWorkflowRecords(baseDir: string): Promise<DreamWorkflowRecord[]> {
  return loadExistingWorkflows(baseDir);
}
