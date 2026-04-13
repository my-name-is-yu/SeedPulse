import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../../../../../base/utils/json-io.js";
import type { MCPServerConfig, MCPServersConfig } from "../../../../../base/types/mcp.js";
import type {
  SetupImportAppliedItem,
  SetupImportItem,
  SetupImportReport,
  SetupImportSelection,
} from "./types.js";

function safeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "imported";
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function uniquePath(parentDir: string, name: string): Promise<string> {
  const baseName = safeName(name);
  let candidate = path.join(parentDir, baseName);
  let suffix = 2;
  while (await pathExists(candidate)) {
    candidate = path.join(parentDir, `${baseName}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

async function copyDirectoryNoSymlinks(sourceDir: string, targetDir: string): Promise<void> {
  const stat = await fsp.lstat(sourceDir);
  if (stat.isSymbolicLink()) {
    throw new Error("refusing to copy symlink");
  }
  if (!stat.isDirectory()) {
    throw new Error("source is not a directory");
  }

  await fsp.mkdir(targetDir, { recursive: true });
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    const entryStat = await fsp.lstat(sourcePath);
    if (entryStat.isSymbolicLink()) continue;
    if (entryStat.isDirectory()) {
      await copyDirectoryNoSymlinks(sourcePath, targetPath);
    } else if (entryStat.isFile()) {
      await fsp.copyFile(sourcePath, targetPath);
    }
  }
}

function nextMcpId(existing: Set<string>, requested: string): string {
  const base = safeName(requested);
  if (!existing.has(base)) return base;
  let suffix = 2;
  for (;;) {
    const candidate = `${base}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
    suffix += 1;
  }
}

async function mergeMcpServers(baseDir: string, servers: MCPServerConfig[]): Promise<string | undefined> {
  if (servers.length === 0) return undefined;
  const configPath = path.join(baseDir, "mcp-servers.json");
  const current = await readJsonFileOrNull<MCPServersConfig>(configPath);
  const existingServers = Array.isArray(current?.servers) ? current.servers : [];
  const existingIds = new Set(existingServers.map((server) => server.id));
  const imported = servers.map((server) => {
    const id = nextMcpId(existingIds, server.id);
    existingIds.add(id);
    return { ...server, id, enabled: false };
  });

  await writeJsonFileAtomic(configPath, { servers: [...existingServers, ...imported] });
  return configPath;
}

async function applyFileItem(baseDir: string, item: SetupImportItem): Promise<SetupImportAppliedItem> {
  if (!item.sourcePath) {
    return {
      id: item.id,
      source: item.source,
      kind: item.kind,
      label: item.label,
      decision: item.decision,
      status: "skipped",
      reason: "no source path",
    };
  }

  if (item.kind === "skill") {
    const parentDir = path.join(baseDir, "skills", "imported", item.source);
    const targetPath = await uniquePath(parentDir, item.label);
    await copyDirectoryNoSymlinks(item.sourcePath, targetPath);
    return {
      id: item.id,
      source: item.source,
      kind: item.kind,
      label: item.label,
      decision: item.decision,
      status: "applied",
      targetPath,
    };
  }

  if (item.kind === "plugin") {
    const parentDir = path.join(baseDir, "plugins-imported-disabled", item.source);
    const targetPath = await uniquePath(parentDir, item.label);
    await copyDirectoryNoSymlinks(item.sourcePath, targetPath);
    return {
      id: item.id,
      source: item.source,
      kind: item.kind,
      label: item.label,
      decision: item.decision,
      status: "applied",
      targetPath,
    };
  }

  return {
    id: item.id,
    source: item.source,
    kind: item.kind,
    label: item.label,
    decision: item.decision,
    status: "skipped",
    reason: "not a file copy item",
  };
}

function reportItem(item: SetupImportItem, status: SetupImportAppliedItem["status"], reason?: string): SetupImportAppliedItem {
  return {
    id: item.id,
    source: item.source,
    kind: item.kind,
    label: item.label,
    decision: item.decision,
    status,
    ...(reason ? { reason } : {}),
  };
}

export async function applySetupImportSelection(
  baseDir: string,
  selection: SetupImportSelection
): Promise<SetupImportReport> {
  const applied: SetupImportAppliedItem[] = [];
  const selectedItems = selection.items.filter((item) => item.decision !== "skip");

  for (const item of selectedItems) {
    try {
      if (item.kind === "provider") {
        applied.push(reportItem(item, "applied", "provider settings seeded into setup answers"));
      } else if (item.kind === "skill" || item.kind === "plugin") {
        applied.push(await applyFileItem(baseDir, item));
      }
    } catch (err) {
      applied.push(reportItem(item, "failed", err instanceof Error ? err.message : String(err)));
    }
  }

  const mcpItems = selectedItems.filter((item) => item.kind === "mcp" && item.mcpServer);
  try {
    const targetPath = await mergeMcpServers(
      baseDir,
      mcpItems.map((item) => item.mcpServer as MCPServerConfig)
    );
    for (const item of mcpItems) {
      applied.push({
        id: item.id,
        source: item.source,
        kind: item.kind,
        label: item.label,
        decision: item.decision,
        status: targetPath ? "applied" : "skipped",
        ...(targetPath ? { targetPath } : { reason: "no MCP server config" }),
      });
    }
  } catch (err) {
    for (const item of mcpItems) {
      applied.push(reportItem(item, "failed", err instanceof Error ? err.message : String(err)));
    }
  }

  const createdAt = new Date().toISOString();
  const report: SetupImportReport = {
    created_at: createdAt,
    sources: selection.sources.map(({ id, label, rootDir }) => ({ id, label, rootDir })),
    items: applied,
  };

  const reportName = createdAt.replace(/[:.]/g, "-");
  const sourceName = selection.sources.map((source) => source.id).join("-") || "import";
  const reportPath = path.join(baseDir, "imports", sourceName, reportName, "report.json");
  await writeJsonFileAtomic(reportPath, report);

  return report;
}
