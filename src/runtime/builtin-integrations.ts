import type { BuiltinIntegrationDescriptor } from "./types/builtin-integration.js";

export const BUILTIN_INTEGRATIONS: BuiltinIntegrationDescriptor[] = [
  {
    id: "soil-display",
    kind: "display",
    title: "Soil Display Bridge",
    description: "Materializes typed Soil content into publishable Markdown snapshots.",
    source: "builtin",
    status: "available",
    capabilities: [
      "soil_projection_materialize",
      "obsidian_markdown_bridge",
      "notion_snapshot_publish",
    ],
  },
  {
    id: "mcp-bridge",
    kind: "bridge",
    title: "MCP Bridge",
    description: "Imports MCP servers and keeps them disabled until reviewed.",
    source: "builtin",
    status: "available",
    capabilities: [
      "mcp_server_import",
      "disabled_registration",
      "stdio_transport_bridge",
    ],
  },
  {
    id: "foreign-plugin-bridge",
    kind: "bridge",
    title: "Foreign Plugin Bridge",
    description: "Classifies Hermes and OpenClaw plugins before they are copied into quarantine.",
    source: "builtin",
    status: "available",
    capabilities: [
      "foreign_manifest_analysis",
      "compatibility_report",
      "quarantined_copy",
    ],
  },
];

export function listBuiltinIntegrations(): BuiltinIntegrationDescriptor[] {
  return [...BUILTIN_INTEGRATIONS];
}
