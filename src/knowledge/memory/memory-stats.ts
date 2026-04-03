import * as path from "node:path";
import { StatisticalSummarySchema } from "../types/memory-lifecycle.js";
import type {
  ShortTermEntry,
  StatisticalSummary,
} from "../types/memory-lifecycle.js";
import { atomicWriteAsync, readJsonFileAsync } from "./memory-persistence.js";

// ─── Statistics ───

export async function updateStatistics(
  memoryDir: string,
  goalId: string,
  entries: ShortTermEntry[]
): Promise<void> {
  const statsPath = path.join(
    memoryDir,
    "long-term",
    "statistics",
    `${goalId}.json`
  );
  const now = new Date().toISOString();

  // Load existing or create fresh
  const existing = await readJsonFileAsync<StatisticalSummary>(
    statsPath,
    StatisticalSummarySchema
  );

  // Compute task statistics from task entries
  const taskEntries = entries.filter((e) => e.data_type === "task");
  const taskCategoryMap = new Map<
    string,
    { total: number; success: number; durations: number[] }
  >();

  for (const entry of taskEntries) {
    const category =
      typeof entry.data["task_category"] === "string"
        ? entry.data["task_category"]
        : "unknown";
    const status =
      typeof entry.data["status"] === "string" ? entry.data["status"] : "";
    const durationHours =
      typeof entry.data["duration_hours"] === "number"
        ? entry.data["duration_hours"]
        : 0;

    const current = taskCategoryMap.get(category) ?? {
      total: 0,
      success: 0,
      durations: [],
    };
    current.total++;
    if (status === "completed") current.success++;
    if (durationHours > 0) current.durations.push(durationHours);
    taskCategoryMap.set(category, current);
  }

  const taskStats = Array.from(taskCategoryMap.entries()).map(
    ([category, stats]) => ({
      task_category: category,
      goal_id: goalId,
      stats: {
        total_count: stats.total,
        success_rate:
          stats.total > 0 ? stats.success / stats.total : 0,
        avg_duration_hours:
          stats.durations.length > 0
            ? stats.durations.reduce((a, b) => a + b, 0) /
              stats.durations.length
            : 0,
        common_failure_reason: undefined,
      },
      period: computePeriod(entries),
      updated_at: now,
    })
  );

  // Compute dimension statistics from observation entries
  const observationEntries = entries.filter(
    (e) => e.data_type === "observation"
  );
  const dimMap = new Map<string, number[]>();

  for (const entry of observationEntries) {
    for (const dim of entry.dimensions) {
      const value =
        typeof entry.data["value"] === "number" ? entry.data["value"] : null;
      if (value !== null) {
        const arr = dimMap.get(dim) ?? [];
        arr.push(value);
        dimMap.set(dim, arr);
      }
    }
  }

  const dimensionStats = Array.from(dimMap.entries())
    .filter(([, values]) => values.length > 0)
    .map(([dim, values]) => {
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const variance =
        values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) /
        values.length;
      const stdDev = Math.sqrt(variance);
      const trend = computeTrend(values);
      return {
        dimension_name: dim,
        goal_id: goalId,
        stats: {
          avg_value: avg,
          std_deviation: stdDev,
          trend,
          anomaly_frequency: 0,
          observation_count: values.length,
        },
        period: computePeriod(entries),
        updated_at: now,
      };
    });

  // Overall stats
  const totalLoops = entries.length > 0
    ? (entries[entries.length - 1]?.loop_number ?? 0) -
      (entries[0]?.loop_number ?? 0) +
      1
    : 0;
  const totalTasks = taskEntries.length;
  const successfulTasks = taskEntries.filter(
    (e) => e.data["status"] === "completed"
  ).length;
  const overallSuccessRate =
    totalTasks > 0 ? successfulTasks / totalTasks : 0;

  // Merge with existing stats
  const mergedTaskStats = mergeTaskStats(
    existing?.task_stats ?? [],
    taskStats
  );
  const mergedDimStats = mergeDimStats(
    existing?.dimension_stats ?? [],
    dimensionStats
  );

  const summary = StatisticalSummarySchema.parse({
    goal_id: goalId,
    task_stats: mergedTaskStats,
    dimension_stats: mergedDimStats,
    overall: {
      total_loops:
        (existing?.overall.total_loops ?? 0) + totalLoops,
      total_tasks:
        (existing?.overall.total_tasks ?? 0) + totalTasks,
      overall_success_rate: overallSuccessRate,
      active_period: computePeriod(entries),
    },
    updated_at: now,
  });

  await atomicWriteAsync(statsPath, summary);
}

export function mergeTaskStats(
  existing: StatisticalSummary["task_stats"],
  incoming: StatisticalSummary["task_stats"]
): StatisticalSummary["task_stats"] {
  const map = new Map(existing.map((s) => [s.task_category, s]));
  for (const inc of incoming) {
    const prev = map.get(inc.task_category);
    if (!prev) {
      map.set(inc.task_category, inc);
      continue;
    }
    const totalCount = prev.stats.total_count + inc.stats.total_count;
    const prevSuccess = prev.stats.success_rate * prev.stats.total_count;
    const incSuccess = inc.stats.success_rate * inc.stats.total_count;
    map.set(inc.task_category, {
      ...inc,
      stats: {
        total_count: totalCount,
        success_rate: totalCount > 0 ? (prevSuccess + incSuccess) / totalCount : 0,
        avg_duration_hours:
          (prev.stats.avg_duration_hours + inc.stats.avg_duration_hours) / 2,
        common_failure_reason: inc.stats.common_failure_reason,
      },
    });
  }
  return Array.from(map.values());
}

export function mergeDimStats(
  existing: StatisticalSummary["dimension_stats"],
  incoming: StatisticalSummary["dimension_stats"]
): StatisticalSummary["dimension_stats"] {
  const map = new Map(existing.map((s) => [s.dimension_name, s]));
  for (const inc of incoming) {
    map.set(inc.dimension_name, inc); // Replace with latest computation
  }
  return Array.from(map.values());
}

export function computeTrend(
  values: number[]
): "rising" | "falling" | "stable" {
  if (values.length < 2) return "stable";
  const first = values.slice(0, Math.floor(values.length / 2));
  const second = values.slice(Math.floor(values.length / 2));
  const avgFirst = first.reduce((a, b) => a + b, 0) / first.length;
  const avgSecond = second.reduce((a, b) => a + b, 0) / second.length;
  const delta = avgSecond - avgFirst;
  const threshold = Math.abs(avgFirst) * 0.05; // 5% change threshold
  if (delta > threshold) return "rising";
  if (delta < -threshold) return "falling";
  return "stable";
}

export function computePeriod(entries: ShortTermEntry[]): string {
  if (entries.length === 0) return "unknown";
  const timestamps = entries.map((e) => e.timestamp).sort();
  const first = timestamps[0]?.slice(0, 10) ?? "unknown";
  const last = timestamps[timestamps.length - 1]?.slice(0, 10) ?? "unknown";
  return first === last ? first : `${first} to ${last}`;
}
