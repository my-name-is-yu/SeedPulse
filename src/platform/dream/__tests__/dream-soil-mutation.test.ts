import { describe, expect, it } from "vitest";
import type { AgentMemoryEntry } from "../../knowledge/types/agent-memory.js";
import type { LearnedPattern } from "../../knowledge/types/learning.js";
import type { DreamWorkflowRecord } from "../dream-event-workflows.js";
import { buildDreamSoilMutationIntent } from "../dream-soil-mutation.js";

function makeAgentMemoryEntry(overrides: Partial<AgentMemoryEntry> & Pick<AgentMemoryEntry, "id" | "key" | "value" | "created_at" | "updated_at">): AgentMemoryEntry {
  return {
    tags: [],
    memory_type: "fact",
    status: "raw",
    ...overrides,
  };
}

function makeLearnedPattern(overrides: Partial<LearnedPattern> & Pick<LearnedPattern, "pattern_id" | "type" | "description" | "confidence" | "evidence_count" | "source_goal_ids" | "applicable_domains" | "created_at">): LearnedPattern {
  return {
    embedding_id: null,
    last_applied_at: null,
    ...overrides,
  };
}

function makeWorkflowRecord(overrides: Partial<DreamWorkflowRecord> & Pick<DreamWorkflowRecord, "workflow_id" | "type" | "title" | "description" | "created_at" | "updated_at">): DreamWorkflowRecord {
  return {
    applicability: {
      goal_ids: ["goal-a"],
      task_ids: [],
      event_types: ["StallDetected"],
      signals: ["stall"],
      scopes: [{ goal_id: "goal-a", task_id: null }],
    },
    preconditions: ["A stall was detected."],
    steps: ["Inspect the stall.", "Change strategy."],
    failure_modes: ["stall"],
    recovery_steps: ["Re-plan before retrying."],
    evidence_refs: ["dream/events/goal-a.jsonl#L1"],
    evidence_count: 1,
    success_count: 0,
    failure_count: 1,
    confidence: 0.72,
    ...overrides,
  };
}

