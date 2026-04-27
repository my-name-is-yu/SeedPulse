import type { StateManager } from "../../base/state/state-manager.js";
import { getPulseedDirPath } from "../../base/utils/paths.js";
import { loadProviderConfig } from "../../base/llm/provider-config.js";
import { TaskSchema, type Task } from "../../base/types/task.js";
import type { Goal } from "../../base/types/goal.js";
import type { ILLMClient, LLMResponse } from "../../base/llm/llm-client.js";
import type { LoadedChatSession } from "./chat-session-store.js";
import { ChatHistory, type ChatSession, type ChatUsageCounter } from "./chat-history.js";
import { ChatSessionCatalog } from "./chat-session-store.js";
import { resolveGitRoot } from "../../platform/observation/context-provider.js";
import { TendCommand, type TendDeps } from "./tend-command.js";
import { EventSubscriber } from "./event-subscriber.js";
import type { ChatEvent } from "./chat-events.js";
import { createRuntimeSessionRegistry } from "../../runtime/session-registry/index.js";
import {
  collectGoalUsage,
  collectScheduleUsage,
  listRecoverableArchivedGoalIds,
  readTasksForGoal,
} from "./chat-runner-state.js";
import { checkGitChanges } from "./chat-runner-support.js";
import { formatFailureRecovery } from "./failure-recovery.js";
import {
  summarizeExecutionPolicy,
  withExecutionPolicyOverrides,
  type ExecutionPolicy,
} from "../../orchestrator/execution/agent-loop/execution-policy.js";
import { formatRoute, formatRuntimeSessionsList, formatRuntimeStatus } from "./chat-runner-runtime.js";
import type { ChatRunnerDeps, ChatRunResult, RuntimeControlChatContext } from "./chat-runner.js";
import type { SelectedChatRoute } from "./ingress-router.js";
import type { DaemonClient } from "../../runtime/daemon/client.js";
import type { GoalNegotiator } from "../../orchestrator/goal/goal-negotiator.js";

export const COMMAND_HELP = `Available commands:
Session
  /help                 Show this help message
  /clear                Clear conversation history
  /sessions             List prior chat sessions
  /history [id|title]   Show saved chat history
  /title <title>        Rename the current session
  /resume [id|title]    Resume native agentloop state for the current or selected session
  /cleanup [--dry-run]  Clean up stale chat sessions
  /compact              Summarize older chat turns and keep the latest turns
  /context              Show active working context and session assumptions
  /exit                 Exit chat mode

Goals and tasks
  /status [goal-id]     Show active goal status, or one goal when an id is provided
  /goals                List goals
  /tasks [goal-id]      List tasks for a goal; uses the only active goal when unambiguous
  /task <task-id> [goal-id]
                        Show one task; searches goals when no goal id is provided
  /track                Promote session to Tier 2 goal pursuit (not yet implemented)
  /tend                 Generate a goal from chat history and start autonomous daemon execution

Configuration
  /config               Show provider configuration with secrets masked
  /model                Show the active provider/model/adapter
  /permissions [args]   Show or update session execution policy
  /plugins              List installed plugins when plugin metadata is available
  /usage [scope]        Show usage summary (session, goal <id>, daemon <goal-id>, schedule [7d|24h|2w])

Review and branching
  /review               Show current diff summary and verification context
  /fork [title]         Fork the current chat session into a new session
  /undo                 Remove the latest chat turn from session history

Deferred
  /retry is intentionally not supported yet.`;

interface ProviderConfigSummary {
  provider: string;
  model: string;
  adapter: string;
  light_model?: string;
  base_url?: string;
  codex_cli_path?: string;
  has_api_key: boolean;
}

export interface PendingTendState {
  goalId: string;
  maxIterations?: number;
}

export interface ResumeCommand {
  selector?: string;
}

export interface ChatRunnerCommandHost {
  deps: ChatRunnerDeps;
  onNotification?: (message: string) => void;
  getHistory(): ChatHistory | null;
  setHistory(history: ChatHistory | null): void;
  getSessionCwd(): string | null;
  setSessionCwd(cwd: string | null): void;
  setSessionActive(active: boolean): void;
  getNativeAgentLoopStatePath(): string | null;
  setNativeAgentLoopStatePath(path: string | null): void;
  getRuntimeControlContext(): RuntimeControlChatContext | null;
  getPendingTend(): PendingTendState | null;
  setPendingTend(value: PendingTendState | null): void;
  getLastSelectedRoute(): SelectedChatRoute | null;
  getSessionExecutionPolicy(): Promise<ExecutionPolicy>;
  emitEvent(event: ChatEvent): void;
  getActiveSubscribers(): Map<string, EventSubscriber>;
}

export class ChatRunnerCommandHandler {
  constructor(private readonly host: ChatRunnerCommandHost) {}

  parseResumeCommand(input: string): ResumeCommand | null {
    const trimmed = input.trim();
    const match = /^\/resume(?:\s+(.+))?$/i.exec(trimmed);
    if (!match) return null;
    const selector = match[1]?.trim();
    return selector ? { selector } : {};
  }

