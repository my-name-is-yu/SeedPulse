import * as fs from "node:fs";
import * as path from "node:path";
import { readJsonFileOrNull } from "../../../base/utils/json-io.js";
import { DaemonConfigSchema } from "../../../base/types/daemon.js";
import type { DaemonConfig } from "../../../base/types/daemon.js";
import type { PIDManager } from "../../../runtime/pid-manager.js";
import { compactRuntimeHealthKpi, type RuntimeHealthKpi } from "../../../runtime/store/index.js";
import type { SupervisorState } from "../../../runtime/executor/index.js";
import { getCliLogger } from "../cli-logger.js";

export function resolveDaemonRuntimeRoot(baseDir: string, configuredRoot?: string): string {
  if (!configuredRoot || configuredRoot.trim() === "") {
    return path.join(baseDir, "runtime");
  }
  return path.isAbsolute(configuredRoot)
    ? configuredRoot
    : path.resolve(baseDir, configuredRoot);
}

export function formatGoalMode(goalIds: string[]): string {
  return goalIds.length > 0 ? goalIds.join(", ") : "(idle mode)";
}

export async function loadDaemonConfig(baseDir: string): Promise<DaemonConfig> {
  const configPath = path.join(baseDir, "daemon.json");
  const legacyConfigPath = path.join(baseDir, "daemon-config.json");

  function readDaemonConfigFile(filePath: string): DaemonConfig | null {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
      const configParsed = DaemonConfigSchema.safeParse(raw);
      if (configParsed.success) {
        return configParsed.data;
      }
      getCliLogger().warn(`Ignoring invalid daemon config at ${filePath}; using defaults.`);
    } catch (err) {
      getCliLogger().warn(
        `Ignoring invalid daemon config at ${filePath}; using defaults. ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return null;
  }

  return readDaemonConfigFile(configPath) ?? readDaemonConfigFile(legacyConfigPath) ?? DaemonConfigSchema.parse({});
}

export function formatUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

export function formatRelativeTime(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const suffix = ms < 0 ? "from now" : "ago";
  const absMs = Math.abs(ms);
  if (absMs < 60000) return `${Math.floor(absMs / 1000)}s ${suffix}`;
  if (absMs < 3600000) return `${Math.floor(absMs / 60000)}m ${suffix}`;
  if (absMs < 86400000) return `${Math.floor(absMs / 3600000)}h ${suffix}`;
  return `${Math.floor(absMs / 86400000)}d ${suffix}`;
}

export function formatRelativeTimestamp(timestamp: number): string {
  return formatRelativeTime(new Date(timestamp).toISOString());
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

export type RuntimeHealthCapabilityKey = "process_alive" | "command_acceptance" | "task_execution";

export function formatCapabilityLabel(
  label: string,
  kpi: RuntimeHealthKpi,
  key: RuntimeHealthCapabilityKey
): string {
  const capability = kpi[key];
  const reason = capability.reason ? `, ${capability.reason}` : "";
  return `${label.padEnd(16)} ${capability.status} (${formatRelativeTimestamp(capability.checked_at)}${reason})`;
}

export function formatKpiCompactLine(kpi: RuntimeHealthKpi): string {
  const compact = compactRuntimeHealthKpi(kpi);
  if (!compact) {
    return "KPI snapshot:    unavailable";
  }
  return `KPI snapshot:    process=${compact.process_alive ? "up" : "down"} accept=${compact.can_accept_command ? "up" : "down"} execute=${compact.can_execute_task ? "up" : "down"} (${compact.status})`;
}

export interface RuntimeTaskOutcomeDetails {
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

export function formatTaskOutcomeLine(taskOutcome: RuntimeTaskOutcomeDetails): string {
  const rate = formatPercent(taskOutcome.success_rate);
  const terminalCounts = taskOutcome.terminal_counts;
  const thresholdLabel =
    taskOutcome.healthy_at_0_95 === null
      ? "threshold n/a"
      : taskOutcome.healthy_at_0_95
        ? "healthy @ 0.95"
        : "degraded @ 0.95";
  return `${rate} (${terminalCounts.succeeded}/${terminalCounts.terminal_tasks} terminal, ${thresholdLabel})`;
}

export function formatTaskSuccessRateLine(
  taskSuccessRate: number | null,
  taskOutcome: RuntimeTaskOutcomeDetails | undefined
): string {
  const rate = formatPercent(taskSuccessRate);
  if (!taskOutcome) {
    return `task_success_rate: ${rate}`;
  }

  const terminalCounts = taskOutcome.terminal_counts;
  const thresholdLabel =
    taskOutcome.healthy_at_0_95 === null
      ? "threshold n/a"
      : taskOutcome.healthy_at_0_95
        ? "healthy @ 0.95"
        : "degraded @ 0.95";
  return `task_success_rate: ${rate} (${terminalCounts.succeeded}/${terminalCounts.terminal_tasks} terminal, ${thresholdLabel})`;
}

export function isPidAlive(pidStatus: Awaited<ReturnType<PIDManager["inspect"]>>, pid?: number | null): boolean {
  return typeof pid === "number" && pidStatus.alivePids.includes(pid);
}

export async function readSupervisorState(runtimeRoot: string): Promise<SupervisorState | null> {
  const raw = await readJsonFileOrNull(path.join(runtimeRoot, "supervisor-state.json"));
  return raw as SupervisorState | null;
}
