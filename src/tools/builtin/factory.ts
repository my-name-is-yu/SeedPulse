import {
  BrowserGetStateTool,
  BrowserRunWorkflowTool,
  DesktopClickTool,
  DesktopGetAppStateTool,
  DesktopListAppsTool,
  DesktopTypeTextTool,
  ResearchAnswerWithSourcesTool,
  ResearchWebTool,
} from "../automation/index.js";
import type { InteractiveAutomationToolPolicy } from "../automation/index.js";
import { ApplyPatchTool } from "../fs/ApplyPatchTool/ApplyPatchTool.js";
import { FileEditTool } from "../fs/FileEditTool/FileEditTool.js";
import { FileWriteTool } from "../fs/FileWriteTool/FileWriteTool.js";
import { GlobTool } from "../fs/GlobTool/GlobTool.js";
import { GrepTool } from "../fs/GrepTool/GrepTool.js";
import { JsonQueryTool } from "../fs/JsonQueryTool/JsonQueryTool.js";
import { ListDirTool } from "../fs/ListDirTool/ListDirTool.js";
import { ReadPulseedFileTool } from "../fs/ReadPulseedFileTool/ReadPulseedFileTool.js";
import { ReadTool } from "../fs/ReadTool/ReadTool.js";
import { WritePulseedFileTool } from "../fs/WritePulseedFileTool/WritePulseedFileTool.js";
import { AskHumanTool } from "../interaction/AskHumanTool/AskHumanTool.js";
import { CreatePlanTool } from "../interaction/CreatePlanTool/CreatePlanTool.js";
import { ReadPlanTool } from "../interaction/ReadPlanTool/ReadPlanTool.js";
import { ViewImageTool } from "../media/ViewImageTool/ViewImageTool.js";
import { ArchiveGoalTool } from "../mutation/ArchiveGoalTool/ArchiveGoalTool.js";
import { ConfigureNotificationRoutingTool } from "../mutation/ConfigureNotificationRoutingTool/ConfigureNotificationRoutingTool.js";
import { DeleteGoalTool } from "../mutation/DeleteGoalTool/DeleteGoalTool.js";
import { ResetTrustTool } from "../mutation/ResetTrustTool/ResetTrustTool.js";
import { SetGoalTool } from "../mutation/SetGoalTool/SetGoalTool.js";
import { TaskCreateTool } from "../mutation/TaskCreateTool/TaskCreateTool.js";
import { TaskOutputTool } from "../mutation/TaskOutputTool/TaskOutputTool.js";
import { TaskStopTool } from "../mutation/TaskStopTool/TaskStopTool.js";
import { TaskUpdateTool } from "../mutation/TaskUpdateTool/TaskUpdateTool.js";
import { TogglePluginTool } from "../mutation/TogglePluginTool/TogglePluginTool.js";
import { UpdateConfigTool } from "../mutation/UpdateConfigTool/UpdateConfigTool.js";
import { UpdateGoalTool } from "../mutation/UpdateGoalTool/UpdateGoalTool.js";
import { MemoryConsolidateTool } from "../execution/MemoryConsolidateTool/MemoryConsolidateTool.js";
import { MemoryLintTool } from "../execution/MemoryLintTool/MemoryLintTool.js";
import { MemorySaveTool } from "../execution/MemorySaveTool/MemorySaveTool.js";
import { ObserveGoalTool } from "../execution/ObserveGoalTool/ObserveGoalTool.js";
import { QueryDataSourceTool } from "../execution/QueryDataSourceTool/QueryDataSourceTool.js";
import { RunAdapterTool } from "../execution/RunAdapterTool/RunAdapterTool.js";
import { SoilDoctorTool } from "../execution/SoilDoctorTool/SoilDoctorTool.js";
import { SoilImportTool } from "../execution/SoilImportTool/SoilImportTool.js";
import { SoilOpenTool } from "../execution/SoilOpenTool/SoilOpenTool.js";
import { SoilPublishTool } from "../execution/SoilPublishTool/SoilPublishTool.js";
import { SoilRebuildTool } from "../execution/SoilRebuildTool/SoilRebuildTool.js";
import { SpawnSessionTool } from "../execution/SpawnSessionTool/SpawnSessionTool.js";
import { WriteKnowledgeTool } from "../execution/WriteKnowledgeTool/WriteKnowledgeTool.js";
import { GitHubPrCreateTool, GitHubReadTool } from "../network/GitHubCliTool/GitHubCliTool.js";
import { HttpFetchTool } from "../network/HttpFetchTool/HttpFetchTool.js";
import { McpCallToolTool, McpListToolsTool } from "../network/McpStdioTool/McpStdioTool.js";
import { WebSearchTool, createWebSearchClient } from "../network/WebSearchTool/WebSearchTool.js";
import { ArchitectureTool } from "../query/ArchitectureTool/ArchitectureTool.js";
import { ConfigTool } from "../query/ConfigTool/ConfigTool.js";
import { GoalStateTool } from "../query/GoalStateTool/GoalStateTool.js";
import { KnowledgeQueryTool } from "../query/KnowledgeQueryTool/KnowledgeQueryTool.js";
import { MemoryRecallTool } from "../query/MemoryRecallTool/MemoryRecallTool.js";
import { PluginStateTool } from "../query/PluginStateTool/PluginStateTool.js";
import { ProgressHistoryTool } from "../query/ProgressHistoryTool/ProgressHistoryTool.js";
import { SessionHistoryTool } from "../query/SessionHistoryTool/SessionHistoryTool.js";
import { SkillSearchTool } from "../query/SkillSearchTool/SkillSearchTool.js";
import { SoilQueryTool } from "../query/SoilQueryTool/SoilQueryTool.js";
import { TaskGetTool } from "../query/TaskGetTool/TaskGetTool.js";
import { TaskListTool } from "../query/TaskListTool/TaskListTool.js";
import { ToolSearchTool } from "../query/ToolSearchTool/ToolSearchTool.js";
import { TrustStateTool } from "../query/TrustStateTool/TrustStateTool.js";
import { CreateScheduleTool } from "../schedule/CreateScheduleTool/CreateScheduleTool.js";
import { GetScheduleTool } from "../schedule/GetScheduleTool/GetScheduleTool.js";
import { ListSchedulesTool } from "../schedule/ListSchedulesTool/ListSchedulesTool.js";
import { PauseScheduleTool } from "../schedule/PauseScheduleTool/PauseScheduleTool.js";
import { RemoveScheduleTool } from "../schedule/RemoveScheduleTool/RemoveScheduleTool.js";
import { ResumeScheduleTool } from "../schedule/ResumeScheduleTool/ResumeScheduleTool.js";
import { RunScheduleTool } from "../schedule/RunScheduleTool/RunScheduleTool.js";
import { UpdateScheduleTool } from "../schedule/UpdateScheduleTool/UpdateScheduleTool.js";
import { EnvTool } from "../system/EnvTool/EnvTool.js";
import { GitDiffTool } from "../system/GitDiffTool/GitDiffTool.js";
import { GitLogTool } from "../system/GitLogTool/GitLogTool.js";
import {
  ProcessSessionListTool,
  ProcessSessionReadTool,
  ProcessSessionStartTool,
  ProcessSessionStopTool,
  ProcessSessionWriteTool,
  defaultProcessSessionManager,
} from "../system/ProcessSessionTool/ProcessSessionTool.js";
import { ProcessStatusTool } from "../system/ProcessStatusTool/ProcessStatusTool.js";
import { ShellCommandTool } from "../system/ShellCommandTool/ShellCommandTool.js";
import { ShellTool } from "../system/ShellTool/ShellTool.js";
import { SleepTool } from "../system/SleepTool/SleepTool.js";
import { TestRunnerTool } from "../system/TestRunnerTool/TestRunnerTool.js";
import { UpdatePlanTool } from "../system/UpdatePlanTool/UpdatePlanTool.js";
import type { ITool } from "../types.js";
import { loadGlobalConfigSync } from "../../base/config/global-config.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { IEmbeddingClient } from "../../platform/knowledge/embedding-client.js";
import type { KnowledgeManager } from "../../platform/knowledge/knowledge-manager.js";
import type { ObservationEngine } from "../../platform/observation/observation-engine.js";
import type { TrustManager } from "../../platform/traits/trust-manager.js";
import type { AdapterRegistry } from "../../orchestrator/execution/adapter-layer.js";
import type { SessionManager } from "../../orchestrator/execution/session-manager.js";
import type { PluginLoader } from "../../runtime/plugin-loader.js";
import {
  createDefaultInteractiveAutomationRegistry,
  type CodexAppComputerUseBridge,
  type InteractiveAutomationRegistry,
} from "../../runtime/interactive-automation/index.js";
import type { ScheduleEngine } from "../../runtime/schedule/engine.js";
import type { ToolRegistry } from "../registry.js";

