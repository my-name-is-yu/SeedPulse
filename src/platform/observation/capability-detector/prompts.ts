import type { Capability, CapabilityAcquisitionTask } from "../../../base/types/capability.js";
import type { Task } from "../../../base/types/task.js";
import type { AgentResult } from "../../../orchestrator/execution/adapter-layer.js";

export function formatAvailableCapabilities(capabilities: Capability[]): string {
  const lines = capabilities
    .filter((capability) => capability.status === "available")
    .map((capability) => `- ${capability.name} (${capability.type}): ${capability.description}`);
  return lines.length > 0 ? lines.join("\n") : "(none registered)";
}

export function formatAvailableGoalCapabilities(
  capabilities: Capability[],
  adapterCapabilities: string[]
): string {
  const registryLines = capabilities
    .filter((capability) => capability.status === "available")
    .map((capability) => `- ${capability.name} (${capability.type}): ${capability.description}`);
  const adapterLines = adapterCapabilities.map((capability) => `- ${capability} (adapter-declared)`);
  const allLines = [...registryLines, ...adapterLines];
  return allLines.length > 0 ? allLines.join("\n") : "(none registered)";
}

export function buildDeficiencyPrompt(task: Task, availableCapabilities: string): { systemPrompt: string; userMessage: string } {
  return {
    systemPrompt:
      "You are a capability analyzer for an AI orchestration system. " +
      "Your job is to determine whether a given task can be executed with the available capabilities. " +
      "Respond with valid JSON only — no markdown, no explanation outside the JSON.",
    userMessage:
      `Analyze the following task and determine if any required capabilities are missing.\n\n` +
      `Task description: ${task.work_description}\n` +
      `Task rationale: ${task.rationale}\n` +
      `Task approach: ${task.approach}\n\n` +
      `Available capabilities:\n${availableCapabilities}\n\n` +
      `Respond with JSON in one of these two formats:\n` +
      `If all capabilities are available:\n` +
      `{ "has_deficiency": false }\n\n` +
      `If a capability is missing:\n` +
      `{\n` +
      `  "has_deficiency": true,\n` +
      `  "missing_capability": { "name": "<name>", "type": "tool|permission|service" },\n` +
      `  "reason": "<why this capability is needed>",\n` +
      `  "alternatives": ["<alternative approach 1>", "<alternative approach 2>"],\n` +
      `  "impact_description": "<impact if capability remains unavailable>"\n` +
      `}`,
  };
}

export function buildGoalGapPrompt(goalDescription: string, availableCapabilities: string): { systemPrompt: string; userMessage: string } {
  return {
    systemPrompt:
      "You are a capability analyzer for an AI orchestration system. " +
      "Your job is to determine whether a given goal can be achieved with the available capabilities. " +
      "Respond with valid JSON only — no markdown, no explanation outside the JSON.",
    userMessage:
      `Analyze the following goal and determine if any required capabilities are missing.\n\n` +
      `Goal description: ${goalDescription}\n\n` +
      `Available capabilities (from capability registry and declared adapter capabilities):\n${availableCapabilities}\n\n` +
      `Respond with JSON in one of these two formats:\n` +
      `If all capabilities are available:\n` +
      `{ "has_gap": false }\n\n` +
      `If a capability is missing:\n` +
      `{\n` +
      `  "has_gap": true,\n` +
      `  "missing_capability": { "name": "<name>", "type": "tool|permission|service|data_source" },\n` +
      `  "reason": "<why this capability is needed>",\n` +
      `  "alternatives": ["<alternative approach 1>", "<alternative approach 2>"],\n` +
      `  "impact_description": "<impact if capability remains unavailable>",\n` +
      `  "acquirable": true|false\n` +
      `}`,
  };
}

export function buildVerificationPrompt(
  capability: Capability,
  acquisitionTask: CapabilityAcquisitionTask,
  agentResult: AgentResult
): { systemPrompt: string; userMessage: string } {
  return {
    systemPrompt:
      "You are a capability verifier for an AI orchestration system. " +
      "Your job is to assess whether a newly acquired capability is ready for use. " +
      "Respond with valid JSON only — no markdown, no explanation outside the JSON.",
    userMessage:
      `Verify the following acquired capability.\n\n` +
      `Capability name: ${capability.name}\n` +
      `Capability type: ${capability.type}\n` +
      `Capability description: ${capability.description}\n\n` +
      `Acquisition task: ${acquisitionTask.task_description}\n` +
      `Success criteria: ${acquisitionTask.success_criteria.join("; ")}\n\n` +
      `Agent result output:\n${agentResult.output}\n\n` +
      `Evaluate the following three criteria:\n` +
      `1. Basic operation — does the capability work as described?\n` +
      `2. Error handling — does it handle edge cases gracefully?\n` +
      `3. Scope boundary — does it only do what is intended and nothing more?\n\n` +
      `Respond with JSON in this format:\n` +
      `{ "verdict": "pass" | "fail", "reason": "<explanation>" }`,
  };
}
