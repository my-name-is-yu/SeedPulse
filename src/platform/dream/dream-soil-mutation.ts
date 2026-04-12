import { createHash } from "node:crypto";
import type { AgentMemoryEntry, AgentMemoryStatus, AgentMemoryType } from "../knowledge/types/agent-memory.js";
import type { LearnedPattern } from "../knowledge/types/learning.js";
import type { DreamWorkflowRecord } from "./dream-event-workflows.js";
import {
  SoilMutationSchema,
  SoilRecordSchema,
  SoilChunkSchema,
  SoilTombstoneSchema,
  type SoilMutationInput,
  type SoilChunk,
  type SoilEdge,
  type SoilEmbedding,
  type SoilPage,
  type SoilPageMember,
  type SoilRecord,
  type SoilRecordStatus,
  type SoilRecordType,
  type SoilTombstone,
} from "../soil/contracts.js";

type DreamSoilMutationPayload = SoilMutationInput & {
  records: SoilRecord[];
  chunks: SoilChunk[];
  pages: SoilPage[];
  page_members: SoilPageMember[];
  embeddings: SoilEmbedding[];
  edges: SoilEdge[];
  tombstones: SoilTombstone[];
};

export interface DreamSoilMutationIntent {
  mutation: DreamSoilMutationPayload;
  recordsWithChangedSearchMaterial: string[];
  queueReindexRecordIds: string[];
}

export interface DreamSoilMutationSource {
  agentMemoryEntries?: AgentMemoryEntry[];
  learnedPatterns?: LearnedPattern[];
  workflowRecords?: DreamWorkflowRecord[];
  previousRecords?: SoilRecord[];
  deletedAt?: string;
}

const DEFAULT_SOURCE_RELIABILITY = 0.6;
const DEFAULT_IMPORTANCE = 0.5;
const DEFAULT_CONFIDENCE = 0.5;

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "general";
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function trimText(value: string, maxLength = 320): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function soilRecordTypeForAgentMemoryType(memoryType: AgentMemoryType): SoilRecordType {
  switch (memoryType) {
    case "fact":
      return "fact";
    case "procedure":
      return "workflow";
    case "preference":
      return "preference";
    case "observation":
      return "observation";
  }
}

function soilRecordStatusForAgentMemoryStatus(status: AgentMemoryStatus): SoilRecordStatus {
  switch (status) {
    case "raw":
      return "candidate";
    case "compiled":
      return "confirmed";
    case "archived":
      return "archived";
  }
}

function soilRecordStatusForLearnedPattern(confidence: number): SoilRecordStatus {
  return confidence >= 0.7 ? "confirmed" : "candidate";
}

function soilRecordStatusForDreamWorkflow(confidence: number): SoilRecordStatus {
  return confidence >= 0.7 ? "confirmed" : "candidate";
}

function soilIdForAgentMemory(entry: AgentMemoryEntry): string {
  const category = entry.category ? slugify(entry.category) : entry.memory_type;
  return `memory/agent-memory/${category}`;
}

function soilIdForLearnedPattern(pattern: LearnedPattern): string {
  return `learning/learned-patterns/${slugify(pattern.type)}`;
}

function soilIdForDreamWorkflow(workflow: DreamWorkflowRecord): string {
  return `dream/workflows/${slugify(workflow.type)}`;
}

function recordKeyForAgentMemory(entry: AgentMemoryEntry): string {
  return `agent-memory:${entry.key}`;
}

function goalIdsForLearnedPattern(pattern: LearnedPattern): string[] {
  const goalIds = unique(pattern.source_goal_ids).sort();
  return goalIds.length > 0 ? goalIds : ["global"];
}

function recordKeyForLearnedPattern(pattern: LearnedPattern, goalId: string): string {
  return `learned-pattern:${pattern.pattern_id}:${goalId}`;
}

function recordKeyForDreamWorkflow(workflow: DreamWorkflowRecord): string {
  return workflow.workflow_id.startsWith("dream-workflow:")
    ? workflow.workflow_id
    : `dream-workflow:${workflow.workflow_id}`;
}

interface DreamWorkflowSoilScope {
  goalId: string | null;
  taskId: string | null;
}

function dreamWorkflowScopeKey(scope: DreamWorkflowSoilScope): string {
  return `${scope.goalId ?? "global"}:${scope.taskId ?? "all-tasks"}`;
}

