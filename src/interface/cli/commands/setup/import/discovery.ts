import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProviderConfig } from "../../../../../base/llm/provider-config.js";
import type { MCPServerConfig } from "../../../../../base/types/mcp.js";
import { PROVIDERS, getAdaptersForModel } from "../../setup-shared.js";
import type { Provider } from "../../setup-shared.js";
import type {
  SetupImportItem,
  SetupImportProviderSettings,
  SetupImportSource,
  SetupImportSourceId,
} from "./types.js";

const SOURCE_LABELS: Record<SetupImportSourceId, string> = {
  hermes: "Hermes Agent",
  openclaw: "OpenClaw",
};

const CONFIG_FILENAMES = [
  "provider.json",
  "config.json",
  "settings.json",
  "agent.json",
  "openclaw.config.json",
  "hermes.config.json",
];

const MCP_FILENAMES = [
  "mcp-servers.json",
  "mcp.json",
  "mcpServers.json",
  "servers.json",
];

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function pathExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function readJson(filePath: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string");
  return values.length === value.length ? values : undefined;
}

function nestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function collectRecords(value: unknown, maxDepth = 3): Record<string, unknown>[] {
  if (!isRecord(value) || maxDepth < 0) return [];
  const records: Record<string, unknown>[] = [value];
  if (maxDepth === 0) return records;
  for (const child of Object.values(value)) {
    if (isRecord(child)) {
      records.push(...collectRecords(child, maxDepth - 1));
    }
  }
  return records;
}

function firstString(records: Record<string, unknown>[], keys: string[]): string | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = stringValue(record[key]);
      if (value) return value;
    }
  }
  return undefined;
}

function normalizeProvider(value: string | undefined): Provider | undefined {
  const normalized = value?.toLowerCase().trim();
  if (!normalized) return undefined;
  if (normalized === "codex" || normalized === "openai_codex" || normalized.includes("openai")) {
    return "openai";
  }
  if (normalized === "claude" || normalized.includes("anthropic")) {
    return "anthropic";
  }
  if (normalized.includes("ollama")) {
    return "ollama";
  }
  return PROVIDERS.includes(normalized as Provider) ? (normalized as Provider) : undefined;
}

function normalizeAdapter(
  value: string | undefined,
  provider: ProviderConfig["provider"] | undefined,
  model: string | undefined
): ProviderConfig["adapter"] | undefined {
  const normalized = value?.toLowerCase().trim();
  const knownAdapters: ProviderConfig["adapter"][] = [
    "claude_code_cli",
    "claude_api",
    "openai_codex_cli",
    "openai_api",
    "agent_loop",
  ];
  if (knownAdapters.includes(normalized as ProviderConfig["adapter"])) {
    return normalized as ProviderConfig["adapter"];
  }
  if (normalized?.includes("codex")) return "openai_codex_cli";
  if (normalized?.includes("claude") && normalized.includes("code")) return "claude_code_cli";
  if (normalized?.includes("claude") || normalized?.includes("anthropic")) return "claude_api";
  if (normalized?.includes("openai")) return "openai_api";
  if (normalized?.includes("agent")) return "agent_loop";
  if (provider && model) {
    const adapters = getAdaptersForModel(model, provider);
    return adapters[0] as ProviderConfig["adapter"] | undefined;
  }
  return undefined;
}

function providerSection(records: Record<string, unknown>[], provider: ProviderConfig["provider"] | undefined): Record<string, unknown> | undefined {
  if (!provider) return undefined;
  for (const record of records) {
    const direct = nestedRecord(record, provider);
    if (direct) return direct;
    if (provider === "anthropic") {
      const claude = nestedRecord(record, "claude");
      if (claude) return claude;
    }
    if (provider === "openai") {
      const codex = nestedRecord(record, "codex");
      if (codex) return codex;
    }
  }
  return undefined;
}

