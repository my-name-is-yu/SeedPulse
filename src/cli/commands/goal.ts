// ─── motiva goal subcommands ───

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

import { StateManager } from "../../state-manager.js";
import { CharacterConfigManager } from "../../traits/character-config.js";
import { loadProviderConfig } from "../../llm/provider-config.js";
import { ReportingEngine } from "../../reporting-engine.js";
import { EthicsRejectedError, gatherNegotiationContext } from "../../goal/goal-negotiator.js";
import { buildDeps } from "../setup.js";
import { formatOperationError } from "../utils.js";

export async function cmdGoalAdd(
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager,
  description: string,
  opts: { deadline?: string; constraints?: string[]; yes?: boolean }
): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const providerConfig = loadProviderConfig();
  const provider = providerConfig.llm_provider;
  if (!apiKey && provider !== "ollama" && provider !== "openai" && provider !== "codex") {
    console.error(
      "Error: ANTHROPIC_API_KEY environment variable is not set.\n" +
        "Set it with: export ANTHROPIC_API_KEY=<your-key>\n" +
        "Or use OpenAI: export MOTIVA_LLM_PROVIDER=openai\n" +
        "Or use Ollama: export MOTIVA_LLM_PROVIDER=ollama\n" +
        "Or use Codex: export MOTIVA_LLM_PROVIDER=codex"
    );
    return 1;
  }

  let deps: ReturnType<typeof buildDeps>;
  try {
    deps = buildDeps(stateManager, characterConfigManager, apiKey);
  } catch (err) {
    console.error(formatOperationError("initialise goal negotiation dependencies", err));
    return 1;
  }

  const { goalNegotiator } = deps;

  console.log(`Negotiating goal: "${description}"`);
  if (opts.deadline) {
    console.log(`Deadline: ${opts.deadline}`);
  }
  if (opts.constraints && opts.constraints.length > 0) {
    console.log(`Constraints: ${opts.constraints.join(", ")}`);
  }
  console.log("This may take a moment...\n");

  try {
    const workspaceContext = await gatherNegotiationContext(description, process.cwd());
    const { goal, response } = await goalNegotiator.negotiate(description, {
      deadline: opts.deadline,
      constraints: opts.constraints,
      workspaceContext: workspaceContext || undefined,
    });

    if (response.type === "counter_propose") {
      console.log(`\nCounter-proposal: ${response.message}`);
      if (response.counter_proposal) {
        console.log(`Suggested target: ${response.counter_proposal.realistic_target}`);
        console.log(`Reasoning: ${response.counter_proposal.reasoning}`);
      }

      let accepted: boolean;
      if (opts.yes) {
        console.log("\n--- Auto-accepted counter-proposal (--yes) ---");
        accepted = true;
      } else {
        accepted = await new Promise<boolean>((resolve) => {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          process.stdout.write("\nAccept this counter-proposal and register the goal? [y/N] ");
          rl.once("line", (answer) => {
            rl?.close();
            resolve(answer.trim().toLowerCase() === "y");
          });
        });
      }

      if (!accepted) {
        stateManager.deleteGoal(goal.id);
        console.log("Goal not registered.");
        return 0;
      }
    }

    autoRegisterFileExistenceDataSources(stateManager, goal.dimensions, goal.description, goal.id);
    autoRegisterShellDataSources(stateManager, goal.dimensions, goal.id);

    console.log(`Goal registered successfully!`);
    console.log(`Goal ID:    ${goal.id}`);
    console.log(`Title:      ${goal.title}`);
    console.log(`Status:     ${goal.status}`);
    console.log(`Dimensions: ${goal.dimensions.length}`);
    console.log(`\nResponse: ${response.message}`);

    if (goal.dimensions.length > 0) {
      console.log(`\nDimensions:`);
      for (const dim of goal.dimensions) {
        console.log(`  - ${dim.label} (${dim.name}): ${JSON.stringify(dim.threshold)}`);
      }
    }

    console.log(`\nTo run the loop: motiva run --goal ${goal.id}`);
    return 0;
  } catch (err) {
    if (err instanceof EthicsRejectedError) {
      console.error(formatOperationError(`negotiate goal "${description}" via ethics gate`, err));
      console.error(`Ethics gate reasoning: ${err.verdict.reasoning}`);
      return 1;
    }
    console.error(formatOperationError(`negotiate goal "${description}"`, err));
    return 1;
  }
}

