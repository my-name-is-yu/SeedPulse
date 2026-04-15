import type { SoilConfigInput } from "../config.js";

export type SoilDisplayIntegrationSource = "builtin";

export interface SoilDisplaySnapshotInput extends SoilConfigInput {
  clock?: () => Date;
}

export interface SoilDisplayMaterializedPage {
  pageId: string;
  soilId: string;
  relativePath: string;
  source: "typed_page" | "fallback_record";
  recordIds: string[];
  filePath: string;
}

export interface SoilDisplaySnapshotResult {
  rootDir: string;
  indexPath: string;
  typedPageCount: number;
  fallbackPageCount: number;
  materializedPages: SoilDisplayMaterializedPage[];
}

export interface SoilDisplayIntegration {
  id: string;
  title: string;
  source: SoilDisplayIntegrationSource;
  capabilities: string[];
  prepare(input: SoilDisplaySnapshotInput): Promise<SoilDisplaySnapshotResult>;
}
