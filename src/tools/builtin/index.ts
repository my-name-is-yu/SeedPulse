export { GlobTool } from "../filesystem/glob.js";
export { GrepTool } from "../filesystem/grep.js";
export { ReadTool } from "../filesystem/read.js";
export { ShellTool } from "../system/shell.js";
export { HttpFetchTool } from "../network/http-fetch.js";
export { JsonQueryTool } from "../filesystem/json-query.js";
export { GitLogTool } from "../git/git-log.js";
export { ListDirTool } from "../filesystem/list-dir.js";
export { ProcessStatusTool } from "../system/process-status.js";
export { TestRunnerTool } from "../system/test-runner.js";
export { GoalStateTool } from "../state/goal-state.js";
export { TrustStateTool } from "../state/trust-state.js";
export { SessionHistoryTool } from "../state/session-history.js";
export { KnowledgeQueryTool } from "../state/knowledge-query.js";
export { ProgressHistoryTool } from "../state/progress-history.js";
export { ConfigTool } from "../state/config-tool.js";
export { PluginStateTool } from "../state/plugin-state-tool.js";
export { ArchitectureTool } from "../state/architecture-tool.js";
export { WebSearchTool, createWebSearchClient } from "../network/web-search.js";
export type { ISearchClient, SearchResult } from "../network/web-search.js";
export { ToolSearchTool } from "../meta/tool-search.js";
export { EnvTool } from "../system/env.js";
export { SleepTool } from "../system/sleep.js";
export { GitDiffTool } from "../git/git-diff.js";
export { FileWriteTool } from "../filesystem/file-write.js";
export { FileEditTool } from "../filesystem/file-edit.js";
export { validateFilePath } from "../filesystem/file-validation.js";

import { GlobTool } from "../filesystem/glob.js";
import { GrepTool } from "../filesystem/grep.js";
import { ReadTool } from "../filesystem/read.js";
import { ShellTool } from "../system/shell.js";
import { HttpFetchTool } from "../network/http-fetch.js";
import { JsonQueryTool } from "../filesystem/json-query.js";
import { GitLogTool } from "../git/git-log.js";
import { ListDirTool } from "../filesystem/list-dir.js";
import { ProcessStatusTool } from "../system/process-status.js";
import { TestRunnerTool } from "../system/test-runner.js";
import { GoalStateTool } from "../state/goal-state.js";
import { TrustStateTool } from "../state/trust-state.js";
import { SessionHistoryTool } from "../state/session-history.js";
import { KnowledgeQueryTool } from "../state/knowledge-query.js";
import { ProgressHistoryTool } from "../state/progress-history.js";
import { ConfigTool } from "../state/config-tool.js";
import { PluginStateTool } from "../state/plugin-state-tool.js";
import { ArchitectureTool } from "../state/architecture-tool.js";
import { WebSearchTool, createWebSearchClient } from "../network/web-search.js";
import { ToolSearchTool } from "../meta/tool-search.js";
import { EnvTool } from "../system/env.js";
import { SleepTool } from "../system/sleep.js";
import { GitDiffTool } from "../git/git-diff.js";
import { FileWriteTool } from "../filesystem/file-write.js";
import { FileEditTool } from "../filesystem/file-edit.js";
import type { ITool } from "../types.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { KnowledgeManager } from "../../platform/knowledge/knowledge-manager.js";
import type { ToolRegistry } from "../registry.js";
import type { PluginLoader } from "../../runtime/plugin-loader.js";

export interface BuiltinToolDeps {
  stateManager?: StateManager;
  knowledgeManager?: KnowledgeManager;
  registry?: ToolRegistry;
  pluginLoader?: PluginLoader;
}

/** All built-in tools, sorted alphabetically by name. */
export function createBuiltinTools(deps?: BuiltinToolDeps): ITool[] {
  const tools: ITool[] = [
    new EnvTool(),
    new FileEditTool(),
    new FileWriteTool(),
    new GitDiffTool(),
    new GitLogTool(),
    new GlobTool(),
    new GrepTool(),
    new HttpFetchTool(),
    new JsonQueryTool(),
    new ListDirTool(),
    new ProcessStatusTool(),
    new ReadTool(),
    new ShellTool(),
    new SleepTool(),
    new TestRunnerTool(),
  ];

  if (deps?.stateManager) {
    tools.push(
      new GoalStateTool(deps.stateManager),
      new TrustStateTool(deps.stateManager),
      new SessionHistoryTool(deps.stateManager),
      new ProgressHistoryTool(deps.stateManager),
    );
  }

  if (deps?.knowledgeManager) {
    tools.push(new KnowledgeQueryTool(deps.knowledgeManager));
  }

  tools.push(new ConfigTool(), new ArchitectureTool());

  if (deps?.pluginLoader) {
    tools.push(new PluginStateTool(deps.pluginLoader));
  }

  const searchClient = createWebSearchClient();
  if (searchClient) {
    tools.push(new WebSearchTool(searchClient));
  }

  if (deps?.registry) {
    tools.push(new ToolSearchTool(deps.registry));
  }

  return tools;
}
