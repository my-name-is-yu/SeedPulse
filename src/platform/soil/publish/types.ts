import { z } from "zod";

export const SoilPublishProviderSchema = z.enum(["notion", "apple_notes", "all"]);
export type SoilPublishProvider = z.infer<typeof SoilPublishProviderSchema>;

export const SoilPublishConfigSchema = z.object({
  notion: z.object({
    enabled: z.boolean().default(false),
    token: z.string().min(1).optional(),
    parentPageId: z.string().min(1).optional(),
    titlePrefix: z.string().default("Soil"),
  }).optional(),
  apple_notes: z.object({
    enabled: z.boolean().default(false),
    shortcutName: z.string().min(1).optional(),
    folderName: z.string().min(1).optional(),
  }).optional(),
});
export type SoilPublishConfig = z.infer<typeof SoilPublishConfigSchema>;

export const SoilPublishStateSchema = z.object({
  version: z.literal("soil-publish-state-v1").default("soil-publish-state-v1"),
  notion: z.object({
    pages: z.record(z.object({
      notion_page_id: z.string(),
      source_hash: z.string(),
      published_at: z.string(),
    })).default({}),
  }).default({ pages: {} }),
  apple_notes: z.object({
    pages: z.record(z.object({
      source_hash: z.string(),
      published_at: z.string(),
    })).default({}),
  }).default({ pages: {} }),
});
export type SoilPublishState = z.infer<typeof SoilPublishStateSchema>;

export interface SoilSnapshotFile {
  relativePath: string;
  absolutePath: string;
  content: string;
  sourceHash: string;
}

export interface SoilPublishPageResult {
  provider: Exclude<SoilPublishProvider, "all">;
  relativePath: string;
  status: "published" | "archived" | "skipped" | "dry_run" | "error";
  sourceHash?: string;
  destinationId?: string;
  message?: string;
}

export interface SoilPublishProviderResult {
  provider: Exclude<SoilPublishProvider, "all">;
  status: "ok" | "skipped" | "error";
  pages: SoilPublishPageResult[];
  message?: string;
}

export interface SoilPublishResult {
  rootDir: string;
  dryRun: boolean;
  providers: SoilPublishProviderResult[];
  statePath: string;
}
