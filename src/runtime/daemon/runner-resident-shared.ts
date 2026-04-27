import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { Goal } from "../../base/types/goal.js";
import type { DaemonConfig, DaemonState, ResidentActivity } from "../../base/types/daemon.js";
import { ResidentActivitySchema } from "../../base/types/daemon.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { GoalNegotiator } from "../../orchestrator/goal/goal-negotiator.js";
import type { CuriosityEngine } from "../../platform/traits/curiosity-engine.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { MemoryLifecycleManager } from "../../platform/knowledge/memory/memory-lifecycle.js";
import type { KnowledgeManager } from "../../platform/knowledge/knowledge-manager.js";
import type { Logger } from "../logger.js";
import type { LoopSupervisor } from "../executor/index.js";
import type { ScheduleEngine } from "../schedule/engine.js";

export function resolveResidentWorkspaceDir(configuredPath?: string): string {
  const trimmed = configuredPath?.trim();
  return trimmed ? path.resolve(trimmed) : process.cwd();
}

export function gatherResidentWorkspaceContext(workspaceDir: string, seedDescription?: string): string {
  const parts: string[] = [`Workspace: ${workspaceDir}`];
  const seed = seedDescription?.trim();
  if (seed) {
    parts.push(`Resident trigger hint: ${seed}`);
  }

  try {
    const pkgPath = path.join(workspaceDir, "package.json");
    const pkgRaw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
    const name = typeof pkg.name === "string" ? pkg.name : "";
    const description = typeof pkg.description === "string" ? pkg.description : "";
    const scripts = pkg.scripts && typeof pkg.scripts === "object"
      ? Object.keys(pkg.scripts as Record<string, unknown>).join(", ")
      : "";
    const prefix = name ? `Node.js project '${name}'` : "Node.js project";
    const descPart = description ? `. ${description}` : "";
    const scriptsPart = scripts ? `. Scripts: ${scripts}` : "";
    parts.push(`${prefix}${descPart}${scriptsPart}`);
  } catch {
    // No package metadata available.
  }

  try {
    const entries = fs.readdirSync(workspaceDir);
    const dirs = entries.filter((entry) => {
      try {
        return fs.statSync(path.join(workspaceDir, entry)).isDirectory();
      } catch {
        return false;
      }
    });
    const files = entries.filter((entry) => {
      try {
        return fs.statSync(path.join(workspaceDir, entry)).isFile();
      } catch {
        return false;
      }
    });
    const visibleEntries = [
      dirs.slice(0, 10).map((entry) => `${entry}/`).join(", "),
      files.slice(0, 5).join(", "),
    ].filter(Boolean).join(", ");
    if (visibleEntries) {
      parts.push(`Files: ${visibleEntries}`);
    }
  } catch {
    // Workspace listing is best-effort.
  }

  const gitResult = spawnSync("git", ["log", "--oneline", "-5", "--format=%s"], {
    cwd: workspaceDir,
    encoding: "utf-8",
  });
  if (gitResult.status === 0 && gitResult.stdout.trim().length > 0) {
    parts.push(`Recent changes: ${gitResult.stdout.trim().split("\n").join("; ")}`);
  }

  return parts.join(". ");
}

export interface DaemonRunnerResidentContext {
  baseDir: string;
  config: DaemonConfig;
  state: DaemonState;
  currentGoalIds: string[];
  stateManager: StateManager;
  driveSystem: { writeEvent(event: unknown): Promise<void> };
  logger: Logger;
  goalNegotiator?: GoalNegotiator;
  curiosityEngine?: CuriosityEngine;
  llmClient?: ILLMClient;
  memoryLifecycle?: MemoryLifecycleManager;
  knowledgeManager?: KnowledgeManager;
  scheduleEngine?: ScheduleEngine;
  supervisor?: LoopSupervisor;
  saveDaemonState(): Promise<void>;
  refreshOperationalState(): void;
  abortSleep(): void;
}

export async function loadExistingGoalTitles(
  context: Pick<DaemonRunnerResidentContext, "stateManager">,
): Promise<string[]> {
  const goalIds = await context.stateManager.listGoalIds().catch(() => []);
  const titles: string[] = [];
  for (const goalId of goalIds) {
    const goal = await context.stateManager.loadGoal(goalId).catch(() => null);
    if (goal?.title) {
      titles.push(goal.title);
    }
  }
  return titles;
}

export async function loadKnownGoals(
  context: Pick<DaemonRunnerResidentContext, "stateManager">,
): Promise<Goal[]> {
  const goalIds = await context.stateManager.listGoalIds().catch(() => []);
  const goals: Goal[] = [];
  for (const goalId of goalIds) {
    const goal = await context.stateManager.loadGoal(goalId).catch(() => null);
    if (goal) {
      goals.push(goal);
    }
  }
  return goals;
}

export async function persistResidentActivity(
  context: Pick<DaemonRunnerResidentContext, "state" | "saveDaemonState">,
  activity: Omit<ResidentActivity, "recorded_at"> & { recorded_at?: string },
): Promise<void> {
  const residentActivity = ResidentActivitySchema.parse({
    ...activity,
    recorded_at: activity.recorded_at ?? new Date().toISOString(),
  });
  context.state.last_resident_at = residentActivity.recorded_at;
  context.state.resident_activity = residentActivity;
  await context.saveDaemonState();
}
