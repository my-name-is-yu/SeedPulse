import type { GroundingBundle } from "../contracts.js";

export function renderDebugBundle(bundle: GroundingBundle): Record<string, unknown> {
  return {
    profile: bundle.profile,
    warnings: bundle.warnings,
    metrics: bundle.metrics,
    traces: bundle.traces,
    staticSections: bundle.staticSections,
    dynamicSections: bundle.dynamicSections,
  };
}
