import type { StateManager } from "../../base/state/state-manager.js";
import { createGroundingGateway, type GroundingGateway } from "../../grounding/gateway.js";
import type { GroundingBundle } from "../../grounding/contracts.js";
import {
  buildApprovalPolicySectionContent,
  buildExecutionPolicySectionContent,
  buildIdentitySectionContent,
} from "../../grounding/providers/static-policy-provider.js";

export interface GroundingOptions {
  stateManager: StateManager;
  homeDir?: string;
  pluginLoader?: { loadAll(): Promise<Array<{ name: string; enabled?: boolean; error?: string | null }>> };
  workspaceRoot?: string;
  goalId?: string;
  userMessage?: string;
  trustProjectInstructions?: boolean;
  workspaceContext?: string;
}

function createChatGateway(options: Pick<GroundingOptions, "stateManager" | "pluginLoader">): GroundingGateway {
  return createGroundingGateway({
    stateManager: options.stateManager,
    pluginLoader: options.pluginLoader,
  });
}

export { createChatGateway as createChatGroundingGateway };

function renderLegacyStaticPrompt(bundle: GroundingBundle): string {
  return bundle.staticSections.map((section) => {
    if (section.key === "execution_policy") {
      return section.content.trim();
    }
    if (section.key === "approval_policy") {
      return `## Safety And Approval\n${section.content}`.trim();
    }
    return `## ${section.title}\n${section.content}`.trim();
  }).join("\n\n").trim();
}

function renderLegacyDynamicPrompt(bundle: GroundingBundle): string {
  const byKey = new Map(bundle.dynamicSections.map((section) => [section.key, section]));
  const goalState = byKey.get("goal_state")?.content ?? "No goals configured yet.";
  const plugins = byKey.get("plugins")?.content?.replace(/^Installed:\s*/, "") ?? "none";
  const provider = byKey.get("provider_state")?.content ?? "not configured";
  return [
    "## Dynamic Context",
    "### Current Goals",
    goalState,
    "",
    "### Installed Plugins",
    `Installed: ${plugins}`,
    "",
    "### Provider",
    provider,
  ].join("\n").trim();
}

export async function buildChatGroundingBundle(options: GroundingOptions): Promise<GroundingBundle> {
  return await createChatGateway(options).build({
    surface: "chat",
    purpose: "general_turn",
    homeDir: options.homeDir,
    workspaceRoot: options.workspaceRoot,
    goalId: options.goalId,
    userMessage: options.userMessage,
    query: options.userMessage,
    trustProjectInstructions: options.trustProjectInstructions,
    workspaceContext: options.workspaceContext,
  });
}

export function buildStaticSystemPrompt(): string {
  return [
    `## Identity\n${buildIdentitySectionContent()}`,
    buildExecutionPolicySectionContent(),
    `## Safety And Approval\n${buildApprovalPolicySectionContent()}`,
  ].join("\n\n").trim();
}

export async function buildDynamicContextPrompt(options: GroundingOptions): Promise<string> {
  const bundle = await createChatGateway(options).build({
    surface: "chat",
    purpose: "general_turn",
    homeDir: options.homeDir,
    goalId: options.goalId,
    include: {
      identity: false,
      execution_policy: false,
      approval_policy: false,
      trust_state: false,
      repo_instructions: false,
      soil_knowledge: false,
    },
  });
  return renderLegacyDynamicPrompt(bundle);
}

export async function buildSystemPrompt(options: GroundingOptions): Promise<string> {
  const bundle = await buildChatGroundingBundle(options);
  const staticSections = bundle.staticSections.filter((section) =>
    section.key === "identity" || section.key === "execution_policy" || section.key === "approval_policy"
  );
  const dynamicSections = bundle.dynamicSections.filter((section) =>
    section.key === "goal_state" || section.key === "plugins" || section.key === "provider_state"
  );
  return [
    renderLegacyStaticPrompt({ ...bundle, staticSections, dynamicSections: [] }),
    renderLegacyDynamicPrompt({ ...bundle, staticSections: [], dynamicSections }),
  ].join("\n\n").trim();
}