export function cmdGoalList(
  stateManager: StateManager,
  opts: { archived?: boolean } = {}
): number {
  const goalsDir = path.join(stateManager.getBaseDir(), "goals");

  if (!fs.existsSync(goalsDir) || fs.readdirSync(goalsDir).length === 0) {
    console.log("No goals registered. Use `motiva goal add` to create one.");
  } else {
    let entries: string[];
    try {
      entries = fs.readdirSync(goalsDir);
    } catch (err) {
      console.error(formatOperationError("read goals directory", err));
      return 1;
    }

    const goalDirs = entries.filter((e) => {
      try {
        return fs.statSync(path.join(goalsDir, e)).isDirectory();
      } catch (err) {
        console.error(formatOperationError(`inspect goal directory entry "${e}"`, err));
        return false;
      }
    });

    if (goalDirs.length === 0) {
      console.log("No goals registered. Use `motiva goal add` to create one.");
    } else {
      console.log(`Found ${goalDirs.length} goal(s):\n`);
      for (const goalId of goalDirs) {
        const goal = stateManager.loadGoal(goalId);
        if (!goal) {
          console.log(`[${goalId}] (could not load)`);
          continue;
        }
        console.log(
          `[${goalId}] status: ${goal.status} — ${goal.title} (dimensions: ${goal.dimensions.length})`
        );
      }
    }
  }

  const archivedIds = stateManager.listArchivedGoals();
  if (opts.archived && archivedIds.length > 0) {
    console.log(`\nArchived goals (${archivedIds.length}):\n`);
    for (const goalId of archivedIds) {
      const archivedGoalPath = path.join(
        stateManager.getBaseDir(),
        "archive",
        goalId,
        "goal",
        "goal.json"
      );
      let title = "(could not load)";
      let status = "unknown";
      let dimCount = 0;
      try {
        if (fs.existsSync(archivedGoalPath)) {
          const raw = JSON.parse(fs.readFileSync(archivedGoalPath, "utf-8")) as {
            title?: string;
            status?: string;
            dimensions?: unknown[];
          };
          title = raw.title ?? title;
          status = raw.status ?? status;
          dimCount = raw.dimensions?.length ?? 0;
        }
      } catch (err) {
        console.error(formatOperationError(`read archived goal metadata for "${goalId}"`, err));
      }
      console.log(`[${goalId}] status: ${status} — ${title} (dimensions: ${dimCount})`);
    }
  } else {
    console.log(`\nArchived goals: ${archivedIds.length} (use \`motiva goal list --archived\` to show)`);
  }

  return 0;
}

export function cmdStatus(stateManager: StateManager, goalId: string): number {
  const reportingEngine = new ReportingEngine(stateManager);

  const goal = stateManager.loadGoal(goalId);
  if (!goal) {
    console.error(`Error: Goal "${goalId}" not found.`);
    return 1;
  }

  console.log(`# Status: ${goal.title}`);
  console.log(`\n**Goal ID**: ${goalId}`);
  console.log(`**Status**: ${goal.status}`);
  if (goal.deadline) {
    console.log(`**Deadline**: ${goal.deadline}`);
  }
  console.log(`\n## Dimensions\n`);
  for (const dim of goal.dimensions) {
    const progress =
      typeof dim.current_value === "number"
        ? `${(dim.current_value * 100).toFixed(1)}%`
        : dim.current_value !== null
        ? String(dim.current_value)
        : "not yet measured";
    const confidence = `${(dim.confidence * 100).toFixed(1)}%`;
    console.log(`- **${dim.label}** (${dim.name})`);
    console.log(`  Progress: ${progress}  Confidence: ${confidence}`);
    console.log(`  Target: ${JSON.stringify(dim.threshold)}`);
  }

  const reports = reportingEngine.listReports(goalId);
  const execReports = reports
    .filter((r) => r.report_type === "execution_summary")
    .sort((a, b) => (a.generated_at < b.generated_at ? 1 : -1));

  if (execReports.length > 0) {
    const latest = execReports[0];
    console.log(`\n## Latest Execution Summary\n`);
    console.log(latest.content);
  } else {
    console.log(`\n_No execution reports yet. Run \`motiva run --goal ${goalId}\` to start._`);
  }

  return 0;
}