describe("dream soil mutation intent", () => {
  it("maps agent memory entries into typed soil records and tombstones without applying them", () => {
    const compiled = makeAgentMemoryEntry({
      id: "mem-compiled",
      key: "procedure.deploy",
      value: "Deploy from main after CI passes.",
      summary: "Deployment procedure",
      tags: ["deploy"],
      category: "ops",
      memory_type: "procedure",
      status: "compiled",
      compiled_from: ["mem-raw"],
      created_at: "2026-04-12T00:00:00.000Z",
      updated_at: "2026-04-12T01:00:00.000Z",
    });
    const archived = makeAgentMemoryEntry({
      id: "mem-archived",
      key: "observation.alert",
      value: "Alert spikes when the queue is overloaded.",
      tags: ["alert"],
      memory_type: "observation",
      status: "archived",
      created_at: "2026-04-11T00:00:00.000Z",
      updated_at: "2026-04-12T02:00:00.000Z",
    });

    const result = buildDreamSoilMutationIntent({ agentMemoryEntries: [compiled, archived] });

    expect(result.mutation.records).toHaveLength(2);
    expect(result.mutation.chunks).toHaveLength(2);
    expect(result.mutation.tombstones).toHaveLength(1);
    expect(result.recordsWithChangedSearchMaterial).toEqual(["agent-memory:procedure.deploy:v1"]);
    expect(result.queueReindexRecordIds).toEqual([]);

    expect(result.mutation.records[0]).toMatchObject({
      record_id: "agent-memory:procedure.deploy:v1",
      record_key: "agent-memory:procedure.deploy",
      version: 1,
      record_type: "workflow",
      status: "confirmed",
      is_active: true,
      supersedes_record_id: null,
      source_type: "agent_memory",
      source_id: "mem-compiled",
      valid_from: "2026-04-12T00:00:00.000Z",
      valid_to: null,
    });

    expect(result.mutation.records[1]).toMatchObject({
      record_id: "agent-memory:observation.alert:v1",
      record_key: "agent-memory:observation.alert",
      version: 1,
      record_type: "observation",
      status: "archived",
      is_active: false,
      source_type: "agent_memory",
      source_id: "mem-archived",
      valid_to: "2026-04-12T02:00:00.000Z",
    });

    expect(result.mutation.tombstones[0]).toMatchObject({
      record_id: "agent-memory:observation.alert:v1",
      record_key: "agent-memory:observation.alert",
      version: 1,
      reason: "archived agent memory entry",
    });
  });

  it("tombstones the previous active agent-memory record when an entry becomes archived", () => {
    const compiled = makeAgentMemoryEntry({
      id: "mem-compiled",
      key: "procedure.deploy",
      value: "Deploy from main after CI passes.",
      summary: "Deployment procedure",
      tags: ["deploy"],
      category: "ops",
      memory_type: "procedure",
      status: "compiled",
      compiled_from: ["mem-raw"],
      created_at: "2026-04-12T00:00:00.000Z",
      updated_at: "2026-04-12T01:00:00.000Z",
    });
    const archived = {
      ...compiled,
      status: "archived" as const,
      updated_at: "2026-04-12T02:00:00.000Z",
    };
    const previous = buildDreamSoilMutationIntent({ agentMemoryEntries: [compiled] }).mutation.records[0]!;

    const result = buildDreamSoilMutationIntent({
      agentMemoryEntries: [archived],
      previousRecords: [previous],
    });

    expect(result.mutation.records).toHaveLength(1);
    expect(result.mutation.records[0]).toMatchObject({
      record_id: "agent-memory:procedure.deploy:v2",
      record_key: "agent-memory:procedure.deploy",
      version: 2,
      status: "archived",
      is_active: false,
      supersedes_record_id: "agent-memory:procedure.deploy:v1",
    });
    expect(result.mutation.tombstones).toEqual([
      expect.objectContaining({
        record_id: "agent-memory:procedure.deploy:v1",
        record_key: "agent-memory:procedure.deploy",
        version: 1,
        reason: "archived agent memory entry",
      }),
    ]);
    expect(result.recordsWithChangedSearchMaterial).toEqual([]);
    expect(result.queueReindexRecordIds).toEqual([]);
  });

  it("maps learned patterns into reflection records with primary evidence in metadata", () => {
    const pattern = makeLearnedPattern({
      pattern_id: "pat-1",
      type: "strategy_selection",
      description: "Prefer small checkpoints when stalls rise.",
      confidence: 0.84,
      evidence_count: 4,
      source_goal_ids: ["goal-a", "goal-b"],
      applicable_domains: ["stalls", "strategy"],
      created_at: "2026-04-12T03:00:00.000Z",
    });

    const result = buildDreamSoilMutationIntent({ learnedPatterns: [pattern] });

    expect(result.mutation.records).toHaveLength(2);
    expect(result.mutation.chunks).toHaveLength(2);
    expect(result.mutation.tombstones).toHaveLength(0);
    expect(result.recordsWithChangedSearchMaterial).toEqual([
      "learned-pattern:pat-1:goal-a:v1",
      "learned-pattern:pat-1:goal-b:v1",
    ]);
    expect(result.queueReindexRecordIds).toEqual([]);

    expect(result.mutation.records[0]).toMatchObject({
      record_id: "learned-pattern:pat-1:goal-a:v1",
      record_key: "learned-pattern:pat-1:goal-a",
      version: 1,
      record_type: "reflection",
      status: "confirmed",
      is_active: true,
      source_type: "learned_pattern",
      source_id: "pat-1",
      goal_id: "goal-a",
      valid_from: "2026-04-12T03:00:00.000Z",
      valid_to: null,
      confidence: 0.84,
    });

    expect(result.mutation.records[0]?.metadata_json).toMatchObject({
      pattern_id: "pat-1",
      type: "strategy_selection",
      source_goal_ids: ["goal-a", "goal-b"],
    });
  });

  it("marks low-confidence learned patterns as candidates", () => {
    const pattern = makeLearnedPattern({
      pattern_id: "pat-low",
      type: "scope_sizing",
      description: "Sometimes bigger batches are better.",
      confidence: 0.5,
      evidence_count: 2,
      source_goal_ids: ["goal-x"],
      applicable_domains: [],
      created_at: "2026-04-12T04:00:00.000Z",
    });

    const result = buildDreamSoilMutationIntent({ learnedPatterns: [pattern] });

    expect(result.mutation.records[0]).toMatchObject({
      record_id: "learned-pattern:pat-low:goal-x:v1",
      status: "candidate",
      is_active: true,
      confidence: 0.5,
    });
  });

  it("increments versions and supersedes previous soil records when committed truth changes", () => {
    const entry = makeAgentMemoryEntry({
      id: "mem-compiled",
      key: "procedure.deploy",
      value: "Deploy from main after CI and smoke tests pass.",
      summary: "Deployment procedure",
      tags: ["deploy"],
      category: "ops",
      memory_type: "procedure",
      status: "compiled",
      created_at: "2026-04-12T00:00:00.000Z",
      updated_at: "2026-04-12T02:00:00.000Z",
    });

    const previous = buildDreamSoilMutationIntent({
      agentMemoryEntries: [
        {
          ...entry,
          value: "Deploy from main after CI passes.",
          updated_at: "2026-04-12T01:00:00.000Z",
        },
      ],
    }).mutation.records[0]!;

    const result = buildDreamSoilMutationIntent({
      agentMemoryEntries: [entry],
      previousRecords: [previous],
    });

    expect(result.mutation.records).toHaveLength(1);
    expect(result.mutation.records[0]).toMatchObject({
      record_id: "agent-memory:procedure.deploy:v2",
      record_key: "agent-memory:procedure.deploy",
      version: 2,
      supersedes_record_id: "agent-memory:procedure.deploy:v1",
    });
    expect(result.recordsWithChangedSearchMaterial).toEqual(["agent-memory:procedure.deploy:v2"]);
    expect(result.queueReindexRecordIds).toEqual([]);
  });

  it("tombstones the previous active agent memory record when the entry is archived", () => {
    const entry = makeAgentMemoryEntry({
      id: "mem-compiled",
      key: "procedure.deploy",
      value: "Deploy from main after CI passes.",
      summary: "Deployment procedure",
      tags: ["deploy"],
      category: "ops",
      memory_type: "procedure",
      status: "compiled",
      created_at: "2026-04-12T00:00:00.000Z",
      updated_at: "2026-04-12T01:00:00.000Z",
    });
    const previous = buildDreamSoilMutationIntent({ agentMemoryEntries: [entry] }).mutation.records[0]!;

    const result = buildDreamSoilMutationIntent({
      agentMemoryEntries: [
        {
          ...entry,
          status: "archived",
          updated_at: "2026-04-12T02:00:00.000Z",
        },
      ],
      previousRecords: [previous],
    });

    expect(result.mutation.records).toEqual([
      expect.objectContaining({
        record_id: "agent-memory:procedure.deploy:v2",
        status: "archived",
        is_active: false,
        supersedes_record_id: "agent-memory:procedure.deploy:v1",
      }),
    ]);
    expect(result.mutation.tombstones).toEqual([
      expect.objectContaining({
        record_id: "agent-memory:procedure.deploy:v1",
        record_key: "agent-memory:procedure.deploy",
        version: 1,
        reason: "archived agent memory entry",
      }),
    ]);
    expect(result.recordsWithChangedSearchMaterial).toEqual([]);
  });

  it("returns an empty mutation when previous soil records already mirror committed truth", () => {
    const entry = makeAgentMemoryEntry({
      id: "mem-compiled",
      key: "procedure.deploy",
      value: "Deploy from main after CI passes.",
      summary: "Deployment procedure",
      tags: ["deploy"],
      category: "ops",
      memory_type: "procedure",
      status: "compiled",
      created_at: "2026-04-12T00:00:00.000Z",
      updated_at: "2026-04-12T01:00:00.000Z",
    });
    const previous = buildDreamSoilMutationIntent({ agentMemoryEntries: [entry] }).mutation.records[0]!;

    const result = buildDreamSoilMutationIntent({
      agentMemoryEntries: [entry],
      previousRecords: [previous],
    });

    expect(result.mutation.records).toHaveLength(0);
    expect(result.mutation.chunks).toHaveLength(0);
    expect(result.mutation.tombstones).toHaveLength(0);
    expect(result.recordsWithChangedSearchMaterial).toEqual([]);
    expect(result.queueReindexRecordIds).toEqual([]);
  });

  it("versions learned patterns when ranking metadata changes", () => {
    const pattern = makeLearnedPattern({
      pattern_id: "pat-1",
      type: "strategy_selection",
      description: "Prefer small checkpoints when stalls rise.",
      confidence: 0.84,
      evidence_count: 4,
      source_goal_ids: ["goal-a"],
      applicable_domains: ["stalls"],
      created_at: "2026-04-12T03:00:00.000Z",
    });
    const previous = buildDreamSoilMutationIntent({ learnedPatterns: [pattern] }).mutation.records[0]!;

    const result = buildDreamSoilMutationIntent({
      learnedPatterns: [{ ...pattern, confidence: 0.92 }],
      previousRecords: [previous],
    });

    expect(result.mutation.records[0]).toMatchObject({
      record_id: "learned-pattern:pat-1:goal-a:v2",
      version: 2,
      supersedes_record_id: "learned-pattern:pat-1:goal-a:v1",
      confidence: 0.92,
    });
  });

  it("tombstones learned-pattern goal records that no longer apply", () => {
    const pattern = makeLearnedPattern({
      pattern_id: "pat-1",
      type: "strategy_selection",
      description: "Prefer small checkpoints when stalls rise.",
      confidence: 0.84,
      evidence_count: 4,
      source_goal_ids: ["goal-a", "goal-b"],
      applicable_domains: ["stalls"],
      created_at: "2026-04-12T03:00:00.000Z",
    });
    const previous = buildDreamSoilMutationIntent({ learnedPatterns: [pattern] }).mutation.records;

    const result = buildDreamSoilMutationIntent({
      learnedPatterns: [{ ...pattern, source_goal_ids: ["goal-a"] }],
      previousRecords: previous,
      deletedAt: "2026-04-12T05:00:00.000Z",
    });

    expect(result.mutation.records).toEqual([
      expect.objectContaining({
        record_id: "learned-pattern:pat-1:goal-a:v2",
        supersedes_record_id: "learned-pattern:pat-1:goal-a:v1",
      }),
    ]);
    expect(result.mutation.tombstones).toEqual([
      expect.objectContaining({
        record_id: "learned-pattern:pat-1:goal-b:v1",
        record_key: "learned-pattern:pat-1:goal-b",
        reason: "learned pattern no longer applies to goal",
        deleted_at: "2026-04-12T05:00:00.000Z",
      }),
    ]);
    expect(result.recordsWithChangedSearchMaterial).toEqual(["learned-pattern:pat-1:goal-a:v2"]);
  });

  it("tombstones agent memory records whose source disappeared", () => {
    const entry = makeAgentMemoryEntry({
      id: "mem-compiled",
      key: "procedure.deploy",
      value: "Deploy from main after CI passes.",
      summary: "Deployment procedure",
      tags: ["deploy"],
      category: "ops",
      memory_type: "procedure",
      status: "compiled",
      created_at: "2026-04-12T00:00:00.000Z",
      updated_at: "2026-04-12T01:00:00.000Z",
    });
    const previous = buildDreamSoilMutationIntent({ agentMemoryEntries: [entry] }).mutation.records;

    const result = buildDreamSoilMutationIntent({
      agentMemoryEntries: [],
      previousRecords: previous,
      deletedAt: "2026-04-12T05:00:00.000Z",
    });

    expect(result.mutation.records).toHaveLength(0);
    expect(result.mutation.chunks).toHaveLength(0);
    expect(result.mutation.tombstones).toEqual([
      expect.objectContaining({
        record_id: "agent-memory:procedure.deploy:v1",
        record_key: "agent-memory:procedure.deploy",
        reason: "agent memory entry no longer exists",
        deleted_at: "2026-04-12T05:00:00.000Z",
      }),
    ]);
    expect(result.recordsWithChangedSearchMaterial).toEqual([]);
  });

  it("tombstones learned-pattern records whose source disappeared", () => {
    const pattern = makeLearnedPattern({
      pattern_id: "pat-1",
      type: "strategy_selection",
      description: "Prefer small checkpoints when stalls rise.",
      confidence: 0.84,
      evidence_count: 4,
      source_goal_ids: ["goal-a"],
      applicable_domains: ["stalls"],
      created_at: "2026-04-12T03:00:00.000Z",
    });
    const previous = buildDreamSoilMutationIntent({ learnedPatterns: [pattern] }).mutation.records;

    const result = buildDreamSoilMutationIntent({
      learnedPatterns: [],
      previousRecords: previous,
      deletedAt: "2026-04-12T05:00:00.000Z",
    });

    expect(result.mutation.records).toHaveLength(0);
    expect(result.mutation.chunks).toHaveLength(0);
    expect(result.mutation.tombstones).toEqual([
      expect.objectContaining({
        record_id: "learned-pattern:pat-1:goal-a:v1",
        record_key: "learned-pattern:pat-1:goal-a",
        reason: "learned pattern no longer exists",
        deleted_at: "2026-04-12T05:00:00.000Z",
      }),
    ]);
    expect(result.recordsWithChangedSearchMaterial).toEqual([]);
  });

  it("maps Dream workflow artifacts into workflow soil records", () => {
    const workflow = makeWorkflowRecord({
      workflow_id: "dream-workflow:abc",
      type: "stall_recovery",
      title: "Stall recovery: repeated confidence stall",
      description: "Change strategy when confidence stalls.",
      created_at: "2026-04-12T03:00:00.000Z",
      updated_at: "2026-04-12T04:00:00.000Z",
    });

    const result = buildDreamSoilMutationIntent({ workflowRecords: [workflow] });

    expect(result.mutation.records).toEqual([
      expect.objectContaining({
        record_id: "dream-workflow:abc:v1",
        record_key: "dream-workflow:abc",
        record_type: "workflow",
        status: "confirmed",
        is_active: true,
        source_type: "dream_workflow",
        source_id: "dream-workflow:abc",
        goal_id: "goal-a",
      }),
    ]);
    expect(result.mutation.chunks).toHaveLength(1);
    expect(result.recordsWithChangedSearchMaterial).toEqual(["dream-workflow:abc:v1"]);
  });

  it("projects multi-scope Dream workflows into filterable Soil records", () => {
    const workflow = makeWorkflowRecord({
      workflow_id: "dream-workflow:abc",
      type: "stall_recovery",
      title: "Stall recovery: repeated confidence stall",
      description: "Change strategy when confidence stalls.",
      applicability: {
        goal_ids: ["goal-a", "goal-b"],
        task_ids: ["task-a", "task-b"],
        event_types: ["StallDetected"],
        signals: ["stall"],
        scopes: [
          { goal_id: "goal-a", task_id: "task-a" },
          { goal_id: "goal-b", task_id: "task-b" },
        ],
      },
      created_at: "2026-04-12T03:00:00.000Z",
      updated_at: "2026-04-12T04:00:00.000Z",
    });

    const result = buildDreamSoilMutationIntent({ workflowRecords: [workflow] });

    expect(result.mutation.records).toEqual([
      expect.objectContaining({
        record_key: "dream-workflow:abc:goal-a:task-a",
        goal_id: "goal-a",
        task_id: "task-a",
      }),
      expect.objectContaining({
        record_key: "dream-workflow:abc:goal-b:task-b",
        goal_id: "goal-b",
        task_id: "task-b",
      }),
    ]);
    expect(result.mutation.chunks).toHaveLength(2);
    expect(result.recordsWithChangedSearchMaterial).toEqual([
      "dream-workflow:abc:goal-a:task-a:v1",
      "dream-workflow:abc:goal-b:task-b:v1",
    ]);
  });

  it("does not invent goal/task pairs when legacy workflow scopes are missing", () => {
    const workflow = makeWorkflowRecord({
      workflow_id: "dream-workflow:abc",
      type: "stall_recovery",
      title: "Stall recovery: repeated confidence stall",
      description: "Change strategy when confidence stalls.",
      applicability: {
        goal_ids: ["goal-a", "goal-b"],
        task_ids: ["task-a", "task-b"],
        event_types: ["StallDetected"],
        signals: ["stall"],
        scopes: [],
      },
      created_at: "2026-04-12T03:00:00.000Z",
      updated_at: "2026-04-12T04:00:00.000Z",
    });

    const result = buildDreamSoilMutationIntent({ workflowRecords: [workflow] });

    expect(result.mutation.records.map((record) => ({
      record_key: record.record_key,
      goal_id: record.goal_id,
      task_id: record.task_id,
    }))).toEqual([
      {
        record_key: "dream-workflow:abc:goal-a:all-tasks",
        goal_id: "goal-a",
        task_id: null,
      },
      {
        record_key: "dream-workflow:abc:goal-b:all-tasks",
        goal_id: "goal-b",
        task_id: null,
      },
    ]);
  });

  it("tombstones Dream workflow records whose artifact disappeared", () => {
    const workflow = makeWorkflowRecord({
      workflow_id: "dream-workflow:abc",
      type: "stall_recovery",
      title: "Stall recovery: repeated confidence stall",
      description: "Change strategy when confidence stalls.",
      created_at: "2026-04-12T03:00:00.000Z",
      updated_at: "2026-04-12T04:00:00.000Z",
    });
    const previous = buildDreamSoilMutationIntent({ workflowRecords: [workflow] }).mutation.records;

    const result = buildDreamSoilMutationIntent({
      workflowRecords: [],
      previousRecords: previous,
      deletedAt: "2026-04-12T05:00:00.000Z",
    });

    expect(result.mutation.records).toHaveLength(0);
    expect(result.mutation.tombstones).toEqual([
      expect.objectContaining({
        record_id: "dream-workflow:abc:v1",
        record_key: "dream-workflow:abc",
        reason: "dream workflow no longer exists",
        deleted_at: "2026-04-12T05:00:00.000Z",
      }),
    ]);
  });
});
