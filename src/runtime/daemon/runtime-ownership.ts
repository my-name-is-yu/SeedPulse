import * as path from "node:path";
import type { Logger } from "../logger.js";
import type { ApprovalStore, OutboxStore, RuntimeHealthStore } from "../store/index.js";
import type { LeaderLockManager } from "../leader-lock-manager.js";
import { summarizeTaskOutcomeLedgers } from "../../orchestrator/execution/task/task-outcome-ledger.js";
import {
  evolveRuntimeHealthKpi,
  type RuntimeDaemonHealth,
  type RuntimeHealthCapabilityStatuses,
} from "../store/index.js";

export type RuntimeHealthComponents = Record<
  "gateway" | "queue" | "leases" | "approval" | "outbox" | "supervisor",
  "ok" | "degraded"
>;

interface RuntimeOwnershipDeps {
  baseDir: string | null;
  runtimeRoot: string | null;
  logger: Logger;
  approvalStore: ApprovalStore | null;
  outboxStore: OutboxStore | null;
  runtimeHealthStore: RuntimeHealthStore | null;
  leaderLockManager: LeaderLockManager | null;
  onLeadershipLost: (reason: string) => void;
}

interface RuntimeTaskOutcomeDetails {
  success_rate: number | null;
  terminal_counts: {
    total_tasks: number;
    terminal_tasks: number;
    succeeded: number;
    failed: number;
    abandoned: number;
    retried: number;
  };
  healthy_at_0_95: boolean | null;
}

export class RuntimeOwnershipCoordinator {
  private leaderOwnerToken: string | null = null;
  private leaderHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private runtimeHealthPhase = "disabled";
  private runtimeHealthComponents: RuntimeHealthComponents | null = null;

  constructor(private readonly deps: RuntimeOwnershipDeps) {}

  private deriveCapabilityStatuses(
    components: RuntimeHealthComponents
  ): RuntimeHealthCapabilityStatuses {
    return {
      process_alive: "ok",
      command_acceptance:
        components.gateway === "ok" && components.queue === "ok" ? "ok" : "degraded",
      task_execution:
        components.supervisor === "ok" && components.leases === "ok" ? "ok" : "degraded",
    };
  }

  private mergeCapabilityStatus(
    previous: RuntimeHealthCapabilityStatuses[keyof RuntimeHealthCapabilityStatuses] | undefined,
    derived: RuntimeHealthCapabilityStatuses[keyof RuntimeHealthCapabilityStatuses]
  ): RuntimeHealthCapabilityStatuses[keyof RuntimeHealthCapabilityStatuses] {
    const rank = { ok: 0, degraded: 1, failed: 2 } as const;
    if (!previous) {
      return derived;
    }
    return rank[previous] >= rank[derived] ? previous : derived;
  }

  private summarizeComponents(components: RuntimeHealthComponents | null): RuntimeDaemonHealth["status"] {
    if (!components) {
      return "degraded";
    }
    return Object.values(components).every((value) => value === "ok") ? "ok" : "degraded";
  }

  private async summarizeTaskOutcomeDetails(): Promise<RuntimeTaskOutcomeDetails | null> {
    if (!this.deps.baseDir) {
      return null;
    }

    const summary = await summarizeTaskOutcomeLedgers(this.deps.baseDir);
    return {
      success_rate: summary.success_rate,
      terminal_counts: {
        total_tasks: summary.total_tasks,
        terminal_tasks: summary.terminal_tasks,
        succeeded: summary.succeeded,
        failed: summary.failed,
        abandoned: summary.abandoned,
        retried: summary.retried,
      },
      healthy_at_0_95: summary.success_rate === null ? null : summary.success_rate >= 0.95,
    };
  }

  private async buildHealthDetails(phase: string): Promise<Record<string, unknown>> {
    const details: Record<string, unknown> = {
      pid: process.pid,
      runtime_journal_v2: true,
      runtime_root: this.deps.runtimeRoot,
      phase,
    };
    const taskOutcome = await this.summarizeTaskOutcomeDetails();
    if (taskOutcome) {
      details.task_success_rate = taskOutcome.success_rate;
      details.task_outcome = taskOutcome;
    }
    return details;
  }

