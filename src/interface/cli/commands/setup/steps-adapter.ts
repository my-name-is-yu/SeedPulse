import * as p from "@clack/prompts";
import { RECOMMENDED_ADAPTERS, getAdaptersForModel } from "../setup-shared.js";
import type { Provider } from "../setup-shared.js";
import { guardCancel } from "./utils.js";

const ADAPTER_LABELS: Record<string, string> = {
  agent_loop: "Native agent loop",
  openai_codex_cli: "OpenAI Codex CLI",
  openai_api: "OpenAI API",
  claude_code_cli: "Claude Code CLI",
  claude_api: "Anthropic API",
};

const ADAPTER_HINTS: Record<string, string> = {
  agent_loop: "built-in task runner",
  openai_codex_cli: "uses Codex CLI/OAuth",
  openai_api: "direct API calls",
  claude_code_cli: "uses Claude Code",
  claude_api: "direct API calls",
};

export async function stepAdapter(
  model: string,
  provider: Provider,
  initialAdapter?: string
): Promise<string> {
  const adapters = getAdaptersForModel(model, provider);
  const recommendedAdapter = RECOMMENDED_ADAPTERS[provider];

  if (adapters.length === 0) {
    p.log.error(`No compatible adapters found for model "${model}".`);
    return "";
  }

  if (adapters.length <= 1) {
    const adapter = adapters[0];
    p.log.info(`Execution adapter: ${ADAPTER_LABELS[adapter] ?? adapter} (auto-selected)`);
    return adapter;
  }

  const options = adapters.map((adapter) => ({
    value: adapter,
    label: ADAPTER_LABELS[adapter] ?? adapter,
    hint: [
      adapter === recommendedAdapter ? "recommended" : undefined,
      adapter === initialAdapter ? "current" : undefined,
      ADAPTER_HINTS[adapter],
    ].filter(Boolean).join(", ") || undefined,
  }));

  const initialValue =
    initialAdapter && adapters.includes(initialAdapter)
      ? initialAdapter
      : adapters.includes(recommendedAdapter ?? "")
        ? recommendedAdapter
        : adapters[0];

  const adapter = guardCancel(
    await p.select({
      message: `Select execution adapter for ${model}:`,
      options,
      initialValue,
    })
  );
  return adapter;
}
