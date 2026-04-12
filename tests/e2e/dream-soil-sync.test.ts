import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ScheduleEngine } from "../../src/runtime/schedule/engine.js";
import { DaemonRunner, type DaemonDeps } from "../../src/runtime/daemon-runner.js";
import { Logger } from "../../src/runtime/logger.js";
import { PIDManager } from "../../src/runtime/pid-manager.js";
import { SqliteSoilRepository } from "../../src/platform/soil/sqlite-repository.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-dir.js";

interface ResidentDreamInvoker {
  triggerResidentDreamMaintenance(details?: Record<string, unknown>, tier?: "light" | "deep"): Promise<void>;
}

function seedDreamOutputs(baseDir: string): void {
  fs.mkdirSync(path.join(baseDir, "memory", "agent-memory"), { recursive: true });
  fs.mkdirSync(path.join(baseDir, "learning"), { recursive: true });
  fs.mkdirSync(path.join(baseDir, "dream", "events"), { recursive: true });
  fs.writeFileSync(
    path.join(baseDir, "memory", "agent-memory", "entries.json"),
    JSON.stringify({
      entries: [
        {
          id: "mem-e2e-procedure",
          key: "procedure.release",
          value: "Run CI before release.",
          summary: "Release procedure",
          tags: ["release"],
          memory_type: "procedure",
          status: "compiled",
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-12T01:00:00.000Z",
        },
      ],
      last_consolidated_at: null,
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(baseDir, "learning", "goal_patterns.json"),
    JSON.stringify([
      {
        pattern_id: "pattern-e2e-1",
        type: "task_generation",
        description: "Promote learned patterns into Soil.",
        confidence: 0.9,
        evidence_count: 3,
        source_goal_ids: ["goal-e2e"],
        applicable_domains: ["daemon"],
        embedding_id: null,
        created_at: "2026-04-12T00:00:00.000Z",
        last_applied_at: null,
      },
    ]),
    "utf8"
  );
  fs.writeFileSync(
    path.join(baseDir, "dream", "events", "goal-e2e.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-04-12T02:00:00.000Z",
      eventType: "StallDetected",
      goalId: "goal-e2e",
      taskId: "task-e2e",
      data: {
        task_id: "task-e2e",
        stall_type: "confidence_stall",
        suggested_cause: "verification signal is weak",
      },
    })}\n`,
    "utf8"
  );
}

async function expectDreamSoilRecords(baseDir: string): Promise<void> {
  const repository = await SqliteSoilRepository.create({ rootDir: path.join(baseDir, "soil") });
  try {
    const records = await repository.loadRecords({
      active_only: false,
      source_types: ["agent_memory", "learned_pattern", "dream_workflow"],
    });
    expect(records).toHaveLength(3);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        record_key: "agent-memory:procedure.release",
        record_type: "workflow",
        status: "confirmed",
        is_active: true,
        source_type: "agent_memory",
        source_id: "mem-e2e-procedure",
      }),
      expect.objectContaining({
        record_key: "learned-pattern:pattern-e2e-1:goal-e2e",
        record_type: "reflection",
        status: "confirmed",
        is_active: true,
        source_type: "learned_pattern",
        source_id: "pattern-e2e-1",
      }),
      expect.objectContaining({
        record_type: "workflow",
        source_type: "dream_workflow",
        status: "candidate",
        is_active: true,
      }),
    ]));
  } finally {
    repository.close();
  }
}

describe("Dream Soil sync E2E", () => {
  let tempDir = "";

  afterEach(() => {
    if (tempDir) {
      cleanupTempDir(tempDir);
      tempDir = "";
    }
  });

  it("syncs Dream agent memory into the SQLite Soil store during dream consolidation", async () => {
    tempDir = makeTempDir("dream-soil-e2e-");
    seedDreamOutputs(tempDir);

    const stateManager = {
      listGoalIds: async () => ["goal-e2e"],
    };
    const engine = new ScheduleEngine({
      baseDir: tempDir,
      stateManager: stateManager as never,
    });
    const entry = await engine.addEntry({
      name: "dream-soil-sync",
      layer: "cron",
      trigger: { type: "interval", seconds: 3600, jitter_factor: 0 },
      enabled: true,
      cron: {
        job_kind: "reflection",
        reflection_kind: "dream_consolidation",
        prompt_template: "Run dream consolidation.",
        context_sources: [],
        output_format: "report",
        max_tokens: 1000,
      },
    });

    const result = await engine.executeCron(entry);

    expect(result.status).toBe("ok");
    expect(result.output_summary).toContain("Dream consolidation completed");
    expect(fs.existsSync(path.join(tempDir, "reflections"))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "dream", "reports"))).toBe(true);

    await expectDreamSoilRecords(tempDir);
  });

  it("syncs Dream outputs through the resident daemon dream maintenance path", async () => {
    tempDir = makeTempDir("dream-soil-daemon-e2e-");
    seedDreamOutputs(tempDir);

    const stateManager = {
      getBaseDir: () => tempDir,
      listGoalIds: async () => ["goal-e2e"],
      loadGoal: async () => null,
    };
    const daemon = new DaemonRunner({
      coreLoop: { run: async () => ({}) } as unknown as DaemonDeps["coreLoop"],
      driveSystem: {} as unknown as DaemonDeps["driveSystem"],
      stateManager: stateManager as unknown as DaemonDeps["stateManager"],
      pidManager: new PIDManager(tempDir),
      logger: new Logger({ dir: path.join(tempDir, "logs"), consoleOutput: false }),
    });

    await (daemon as unknown as ResidentDreamInvoker).triggerResidentDreamMaintenance(undefined, "deep");

    const state = JSON.parse(fs.readFileSync(path.join(tempDir, "daemon-state.json"), "utf8")) as {
      resident_activity?: { kind?: string; summary?: string };
    };
    expect(state.resident_activity).toEqual(expect.objectContaining({
      kind: "dream",
      summary: expect.stringContaining("Resident dream deep analysis ran"),
    }));
    expect(fs.existsSync(path.join(tempDir, "reflections"))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "dream", "reports"))).toBe(true);

    await expectDreamSoilRecords(tempDir);
  });
});
