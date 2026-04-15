import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";
import type {
  ForeignPluginCompatibilityReport,
  ForeignPluginManifestSummary,
  ForeignPluginPermissions,
  ForeignPluginSource,
} from "./types.js";

const MANIFEST_FILENAMES = ["plugin.yaml", "plugin.json"] as const;
const NAME_PATTERN = /^[a-z0-9-]+$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SUPPORTED_TYPES = new Set(["adapter", "data_source", "notifier", "schedule_source"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []));
  return result.length > 0 ? result : undefined;
}

function readManifest(filePath: string): unknown | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    if (filePath.endsWith(".yaml")) {
      return yaml.load(raw) as unknown;
    }
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function findManifestPath(pluginDir: string): string | undefined {
  for (const filename of MANIFEST_FILENAMES) {
    const candidate = path.join(pluginDir, filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function defaultPermissions(): ForeignPluginPermissions {
  return {
    network: false,
    file_read: false,
    file_write: false,
    shell: false,
  };
}

function normalizePermissions(raw: unknown): { permissions: ForeignPluginPermissions; issues: string[] } {
  const permissions = defaultPermissions();
  if (raw === undefined) return { permissions, issues: [] };
  if (!isRecord(raw)) {
    return { permissions, issues: ["permissions block must be an object"] };
  }

  const issues: string[] = [];
  for (const key of Object.keys(permissions) as Array<keyof ForeignPluginPermissions>) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      issues.push(`permissions.${key} must be a boolean`);
      continue;
    }
    permissions[key] = value;
  }
  return { permissions, issues };
}

function summarizeManifest(
  raw: Record<string, unknown>,
  pluginDir?: string
): {
  summary?: ForeignPluginManifestSummary;
  issues: string[];
  permissions: ForeignPluginPermissions;
} {
  const issues: string[] = [];
  const name = stringValue(raw["name"]);
  if (!name) issues.push("missing plugin name");
  else if (!NAME_PATTERN.test(name)) issues.push("plugin name must use lowercase letters, digits, and hyphens");

  const version = stringValue(raw["version"]);
  if (!version) issues.push("missing plugin version");
  else if (!VERSION_PATTERN.test(version)) issues.push("plugin version must use semver major.minor.patch");

  const type = stringValue(raw["type"]);
  if (!type) issues.push("missing plugin type");
  else if (!SUPPORTED_TYPES.has(type)) issues.push(`unsupported plugin type: ${type}`);

  const capabilities = stringArray(raw["capabilities"]);
  if (!capabilities) issues.push("capabilities must be a non-empty array of strings");

  const description = stringValue(raw["description"]);
  if (!description) issues.push("missing plugin description");

  const entryPoint = stringValue(raw["entry_point"]) ?? "dist/index.js";
  if (pluginDir) {
    const resolvedEntryPoint = path.resolve(pluginDir, entryPoint);
    const boundary = pluginDir.endsWith(path.sep) ? pluginDir : `${pluginDir}${path.sep}`;
    if (resolvedEntryPoint !== pluginDir && !resolvedEntryPoint.startsWith(boundary)) {
      issues.push(`entry_point escapes plugin directory: ${entryPoint}`);
    }
  }

  const { permissions, issues: permissionIssues } = normalizePermissions(raw["permissions"]);
  issues.push(...permissionIssues);

  if (issues.length > 0 || !name || !version || !type || !capabilities || !description) {
    return { issues, permissions };
  }

  return {
    summary: {
      name,
      version,
      type,
      capabilities,
      description,
      entry_point: entryPoint,
    },
    issues,
    permissions,
  };
}

export function analyzeForeignPluginManifest(
  source: ForeignPluginSource,
  raw: unknown,
  context: { pluginDir?: string; manifestPath?: string } = {}
): ForeignPluginCompatibilityReport {
  const permissions = defaultPermissions();
  if (!isRecord(raw)) {
    return {
      source,
      status: "incompatible",
      issues: ["manifest is not an object"],
      permissions,
      ...(context.manifestPath ? { manifestPath: context.manifestPath } : {}),
    };
  }

  const { summary, issues, permissions: parsedPermissions } = summarizeManifest(raw, context.pluginDir);
  if (issues.length > 0 || !summary) {
    return {
      source,
      status: "incompatible",
      issues: issues.length > 0 ? issues : ["manifest is incompatible"],
      permissions: parsedPermissions,
      ...(context.manifestPath ? { manifestPath: context.manifestPath } : {}),
    };
  }

  const requestedPermissions = Object.entries(parsedPermissions)
    .flatMap(([key, value]) => (value ? [key] : []));
  const status = requestedPermissions.length > 0 ? "quarantined" : "convertible";
  const compatibilityIssues =
    status === "quarantined"
      ? [`requested permissions: ${requestedPermissions.join(", ")}`]
      : ["manifest is compatible and can be translated into a disabled PulSeed plugin"];

  return {
    source,
    status,
    issues: compatibilityIssues,
    permissions: parsedPermissions,
    manifest: summary,
    ...(context.manifestPath ? { manifestPath: context.manifestPath } : {}),
  };
}

export function analyzeForeignPluginDirectory(
  source: ForeignPluginSource,
  pluginDir: string
): ForeignPluginCompatibilityReport {
  const manifestPath = findManifestPath(pluginDir);
  if (!manifestPath) {
    return {
      source,
      status: "incompatible",
      issues: ["plugin.yaml or plugin.json was not found"],
      permissions: defaultPermissions(),
    };
  }

  const raw = readManifest(manifestPath);
  if (raw === undefined) {
    return {
      source,
      status: "incompatible",
      issues: [`failed to parse manifest: ${path.basename(manifestPath)}`],
      permissions: defaultPermissions(),
      manifestPath,
    };
  }

  return analyzeForeignPluginManifest(source, raw, { pluginDir, manifestPath });
}