function scopesForDreamWorkflow(workflow: DreamWorkflowRecord): DreamWorkflowSoilScope[] {
  const scoped = workflow.applicability.scopes.map((scope) => ({
    goalId: scope.goal_id,
    taskId: scope.task_id,
  }));
  if (scoped.length > 0) {
    return unique(scoped.map((scope) => JSON.stringify(scope)))
      .map((serialized) => JSON.parse(serialized) as DreamWorkflowSoilScope)
      .sort((left, right) => dreamWorkflowScopeKey(left).localeCompare(dreamWorkflowScopeKey(right)));
  }

  if (workflow.applicability.goal_ids.length > 0) {
    return unique(workflow.applicability.goal_ids.map((goalId) => JSON.stringify({ goalId, taskId: null })))
      .map((serialized) => JSON.parse(serialized) as DreamWorkflowSoilScope);
  }
  if (workflow.applicability.task_ids.length > 0) {
    return unique(workflow.applicability.task_ids.map((taskId) => JSON.stringify({ goalId: null, taskId })))
      .map((serialized) => JSON.parse(serialized) as DreamWorkflowSoilScope);
  }
  return [{ goalId: null, taskId: null }];
}

function scopedRecordKeyForDreamWorkflow(workflow: DreamWorkflowRecord, scope: DreamWorkflowSoilScope): string {
  const baseKey = recordKeyForDreamWorkflow(workflow);
  if (
    scope.goalId !== null &&
    scope.taskId === null &&
    workflow.applicability.goal_ids.length <= 1 &&
    workflow.applicability.task_ids.length === 0
  ) {
    return baseKey;
  }
  if (scope.goalId === null && scope.taskId === null) {
    return baseKey;
  }
  return `${baseKey}:${dreamWorkflowScopeKey(scope)}`;
}

function stableRecordId(recordKey: string, version: number): string {
  return `${recordKey}:v${version}`;
}

function canonicalTextForAgentMemory(entry: AgentMemoryEntry): string {
  const parts = [`Key: ${entry.key}`];
  if (entry.summary) {
    parts.push(`Summary: ${entry.summary}`);
  }
  parts.push(`Value: ${entry.value}`);
  if (entry.tags.length > 0) {
    parts.push(`Tags: ${entry.tags.join(", ")}`);
  }
  if (entry.compiled_from?.length) {
    parts.push(`Compiled from: ${entry.compiled_from.join(", ")}`);
  }
  return parts.join("\n");
}

function canonicalTextForLearnedPattern(pattern: LearnedPattern): string {
  const parts = [`Pattern: ${pattern.type}`, `Description: ${pattern.description}`];
  if (pattern.applicable_domains.length > 0) {
    parts.push(`Domains: ${pattern.applicable_domains.join(", ")}`);
  }
  if (pattern.source_goal_ids.length > 0) {
    parts.push(`Source goals: ${pattern.source_goal_ids.join(", ")}`);
  }
  parts.push(`Evidence count: ${pattern.evidence_count}`);
  return parts.join("\n");
}

function canonicalTextForDreamWorkflow(workflow: DreamWorkflowRecord): string {
  const parts = [
    `Workflow: ${workflow.title}`,
    `Type: ${workflow.type}`,
    `Description: ${workflow.description}`,
  ];
  if (workflow.preconditions.length > 0) {
    parts.push(`Preconditions: ${workflow.preconditions.join("; ")}`);
  }
  if (workflow.steps.length > 0) {
    parts.push(`Steps: ${workflow.steps.join(" -> ")}`);
  }
  if (workflow.failure_modes.length > 0) {
    parts.push(`Failure modes: ${workflow.failure_modes.join(", ")}`);
  }
  if (workflow.recovery_steps.length > 0) {
    parts.push(`Recovery steps: ${workflow.recovery_steps.join(" -> ")}`);
  }
  if (workflow.applicability.signals.length > 0) {
    parts.push(`Signals: ${workflow.applicability.signals.join(", ")}`);
  }
  parts.push(`Evidence count: ${workflow.evidence_count}`);
  return parts.join("\n");
}

function titleForAgentMemory(entry: AgentMemoryEntry): string {
  return trimText(entry.summary ?? entry.key, 120);
}

function titleForLearnedPattern(pattern: LearnedPattern): string {
  return trimText(`Pattern: ${pattern.type}`, 120);
}

function titleForDreamWorkflow(workflow: DreamWorkflowRecord): string {
  return trimText(workflow.title, 120);
}