function extractProviderSettings(raw: unknown, source: SetupImportSourceId): SetupImportProviderSettings | undefined {
  const records = collectRecords(raw);
  if (records.length === 0) return undefined;

  const provider = normalizeProvider(
    firstString(records, [
      "provider",
      "llm_provider",
      "llmProvider",
      "model_provider",
      "modelProvider",
      "defaultProvider",
    ])
  );
  const section = providerSection(records, provider);
  const searchable = section ? [section, ...records] : records;
  const model = firstString(searchable, ["model", "default_model", "defaultModel", "modelName"]);
  const adapter = normalizeAdapter(
    firstString(searchable, ["adapter", "default_adapter", "defaultAdapter", "backend", "terminalBackend"]),
    provider,
    model
  );
  const apiKey = firstString(searchable, ["api_key", "apiKey", "key", "token", "authToken"]);
  const baseUrl = firstString(searchable, ["base_url", "baseUrl", "baseURL", "endpoint", "api_base"]);
  const codexCliPath = firstString(searchable, ["codex_cli_path", "codexCliPath", "cli_path", "cliPath"]);
  const openclawCliPath = source === "openclaw"
    ? firstString(searchable, ["openclaw_cli_path", "openclawCliPath", "cli_path", "cliPath"])
    : undefined;
  const openclawProfile = source === "openclaw"
    ? firstString(searchable, ["profile", "openclawProfile"])
    : undefined;
  const workDir = source === "openclaw"
    ? firstString(searchable, ["work_dir", "workDir", "workspace", "workspacePath"])
    : undefined;

  const settings: SetupImportProviderSettings = {};
  if (provider) settings.provider = provider;
  if (model) settings.model = model;
  if (adapter) settings.adapter = adapter;
  if (apiKey) settings.apiKey = apiKey;
  if (baseUrl) settings.baseUrl = baseUrl;
  if (codexCliPath) settings.codexCliPath = codexCliPath;
  if (source === "openclaw" && (openclawCliPath || openclawProfile || model || workDir)) {
    settings.openclaw = {
      ...(openclawCliPath ? { cli_path: openclawCliPath } : {}),
      ...(openclawProfile ? { profile: openclawProfile } : {}),
      ...(model ? { model } : {}),
      ...(workDir ? { work_dir: workDir } : {}),
    };
  }

  return Object.keys(settings).length > 0 ? settings : undefined;
}

function buildProviderItem(
  source: SetupImportSourceId,
  configPath: string,
  settings: SetupImportProviderSettings
): SetupImportItem {
  const parts = [
    settings.provider,
    settings.model,
    settings.adapter,
  ].filter(Boolean);
  return {
    id: `${source}:provider:${path.basename(configPath)}`,
    source,
    sourceLabel: SOURCE_LABELS[source],
    kind: "provider",
    label: parts.length > 0 ? parts.join(" / ") : path.basename(configPath),
    sourcePath: configPath,
    decision: "import",
    reason: "provider, model, adapter, and auth defaults",
    providerSettings: settings,
  };
}

function safeEntryName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "imported";
}

function listImmediateDirs(parentDir: string): string[] {
  try {
    return fs.readdirSync(parentDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(parentDir, entry.name));
  } catch {
    return [];
  }
}

function findSkillDirs(rootDir: string): string[] {
  const roots = unique([
    path.join(rootDir, "skills"),
    path.join(rootDir, "agent", "skills"),
    path.join(rootDir, "agents", "skills"),
  ]);
  const candidates: string[] = [];
  for (const skillRoot of roots) {
    for (const dir of listImmediateDirs(skillRoot)) {
      if (pathExists(path.join(dir, "SKILL.md"))) candidates.push(dir);
      for (const nested of listImmediateDirs(dir)) {
        if (pathExists(path.join(nested, "SKILL.md"))) candidates.push(nested);
      }
    }
  }
  return unique(candidates);
}

function findPluginDirs(rootDir: string): string[] {
  const roots = unique([
    path.join(rootDir, "plugins"),
    path.join(rootDir, "extensions"),
  ]);
  const candidates: string[] = [];
  for (const pluginRoot of roots) {
    for (const dir of listImmediateDirs(pluginRoot)) {
      if (pathExists(path.join(dir, "plugin.yaml")) || pathExists(path.join(dir, "plugin.json"))) {
        candidates.push(dir);
      }
    }
  }
  return unique(candidates);
}

function candidateConfigFiles(rootDir: string): string[] {
  return unique([
    ...CONFIG_FILENAMES.map((name) => path.join(rootDir, name)),
    ...CONFIG_FILENAMES.map((name) => path.join(rootDir, "config", name)),
  ]).filter(pathExists);
}

function candidateMcpFiles(rootDir: string): string[] {
  return unique([
    ...MCP_FILENAMES.map((name) => path.join(rootDir, name)),
    ...MCP_FILENAMES.map((name) => path.join(rootDir, "config", name)),
  ]).filter(pathExists);
}

function normalizeMcpServer(
  id: string,
  raw: Record<string, unknown>,
  source: SetupImportSourceId
): MCPServerConfig | undefined {
  const command = stringValue(raw["command"]);
  const args = stringArray(raw["args"]) ?? [];
  const env = isRecord(raw["env"])
    ? Object.fromEntries(
        Object.entries(raw["env"]).filter(([, value]) => typeof value === "string")
      ) as Record<string, string>
    : undefined;
  const url = stringValue(raw["url"]);
  const transport = stringValue(raw["transport"]);
  const resolvedTransport = transport === "sse" || url ? "sse" : "stdio";

  if (resolvedTransport === "stdio" && !command) return undefined;
  if (resolvedTransport === "sse" && !url) return undefined;

  return {
    id: safeEntryName(`${source}-${id}`),
    name: stringValue(raw["name"]) ?? id,
    transport: resolvedTransport,
    ...(command ? { command } : {}),
    ...(args.length > 0 ? { args } : {}),
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
    ...(url ? { url } : {}),
    tool_mappings: normalizeToolMappings(raw["tool_mappings"]),
    enabled: false,
  };
}

