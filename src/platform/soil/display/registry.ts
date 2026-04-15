import type { SoilDisplayIntegration } from "./types.js";
import { prepareSoilDisplaySnapshot } from "./materialize.js";

const BUILTIN_SOIL_DISPLAY_INTEGRATION: SoilDisplayIntegration = {
  id: "soil-display",
  title: "Soil display integration",
  source: "builtin",
  capabilities: [
    "materialize_typed_pages",
    "fallback_project_active_records",
    "publishable_markdown_snapshot",
  ],
  prepare: prepareSoilDisplaySnapshot,
};

export function listBuiltinSoilDisplayIntegrations(): SoilDisplayIntegration[] {
  return [BUILTIN_SOIL_DISPLAY_INTEGRATION];
}

export function getBuiltinSoilDisplayIntegration(id: string): SoilDisplayIntegration | null {
  return listBuiltinSoilDisplayIntegrations().find((integration) => integration.id === id) ?? null;
}
