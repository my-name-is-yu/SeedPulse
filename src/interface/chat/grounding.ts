// ─── Chat Grounding ───
//
// Builds a system prompt that gives the LLM self-knowledge about PulSeed:
// identity, operating rules, and current state (goals, plugins, provider).

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { StateManager } from "../../base/state/state-manager.js";
import { getAgentName, getUserFacingIdentity, loadIdentity } from "../../base/config/identity-loader.js";

export interface GroundingOptions {
  stateManager: StateManager;
  /** Base directory for PulSeed config files. Defaults to ~/.pulseed */
  homeDir?: string;
}

async function readPlugins(homeDir: string): Promise<string[]> {
  const pluginsDir = path.join(homeDir, "plugins");
  try {
    const entries = await fsp.readdir(pluginsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function readProvider(homeDir: string): Promise<string> {
  const providerPath = path.join(homeDir, "provider.json");
  try {
    const raw = await fsp.readFile(providerPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const llm = typeof parsed.llm === "string" ? parsed.llm : null;
    const adapter = typeof parsed.default_adapter === "string" ? parsed.default_adapter : null;
    if (llm && adapter) return `${llm} / ${adapter}`;
    if (llm) return llm;
    return "not configured";
  } catch {
    return "not configured";
  }
}

async function buildGoalsBlock(stateManager: StateManager): Promise<string> {
  const ids = await stateManager.listGoalIds();
  if (ids.length === 0) return "No goals configured yet.";

  const lines: string[] = [];
  for (const id of ids) {
    const goal = await stateManager.loadGoal(id);
    if (!goal) continue;
    const status = goal.loop_status !== "idle" ? ` [${goal.loop_status}]` : "";
    lines.push(`- ${goal.title} (${id})${status} — status: ${goal.status}`);
  }
  return lines.length > 0 ? lines.join("\n") : "No goals configured yet.";
}

function buildIdentitySection(): string {
  const { name } = loadIdentity();

  return [
    "## Identity",
    `You are ${name}.`,
    "You run PulSeed, an AI goal pursuit orchestration system.",
    "",
    "Your role is to help the user make concrete progress by inspecting the workspace, using tools, delegating work when useful, and executing the next valid step.",
    "",
    getUserFacingIdentity().trim(),
  ].join("\n");
}

function buildExecutionBiasSection(): string {
  return [
    "## Execution Bias",
    "- If the next step is clear and safe, do it in the same turn.",
    "- Do not stop at analysis when execution is possible.",
    "- Inspect files, code, and state before asking avoidable questions.",
    "- Prefer subagents for parallel exploration and context isolation when that reduces context pollution.",
    "- Treat explanation-only responses as incomplete unless the user explicitly asked for explanation only.",
  ].join("\n");
}

function buildToolingPolicySection(): string {
  return [
    "## Tooling Policy",
    "- Tool schemas are the source of truth for capabilities, arguments, and constraints.",
    "- Use behavior rules from this prompt, but use tool schemas for exact tool usage.",
    "- Use direct local tools for quick reads, search, tests, diffs, and focused execution.",
    "- Use background execution only for long-running tasks.",
    "- Choose the narrowest tool that can complete the task correctly.",
  ].join("\n");
}

function buildCommunicationPolicySection(): string {
  return [
    "## Communication Policy",
    "- Keep pre-tool messages short and factual.",
    "- Do not give long preambles before routine tool calls.",
    "- Prefer action first, then concise reporting.",
    "- Progress updates should be brief and relevant.",
    "- Do not narrate internal process details at length unless they matter to the user's decision.",
  ].join("\n");
}

function buildSafetySection(name: string): string {
  return [
    "## Safety And Approval",
    "- Before changing configuration, explain the effect, required environment, risks, and rollback path.",
    "- Require explicit user approval before applying configuration changes.",
    "- Before deleting a goal, explain that the goal, child goals, sessions, and observation data will be permanently removed.",
    "- Before goal deletion, explicitly state that the action is irreversible and require explicit user approval.",
    `- Stay focused on goals — you're here to help them grow (${name}).`,
  ].join("\n");
}

function buildDynamicContextSection(goalsBlock: string, pluginsLine: string, provider: string): string {
  return [
    "## Dynamic Context",
    "### Current Goals",
    goalsBlock,
    "",
    "### Installed Plugins",
    `Installed: ${pluginsLine}`,
    "",
    "### Provider",
    provider,
  ].join("\n");
}

export async function buildSystemPrompt(options: GroundingOptions): Promise<string> {
  const homeDir = options.homeDir ?? path.join(
    process.env["HOME"] ?? process.env["USERPROFILE"] ?? "/tmp",
    ".pulseed"
  );

  const [goalsBlock, plugins, provider] = await Promise.all([
    buildGoalsBlock(options.stateManager),
    readPlugins(homeDir),
    readProvider(homeDir),
  ]);

  const pluginsLine = plugins.length > 0 ? plugins.join(", ") : "none";
  const name = getAgentName();

  return [
    buildIdentitySection(),
    buildExecutionBiasSection(),
    buildToolingPolicySection(),
    buildCommunicationPolicySection(),
    buildSafetySection(name),
    buildDynamicContextSection(goalsBlock, pluginsLine, provider),
  ].join("\n\n").trim();
}