export function cmdGoalShow(stateManager: StateManager, goalId: string): number {
  const goal = stateManager.loadGoal(goalId);
  if (!goal) {
    console.error(`Error: Goal "${goalId}" not found.`);
    return 1;
  }

  console.log(`# Goal: ${goal.title}`);
  console.log(`\nID:          ${goal.id}`);
  console.log(`Status:      ${goal.status}`);
  console.log(`Description: ${goal.description || "(none)"}`);
  if (goal.deadline) {
    console.log(`Deadline:    ${goal.deadline}`);
  }
  console.log(`Created at:  ${goal.created_at}`);

  if (goal.dimensions.length > 0) {
    console.log(`\nDimensions:`);
    for (const dim of goal.dimensions) {
      console.log(`  - ${dim.label} (${dim.name})`);
      console.log(`    Threshold type:  ${dim.threshold.type}`);
      console.log(`    Threshold value: ${JSON.stringify((dim.threshold as { value?: unknown }).value ?? dim.threshold)}`);
    }
  } else {
    console.log(`\nDimensions: (none)`);
  }

  if (goal.constraints.length > 0) {
    console.log(`\nConstraints:`);
    for (const c of goal.constraints) {
      console.log(`  - ${c}`);
    }
  }

  return 0;
}

export function cmdGoalReset(stateManager: StateManager, goalId: string): number {
  const goal = stateManager.loadGoal(goalId);
  if (!goal) {
    console.error(`Error: Goal "${goalId}" not found.`);
    return 1;
  }

  const now = new Date().toISOString();
  const resetDimensions = goal.dimensions.map((dim) => ({
    ...dim,
    current_value: null,
    confidence: 0,
    last_updated: null,
    history: [],
  }));

  const resetGoal = {
    ...goal,
    status: "active" as const,
    loop_status: "idle" as const,
    dimensions: resetDimensions,
    updated_at: now,
  };

  stateManager.saveGoal(resetGoal);

  console.log(`Goal "${goalId}" reset to active.`);
  console.log(`  Status:      active`);
  console.log(`  Dimensions:  ${resetDimensions.length} dimension(s) cleared`);
  console.log(`\nRun \`motiva run --goal ${goalId}\` to restart the loop.`);

  return 0;
}

export function cmdLog(stateManager: StateManager, goalId: string): number {
  const observationLog = stateManager.loadObservationLog(goalId);
  const gapHistory = stateManager.loadGapHistory(goalId);

  if ((!observationLog || observationLog.entries.length === 0) && gapHistory.length === 0) {
    console.log(`No logs found for goal ${goalId}`);
    return 0;
  }

  if (observationLog && observationLog.entries.length > 0) {
    console.log(`# Observation Log (${observationLog.entries.length} entries, newest first)\n`);
    const sorted = [...observationLog.entries].sort((a, b) =>
      a.timestamp < b.timestamp ? 1 : -1
    );
    for (const entry of sorted) {
      console.log(`[${entry.timestamp}]`);
      console.log(`  Dimension:  ${entry.dimension_name}`);
      console.log(`  Confidence: ${(entry.confidence * 100).toFixed(1)}%`);
      console.log(`  Layer:      ${entry.layer}`);
      console.log(`  Trigger:    ${entry.trigger}`);
      console.log();
    }
  }

  if (gapHistory.length > 0) {
    console.log(`# Gap History (${gapHistory.length} entries, newest first)\n`);
    const sorted = [...gapHistory].sort((a, b) =>
      a.timestamp < b.timestamp ? 1 : -1
    );
    for (const entry of sorted) {
      const avgGap =
        entry.gap_vector.length > 0
          ? entry.gap_vector.reduce((sum, g) => sum + g.normalized_weighted_gap, 0) /
            entry.gap_vector.length
          : 0;
      console.log(`[${entry.timestamp}]`);
      console.log(`  Iteration: ${entry.iteration}`);
      console.log(`  Avg gap:   ${avgGap.toFixed(4)} (across ${entry.gap_vector.length} dimension(s))`);
      console.log();
    }
  }

  return 0;
}

export async function cmdGoalArchive(
  stateManager: StateManager,
  goalId: string,
  opts: { yes?: boolean; force?: boolean }
): Promise<number> {
  const goal = stateManager.loadGoal(goalId);
  if (!goal) {
    console.error(`Error: Goal "${goalId}" not found.`);
    return 1;
  }

  if (goal.status !== "completed" && !opts.force && !opts.yes) {
    console.warn(`Warning: Goal "${goalId}" is not completed (status: ${goal.status}).`);
    console.warn("Archive anyway? Use --yes or --force to skip this check.");
    return 1;
  }

  const archived = stateManager.archiveGoal(goalId);
  if (!archived) {
    console.error(`Error: Failed to archive goal "${goalId}".`);
    return 1;
  }

  console.log(`Goal "${goalId}" archived successfully.`);
  console.log(`  Title:  ${goal.title}`);
  console.log(`  Status: ${goal.status}`);
  return 0;
}