export interface BuiltinToolDeps {
  stateManager?: StateManager;
  knowledgeManager?: KnowledgeManager;
  registry?: ToolRegistry;
  pluginLoader?: PluginLoader;
  trustManager?: TrustManager;
  adapterRegistry?: AdapterRegistry;
  sessionManager?: SessionManager;
  observationEngine?: ObservationEngine;
  llmCall?: (prompt: string) => Promise<string>;
  scheduleEngine?: ScheduleEngine;
  embeddingClient?: IEmbeddingClient | null;
  embeddingModel?: string;
  interactiveAutomationRegistry?: InteractiveAutomationRegistry;
  interactiveAutomationPolicy?: InteractiveAutomationToolPolicy;
  codexAppComputerUseBridge?: CodexAppComputerUseBridge;
}

/** All built-in tools, sorted alphabetically by name. */
export function createBuiltinTools(deps?: BuiltinToolDeps): ITool[] {
  const tools: ITool[] = [
    new EnvTool(),
    new ApplyPatchTool(),
    new FileEditTool(),
    new FileWriteTool(),
    new GitDiffTool(),
    new GitLogTool(),
    new GitHubPrCreateTool(),
    new GitHubReadTool(),
    new GlobTool(),
    new GrepTool(),
    new HttpFetchTool(),
    new JsonQueryTool(),
    new ListDirTool(),
    new ProcessStatusTool(),
    new ProcessSessionListTool(defaultProcessSessionManager),
    new ProcessSessionReadTool(defaultProcessSessionManager),
    new ProcessSessionStartTool(defaultProcessSessionManager),
    new ProcessSessionStopTool(defaultProcessSessionManager),
    new ProcessSessionWriteTool(defaultProcessSessionManager),
    new McpCallToolTool(),
    new McpListToolsTool(),
    new ReadTool(),
    new ShellCommandTool(),
    new ShellTool(),
    new SleepTool(),
    new TestRunnerTool(),
    new UpdatePlanTool(),
    new ViewImageTool(),
  ];

  if (deps?.stateManager) {
    tools.push(
      new GoalStateTool(deps.stateManager),
      new TrustStateTool(deps.stateManager),
      new SessionHistoryTool(deps.stateManager),
      new ProgressHistoryTool(deps.stateManager),
      new TaskListTool(deps.stateManager),
      new TaskGetTool(deps.stateManager),
    );
  }

  if (deps?.knowledgeManager) {
    tools.push(new KnowledgeQueryTool(deps.knowledgeManager));
    tools.push(new MemoryRecallTool(deps.knowledgeManager));
  }

  tools.push(
    new ConfigTool(),
    new ArchitectureTool(),
    new SkillSearchTool(),
    new SoilQueryTool(
      deps && "embeddingClient" in deps
        ? { embeddingClient: deps.embeddingClient ?? null, embeddingModel: deps.embeddingModel }
        : {}
    ),
    new SoilDoctorTool(),
    new SoilImportTool(),
    new SoilOpenTool(),
    new SoilPublishTool(),
  );

  if (deps?.pluginLoader) {
    tools.push(new PluginStateTool(deps.pluginLoader));
  }

  if (deps?.stateManager) {
    tools.push(
      new SetGoalTool(deps.stateManager),
      new TaskCreateTool(deps.stateManager),
      new TaskOutputTool(deps.stateManager),
      new TaskStopTool(deps.stateManager),
      new TaskUpdateTool(deps.stateManager),
      new UpdateGoalTool(deps.stateManager),
      new ArchiveGoalTool(deps.stateManager),
      new DeleteGoalTool(deps.stateManager),
      new SoilRebuildTool(deps.stateManager),
    );
  }

  tools.push(new TogglePluginTool(), new UpdateConfigTool(), new ConfigureNotificationRoutingTool());

  if (deps?.trustManager) {
    tools.push(new ResetTrustTool(deps.trustManager));
  }

  const searchClient = createWebSearchClient();
  if (searchClient) {
    tools.push(new WebSearchTool(searchClient));
  }

  if (deps?.registry) {
    tools.push(new ToolSearchTool(deps.registry));
  }

  if (deps?.adapterRegistry) {
    tools.push(new RunAdapterTool(deps.adapterRegistry));
  }
  if (deps?.sessionManager) {
    tools.push(new SpawnSessionTool(deps.sessionManager));
  }

  if (deps?.knowledgeManager) {
    tools.push(new WriteKnowledgeTool(deps.knowledgeManager));
    tools.push(new MemorySaveTool(deps.knowledgeManager));
    const llmCall = deps.llmCall ?? ((_: string) => Promise.reject(new Error("LLM not configured")));
    tools.push(new MemoryConsolidateTool(deps.knowledgeManager, llmCall));
    tools.push(new MemoryLintTool(deps.knowledgeManager, llmCall));
  }
  if (deps?.observationEngine) {
    tools.push(new QueryDataSourceTool(deps.observationEngine));
    tools.push(new ObserveGoalTool(deps.observationEngine));
  }

  if (deps?.scheduleEngine) {
    tools.push(
      new ListSchedulesTool(deps.scheduleEngine),
      new GetScheduleTool(deps.scheduleEngine),
      new CreateScheduleTool(deps.scheduleEngine),
      new UpdateScheduleTool(deps.scheduleEngine),
      new RemoveScheduleTool(deps.scheduleEngine),
      new PauseScheduleTool(deps.scheduleEngine),
      new ResumeScheduleTool(deps.scheduleEngine),
      new RunScheduleTool(deps.scheduleEngine),
    );
  }

  const interactiveAutomationConfig = loadGlobalConfigSync().interactive_automation;
  const shouldRegisterInteractiveAutomation =
    deps?.interactiveAutomationRegistry !== undefined || interactiveAutomationConfig.enabled;
  const interactiveAutomationRegistry = shouldRegisterInteractiveAutomation
    ? deps?.interactiveAutomationRegistry
      ?? createDefaultInteractiveAutomationRegistry({
        codexAppBridge: deps?.codexAppComputerUseBridge,
        defaultProviders: {
          desktop: interactiveAutomationConfig.default_desktop_provider,
          browser: interactiveAutomationConfig.default_browser_provider,
          research: interactiveAutomationConfig.default_research_provider,
        },
      })
    : undefined;
  const interactiveAutomationPolicy = deps?.interactiveAutomationPolicy ?? {
    requireApproval: interactiveAutomationConfig.require_approval,
    allowedApps: interactiveAutomationConfig.allowed_apps,
    deniedApps: interactiveAutomationConfig.denied_apps,
  };
  if (interactiveAutomationRegistry) {
    tools.push(
      new BrowserGetStateTool(interactiveAutomationRegistry, interactiveAutomationPolicy),
      new BrowserRunWorkflowTool(interactiveAutomationRegistry, interactiveAutomationPolicy),
      new DesktopClickTool(interactiveAutomationRegistry, interactiveAutomationPolicy),
      new DesktopGetAppStateTool(interactiveAutomationRegistry, interactiveAutomationPolicy),
      new DesktopListAppsTool(interactiveAutomationRegistry, interactiveAutomationPolicy),
      new DesktopTypeTextTool(interactiveAutomationRegistry, interactiveAutomationPolicy),
      new ResearchAnswerWithSourcesTool(interactiveAutomationRegistry, interactiveAutomationPolicy),
      new ResearchWebTool(interactiveAutomationRegistry, interactiveAutomationPolicy),
    );
  }

  tools.push(
    new ReadPulseedFileTool(),
    new WritePulseedFileTool(),
    new AskHumanTool(),
    new CreatePlanTool(),
    new ReadPlanTool(),
  );

  return tools;
}
