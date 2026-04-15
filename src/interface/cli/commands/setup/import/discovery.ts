import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_FILENAMES, MCP_FILENAMES, SOURCE_LABELS } from "./constants.js";
import {
  listImmediateDirs,
  pathExists,
  readEnvFile,
  readJson,
  safeImportName,
  unique,
} from "./fs-utils.js";
import { extractMcpServers } from "./mcp.js";
import { collectRecords, firstString, nestedRecord } from "./parse.js";
import { buildProviderItem, extractProviderSettings } from "./provider.js";
import { buildTelegramItem, extractTelegramSettings, telegramCredentialItems } from "./telegram.js";
import { analyzeForeignPluginDirectory } from "../../../../../runtime/foreign-plugins/compatibility.js";
import type {
  SetupImportItem,
  SetupImportSource,
  SetupImportSourceId,
} from "./types.js";

function candidateFiles(rootDir: string, filenames: readonly string[]): string[] {
  return unique([
    ...filenames.map((name) => path.join(rootDir, name)),
    ...filenames.map((name) => path.join(rootDir, "config", name)),
  ]).filter(pathExists);
}

function workspaceRoots(rootDir: string): string[] {
  return unique([
    path.join(rootDir, "workspace"),
    path.join(rootDir, "workspace.default"),
    path.join(rootDir, "workspace-main"),
    ...listImmediateDirs(rootDir).filter((dir) => path.basename(dir).startsWith("workspace-")),
  ]);
}

function findSkillDirs(source: SetupImportSourceId, rootDir: string): string[] {
  const roots = unique([
    path.join(rootDir, "skills"),
    path.join(rootDir, "agent", "skills"),
    path.join(rootDir, "agents", "skills"),
    ...workspaceRoots(rootDir).flatMap((workspaceRoot) => [
      path.join(workspaceRoot, "skills"),
      path.join(workspaceRoot, ".agents", "skills"),
    ]),
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
  const candidates: string[] = [];
  for (const pluginRoot of [path.join(rootDir, "plugins"), path.join(rootDir, "extensions")]) {
    for (const dir of listImmediateDirs(pluginRoot)) {
      if (pathExists(path.join(dir, "plugin.yaml")) || pathExists(path.join(dir, "plugin.json"))) {
        candidates.push(dir);
      }
    }
  }
  return unique(candidates);
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
      path.join(home, ".clawdbot"),
      path.join(home, ".moltbot"),
      path.join(home, ".config", "openclaw"),
      path.join(home, "Library", "Application Support", "OpenClaw"),
    ].filter(Boolean));
}

function providerItems(source: SetupImportSourceId, rootDir: string): SetupImportItem[] {
  const baseEnv = {
    ...readEnvFile(path.join(rootDir, ".env")),
    ...readEnvFile(path.join(rootDir, ".env.local")),
    ...readEnvFile(path.join(rootDir, "config", ".env")),
    ...readEnvFile(path.join(rootDir, "config", ".env.local")),
  };
  return candidateFiles(rootDir, CONFIG_FILENAMES).flatMap((configPath) => {
    const raw = readJson(configPath);
    const records = collectRecords(raw);
    const workspaceHint = records
      .map((record) => {
        const direct =
          firstString([record], ["work_dir", "workDir", "workspacePath"]) ??
          firstString([record], ["workspace"]);
        if (direct) return direct;
        const workspace = nestedRecord(record, "workspace");
        if (!workspace) return undefined;
        return firstString([workspace], ["path", "dir", "root", "work_dir", "workDir", "workspacePath", "name"]);
      })
      .find(Boolean);

    const env = { ...baseEnv };
    if (workspaceHint) {
      const workspaceRoot = path.isAbsolute(workspaceHint)
        ? workspaceHint
        : path.join(rootDir, workspaceHint);
      if (pathExists(workspaceRoot)) {
        Object.assign(env, readEnvFile(path.join(workspaceRoot, ".env")));
        Object.assign(env, readEnvFile(path.join(workspaceRoot, ".env.local")));
      }
    }

    const settings = extractProviderSettings(raw, source, { env });
    return settings ? [buildProviderItem(source, configPath, settings)] : [];
  });
}

