import { getPulseedDirPath } from "../../base/utils/paths.js";
import { loadProviderConfig } from "../../base/llm/provider-config.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { Goal } from "../../base/types/goal.js";
import type { Task } from "../../base/types/task.js";

export interface ProviderConfigSummary {
  provider: string;
  model: string;
  adapter: string;
  light_model?: string;
  base_url?: string;
  codex_cli_path?: string;
  has_api_key: boolean;
}

export class ChatStateService {
  constructor(private readonly stateManager: StateManager) {}

  async loadGoals(): Promise<Goal[]> {
    const goalIds = await this.stateManager.listGoalIds();
    const goals = await Promise.all(goalIds.map((id) => this.stateManager.loadGoal(id)));
    return goals.filter((goal): goal is Goal => goal !== null);
  }

  activeGoals(goals: Goal[]): Goal[] {
    return goals.filter((goal) => goal.status === "active" || goal.status === "waiting" || goal.loop_status === "running");
  }

  async listAllGoalIds(): Promise<string[]> {
    const [activeIds, archivedIds, recoverableArchivedIds] = await Promise.all([
      this.stateManager.listGoalIds(),
      this.stateManager.listArchivedGoals(),
      this.stateManager.listRecoverableArchivedGoalIds(),
    ]);
    return [...new Set([...activeIds, ...archivedIds, ...recoverableArchivedIds])];
  }

  async readTasksForGoal(goalId: string): Promise<Task[]> {
    return this.stateManager.listTasks(goalId);
  }

  async findTask(
    taskId: string,
    goalId?: string
  ): Promise<{ task?: Task; matches: Array<{ goalId: string; task: Task }> }> {
    const goalIds = goalId ? [goalId] : await this.listAllGoalIds();
    const matches: Array<{ goalId: string; task: Task }> = [];

    for (const candidateGoalId of goalIds) {
      let exact: Task | null = null;
      try {
        exact = await this.stateManager.loadTask(candidateGoalId, taskId);
      } catch {
        exact = null;
      }
      if (exact) {
        matches.push({ goalId: candidateGoalId, task: exact });
        continue;
      }

      let tasks: Task[] = [];
      try {
        tasks = await this.readTasksForGoal(candidateGoalId);
      } catch {
        tasks = [];
      }
      const partial = tasks.find((task) => task.id === taskId || task.id.startsWith(taskId));
      if (partial) {
        matches.push({ goalId: candidateGoalId, task: partial });
      }
    }

    return { task: matches.length === 1 ? matches[0]!.task : undefined, matches };
  }

  async readProviderConfigSummary(): Promise<ProviderConfigSummary> {
    const config = await loadProviderConfig({
      baseDir: this.providerConfigBaseDir(),
      saveMigration: false,
    });
    return {
      provider: config.provider,
      model: config.model,
      adapter: config.adapter,
      light_model: config.light_model,
      base_url: config.base_url,
      codex_cli_path: config.codex_cli_path,
      has_api_key: Boolean(config.api_key),
    };
  }

  formatConfig(config: ProviderConfigSummary): string {
    return Object.entries(config)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${typeof value === "string" && /key|token|secret/i.test(key) ? "[masked]" : String(value)}`)
      .join("\n");
  }

  private providerConfigBaseDir(): string {
    return this.stateManager.getBaseDir?.() ?? getPulseedDirPath();
  }
}
