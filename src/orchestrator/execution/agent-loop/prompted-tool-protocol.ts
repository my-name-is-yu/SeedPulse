import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "../../../base/llm/llm-client.js";
import { extractJSON } from "../../../base/llm/base-llm-client.js";
import { sanitizeLLMJson } from "../../../base/llm/json-sanitizer.js";

export interface PromptedToolCall {
  id: string;
  name: string;
  input: unknown;
}

export function buildPromptedToolProtocolSystemPrompt(input: {
  systemPrompt?: string;
  tools: ToolDefinition[];
}): string {
  const toolDefinitions = input.tools.length > 0
    ? input.tools.map((tool) => [
        `- ${tool.function.name}: ${tool.function.description}`,
        `  input schema: ${JSON.stringify(tool.function.parameters)}`,
      ].join("\n")).join("\n")
    : "- No tools are available.";

  return [
    input.systemPrompt?.trim() ?? "",
    "You do not have native function/tool calling in this turn.",
    "If you need to call tools, return exactly one JSON object and nothing else.",
    'For one tool, use { "tool": "<name>", "input": { ... } } or { "tool_call": { "name": "<name>", "input": { ... } } }.',
    'For multiple tools, use { "tool_calls": [{ "name": "<name>", "input": { ... } }] }.',
    "When you need repository context, inspect the narrowest likely files first; avoid repo-wide glob or grep sweeps unless they are truly necessary.",
    "Only use tool names listed below.",
    "Available tools:",
    toolDefinitions,
  ].filter((part) => part.trim().length > 0).join("\n\n");
}

export function extractPromptedToolCalls(input: {
  content: string;
  tools: ToolDefinition[];
  createId?: () => string;
}): PromptedToolCall[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sanitizeLLMJson(extractJSON(input.content))) as unknown;
  } catch {
    return [];
  }

  return normalizePromptedToolCalls(parsed, input.createId ?? randomUUID);
}

function normalizePromptedToolCalls(
  value: unknown,
  createId: () => string,
): PromptedToolCall[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizePromptedToolCall(item, createId, true));
  }

  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;

  if (Array.isArray(record["tool_calls"])) {
    return record["tool_calls"].flatMap((item) => normalizePromptedToolCall(item, createId, true));
  }

  if (record["tool_call"] && typeof record["tool_call"] === "object") {
    return normalizePromptedToolCall(record["tool_call"], createId, true);
  }

  return normalizePromptedToolCall(record, createId, false);
}

function normalizePromptedToolCall(
  value: unknown,
  createId: () => string,
  allowNameField: boolean,
): PromptedToolCall[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const name = typeof record["tool"] === "string"
    ? record["tool"]
    : allowNameField && typeof record["name"] === "string"
      ? record["name"]
      : null;
  if (!name) return [];

  return [{
    id: createId(),
    name,
    input: normalizePromptedInput(record["input"] ?? record["arguments"] ?? {}),
  }];
}

function normalizePromptedInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(sanitizeLLMJson(extractJSON(value))) as unknown;
  } catch {
    return value;
  }
}