function soilChunkKindForText(text: string): SoilChunk["chunk_kind"] {
  return text.length > 240 ? "paragraph" : "summary";
}

function latestRecordForKey(records: SoilRecord[], recordKey: string): SoilRecord | null {
  const matches = records.filter((record) => record.record_key === recordKey);
  if (matches.length === 0) return null;
  return matches.sort((left, right) => right.version - left.version)[0] ?? null;
}

function recordPayloadChanged(
  previous: SoilRecord | null,
  next: {
    record_type: SoilRecordType;
    soil_id: string;
    title: string;
    summary: string | null;
    canonical_text: string;
    goal_id: string | null;
    task_id: string | null;
    status: SoilRecordStatus;
    is_active: boolean;
    valid_from: string | null;
    valid_to: string | null;
    source_type: string;
    source_id: string;
    confidence: number | null;
    importance: number | null;
    source_reliability: number | null;
  }
): boolean {
  if (!previous) return true;
  return previous.record_type !== next.record_type ||
    previous.soil_id !== next.soil_id ||
    previous.title !== next.title ||
    previous.summary !== next.summary ||
    previous.canonical_text !== next.canonical_text ||
    previous.goal_id !== next.goal_id ||
    previous.task_id !== next.task_id ||
    previous.status !== next.status ||
    previous.is_active !== next.is_active ||
    previous.valid_from !== next.valid_from ||
    previous.valid_to !== next.valid_to ||
    previous.source_type !== next.source_type ||
    previous.source_id !== next.source_id ||
    previous.confidence !== next.confidence ||
    previous.importance !== next.importance ||
    previous.source_reliability !== next.source_reliability;
}

function buildRecordFromAgentMemory(
  entry: AgentMemoryEntry,
  previousRecords: SoilRecord[]
): { record: SoilRecord | null; chunk: SoilChunk | null; tombstone: SoilTombstone | null; shouldReindex: boolean } {
  const canonicalText = canonicalTextForAgentMemory(entry);
  const createdAt = entry.created_at;
  const updatedAt = entry.updated_at;
  const recordStatus = soilRecordStatusForAgentMemoryStatus(entry.status);
  const recordKey = recordKeyForAgentMemory(entry);
  const previous = latestRecordForKey(previousRecords, recordKey);
  const payload = {
    record_type: soilRecordTypeForAgentMemoryType(entry.memory_type),
    soil_id: soilIdForAgentMemory(entry),
    title: titleForAgentMemory(entry),
    summary: entry.summary ?? null,
    canonical_text: canonicalText,
    goal_id: null,
    task_id: null,
    status: recordStatus,
    is_active: entry.status !== "archived",
    valid_from: createdAt,
    valid_to: entry.status === "archived" ? updatedAt : null,
    source_type: "agent_memory",
    source_id: entry.id,
    confidence: DEFAULT_CONFIDENCE,
    importance: DEFAULT_IMPORTANCE,
    source_reliability: DEFAULT_SOURCE_RELIABILITY,
  };
  const changed = recordPayloadChanged(previous, payload);
  if (!changed) {
    return { record: null, chunk: null, tombstone: null, shouldReindex: false };
  }

  const version = previous ? previous.version + 1 : 1;
  const recordId = stableRecordId(recordKey, version);
  const record: SoilRecord = SoilRecordSchema.parse({
    record_id: recordId,
    record_key: recordKey,
    version,
    record_type: payload.record_type,
    soil_id: payload.soil_id,
    title: payload.title,
    summary: payload.summary,
    canonical_text: payload.canonical_text,
    goal_id: payload.goal_id,
    task_id: payload.task_id,
    status: payload.status,
    confidence: payload.confidence,
    importance: payload.importance,
    source_reliability: payload.source_reliability,
    valid_from: payload.valid_from,
    valid_to: payload.valid_to,
    supersedes_record_id: previous?.record_id ?? null,
    is_active: payload.is_active,
    source_type: payload.source_type,
    source_id: payload.source_id,
    metadata_json: {
      agent_memory_id: entry.id,
      key: entry.key,
      value: entry.value,
      tags: entry.tags,
      category: entry.category ?? null,
      memory_type: entry.memory_type,
      status: entry.status,
      compiled_from: entry.compiled_from ?? [],
      created_at: entry.created_at,
      updated_at: entry.updated_at,
    },
    created_at: createdAt,
    updated_at: updatedAt,
  });

  const chunk: SoilChunk = SoilChunkSchema.parse({
    chunk_id: `${recordId}:chunk:0`,
    record_id: recordId,
    soil_id: record.soil_id,
    chunk_index: 0,
    chunk_kind: soilChunkKindForText(canonicalText),
    heading_path_json: [record.title],
    chunk_text: canonicalText,
    token_count: estimateTokenCount(canonicalText),
    checksum: hashText(canonicalText),
    created_at: updatedAt,
  });

  const tombstone: SoilTombstone | null =
    entry.status === "archived"
      ? SoilTombstoneSchema.parse({
          record_id: previous?.is_active ? previous.record_id : recordId,
          record_key: previous?.is_active ? previous.record_key : record.record_key,
          version: previous?.is_active ? previous.version : record.version,
          reason: "archived agent memory entry",
          deleted_at: updatedAt,
        })
      : null;

  return { record, chunk, tombstone, shouldReindex: record.is_active };
}