  private async saveDaemonHealthWithKpi(params: {
    status: RuntimeDaemonHealth["status"];
    checkedAt: number;
    capabilityStatuses: RuntimeHealthCapabilityStatuses;
    reasons?: Partial<Record<keyof RuntimeHealthCapabilityStatuses, string>>;
  }): Promise<void> {
    const previous = await this.deps.runtimeHealthStore?.loadDaemonHealth();
    await this.deps.runtimeHealthStore?.saveDaemonHealth({
      status: params.status,
      leader: this.leaderOwnerToken !== null,
      checked_at: params.checkedAt,
      kpi: evolveRuntimeHealthKpi(
        previous?.kpi,
        params.capabilityStatuses,
        params.checkedAt,
        params.reasons,
      ),
      details: await this.buildHealthDetails(this.runtimeHealthPhase),
    });
  }

  async initializeFoundation(): Promise<void> {
    await Promise.all([
      this.deps.approvalStore?.ensureReady(),
      this.deps.outboxStore?.ensureReady(),
      this.deps.runtimeHealthStore?.ensureReady(),
    ]);

    this.deps.logger.info("Runtime journal foundation initialized", {
      runtime_root: this.deps.runtimeRoot,
      queue_path: this.deps.runtimeRoot ? path.join(this.deps.runtimeRoot, "queue.json") : undefined,
    });
  }

  async saveRuntimeHealthSnapshot(
    phase: string,
    components: RuntimeHealthComponents
  ): Promise<void> {
    this.runtimeHealthPhase = phase;
    this.runtimeHealthComponents = components;
    const checkedAt = Date.now();
    const status = Object.values(components).every((value) => value === "ok") ? "ok" : "degraded";
    const kpiStatuses = this.deriveCapabilityStatuses(components);
    const previous = await this.deps.runtimeHealthStore?.loadDaemonHealth();
    await this.deps.runtimeHealthStore?.saveSnapshot({
      status,
      leader: this.leaderOwnerToken !== null,
      checked_at: checkedAt,
      components,
      kpi: evolveRuntimeHealthKpi(previous?.kpi, kpiStatuses, checkedAt, {
        command_acceptance:
          kpiStatuses.command_acceptance === "ok"
            ? undefined
            : "gateway or queue health degraded",
        task_execution:
          kpiStatuses.task_execution === "ok"
            ? undefined
            : "supervisor or lease health degraded",
      }),
      details: await this.buildHealthDetails(phase),
    });
  }

  async acquireLeadership(leaseMs: number, heartbeatMs: number): Promise<void> {
    if (!this.deps.leaderLockManager) {
      return;
    }

    const acquired = await this.deps.leaderLockManager.acquire({ leaseMs });
    if (!acquired) {
      const current = await this.deps.leaderLockManager.read();
      throw new Error(
        `Runtime daemon leader already active (PID ${current?.pid ?? "unknown"})`
      );
    }

    this.leaderOwnerToken = acquired.owner_token;
    await this.writeRuntimeHeartbeat();
    this.leaderHeartbeatTimer = setInterval(() => {
      void this.renewLeadership(leaseMs).catch((err) => {
        this.deps.logger.error("Failed to renew runtime leader lock", {
          error: err instanceof Error ? err.message : String(err),
        });
        this.deps.onLeadershipLost(
          err instanceof Error ? err.message : String(err)
        );
      });
    }, heartbeatMs);
    this.leaderHeartbeatTimer.unref?.();
  }

  async releaseLeadership(): Promise<void> {
    if (this.leaderHeartbeatTimer !== null) {
      clearInterval(this.leaderHeartbeatTimer);
      this.leaderHeartbeatTimer = null;
    }

    const ownerToken = this.leaderOwnerToken;
    this.leaderOwnerToken = null;
    if (ownerToken) {
      await this.deps.leaderLockManager?.release(ownerToken);
    }
  }

