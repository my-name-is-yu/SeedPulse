import * as path from "node:path";
import type { GroundingProvider } from "../contracts.js";
import { makeSection, makeSource, readJsonFile, resolveHomeDir } from "./helpers.js";

function summarizeProviderState(raw: Record<string, unknown> | null): string {
  if (!raw) {
    return "not configured";
  }
  const llm = typeof raw["llm"] === "string" ? raw["llm"] : null;
  const adapter = typeof raw["default_adapter"] === "string" ? raw["default_adapter"] : null;
  if (llm && adapter) return `${llm} / ${adapter}`;
  if (llm) return llm;
  return "not configured";
}

export const providerStateProvider: GroundingProvider = {
  key: "provider_state",
  kind: "dynamic",
  async build(context) {
    const homeDir = resolveHomeDir(context.request.homeDir ?? context.deps.stateManager?.getBaseDir?.());
    const providerPath = path.join(homeDir, "provider.json");
    const raw = await readJsonFile(providerPath);
    return makeSection("provider_state", summarizeProviderState(raw), [
      makeSource("provider_state", "provider.json", {
        type: raw ? "file" : "none",
        path: providerPath,
        trusted: true,
        accepted: true,
      }),
    ], { title: "Provider" });
  },
};