function buildRecordFromLearnedPatternForGoal(
  pattern: LearnedPattern,
  goalId: string,
  previousRecords: SoilRecord[]
): { record: SoilRecord | null; chunk: SoilChunk | null; tombstone: SoilTombstone | null; shouldReindex: boolean } {
  const canonicalText = canonicalTextForLearnedPattern(pattern);
  const recordKey = recordKeyForLearnedPattern(pattern, goalId);
  const previous = latestRecordForKey(previousRecords, recordKey);
  const importance = Math.min(1, Math.max(DEFAULT_IMPORTANCE, pattern.confidence * 0.7 + Math.min(pattern.evidence_count, 10) * 0.03));
  const payload = {
    record_type: "reflection" as const,
    soil_id: soilIdForLearnedPattern(pattern),
    title: titleForLearnedPattern(pattern),
    summary: pattern.description,
    canonical_text: canonicalText,
    goal_id: goalId === "global" ? null : goalId,
    task_id: null,
    status: soilRecordStatusForLearnedPattern(pattern.confidence),
    is_active: true,
    valid_from: pattern.created_at,
    valid_to: null,
    source_type: "learned_pattern",
    source_id: pattern.pattern_id,
    confidence: pattern.confidence,
    importance,
    source_reliability: 0.7,
  };
  const changed = recordPayloadChanged(previous, payload);
  if (!changed) {
    return { record: null, chunk: null, tombstone: null, shouldReindex: false };
  }

  const version = previous ? previous.version + 1 : 1;
  const recordId = stableRecordId(recordKey, version);
  const record: SoilRecord = SoilRecordSchema.parse({
    record_id: recordId,
    record_key: recordKey,
    version,
    record_type: payload.record_type,
    soil_id: payload.soil_id,
    title: payload.title,
    summary: payload.summary,
    canonical_text: payload.canonical_text,
    goal_id: payload.goal_id,
    task_id: payload.task_id,
    status: payload.status,
    confidence: payload.confidence,
    importance: payload.importance,
    source_reliability: payload.source_reliability,
    valid_from: payload.valid_from,
    valid_to: payload.valid_to,
    supersedes_record_id: previous?.record_id ?? null,
    is_active: payload.is_active,
    source_type: payload.source_type,
    source_id: payload.source_id,
    metadata_json: {
      pattern_id: pattern.pattern_id,
      type: pattern.type,
      evidence_count: pattern.evidence_count,
      source_goal_ids: pattern.source_goal_ids,
      applicable_domains: pattern.applicable_domains,
      embedding_id: pattern.embedding_id,
      last_applied_at: pattern.last_applied_at,
      confidence: pattern.confidence,
    },
    created_at: pattern.created_at,
    updated_at: pattern.created_at,
  });

  const chunk: SoilChunk = SoilChunkSchema.parse({
    chunk_id: `${recordId}:chunk:0`,
    record_id: recordId,
    soil_id: record.soil_id,
    chunk_index: 0,
    chunk_kind: "summary",
    heading_path_json: [record.title],
    chunk_text: canonicalText,
    token_count: estimateTokenCount(canonicalText),
    checksum: hashText(canonicalText),
    created_at: pattern.created_at,
  });

  return { record, chunk, tombstone: null, shouldReindex: true };
}

