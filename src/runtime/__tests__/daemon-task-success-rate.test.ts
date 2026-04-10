import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeOwnershipCoordinator } from "../daemon/runtime-ownership.js";
import { RuntimeHealthStore } from "../store/health-store.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";

function makeLedgerRecord(taskId: string, goalId: string, latestEventType: string) {
  const now = "2026-04-10T00:00:00.000Z";
  return {
    task_id: taskId,
    goal_id: goalId,
    events: [],
    summary: {
      task_id: taskId,
      goal_id: goalId,
      latest_event_type: latestEventType,
      latest_event_at: now,
      attempt: 1,
      task_status: latestEventType === "failed" ? "error" : "done",
      created_at: now,
      acked_at: now,
      started_at: now,
      completed_at: now,
      verification_at: now,
      last_failure_at: latestEventType === "failed" ? now : null,
      abandoned_at: latestEventType === "abandoned" ? now : null,
      estimated_duration_ms: 1000,
      latencies: {
        created_to_acked_ms: 1,
        acked_to_started_ms: 1,
        started_to_completed_ms: 1,
        completed_to_verification_ms: 1,
        created_to_completed_ms: 1,
      },
    },
  };
}

describe("daemon task success rate", () => {
  let baseDir: string;
  let runtimeRoot: string;
  let store: RuntimeHealthStore;

  beforeEach(async () => {
    baseDir = makeTempDir("daemon-task-success-rate-base-");
    runtimeRoot = makeTempDir("daemon-task-success-rate-runtime-");
    store = new RuntimeHealthStore(runtimeRoot);
    await store.ensureReady();
  });

  afterEach(() => {
    cleanupTempDir(baseDir);
    cleanupTempDir(runtimeRoot);
  });

  it("persists task outcome ledger aggregates into the daemon health snapshot", async () => {
    const ledgerDir = path.join(baseDir, "tasks", "goal-important", "ledger");
    await fsp.mkdir(ledgerDir, { recursive: true });

    for (let index = 0; index < 19; index += 1) {
      await fsp.writeFile(
        path.join(ledgerDir, `task-success-${index}.json`),
        JSON.stringify(makeLedgerRecord(`task-success-${index}`, "goal-important", "succeeded"))
      );
    }
    await fsp.writeFile(
      path.join(ledgerDir, "task-failure.json"),
      JSON.stringify(makeLedgerRecord("task-failure", "goal-important", "failed"))
    );

    const coordinator = new RuntimeOwnershipCoordinator({
      baseDir,
      runtimeRoot,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
      approvalStore: null,
      outboxStore: null,
      runtimeHealthStore: store,
      leaderLockManager: null,
      onLeadershipLost: vi.fn(),
    });

    await coordinator.saveRuntimeHealthSnapshot("daemon_health_snapshot", {
      gateway: "ok",
      queue: "ok",
      leases: "ok",
      approval: "ok",
      outbox: "ok",
      supervisor: "ok",
    });

    const snapshot = await store.loadSnapshot();
    const taskDetails = snapshot?.details as
      | {
          task_success_rate: number | null;
          task_outcome?: {
            success_rate: number | null;
            terminal_counts: {
              succeeded: number;
              failed: number;
              abandoned: number;
              retried: number;
              terminal_tasks: number;
              total_tasks: number;
            };
            healthy_at_0_95: boolean | null;
          };
        }
      | undefined;

    expect(taskDetails?.task_success_rate).toBeCloseTo(0.95);
    expect(taskDetails?.task_outcome).toBeDefined();
    expect(taskDetails?.task_outcome?.terminal_counts).toMatchObject({
      total_tasks: 20,
      terminal_tasks: 20,
      succeeded: 19,
      failed: 1,
      abandoned: 0,
      retried: 0,
    });
    expect(taskDetails?.task_outcome?.healthy_at_0_95).toBe(true);
  });
});