function userItems(source: SetupImportSourceId, rootDir: string): SetupImportItem[] {
  const candidates = unique([
    path.join(rootDir, "USER.md"),
    path.join(rootDir, "user.md"),
    ...workspaceRoots(rootDir).flatMap((workspaceRoot) => [
      path.join(workspaceRoot, "USER.md"),
      path.join(workspaceRoot, "user.md"),
    ]),
  ]).filter(pathExists);

  const sourcePath = candidates.find((candidate) => {
    try {
      return fs.readFileSync(candidate, "utf-8").trim().length > 0;
    } catch {
      return false;
    }
  });
  if (!sourcePath) return [];

  return [{
    id: `${source}:user:${safeImportName(sourcePath)}`,
    source,
    sourceLabel: SOURCE_LABELS[source],
    kind: "user",
    label: path.relative(rootDir, sourcePath) || "USER.md",
    sourcePath,
    decision: "import",
    reason: "USER.md found",
    userSettings: {
      content: fs.readFileSync(sourcePath, "utf-8"),
    },
  }];
}

function telegramItems(source: SetupImportSourceId, rootDir: string): SetupImportItem[] {
  const env = {
    ...readEnvFile(path.join(rootDir, ".env")),
    ...readEnvFile(path.join(rootDir, "config", ".env")),
  };
  const configItems = candidateFiles(rootDir, CONFIG_FILENAMES).flatMap((configPath) => {
    const settings = extractTelegramSettings(readJson(configPath), env);
    return settings ? [buildTelegramItem(source, configPath, settings)] : [];
  });
  return [...configItems, ...telegramCredentialItems(source, rootDir)];
}

function skillItems(source: SetupImportSourceId, rootDir: string): SetupImportItem[] {
  return findSkillDirs(source, rootDir).map((skillDir) => {
    const name = path.basename(skillDir);
    return {
      id: `${source}:skill:${safeImportName(skillDir)}`,
      source,
      sourceLabel: SOURCE_LABELS[source],
      kind: "skill",
      label: name,
      sourcePath: skillDir,
      decision: "import",
      reason: "SKILL.md found",
    };
  });
}

function mcpItems(source: SetupImportSourceId, rootDir: string): SetupImportItem[] {
  return candidateFiles(rootDir, [...MCP_FILENAMES, ...CONFIG_FILENAMES]).flatMap((mcpPath) =>
    extractMcpServers(readJson(mcpPath), source).map((server) => ({
      id: `${source}:mcp:${server.id}`,
      source,
      sourceLabel: SOURCE_LABELS[source],
      kind: "mcp",
      label: server.name,
      sourcePath: mcpPath,
      decision: "copy_disabled",
      reason: "MCP servers are imported disabled until reviewed",
      mcpServer: server,
    }))
  );
}

function pluginItems(source: SetupImportSourceId, rootDir: string): SetupImportItem[] {
  return findPluginDirs(rootDir).map((pluginDir) => {
    const pluginCompatibility = analyzeForeignPluginDirectory(source, pluginDir);
    const name = pluginCompatibility.manifest?.name ?? path.basename(pluginDir);
    const reason =
      pluginCompatibility.status === "convertible"
        ? "plugin manifest is compatible and will be copied disabled until reviewed"
        : pluginCompatibility.status === "quarantined"
          ? `plugin is quarantined: ${pluginCompatibility.issues.join("; ")}`
          : `plugin is incompatible: ${pluginCompatibility.issues.join("; ")}`;
    return {
      id: `${source}:plugin:${name}`,
      source,
      sourceLabel: SOURCE_LABELS[source],
      kind: "plugin",
      label: name,
      sourcePath: pluginDir,
      decision: "copy_disabled",
      reason,
      pluginCompatibility,
    };
  });
}

function detectSource(source: SetupImportSourceId): SetupImportSource | undefined {
  for (const rootDir of sourceRoots(source)) {
    if (!pathExists(rootDir)) continue;
    const items = [
      ...providerItems(source, rootDir),
      ...userItems(source, rootDir),
      ...telegramItems(source, rootDir),
      ...skillItems(source, rootDir),
      ...mcpItems(source, rootDir),
      ...pluginItems(source, rootDir),
    ];
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