function buildRecordFromDreamWorkflow(
  workflow: DreamWorkflowRecord,
  scope: DreamWorkflowSoilScope,
  previousRecords: SoilRecord[]
): { record: SoilRecord | null; chunk: SoilChunk | null; tombstone: SoilTombstone | null; shouldReindex: boolean } {
  const canonicalText = canonicalTextForDreamWorkflow(workflow);
  const recordKey = scopedRecordKeyForDreamWorkflow(workflow, scope);
  const previous = latestRecordForKey(previousRecords, recordKey);
  const payload = {
    record_type: "workflow" as const,
    soil_id: soilIdForDreamWorkflow(workflow),
    title: titleForDreamWorkflow(workflow),
    summary: workflow.description,
    canonical_text: canonicalText,
    goal_id: scope.goalId,
    task_id: scope.taskId,
    status: soilRecordStatusForDreamWorkflow(workflow.confidence),
    is_active: true,
    valid_from: workflow.created_at,
    valid_to: null,
    source_type: "dream_workflow",
    source_id: workflow.workflow_id,
    confidence: workflow.confidence,
    importance: Math.min(1, DEFAULT_IMPORTANCE + workflow.evidence_count * 0.05 + workflow.success_count * 0.05),
    source_reliability: 0.7,
  };
  const changed = recordPayloadChanged(previous, payload);
  if (!changed) {
    return { record: null, chunk: null, tombstone: null, shouldReindex: false };
  }

  const version = previous ? previous.version + 1 : 1;
  const recordId = stableRecordId(recordKey, version);
  const record: SoilRecord = SoilRecordSchema.parse({
    record_id: recordId,
    record_key: recordKey,
    version,
    record_type: payload.record_type,
    soil_id: payload.soil_id,
    title: payload.title,
    summary: payload.summary,
    canonical_text: payload.canonical_text,
    goal_id: payload.goal_id,
    task_id: payload.task_id,
    status: payload.status,
    confidence: payload.confidence,
    importance: payload.importance,
    source_reliability: payload.source_reliability,
    valid_from: payload.valid_from,
    valid_to: payload.valid_to,
    supersedes_record_id: previous?.record_id ?? null,
    is_active: payload.is_active,
    source_type: payload.source_type,
    source_id: payload.source_id,
    metadata_json: {
      workflow_id: workflow.workflow_id,
      type: workflow.type,
      applicability: workflow.applicability,
      preconditions: workflow.preconditions,
      steps: workflow.steps,
      failure_modes: workflow.failure_modes,
      recovery_steps: workflow.recovery_steps,
      evidence_refs: workflow.evidence_refs,
      evidence_count: workflow.evidence_count,
      success_count: workflow.success_count,
      failure_count: workflow.failure_count,
      soil_scope: {
        goal_id: scope.goalId,
        task_id: scope.taskId,
      },
    },
    created_at: workflow.created_at,
    updated_at: workflow.updated_at,
  });

  const chunk: SoilChunk = SoilChunkSchema.parse({
    chunk_id: `${recordId}:chunk:0`,
    record_id: recordId,
    soil_id: record.soil_id,
    chunk_index: 0,
    chunk_kind: soilChunkKindForText(canonicalText),
    heading_path_json: [record.title],
    chunk_text: canonicalText,
    token_count: estimateTokenCount(canonicalText),
    checksum: hashText(canonicalText),
    created_at: workflow.updated_at,
  });

  return { record, chunk, tombstone: null, shouldReindex: true };
}