  async handleCommand(input: string, cwd?: string): Promise<ChatRunResult | null> {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return null;

    const cmd = trimmed.toLowerCase().split(/\s+/)[0];
    const start = Date.now();

    if (cmd === "/help") {
      return { success: true, output: COMMAND_HELP, elapsed_ms: Date.now() - start };
    }
    if (cmd === "/clear") {
      await this.host.getHistory()?.clear();
      return { success: true, output: "Conversation history cleared.", elapsed_ms: Date.now() - start };
    }
    if (cmd === "/sessions") {
      const registry = createRuntimeSessionRegistry({ stateManager: this.host.deps.stateManager });
      const snapshot = await registry.snapshot();
      return { success: true, output: formatRuntimeSessionsList(snapshot), elapsed_ms: Date.now() - start };
    }
    if (cmd === "/history") {
      const catalog = new ChatSessionCatalog(this.host.deps.stateManager);
      const selector = trimmed.slice("/history".length).trim();
      const history = this.host.getHistory();
      const session = selector
        ? await catalog.loadSessionBySelector(selector)
        : history
          ? await catalog.loadSession(history.getSessionId())
          : null;
      if (!session) {
        return { success: false, output: "No chat session history found.", elapsed_ms: Date.now() - start };
      }
      return { success: true, output: this.formatHistory(session), elapsed_ms: Date.now() - start };
    }
    if (cmd === "/title") {
      const title = trimmed.slice("/title".length).trim();
      if (!title) {
        return { success: false, output: "Usage: /title <title>", elapsed_ms: Date.now() - start };
      }
      const history = this.host.getHistory();
      if (!history) {
        return { success: false, output: "No active chat session to rename.", elapsed_ms: Date.now() - start };
      }
      const catalog = new ChatSessionCatalog(this.host.deps.stateManager);
      history.setTitle(title);
      await history.persist();
      await catalog.renameSession(history.getSessionId(), title);
      return { success: true, output: `Renamed chat session to "${title}".`, elapsed_ms: Date.now() - start };
    }
    if (cmd === "/cleanup") {
      const catalog = new ChatSessionCatalog(this.host.deps.stateManager);
      const dryRun = trimmed.includes("--dry-run");
      const report = await catalog.cleanupSessions({
        dryRun,
        activeSessionId: this.host.getHistory()?.getSessionId(),
      });
      const verb = dryRun ? "would remove" : "removed";
      return {
        success: true,
        output: `Chat session cleanup ${verb} ${report.removedSessionIds.length} session(s).`,
        elapsed_ms: Date.now() - start,
      };
    }
    if (cmd === "/compact") {
      return this.handleCompact(start);
    }
    if (cmd === "/status") {
      return this.handleStatus(trimmed.slice("/status".length).trim(), start);
    }
    if (cmd === "/goals") {
      return this.handleGoals(start);
    }
    if (cmd === "/tasks") {
      return this.handleTasks(trimmed.slice("/tasks".length).trim(), start);
    }
    if (cmd === "/task") {
      return this.handleTask(trimmed.slice("/task".length).trim(), start);
    }
    if (cmd === "/config") {
      return this.handleConfig(start);
    }
    if (cmd === "/model") {
      return this.handleModel(start);
    }
    if (cmd === "/permissions") {
      return this.handlePermissions(trimmed.slice("/permissions".length).trim(), start);
    }
    if (cmd === "/plugins") {
      return this.handlePlugins(start);
    }
    if (cmd === "/usage") {
      return this.handleUsage(trimmed.slice("/usage".length).trim(), start);
    }
    if (cmd === "/context" || cmd === "/working-memory") {
      return this.handleContext(start, cwd);
    }
    if (cmd === "/review") {
      return this.handleReview(start);
    }
    if (cmd === "/fork") {
      return this.handleFork(trimmed.slice("/fork".length).trim(), start);
    }
    if (cmd === "/undo") {
      return this.handleUndo(start);
    }
    if (cmd === "/retry") {
      return {
        success: false,
        output: [
          "/retry is not supported yet.",
          "",
          formatFailureRecovery({
            kind: "runtime_interruption",
            label: "Retry unavailable",
            summary: "PulSeed does not yet have a safe replay contract for the previous turn.",
            nextActions: [
              "Use /review to inspect any current diff before continuing.",
              "Use /resume when PulSeed reports resumable agent-loop state.",
              "Ask for the exact next step to rerun instead of replaying the full turn.",
            ],
          }),
        ].join("\n"),
        elapsed_ms: Date.now() - start,
      };
    }
    if (cmd === "/exit") {
      return { success: true, output: "Exiting chat mode.", elapsed_ms: Date.now() - start };
    }
    if (cmd === "/track") {
      return this.handleTrack(start);
    }
    if (cmd === "/tend") {
      const args = trimmed.slice("/tend".length).trim();
      return this.handleTend(args, start);
    }

    if (this.host.getPendingTend() !== null) {
      return this.handleTendConfirmation(trimmed, start);
    }

    return {
      success: false,
      output: `Unknown command: ${input.trim()}. Type /help for available commands.`,
      elapsed_ms: Date.now() - start,
    };
  }

