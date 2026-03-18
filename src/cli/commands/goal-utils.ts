// ─── goal-utils.ts: shared types, patterns, and data-source auto-registration ───

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getDatasourcesDir } from "../../utils/paths.js";
import { writeJsonFile } from "../../utils/json-io.js";
import { StateManager } from "../../state-manager.js";
import { getCliLogger } from "../cli-logger.js";
import { formatOperationError } from "../utils.js";

// ─── Shell Dimension Patterns ───
//
// Maps known count-based dimension names to grep commands that can mechanically
// observe them. argv uses pre-split arrays (passed to execFile, not shell).
// output_type "number" sums trailing integers across multi-line grep -rc output.

export interface ShellCommandConfig {
  argv: string[];
  output_type: "number" | "boolean" | "raw";
  timeout_ms?: number;
}

export const SHELL_DIMENSION_PATTERNS: Record<string, ShellCommandConfig> = {
  todo_count:        { argv: ["grep", "-rEc", "//\\s*TODO|#\\s*TODO", "src/"], output_type: "number" },
  fixme_count:       { argv: ["grep", "-rEc", "//\\s*FIXME|#\\s*FIXME", "src/"], output_type: "number" },
  test_count:        { argv: ["grep", "-rEc", "it\\(|test\\(|describe\\(", "tests/"], output_type: "number" },
  lint_errors:       { argv: ["npx", "eslint", "src/", "--format", "compact", "--max-warnings", "9999"], output_type: "number" },
  tsc_error_count:   { argv: ["npx", "tsc", "--noEmit", "--pretty", "false"], output_type: "number" },
  test_coverage:     { argv: ["node", "scripts/measure-coverage.cjs"], output_type: "raw", timeout_ms: 180000 },
};

// ─── Raw Dimension Spec ───

export interface RawDimensionSpec {
  name: string;
  type: "min" | "max" | "range" | "present" | "match";
  value?: string;
}

type Threshold =
  | { type: "min"; value: number }
  | { type: "max"; value: number }
  | { type: "range"; low: number; high: number }
  | { type: "present" }
  | { type: "match"; value: string | number | boolean };

/** Parse a "name:type:value" string into a RawDimensionSpec. Returns null on error. */
export function parseRawDim(raw: string): RawDimensionSpec | null {
  const parts = raw.split(":");
  if (parts.length < 2) return null;
  const name = parts[0].trim();
  const type = parts[1].trim() as RawDimensionSpec["type"];
  if (!["min", "max", "range", "present", "match"].includes(type)) return null;
  if (!name) return null;
  const value = parts.slice(2).join(":").trim() || undefined;
  return { name, type, value };
}

/** Build a Threshold object from a RawDimensionSpec. Returns null if value is invalid. */
export function buildThreshold(spec: RawDimensionSpec): Threshold | null {
  if (spec.type === "present") return { type: "present" };

  if (spec.type === "range") {
    if (!spec.value) return null;
    const [lowStr, highStr] = spec.value.split(",");
    const low = parseFloat(lowStr ?? "");
    const high = parseFloat(highStr ?? "");
    if (isNaN(low) || isNaN(high)) return null;
    return { type: "range", low, high };
  }

  if (spec.type === "min" || spec.type === "max") {
    if (!spec.value) return null;
    const num = parseFloat(spec.value);
    if (isNaN(num)) return null;
    return { type: spec.type, value: num };
  }

  if (spec.type === "match") {
    if (spec.value === undefined) return null;
    const num = parseFloat(spec.value);
    if (!isNaN(num)) return { type: "match", value: num };
    if (spec.value === "true") return { type: "match", value: true };
    if (spec.value === "false") return { type: "match", value: false };
    return { type: "match", value: spec.value };
  }

  return null;
}

// ─── Auto DataSource Registration ───