  async saveFinalHealth(status: "failed" | "degraded"): Promise<void> {
    const checkedAt = Date.now();
    const previous = await this.deps.runtimeHealthStore?.loadDaemonHealth();
    await this.deps.runtimeHealthStore?.saveDaemonHealth({
      status,
      leader: false,
      checked_at: checkedAt,
      kpi: evolveRuntimeHealthKpi(previous?.kpi, {
        process_alive: status,
        command_acceptance: status,
        task_execution: status,
      }, checkedAt, {
        process_alive:
          status === "failed" ? "daemon exited unexpectedly" : "daemon stopped",
        command_acceptance:
          status === "failed" ? "daemon exited unexpectedly" : "daemon stopped",
        task_execution:
          status === "failed" ? "daemon exited unexpectedly" : "daemon stopped",
      }),
      details: await this.buildHealthDetails(this.runtimeHealthPhase),
    });
  }

  private async renewLeadership(leaseMs: number): Promise<void> {
    if (!this.deps.leaderLockManager || !this.leaderOwnerToken) {
      return;
    }

    const renewed = await this.deps.leaderLockManager.renew(this.leaderOwnerToken, {
      leaseMs,
    });
    if (!renewed) {
      this.deps.onLeadershipLost("Runtime leader lock was lost");
      return;
    }

    await this.writeRuntimeHeartbeat();
  }

  private async writeRuntimeHeartbeat(): Promise<void> {
    if (!this.deps.runtimeHealthStore) {
      return;
    }

    const checkedAt = Date.now();
    const components =
      this.runtimeHealthComponents ??
      {
        gateway: "degraded" as const,
        queue: "degraded" as const,
        leases: "degraded" as const,
        approval: "degraded" as const,
        outbox: "degraded" as const,
          supervisor: "degraded" as const,
      };
    const status = Object.values(components).every((value) => value === "ok") ? "ok" : "degraded";
    const previous = await this.deps.runtimeHealthStore.loadDaemonHealth();
    const derivedStatuses = this.deriveCapabilityStatuses(components);
    await this.saveDaemonHealthWithKpi({
      status,
      checkedAt,
      capabilityStatuses: {
        process_alive: "ok",
        command_acceptance: this.mergeCapabilityStatus(
          previous?.kpi?.command_acceptance.status,
          derivedStatuses.command_acceptance,
        ),
        task_execution: this.mergeCapabilityStatus(
          previous?.kpi?.task_execution.status,
          derivedStatuses.task_execution,
        ),
      },
      reasons: {
        command_acceptance:
          components.gateway === "ok" && components.queue === "ok"
            ? undefined
            : "gateway or queue health degraded",
        task_execution:
          components.supervisor === "ok" && components.leases === "ok"
            ? undefined
            : "supervisor or lease health degraded",
      },
    });
  }

  async observeCommandAcceptance(
    status: Exclude<RuntimeHealthCapabilityStatuses["command_acceptance"], "failed"> | "failed",
    reason?: string
  ): Promise<void> {
    const components = this.runtimeHealthComponents;
    const derivedStatuses = components ? this.deriveCapabilityStatuses(components) : null;
    await this.saveDaemonHealthWithKpi({
      status: status === "failed" ? "failed" : this.summarizeComponents(components),
      checkedAt: Date.now(),
      capabilityStatuses: {
        process_alive: "ok",
        command_acceptance: status,
        task_execution: derivedStatuses?.task_execution ?? "degraded",
      },
      reasons: {
        command_acceptance: reason,
      },
    });
  }

  async observeTaskExecution(
    status: Exclude<RuntimeHealthCapabilityStatuses["task_execution"], "failed"> | "failed",
    reason?: string
  ): Promise<void> {
    const components = this.runtimeHealthComponents;
    const derivedStatuses = components ? this.deriveCapabilityStatuses(components) : null;
    await this.saveDaemonHealthWithKpi({
      status: status === "failed" ? "failed" : this.summarizeComponents(components),
      checkedAt: Date.now(),
      capabilityStatuses: {
        process_alive: "ok",
        command_acceptance: derivedStatuses?.command_acceptance ?? "degraded",
        task_execution: status,
      },
      reasons: {
        task_execution: reason,
      },
    });
  }
}