  async handleTendConfirmation(input: string, start: number): Promise<ChatRunResult> {
    const pending = this.host.getPendingTend()!;
    this.host.setPendingTend(null);

    const normalized = input.trim().toLowerCase();
    const confirmed = normalized === "" || normalized === "y" || normalized === "yes";

    if (!confirmed) {
      return {
        success: true,
        output: "Tend cancelled. Continue chatting to refine your goal, then try /tend again.",
        elapsed_ms: Date.now() - start,
      };
    }

    if (!this.host.deps.daemonClient) {
      return {
        success: false,
        output: "Daemon client not available.",
        elapsed_ms: Date.now() - start,
      };
    }

    const { goalId, maxIterations } = pending;
    let subscriber: EventSubscriber | null = null;
    if (this.host.deps.daemonBaseUrl && !this.host.getActiveSubscribers().has(goalId)) {
      subscriber = new EventSubscriber(this.host.deps.daemonBaseUrl, goalId, "normal");
      this.host.getActiveSubscribers().set(goalId, subscriber);

      subscriber.on("notification", (notification: unknown) => {
        const n = notification as { message: string };
        this.host.deps.onNotification?.(n.message);
        this.host.onNotification?.(n.message);
      });

      subscriber.on("chat_event", (event: ChatEvent) => {
        this.host.emitEvent(event);
      });

      try {
        await subscriber.subscribeReady();
      } catch (err) {
        subscriber.unsubscribe();
        this.host.getActiveSubscribers().delete(goalId);
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          output: `Daemon event stream unavailable: ${msg}. Goal was not started.`,
          elapsed_ms: Date.now() - start,
        };
      }
    }