function normalizeToolMappings(value: unknown): MCPServerConfig["tool_mappings"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const toolName = stringValue(item["tool_name"]);
    const dimensionPattern = stringValue(item["dimension_pattern"]);
    if (!toolName || !dimensionPattern) return [];
    const argsTemplate = isRecord(item["args_template"]) ? item["args_template"] : undefined;
    return [{
      tool_name: toolName,
      dimension_pattern: dimensionPattern,
      ...(argsTemplate ? { args_template: argsTemplate } : {}),
    }];
  });
}

function extractMcpServers(raw: unknown, source: SetupImportSourceId): MCPServerConfig[] {
  if (!isRecord(raw)) return [];
  const serversValue = raw["servers"];
  if (Array.isArray(serversValue)) {
    return serversValue.flatMap((item, index) => {
      if (!isRecord(item)) return [];
      const id = stringValue(item["id"]) ?? stringValue(item["name"]) ?? `server-${index + 1}`;
      const normalized = normalizeMcpServer(id, item, source);
      return normalized ? [normalized] : [];
    });
  }

  const mapValue = isRecord(raw["mcpServers"])
    ? raw["mcpServers"]
    : isRecord(raw["mcp_servers"])
      ? raw["mcp_servers"]
      : raw;

  return Object.entries(mapValue).flatMap(([id, value]) => {
    if (!isRecord(value)) return [];
    const normalized = normalizeMcpServer(id, value, source);
    return normalized ? [normalized] : [];
  });
}

function sourceRoots(source: SetupImportSourceId): string[] {
  const home = os.homedir();
  if (source === "hermes") {
    return unique([
      process.env["PULSEED_IMPORT_HERMES_HOME"] ?? "",
      process.env["PULSEED_HERMES_HOME"] ?? "",
      process.env["HERMES_HOME"] ?? "",
      path.join(home, ".hermes"),
      path.join(home, ".hermes-agent"),
      path.join(home, "Library", "Application Support", "Hermes Agent"),
    ].filter(Boolean));
  }
  return unique([
    process.env["PULSEED_IMPORT_OPENCLAW_HOME"] ?? "",
    process.env["PULSEED_OPENCLAW_HOME"] ?? "",
    process.env["OPENCLAW_HOME"] ?? "",
    path.join(home, ".openclaw"),
    path.join(home, ".config", "openclaw"),
    path.join(home, "Library", "Application Support", "OpenClaw"),
  ].filter(Boolean));
}

function detectSource(source: SetupImportSourceId): SetupImportSource | undefined {
  for (const rootDir of sourceRoots(source)) {
    if (!pathExists(rootDir)) continue;
    const items: SetupImportItem[] = [];

    for (const configPath of candidateConfigFiles(rootDir)) {
      const settings = extractProviderSettings(readJson(configPath), source);
      if (settings) items.push(buildProviderItem(source, configPath, settings));
    }

    for (const skillDir of findSkillDirs(rootDir)) {
      const name = path.basename(skillDir);
      items.push({
        id: `${source}:skill:${name}`,
        source,
        sourceLabel: SOURCE_LABELS[source],
        kind: "skill",
        label: name,
        sourcePath: skillDir,
        decision: "import",
        reason: "SKILL.md found",
      });
    }

    for (const mcpPath of candidateMcpFiles(rootDir)) {
      for (const server of extractMcpServers(readJson(mcpPath), source)) {
        items.push({
          id: `${source}:mcp:${server.id}`,
          source,
          sourceLabel: SOURCE_LABELS[source],
          kind: "mcp",
          label: server.name,
          sourcePath: mcpPath,
          decision: "copy_disabled",
          reason: "MCP servers are imported disabled until reviewed",
          mcpServer: server,
        });
      }
    }

    for (const pluginDir of findPluginDirs(rootDir)) {
      const name = path.basename(pluginDir);
      items.push({
        id: `${source}:plugin:${name}`,
        source,
        sourceLabel: SOURCE_LABELS[source],
        kind: "plugin",
        label: name,
        sourcePath: pluginDir,
        decision: "copy_disabled",
        reason: "plugins are quarantined until PulSeed compatibility is reviewed",
      });
    }

    if (items.length > 0) {
      return {
        id: source,
        label: SOURCE_LABELS[source],
        rootDir,
        items,
      };
    }
  }
  return undefined;
}

export function detectSetupImportSources(): SetupImportSource[] {
  return (["hermes", "openclaw"] as const).flatMap((source) => {
    const detected = detectSource(source);
    return detected ? [detected] : [];
  });
}
