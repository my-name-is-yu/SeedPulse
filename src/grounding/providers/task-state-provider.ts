import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { GroundingProvider } from "../contracts.js";
import { makeSection, makeSource } from "./helpers.js";

interface TaskSummary {
  id: string;
  work_description?: string;
  status?: string;
}

function formatTask(task: TaskSummary): string {
  const label = task.work_description?.trim() || "Untitled task";
  const status = task.status ? ` - ${task.status}` : "";
  return `- ${label} (${task.id})${status}`;
}

export const taskStateProvider: GroundingProvider = {
  key: "task_state",
  kind: "dynamic",
  async build(context) {
    const stateManager = context.deps.stateManager;
    const goalId = context.request.goalId;
    if (!stateManager || !goalId) {
      return null;
    }

    const baseDir = stateManager.getBaseDir?.();
    if (!baseDir) {
      return null;
    }
    const tasksDir = path.join(baseDir, "tasks", goalId);
    let entries: string[] = [];
    try {
      entries = (await fsp.readdir(tasksDir)).filter((entry) => entry.endsWith(".json"));
    } catch {
      entries = [];
    }

    const prioritizedEntries = context.request.taskId
      ? [
          `${context.request.taskId}.json`,
          ...entries.filter((entry) => entry !== `${context.request.taskId}.json`),
        ]
      : entries;
    const limitedEntries = prioritizedEntries.slice(0, context.profile.budgets.maxTaskCount);
    const tasks: TaskSummary[] = [];
    for (const entry of limitedEntries) {
      const raw = await stateManager.readRaw(`tasks/${goalId}/${entry}`) as TaskSummary | null;
      if (raw?.id) {
        tasks.push(raw);
      }
    }

    return makeSection(
      "task_state",
      tasks.length > 0 ? tasks.map(formatTask).join("\n") : "No active tasks found.",
      [
        makeSource("task_state", "task state", {
          type: tasks.length > 0 ? "state" : "none",
          path: tasksDir,
          trusted: true,
          accepted: true,
          retrievalId: tasks.length > 0 ? `tasks:${goalId}` : "none:task_state",
        }),
      ],
      { title: "Current Tasks" },
    );
  },
};