    try {
      const tendDeps = this.buildTendDeps(
        this.host.deps.llmClient as ILLMClient,
        this.host.deps.goalNegotiator as GoalNegotiator,
        this.host.deps.daemonClient,
      );
      const result = await new TendCommand().startAcceptedGoal(goalId, maxIterations, tendDeps);
      if (!result.success) {
        if (subscriber) {
          subscriber.unsubscribe();
          this.host.getActiveSubscribers().delete(goalId);
        }
        return {
          success: false,
          output: result.message,
          elapsed_ms: Date.now() - start,
        };
      }
      const shortId = goalId.length > 12 ? goalId.slice(0, 12) : goalId;
      return {
        success: true,
        output: `[tend] ${shortId}: Started — daemon is now tending your goal${maxIterations !== undefined ? ` (max ${maxIterations} iterations)` : ""}.\nBackground run: ${result.backgroundRunId}\nRun 'pulseed status' to check progress.`,
        elapsed_ms: Date.now() - start,
      };
    } catch (err) {
      if (subscriber) {
        subscriber.unsubscribe();
        this.host.getActiveSubscribers().delete(goalId);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Daemon unavailable: ${msg}. Start the daemon with 'pulseed daemon start' first.`,
        elapsed_ms: Date.now() - start,
      };
    }
  }

  private formatHistory(session: LoadedChatSession): string {
    const title = session.title ? ` "${session.title}"` : "";
    if (session.messages.length === 0) {
      return `Session ${session.id}${title} has no messages.`;
    }
    const lines = session.messages.map((message) => {
      const role = message.role === "assistant" ? "Assistant" : "User";
      return `${role}: ${message.content}`;
    });
    return `Session ${session.id}${title} (${session.cwd})\n${lines.join("\n")}`;
  }

  private async loadGoals(): Promise<Goal[]> {
    const goalIds = await this.host.deps.stateManager.listGoalIds();
    const goals = await Promise.all(goalIds.map((id) => this.host.deps.stateManager.loadGoal(id)));
    return goals.filter((goal): goal is Goal => goal !== null);
  }

  private async listAllGoalIds(): Promise<string[]> {
    const activeIds = await this.host.deps.stateManager.listGoalIds();
    const archivedIds = await this.host.deps.stateManager.listArchivedGoals();
    const stateManager = this.host.deps.stateManager as StateManager & { getBaseDir?: () => string };
    const recoverableArchivedIds = typeof stateManager.getBaseDir === "function"
      ? await listRecoverableArchivedGoalIds(stateManager.getBaseDir())
      : [];
    return [...new Set([...activeIds, ...archivedIds, ...recoverableArchivedIds])];
  }

  private activeGoals(goals: Goal[]): Goal[] {
    return goals.filter((goal) => goal.status === "active" || goal.status === "waiting" || goal.loop_status === "running");
  }

  private formatGoalLine(goal: Goal): string {
    const dimensions = goal.dimensions.length === 0
      ? "no dimensions"
      : goal.dimensions
        .slice(0, 3)
        .map((dimension) => `${dimension.name}: ${String(dimension.current_value)} target ${JSON.stringify(dimension.threshold)}`)
        .join("; ");
    return `${goal.id} - ${goal.title} [${goal.status}, loop ${goal.loop_status}] ${dimensions}`;
  }

  private async handleStatus(args: string, start: number): Promise<ChatRunResult> {
    if (args) {
      const goal = await this.host.deps.stateManager.loadGoal(args);
      if (!goal) {
        return { success: false, output: `Goal not found: ${args}`, elapsed_ms: Date.now() - start };
      }
      const lines = [
        `Goal status: ${goal.title}`,
        `ID: ${goal.id}`,
        `Status: ${goal.status}`,
        `Loop: ${goal.loop_status}`,
        `Updated: ${goal.updated_at}`,
        `Children: ${goal.children_ids.length}`,
        `Dimensions:`,
        ...goal.dimensions.map((dimension) =>
          `- ${dimension.name}: current=${String(dimension.current_value)}, threshold=${JSON.stringify(dimension.threshold)}, confidence=${dimension.confidence}`
        ),
      ];
      return { success: true, output: lines.join("\n"), elapsed_ms: Date.now() - start };
    }

    const registry = createRuntimeSessionRegistry({ stateManager: this.host.deps.stateManager });
    const [goals, runtimeSnapshot] = await Promise.all([
      this.loadGoals(),
      registry.snapshot(),
    ]);
    const active = this.activeGoals(goals);
    const runtimeStatus = formatRuntimeStatus(runtimeSnapshot);
    if (active.length === 0) {
      return { success: true, output: `No active goals found.\n\n${runtimeStatus}`, elapsed_ms: Date.now() - start };
    }
    return {
      success: true,
      output: `Active goals:\n${active.map((goal) => this.formatGoalLine(goal)).join("\n")}\n\n${runtimeStatus}`,
      elapsed_ms: Date.now() - start,
    };
  }

  private async handleGoals(start: number): Promise<ChatRunResult> {
    const goals = await this.loadGoals();
    if (goals.length === 0) {
      return { success: true, output: "No goals found.", elapsed_ms: Date.now() - start };
    }
    return {
      success: true,
      output: `Goals:\n${goals.map((goal) => this.formatGoalLine(goal)).join("\n")}`,
      elapsed_ms: Date.now() - start,
    };
  }

  private async readTasksForGoal(goalId: string): Promise<Task[]> {
    const stateManager = this.host.deps.stateManager as StateManager & { getBaseDir?: () => string };
    if (typeof stateManager.getBaseDir !== "function") return [];
    return readTasksForGoal(stateManager.getBaseDir(), goalId);
  }

  private async resolveGoalForTasks(selector: string): Promise<{ goalId?: string; error?: string }> {
    if (selector) return { goalId: selector };
    const active = this.activeGoals(await this.loadGoals());
    if (active.length === 1) return { goalId: active[0].id };
    if (active.length === 0) return { error: "No active goals found. Use /tasks <goal-id>." };
    return { error: "Multiple active goals found. Use /tasks <goal-id>." };
  }

  private formatTaskLine(task: Task): string {
    const verdict = task.verification_verdict ? `, verdict ${task.verification_verdict}` : "";
    return `${task.id} - ${task.status}${verdict}: ${task.work_description}`;
  }

  private async handleTasks(args: string, start: number): Promise<ChatRunResult> {
    const resolved = await this.resolveGoalForTasks(args);
    if (resolved.error || !resolved.goalId) {
      return { success: false, output: resolved.error ?? "Usage: /tasks <goal-id>", elapsed_ms: Date.now() - start };
    }
    const tasks = await this.readTasksForGoal(resolved.goalId);
    if (tasks.length === 0) {
      return { success: true, output: `No tasks found for goal "${resolved.goalId}".`, elapsed_ms: Date.now() - start };
    }
    return {
      success: true,
      output: `Tasks for goal ${resolved.goalId}:\n${tasks.map((task) => this.formatTaskLine(task)).join("\n")}`,
      elapsed_ms: Date.now() - start,
    };
  }

  private parseTaskArgs(args: string): { taskId?: string; goalId?: string } {
    const parts = args.split(/\s+/).filter(Boolean);
    const goalFlagIndex = parts.indexOf("--goal");
    if (goalFlagIndex >= 0) {
      const goalId = parts[goalFlagIndex + 1];
      parts.splice(goalFlagIndex, goalId ? 2 : 1);
      return { taskId: parts[0], goalId };
    }
    return { taskId: parts[0], goalId: parts[1] };
  }

  private async findTask(taskId: string, goalId?: string): Promise<{ task?: Task; matches: Array<{ goalId: string; task: Task }> }> {
    const goalIds = goalId ? [goalId] : await this.listAllGoalIds();
    const matches: Array<{ goalId: string; task: Task }> = [];
    for (const candidateGoalId of goalIds) {
      let raw: unknown | null = null;
      try {
        raw = await this.host.deps.stateManager.readRaw(`tasks/${candidateGoalId}/${taskId}.json`);
      } catch {
        raw = null;
      }
      if (!raw) {
        const tasks = await this.readTasksForGoal(candidateGoalId);
        const matched = tasks.find((task) => task.id === taskId || task.id.startsWith(taskId));
        if (matched) matches.push({ goalId: candidateGoalId, task: matched });
        continue;
      }
      const parsed = TaskSchema.safeParse(raw);
      if (parsed.success) matches.push({ goalId: candidateGoalId, task: parsed.data });
    }
    return { task: matches.length === 1 ? matches[0].task : undefined, matches };
  }

  private formatTask(task: Task): string {
    const lines = [
      `Task: ${task.id}`,
      `Goal: ${task.goal_id}`,
      `Status: ${task.status}`,
      `Category: ${task.task_category}`,
      `Created: ${task.created_at}`,
      `Work: ${task.work_description}`,
      `Approach: ${task.approach}`,
    ];
    if (task.started_at) lines.push(`Started: ${task.started_at}`);
    if (task.completed_at) lines.push(`Completed: ${task.completed_at}`);
    if (task.verification_verdict) lines.push(`Verification: ${task.verification_verdict}`);
    if (task.verification_evidence?.length) lines.push(`Evidence: ${task.verification_evidence.join("; ")}`);
    if (task.success_criteria.length > 0) {
      lines.push("Success criteria:");
      lines.push(...task.success_criteria.map((criterion) => `- ${criterion.description}`));
    }
    return lines.join("\n");
  }

  private async handleTask(args: string, start: number): Promise<ChatRunResult> {
    const { taskId, goalId } = this.parseTaskArgs(args);
    if (!taskId) {
      return { success: false, output: "Usage: /task <task-id> [goal-id]", elapsed_ms: Date.now() - start };
    }
    const found = await this.findTask(taskId, goalId);
    if (found.matches.length > 1) {
      return {
        success: false,
        output: `Task selector "${taskId}" matched multiple goals. Use /task ${taskId} <goal-id>.\n${found.matches.map((match) => `- ${match.goalId}`).join("\n")}`,
        elapsed_ms: Date.now() - start,
      };
    }
    if (!found.task) {
      const suffix = goalId ? ` for goal "${goalId}"` : "";
      return { success: false, output: `Task not found: ${taskId}${suffix}`, elapsed_ms: Date.now() - start };
    }
    return { success: true, output: this.formatTask(found.task), elapsed_ms: Date.now() - start };
  }

  private providerConfigBaseDir(): string {
    const stateManager = this.host.deps.stateManager as StateManager & { getBaseDir?: () => string };
    return typeof stateManager.getBaseDir === "function" ? stateManager.getBaseDir() : getPulseedDirPath();
  }

  private async readProviderConfigSummary(): Promise<ProviderConfigSummary> {
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

  private formatConfig(config: ProviderConfigSummary): string {
    return Object.entries(config)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${typeof value === "string" && /key|token|secret/i.test(key) ? "[masked]" : String(value)}`)
      .join("\n");
  }

