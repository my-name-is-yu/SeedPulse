import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { GitHubIssueDataSourceAdapter } from "../../adapters/datasources/github-issue-datasource.js";
import { FileExistenceDataSourceAdapter } from "../../adapters/datasources/file-existence-datasource.js";
import { ShellDataSourceAdapter } from "../../adapters/datasources/shell-datasource.js";
import type { DataSourceConfig } from "../../base/types/data-source.js";
import { readJsonFile } from "../../base/utils/json-io.js";
import { getDatasourcesDir } from "../../base/utils/paths.js";
import type { IDataSourceAdapter } from "../../platform/observation/data-source-adapter.js";
import {
  DataSourceRegistry,
  FileDataSourceAdapter,
  HttpApiDataSourceAdapter,
  PostgresDataSourceAdapter,
} from "../../platform/observation/data-source-adapter.js";

interface DataSourceBootstrapLogger {
  warn(message: string): void;
  error(message: string): void;
}

const consoleLogger: DataSourceBootstrapLogger = {
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export function createCliDataSourceAdapter(
  cfg: DataSourceConfig,
  workspacePath = process.cwd(),
): IDataSourceAdapter | null {
  if (cfg.type === "file") {
    return new FileDataSourceAdapter(cfg);
  }
  if (cfg.type === "http_api") {
    return new HttpApiDataSourceAdapter(cfg);
  }
  if (cfg.type === "database") {
    return new PostgresDataSourceAdapter(cfg);
  }
  if (cfg.type === "github_issue") {
    return new GitHubIssueDataSourceAdapter(cfg);
  }
  if (cfg.type === "file_existence") {
    return new FileExistenceDataSourceAdapter(cfg);
  }
  if (cfg.type === "shell") {
    const adapter = new ShellDataSourceAdapter(
      cfg.id,
      (cfg.connection.commands ?? {}) as Record<string, import("../../adapters/datasources/shell-datasource.js").ShellCommandSpec>,
      cfg.connection?.path ?? workspacePath
    );
    if (cfg.scope_goal_id) {
      (adapter.config as Record<string, unknown>).scope_goal_id = cfg.scope_goal_id;
    }
    return adapter;
  }

  return null;
}

export async function buildCliDataSourceRegistry(
  workspacePath = process.cwd(),
  logger: DataSourceBootstrapLogger = consoleLogger,
): Promise<DataSourceRegistry> {
  const registry = new DataSourceRegistry();
  const dsDir = getDatasourcesDir();

  try {
    let dsExists = false;
    try { await fsp.access(dsDir); dsExists = true; } catch { /* not found */ }
    if (!dsExists) {
      return registry;
    }

    const files = (await fsp.readdir(dsDir)).filter(f => f.endsWith(".json"));
    for (const file of files) {
      const cfg = await readJsonFile<DataSourceConfig>(path.join(dsDir, file));
      const adapter = createCliDataSourceAdapter(cfg, workspacePath);
      if (adapter) {
        registry.register(adapter);
      } else {
        logger.warn(`[pulseed] Unsupported built-in datasource type "${cfg.type}" in ${file}; skipping`);
      }
    }
  } catch (err) {
    logger.error(`[pulseed] Failed to load datasource configurations from "${dsDir}": ${err instanceof Error ? err.message : String(err)}`);
  }

  return registry;
}