export function cmdCleanup(stateManager: StateManager): number {
  const goalIds = stateManager.listGoalIds();

  const completed: string[] = [];
  for (const goalId of goalIds) {
    const goal = stateManager.loadGoal(goalId);
    if (goal && goal.status === "completed") {
      completed.push(goalId);
    }
  }

  if (completed.length === 0) {
    console.log("No completed goals to archive.");
  } else {
    for (const goalId of completed) {
      stateManager.archiveGoal(goalId);
    }
    console.log(`Archived ${completed.length} completed goal(s).`);
  }

  const activeGoalIds = new Set(stateManager.listGoalIds());
  const baseDir = stateManager.getBaseDir();
  const staleReports: string[] = [];

  const reportsDir = path.join(baseDir, "reports");
  if (fs.existsSync(reportsDir)) {
    try {
      const reportFiles = fs.readdirSync(reportsDir).filter((f) => f.endsWith(".json"));
      for (const file of reportFiles) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(reportsDir, file), "utf-8")) as { goal_id?: string };
          if (raw.goal_id && !activeGoalIds.has(raw.goal_id)) {
            staleReports.push(file);
          }
        } catch (err) {
          console.error(formatOperationError(`read report metadata from "${file}"`, err));
        }
      }
    } catch (err) {
      console.error(formatOperationError(`scan reports directory "${reportsDir}"`, err));
    }
  }

  if (staleReports.length > 0) {
    console.log(`\nOrphaned report files (no matching active goal): ${staleReports.length}`);
    for (const f of staleReports) {
      console.log(`  ${f}`);
    }
    console.log("(These can be removed manually from ~/.motiva/reports/)");
  }

  return 0;
}

// ─── Shell Dimension Patterns ───
//
// Maps known count-based dimension names to grep commands that can mechanically
// observe them. argv uses pre-split arrays (passed to execFile, not shell).
// output_type "number" sums trailing integers across multi-line grep -rc output.

export interface ShellCommandConfig {
  argv: string[];
  output_type: "number" | "boolean" | "raw";
}

export const SHELL_DIMENSION_PATTERNS: Record<string, ShellCommandConfig> = {
  todo_count:   { argv: ["grep", "-rEc", "//\\s*TODO|#\\s*TODO", "src/"], output_type: "number" },
  fixme_count:  { argv: ["grep", "-rEc", "//\\s*FIXME|#\\s*FIXME", "src/"], output_type: "number" },
  test_count:   { argv: ["grep", "-rEc", "it\\(|test\\(|describe\\(", "tests/"], output_type: "number" },
  lint_errors:  { argv: ["npx", "eslint", "src/", "--format", "compact", "--max-warnings", "9999"], output_type: "number" },
};

// ─── Auto DataSource Registration ───

export function autoRegisterFileExistenceDataSources(
  stateManager: StateManager,
  dimensions: Array<{ name: string; label?: string }>,
  goalDescription: string,
  goalId: string
): void {
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

    const datasourcesDir = path.join(stateManager.getBaseDir(), "datasources");
    if (!fs.existsSync(datasourcesDir)) {
      fs.mkdirSync(datasourcesDir, { recursive: true });
    }

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
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    console.log(
      `[auto] Registered FileExistenceDataSource for: ${Object.keys(dimensionMapping).join(", ")}`
    );
  } catch (err) {
    console.error(formatOperationError("auto-register file existence data sources", err));
  }
}

export function autoRegisterShellDataSources(
  stateManager: StateManager,
  dimensions: Array<{ name: string }>,
  goalId: string
): void {
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

    const datasourcesDir = path.join(stateManager.getBaseDir(), "datasources");
    if (!fs.existsSync(datasourcesDir)) {
      fs.mkdirSync(datasourcesDir, { recursive: true });
    }

    const id = `ds_auto_shell_${Date.now()}`;

    // Serialize commands in the format ShellDataSourceAdapter expects:
    // Record<dimensionName, ShellCommandSpec>
    const commandsConfig: Record<string, { argv: string[]; output_type: string }> = {};
    for (const [dimName, spec] of Object.entries(matchedCommands)) {
      commandsConfig[dimName] = { argv: spec.argv, output_type: spec.output_type };
    }

    const config = {
      id,
      name: `auto:shell (${Object.keys(matchedCommands).join(", ")})`,
      type: "shell",
      connection: { path: process.cwd() },
      commands: commandsConfig,
      scope_goal_id: goalId,
      enabled: true,
      created_at: new Date().toISOString(),
    };

    const configPath = path.join(datasourcesDir, `${id}.json`);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    console.log(
      `[auto] Registered ShellDataSource for: ${Object.keys(matchedCommands).join(", ")}`
    );
  } catch (err) {
    console.error(formatOperationError("auto-register shell data sources", err));
  }
}