  private async handleConfig(start: number): Promise<ChatRunResult> {
    const config = await this.readProviderConfigSummary();
    return { success: true, output: `Provider configuration:\n${this.formatConfig(config)}`, elapsed_ms: Date.now() - start };
  }

  private async handleModel(start: number): Promise<ChatRunResult> {
    const config = await this.readProviderConfigSummary();
    return {
      success: true,
      output: `Model: ${config.model}\nProvider: ${config.provider}\nAdapter: ${config.adapter}`,
      elapsed_ms: Date.now() - start,
    };
  }

  private async handlePlugins(start: number): Promise<ChatRunResult> {
    if (!this.host.deps.pluginLoader) {
      return { success: true, output: "Plugin information is not available in this chat session.", elapsed_ms: Date.now() - start };
    }
    try {
      const plugins = await this.host.deps.pluginLoader.loadAll();
      if (plugins.length === 0) {
        return { success: true, output: "No plugins found.", elapsed_ms: Date.now() - start };
      }
      return {
        success: true,
        output: `Plugins:\n${plugins.map((plugin) => `${plugin.name} - ${plugin.type ?? "unknown"} - ${plugin.enabled === false ? "disabled" : "enabled"}`).join("\n")}`,
        elapsed_ms: Date.now() - start,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: true, output: `Plugin information is unavailable: ${message}`, elapsed_ms: Date.now() - start };
    }
  }

  private zeroUsageCounter(): ChatUsageCounter {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  private normalizeUsageCounter(usage: ChatUsageCounter): ChatUsageCounter {
    const inputTokens = Number.isFinite(usage.inputTokens) ? Math.max(0, Math.floor(usage.inputTokens)) : 0;
    const outputTokens = Number.isFinite(usage.outputTokens) ? Math.max(0, Math.floor(usage.outputTokens)) : 0;
    const totalTokens = Number.isFinite(usage.totalTokens)
      ? Math.max(0, Math.floor(usage.totalTokens))
      : inputTokens + outputTokens;
    return { inputTokens, outputTokens, totalTokens };
  }

  private usageFromLLMResponse(response: LLMResponse): ChatUsageCounter {
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }

  private hasUsage(usage: ChatUsageCounter): boolean {
    return usage.totalTokens > 0 || usage.inputTokens > 0 || usage.outputTokens > 0;
  }

  private formatUsageCounter(prefix: string, usage: ChatUsageCounter): string[] {
    return [
      `${prefix} input tokens:  ${usage.inputTokens}`,
      `${prefix} output tokens: ${usage.outputTokens}`,
      `${prefix} total tokens:  ${usage.totalTokens}`,
    ];
  }

  private async handleUsage(args: string, start: number): Promise<ChatRunResult> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const scope = tokens[0]?.toLowerCase();

    if (!scope || scope === "session") {
      const history = this.host.getHistory();
      if (!history) {
        return { success: false, output: "No active chat session. Start a session and run work before /usage.", elapsed_ms: Date.now() - start };
      }
      const session = history.getSessionData();
      const totals = this.normalizeUsageCounter(session.usage?.totals ?? this.zeroUsageCounter());
      const lines = [
        `Usage summary (session ${session.id})`,
        ...this.formatUsageCounter("Session", totals),
      ];
      const phaseEntries = Object.entries(session.usage?.byPhase ?? {})
        .map(([phase, usage]) => ({ phase, usage: this.normalizeUsageCounter(usage as ChatUsageCounter) }))
        .filter((entry) => this.hasUsage(entry.usage))
        .sort((left, right) => right.usage.totalTokens - left.usage.totalTokens);
      if (phaseEntries.length > 0) {
        lines.push("");
        lines.push("By phase:");
        for (const entry of phaseEntries) {
          lines.push(`- ${entry.phase}: ${entry.usage.totalTokens} (in=${entry.usage.inputTokens}, out=${entry.usage.outputTokens})`);
        }
      }
      return { success: true, output: lines.join("\n"), elapsed_ms: Date.now() - start };
    }

    if (scope === "goal" || scope === "daemon") {
      const goalId = tokens[1] ?? this.host.deps.goalId;
      if (!goalId) {
        return { success: false, output: "Usage: /usage goal <goal-id>", elapsed_ms: Date.now() - start };
      }
      const summary = await collectGoalUsage(this.host.deps.stateManager.getBaseDir(), goalId);
      const lines = [
        `Usage summary (${scope} scope)`,
        `Goal: ${summary.goalId}`,
        `Tasks observed: ${summary.taskCount}`,
        `Terminal tasks: ${summary.terminalTaskCount}`,
        `Total tokens: ${summary.totalTokens}`,
      ];
      return { success: true, output: lines.join("\n"), elapsed_ms: Date.now() - start };
    }

    if (scope === "schedule") {
      const period = tokens[1] ?? "7d";
      try {
        const summary = await collectScheduleUsage(this.host.deps.stateManager.getBaseDir(), period);
        const lines = [
          `Usage summary (schedule, ${summary.period})`,
          `Runs: ${summary.runs}`,
          `Total tokens: ${summary.totalTokens}`,
        ];
        return { success: true, output: lines.join("\n"), elapsed_ms: Date.now() - start };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: `Usage: /usage schedule [24h|7d|2w]\nError: ${message}`, elapsed_ms: Date.now() - start };
      }
    }