export function buildDreamSoilMutationIntent(input: DreamSoilMutationSource): DreamSoilMutationIntent {
  const records: SoilRecord[] = [];
  const chunks: SoilChunk[] = [];
  const tombstones: SoilTombstone[] = [];
  const recordsWithChangedSearchMaterial = new Set<string>();

  const previousRecords = input.previousRecords ?? [];
  const deletedAt = input.deletedAt ?? new Date().toISOString();
  const currentAgentMemorySourceIds = new Set((input.agentMemoryEntries ?? []).map((entry) => entry.id));
  const currentLearnedPatternSourceIds = new Set((input.learnedPatterns ?? []).map((pattern) => pattern.pattern_id));
  const currentWorkflowSourceIds = new Set((input.workflowRecords ?? []).map((workflow) => workflow.workflow_id));

  for (const entry of input.agentMemoryEntries ?? []) {
    const { record, chunk, tombstone, shouldReindex } = buildRecordFromAgentMemory(entry, previousRecords);
    if (record) {
      records.push(record);
      if (shouldReindex) {
        recordsWithChangedSearchMaterial.add(record.record_id);
      }
    }
    if (chunk) {
      chunks.push(chunk);
    }
    if (tombstone) {
      tombstones.push(tombstone);
    }
  }

  for (const previous of previousRecords) {
    if (
      previous.source_type === "agent_memory" &&
      previous.is_active &&
      !currentAgentMemorySourceIds.has(previous.source_id)
    ) {
      tombstones.push(SoilTombstoneSchema.parse({
        record_id: previous.record_id,
        record_key: previous.record_key,
        version: previous.version,
        reason: "agent memory entry no longer exists",
        deleted_at: deletedAt,
      }));
    }
  }

  for (const pattern of input.learnedPatterns ?? []) {
    const goalIds = goalIdsForLearnedPattern(pattern);
    const activeRecordKeys = new Set(goalIds.map((goalId) => recordKeyForLearnedPattern(pattern, goalId)));
    for (const goalId of goalIds) {
      const { record, chunk, tombstone, shouldReindex } = buildRecordFromLearnedPatternForGoal(pattern, goalId, previousRecords);
      if (record) {
        records.push(record);
        if (shouldReindex) {
          recordsWithChangedSearchMaterial.add(record.record_id);
        }
      }
      if (chunk) {
        chunks.push(chunk);
      }
      if (tombstone) {
        tombstones.push(tombstone);
      }
    }

    for (const previous of previousRecords) {
      if (
        previous.source_type === "learned_pattern" &&
        previous.source_id === pattern.pattern_id &&
        !activeRecordKeys.has(previous.record_key) &&
        previous.is_active
      ) {
        tombstones.push(SoilTombstoneSchema.parse({
          record_id: previous.record_id,
          record_key: previous.record_key,
          version: previous.version,
          reason: "learned pattern no longer applies to goal",
          deleted_at: deletedAt,
        }));
      }
    }
  }

  for (const previous of previousRecords) {
    if (
      previous.source_type === "learned_pattern" &&
      previous.is_active &&
      !currentLearnedPatternSourceIds.has(previous.source_id)
    ) {
      tombstones.push(SoilTombstoneSchema.parse({
        record_id: previous.record_id,
        record_key: previous.record_key,
        version: previous.version,
        reason: "learned pattern no longer exists",
        deleted_at: deletedAt,
      }));
    }
  }

  for (const workflow of input.workflowRecords ?? []) {
    const activeRecordKeys = new Set<string>();
    for (const scope of scopesForDreamWorkflow(workflow)) {
      const recordKey = scopedRecordKeyForDreamWorkflow(workflow, scope);
      activeRecordKeys.add(recordKey);
      const { record, chunk, tombstone, shouldReindex } = buildRecordFromDreamWorkflow(workflow, scope, previousRecords);
      if (record) {
        records.push(record);
        if (shouldReindex) {
          recordsWithChangedSearchMaterial.add(record.record_id);
        }
      }
      if (chunk) {
        chunks.push(chunk);
      }
      if (tombstone) {
        tombstones.push(tombstone);
      }
    }

    for (const previous of previousRecords) {
      if (
        previous.source_type === "dream_workflow" &&
        previous.source_id === workflow.workflow_id &&
        previous.is_active &&
        !activeRecordKeys.has(previous.record_key)
      ) {
        tombstones.push(SoilTombstoneSchema.parse({
          record_id: previous.record_id,
          record_key: previous.record_key,
          version: previous.version,
          reason: "dream workflow no longer applies to scope",
          deleted_at: deletedAt,
        }));
      }
    }
  }

  for (const previous of previousRecords) {
    if (
      previous.source_type === "dream_workflow" &&
      previous.is_active &&
      !currentWorkflowSourceIds.has(previous.source_id)
    ) {
      tombstones.push(SoilTombstoneSchema.parse({
        record_id: previous.record_id,
        record_key: previous.record_key,
        version: previous.version,
        reason: "dream workflow no longer exists",
        deleted_at: deletedAt,
      }));
    }
  }

  const mutation = SoilMutationSchema.parse({
    records,
    chunks,
    pages: [],
    page_members: [],
    embeddings: [],
    edges: [] as SoilEdge[],
    tombstones,
  }) as DreamSoilMutationPayload;

  return {
    mutation,
    recordsWithChangedSearchMaterial: unique([...recordsWithChangedSearchMaterial]),
    queueReindexRecordIds: [],
  };
}