export async function autoRegisterFileExistenceDataSources(
  stateManager: StateManager,
  dimensions: Array<{ name: string; label?: string }>,
  goalDescription: string,
  goalId: string
): Promise<void> {
  try {
    const fileExistenceDims = dimensions.filter((d) =>
      /_exists$|_file$|file_existence/.test(d.name)
    );
    if (fileExistenceDims.length === 0) return;

    const nonFileExistenceDims = dimensions.filter((d) =>
      !/_exists$|_file$|file_existence/.test(d.name)
    );
    if (nonFileExistenceDims.length >= 1) {
      console.log(
        `[auto] Skipping FileExistenceDataSource auto-registration: goal has ${nonFileExistenceDims.length} non-FileExistence dimensions that should take priority`
      );
      return;
    }

    const filePathPattern = /\b([\w.\-/]+\.\w{1,10})\b/g;
    const candidateFiles: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = filePathPattern.exec(goalDescription)) !== null) {
      candidateFiles.push(m[1]);
    }

    for (const dim of fileExistenceDims) {
      if (dim.label) {
        const labelPattern = /\b([\w.\-/]+\.\w{1,10})\b/g;
        let m2: RegExpExecArray | null;
        while ((m2 = labelPattern.exec(dim.label)) !== null) {
          if (!candidateFiles.includes(m2[1])) {
            candidateFiles.push(m2[1]);
          }
        }
      }
    }

    const dimensionMapping: Record<string, string> = {};
    for (const dim of fileExistenceDims) {
      const dimBase = dim.name
        .replace(/_exists$/, "")
        .replace(/_file$/, "")
        .replace(/_/g, "")
        .toLowerCase();
      let matched = candidateFiles.find((f) => {
        const fBase = path.basename(f).replace(/[._-]/g, "").toLowerCase();
        return fBase.includes(dimBase) || dimBase.includes(fBase);
      });
      if (!matched && dim.label) {
        const labelFilePattern = /\b([\w.\-/]+\.\w{1,10})\b/g;
        let lm: RegExpExecArray | null;
        while ((lm = labelFilePattern.exec(dim.label)) !== null) {
          const labelFile = lm[1];
          if (candidateFiles.includes(labelFile)) {
            matched = labelFile;
            break;
          }
        }
      }
      if (matched) {
        dimensionMapping[dim.name] = matched;
      } else if (candidateFiles.length === 1) {
        dimensionMapping[dim.name] = candidateFiles[0];
      }
    }

    if (Object.keys(dimensionMapping).length === 0) return;

    const datasourcesDir = getDatasourcesDir(stateManager.getBaseDir());
    await fsp.mkdir(datasourcesDir, { recursive: true });

    const id = `ds_auto_${Date.now()}`;
    const config = {
      id,
      name: `auto:file_existence (${Object.values(dimensionMapping).join(", ")})`,
      type: "file_existence",
      connection: { path: process.cwd() },
      dimension_mapping: dimensionMapping,
      scope_goal_id: goalId,
      enabled: true,
      created_at: new Date().toISOString(),
    };

    const configPath = path.join(datasourcesDir, `${id}.json`);
    await writeJsonFile(configPath, config);

    console.log(
      `[auto] Registered FileExistenceDataSource for: ${Object.keys(dimensionMapping).join(", ")}`
    );
  } catch (err) {
    getCliLogger().error(formatOperationError("auto-register file existence data sources", err));
  }
}

export async function autoRegisterShellDataSources(
  stateManager: StateManager,
  dimensions: Array<{ name: string }>,
  goalId: string
): Promise<void> {
  try {
    // Collect dimensions that match known shell patterns
    const matchedCommands: Record<string, ShellCommandConfig> = {};
    for (const dim of dimensions) {
      const pattern = SHELL_DIMENSION_PATTERNS[dim.name];
      if (pattern) {
        matchedCommands[dim.name] = pattern;
      }
    }

    if (Object.keys(matchedCommands).length === 0) return;

    const datasourcesDir = getDatasourcesDir(stateManager.getBaseDir());
    await fsp.mkdir(datasourcesDir, { recursive: true });

    const id = `ds_auto_shell_${Date.now()}`;

    // Serialize commands in the format ShellDataSourceAdapter expects:
    // Record<dimensionName, ShellCommandSpec>
    const commandsConfig: Record<string, { argv: string[]; output_type: string; timeout_ms?: number }> = {};
    for (const [dimName, spec] of Object.entries(matchedCommands)) {
      commandsConfig[dimName] = { argv: spec.argv, output_type: spec.output_type, ...(spec.timeout_ms ? { timeout_ms: spec.timeout_ms } : {}) };
    }

    const config = {
      id,
      name: `auto:shell (${Object.keys(matchedCommands).join(", ")})`,
      type: "shell",
      connection: { path: process.cwd(), commands: commandsConfig },
      scope_goal_id: goalId,
      enabled: true,
      created_at: new Date().toISOString(),
    };

    const configPath = path.join(datasourcesDir, `${id}.json`);
    await writeJsonFile(configPath, config);

    console.log(
      `[auto] Registered ShellDataSource for: ${Object.keys(matchedCommands).join(", ")}`
    );
  } catch (err) {
    getCliLogger().error(formatOperationError("auto-register shell data sources", err));
  }
}