    return {
      success: false,
      output: "Usage: /usage [session|goal <goal-id>|daemon <goal-id>|schedule [24h|7d|2w]]",
      elapsed_ms: Date.now() - start,
    };
  }

  private deterministicChatSummary(messages: ChatSession["messages"]): string {
    const lines = messages.map((message) => `${message.role}: ${message.content.replace(/\s+/g, " ").trim()}`);
    return lines.join("\n").slice(0, 4_000);
  }

  private async summarizeChatForCompaction(messages: ChatSession["messages"], existingSummary?: string): Promise<{ summary: string; usedLlm: boolean }> {
    const content = [
      existingSummary ? `Previous summary:\n${existingSummary}` : "",
      `Messages to summarize:\n${messages.map((message) => `${message.role}: ${message.content}`).join("\n")}`,
    ].filter(Boolean).join("\n\n");

    if (this.host.deps.llmClient) {
      try {
        const response = await this.host.deps.llmClient.sendMessage([
          { role: "user", content: `Summarize this chat history for later continuation. Preserve decisions, open tasks, constraints, and user preferences. Keep it concise.\n\n${content}` },
        ], { max_tokens: 700, model_tier: "light" });
        if (response.content.trim()) return { summary: response.content.trim(), usedLlm: true };
      } catch {
        // Fall back to deterministic summary below.
      }
    }

    const fallback = [
      existingSummary ? `Previous summary:\n${existingSummary}` : "",
      "Extractive summary:",
      this.deterministicChatSummary(messages),
    ].filter(Boolean).join("\n\n");
    return { summary: fallback, usedLlm: false };
  }

  private async handleCompact(start: number): Promise<ChatRunResult> {
    const history = this.host.getHistory();
    if (!history) {
      return { success: false, output: "No active chat session to compact.", elapsed_ms: Date.now() - start };
    }
    const session = history.getSessionData();
    if (session.messages.length <= 4) {
      return { success: true, output: "Chat history is already compact. No messages were removed.", elapsed_ms: Date.now() - start };
    }
    const olderMessages = session.messages.slice(0, -4);
    const { summary, usedLlm } = await this.summarizeChatForCompaction(olderMessages, session.compactionSummary);
    const { before, after } = await history.compact(summary, 4);
    const method = usedLlm ? "LLM summary" : "deterministic summary";
    return {
      success: true,
      output: `Compacted chat history with ${method}. Persisted ${before} message(s) down to ${after}; the latest user/assistant turns were kept.`,
      elapsed_ms: Date.now() - start,
    };
  }

  private async handleContext(start: number, cwdOverride?: string): Promise<ChatRunResult> {
    const cwd = this.host.getSessionCwd() ?? (cwdOverride ? resolveGitRoot(cwdOverride) : process.cwd());
    const session = this.host.getHistory()?.getSessionData() ?? null;
    const messages = session?.messages ?? [];
    const policy = await this.host.getSessionExecutionPolicy();
    const recentMessages = messages.slice(-6);
    const userTurns = messages.filter((message) => message.role === "user").length;
    const assistantTurns = messages.filter((message) => message.role === "assistant").length;
    const compactionSummary = session?.compactionSummary?.trim() ?? "";
    const agentLoopPath = this.host.getNativeAgentLoopStatePath() ?? session?.agentLoopStatePath ?? null;
    const replyTarget = this.host.getRuntimeControlContext()?.replyTarget ?? this.host.deps.runtimeReplyTarget ?? null;
    const routeCapabilities = {
      hasAgentLoop: this.host.deps.chatAgentLoopRunner !== undefined,
      hasToolLoop: this.host.deps.llmClient !== undefined,
      hasRuntimeControlService: this.host.deps.runtimeControlService !== undefined,
    };
    const replyTargetParts = replyTarget
      ? [replyTarget.surface, replyTarget.platform, replyTarget.conversation_id].filter(Boolean)
      : [];
    const contextLines = [
      "Working context",
      "",
      "Session",
      `- session_id: ${this.host.getHistory()?.getSessionId() ?? "none"}`,
      `- cwd: ${cwd}`,
      `- messages: ${messages.length} (${userTurns} user, ${assistantTurns} assistant)`,
      `- recent_turns_retained: ${recentMessages.length}`,
      `- compaction_summary: ${compactionSummary ? "present" : "none"}`,
      `- agentloop_state_path: ${agentLoopPath ?? "none"}`,
      "",
      "Turn context",
      `- last_selected_route: ${formatRoute(this.host.getLastSelectedRoute())}`,
      `- reply_target: ${replyTargetParts.length > 0 ? replyTargetParts.join(":") : "none"}`,
      `- route_capabilities: agent_loop=${routeCapabilities.hasAgentLoop}, tool_loop=${routeCapabilities.hasToolLoop}, runtime_control=${routeCapabilities.hasRuntimeControlService}`,
      "",
      "Working assumptions",
      "- this view exposes operational context, not hidden reasoning",
      "- last_selected_route describes the most recent non-command turn in this ChatRunner",
      "- future turns may select a different route based on the next input",
      "",
      "Active constraints",
      ...summarizeExecutionPolicy(policy).split("\n").map((line) => `- ${line}`),
      "",
      "Included context",
      "- current session cwd and execution policy because they constrain tool and route behavior",
      `- ${recentMessages.length} latest persisted message(s)`,
      `- ${compactionSummary ? "compacted older chat summary because older turns were summarized" : "no compacted older chat summary because none is stored"}`,
      `- ${agentLoopPath ? "native agent-loop resume path because this session can persist agent-loop state" : "no native agent-loop resume path because none is active"}`,
      "",
      "Not included",
      "- hidden reasoning or private model chain-of-thought",
      "- raw state files unless a command explicitly reads them",
      "- older chat turns beyond the retained window unless compacted into the session summary",
    ];
    return {
      success: true,
      output: contextLines.join("\n"),
      elapsed_ms: Date.now() - start,
    };
  }

  private async handleTrack(start: number): Promise<ChatRunResult> {
    if (!this.host.deps.escalationHandler) {
      return {
        success: false,
        output: "Escalation not available — missing LLM configuration",
        elapsed_ms: Date.now() - start,
      };
    }
    if (!this.host.getHistory() || this.host.getHistory()!.getMessages().length === 0) {
      return {
        success: false,
        output: "No conversation to escalate. Chat first, then /track.",
        elapsed_ms: Date.now() - start,
      };
    }
    try {
      const result = await this.host.deps.escalationHandler.escalateToGoal(this.host.getHistory()!);
      return {
        success: true,
        output: `Goal created: ${result.title} (ID: ${result.goalId})\nRun: pulseed run --goal ${result.goalId} --yes`,
        elapsed_ms: Date.now() - start,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Escalation failed: ${message}`,
        elapsed_ms: Date.now() - start,
      };
    }
  }

  private async handlePermissions(args: string, start: number): Promise<ChatRunResult> {
    const policy = await this.host.getSessionExecutionPolicy();
    if (!args) {
      return {
        success: true,
        output: summarizeExecutionPolicy(policy),
        elapsed_ms: Date.now() - start,
      };
    }

    const tokens = args.toLowerCase().split(/\s+/).filter(Boolean);
    let nextPolicy = policy;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token === "read-only" || token === "readonly" || token === "read_only") {
        nextPolicy = withExecutionPolicyOverrides(nextPolicy, { sandboxMode: "read_only" });
        continue;
      }
      if (token === "workspace-write" || token === "workspace_write") {
        nextPolicy = withExecutionPolicyOverrides(nextPolicy, { sandboxMode: "workspace_write" });
        continue;
      }
      if (token === "full-access" || token === "danger-full-access" || token === "danger_full_access") {
        nextPolicy = withExecutionPolicyOverrides(nextPolicy, { sandboxMode: "danger_full_access" });
        continue;
      }
      if (token === "network" && tokens[index + 1]) {
        nextPolicy = withExecutionPolicyOverrides(nextPolicy, { networkAccess: tokens[index + 1] === "on" });
        index += 1;
        continue;
      }
      if (token === "approval" && tokens[index + 1]) {
        const approvalPolicy = tokens[index + 1];
        if (approvalPolicy === "never" || approvalPolicy === "on_request" || approvalPolicy === "untrusted") {
          nextPolicy = withExecutionPolicyOverrides(nextPolicy, { approvalPolicy });
          index += 1;
          continue;
        }
      }
      return {
        success: false,
        output: "Usage: /permissions [read-only|workspace-write|full-access] [network on|off] [approval on_request|never|untrusted]",
        elapsed_ms: Date.now() - start,
      };
    }

    const runner = this.host as unknown as { setSessionExecutionPolicy?: (policy: ExecutionPolicy) => void; sessionExecutionPolicy?: ExecutionPolicy | null };
    if (typeof runner.setSessionExecutionPolicy === "function") {
      runner.setSessionExecutionPolicy(nextPolicy);
    } else {
      runner.sessionExecutionPolicy = nextPolicy;
    }
    return {
      success: true,
      output: summarizeExecutionPolicy(nextPolicy),
      elapsed_ms: Date.now() - start,
    };
  }

  private async handleReview(start: number): Promise<ChatRunResult> {
    const cwd = this.host.getSessionCwd() ?? process.cwd();
    const diffStat = await checkGitChanges(cwd);
    const reviewPolicy = withExecutionPolicyOverrides(await this.host.getSessionExecutionPolicy(), {
      sandboxMode: "read_only",
      approvalPolicy: "never",
    });
    if (this.host.deps.reviewAgentLoopRunner) {
      const review = await this.host.deps.reviewAgentLoopRunner.execute({
        cwd,
        diffStat,
        executionPolicy: reviewPolicy,
      });
      return { success: review.success, output: review.output, elapsed_ms: Date.now() - start };
    }
    const output = [
      "Review summary",
      diffStat ? diffStat : "No uncommitted changes detected.",
      "",
      "Execution policy",
      summarizeExecutionPolicy(reviewPolicy),
    ].join("\n");
    return { success: true, output, elapsed_ms: Date.now() - start };
  }

  private async handleFork(title: string, start: number): Promise<ChatRunResult> {
    const cwd = this.host.getSessionCwd() ?? process.cwd();
    const sessionId = crypto.randomUUID();
    const baseSession = this.host.getHistory()?.getSessionData() ?? {
      id: sessionId,
      cwd,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };
    const now = new Date().toISOString();
    const forkedSession: ChatSession = {
      ...baseSession,
      id: sessionId,
      createdAt: now,
      updatedAt: now,
      title: title || (baseSession.title ? `${baseSession.title} (fork)` : "Forked session"),
    };
    this.host.setHistory(ChatHistory.fromSession(this.host.deps.stateManager, forkedSession));
    this.host.setSessionCwd(resolveGitRoot(cwd));
    this.host.setSessionActive(true);
    this.host.setNativeAgentLoopStatePath(`chat/agentloop/${sessionId}.state.json`);
    this.host.getHistory()!.resetAgentLoopState(this.host.getNativeAgentLoopStatePath()!);
    await this.host.getHistory()!.persist();
    const runner = this.host as unknown as { resetSessionExecutionPolicy?: () => void };
    runner.resetSessionExecutionPolicy?.();
    return {
      success: true,
      output: `Forked chat session as ${sessionId}.`,
      elapsed_ms: Date.now() - start,
    };
  }

  private async handleUndo(start: number): Promise<ChatRunResult> {
    const history = this.host.getHistory();
    if (!history) {
      return { success: false, output: "No active chat session to undo.", elapsed_ms: Date.now() - start };
    }
    const removed = await history.removeLastTurn();
    if (removed === 0) {
      return { success: false, output: "No chat turn to undo.", elapsed_ms: Date.now() - start };
    }
    return {
      success: true,
      output: `Removed ${removed} message(s) from chat history. File changes were not reverted.`,
      elapsed_ms: Date.now() - start,
    };
  }

  private async handleTend(args: string, start: number): Promise<ChatRunResult> {
    if (!this.host.deps.llmClient) {
      return {
        success: false,
        output: "Tend not available — missing LLM configuration",
        elapsed_ms: Date.now() - start,
      };
    }
    if (!this.host.deps.goalNegotiator) {
      return {
        success: false,
        output: "Tend not available — missing goal negotiator",
        elapsed_ms: Date.now() - start,
      };
    }
    if (!this.host.deps.daemonClient) {
      return {
        success: false,
        output: "Tend not available — daemon client not configured. Start the daemon with 'pulseed daemon start' first.",
        elapsed_ms: Date.now() - start,
      };
    }

    const tendCommand = new TendCommand();
    const result = await tendCommand.execute(args, this.buildTendDeps(
      this.host.deps.llmClient,
      this.host.deps.goalNegotiator,
      this.host.deps.daemonClient,
    ));

    if (result.needsConfirmation && result.goalId) {
      this.host.setPendingTend({ goalId: result.goalId, maxIterations: result.maxIterations });
      return {
        success: true,
        output: result.confirmation ?? result.message,
        elapsed_ms: Date.now() - start,
      };
    }

    return {
      success: result.success,
      output: result.message,
      elapsed_ms: Date.now() - start,
    };
  }

  private buildTendDeps(
    llmClient: ILLMClient,
    goalNegotiator: GoalNegotiator,
    daemonClient: DaemonClient,
  ): TendDeps {
    return {
      llmClient,
      goalNegotiator,
      daemonClient,
      stateManager: this.host.deps.stateManager,
      chatHistory: this.host.getHistory()?.getMessages() ?? [],
      sessionId: this.host.getHistory()?.getSessionId() ?? null,
      workspace: this.host.getSessionCwd() ?? process.cwd(),
      replyTarget: this.host.getRuntimeControlContext()?.replyTarget ?? this.host.deps.runtimeReplyTarget ?? null,
    };
  }
}
