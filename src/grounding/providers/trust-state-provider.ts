import type { GroundingProvider } from "../contracts.js";
import { makeSection, makeSource } from "./helpers.js";

interface TrustStore {
  balances?: Record<string, { balance: number }>;
}

export const trustStateProvider: GroundingProvider = {
  key: "trust_state",
  kind: "dynamic",
  async build(context) {
    const stateManager = context.deps.stateManager;
    if (!stateManager || typeof (stateManager as { readRaw?: unknown }).readRaw !== "function") {
      return null;
    }
    const raw = await stateManager.readRaw("trust/trust-store.json") as TrustStore | null;
    const balances = raw?.balances ?? {};
    const entries = Object.entries(balances)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([domain, value]) => `- ${domain}: balance=${value.balance}`);

    return makeSection(
      "trust_state",
      entries.length > 0 ? entries.join("\n") : "No adapter trust state recorded.",
      [
        makeSource("trust_state", "trust/trust-store.json", {
          type: entries.length > 0 ? "state" : "none",
          trusted: true,
          accepted: true,
          retrievalId: entries.length > 0 ? "trust:all" : "none:trust_state",
        }),
      ],
    );
  },
};
