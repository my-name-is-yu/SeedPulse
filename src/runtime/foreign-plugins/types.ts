export type ForeignPluginSource = "hermes";

export type ForeignPluginCompatibilityStatus = "convertible" | "quarantined" | "incompatible";

export interface ForeignPluginPermissions {
  network: boolean;
  file_read: boolean;
  file_write: boolean;
  shell: boolean;
}

export interface ForeignPluginManifestSummary {
  name: string;
  version: string;
  type: string;
  capabilities: string[];
  description: string;
  entry_point: string;
}

export interface ForeignPluginCompatibilityReport {
  source: ForeignPluginSource;
  status: ForeignPluginCompatibilityStatus;
  issues: string[];
  permissions: ForeignPluginPermissions;
  manifestPath?: string;
  manifest?: ForeignPluginManifestSummary;
}
