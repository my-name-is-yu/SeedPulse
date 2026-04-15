export type BuiltinIntegrationId = "soil-display" | "mcp-bridge" | "foreign-plugin-bridge";

export type BuiltinIntegrationKind = "display" | "bridge";

export type BuiltinIntegrationStatus = "available" | "disabled";

export interface BuiltinIntegrationDescriptor {
  id: BuiltinIntegrationId;
  kind: BuiltinIntegrationKind;
  title: string;
  description: string;
  source: "builtin";
  status: BuiltinIntegrationStatus;
  capabilities: string[];
}
