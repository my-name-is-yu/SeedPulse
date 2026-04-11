import * as path from "node:path";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../../../base/utils/json-io.js";
import { createSoilConfig, type SoilConfigInput } from "../config.js";
import {
  SoilPublishConfigSchema,
  SoilPublishStateSchema,
  type SoilPublishConfig,
  type SoilPublishState,
} from "./types.js";

export interface SoilPublishConfigInput extends SoilConfigInput {
  baseDir?: string;
}

export function resolveSoilPublishRoot(input: SoilPublishConfigInput = {}): string {
  if (input.rootDir) {
    return createSoilConfig({ rootDir: input.rootDir }).rootDir;
  }
  if (input.baseDir) {
    return path.join(input.baseDir, "soil");
  }
  return createSoilConfig({}).rootDir;
}

export function getSoilPublishConfigPath(rootDir: string): string {
  return path.join(rootDir, "publish.json");
}

export function getSoilPublishStatePath(rootDir: string): string {
  return path.join(rootDir, ".publish", "state.json");
}

export async function loadSoilPublishConfig(input: SoilPublishConfigInput = {}): Promise<SoilPublishConfig> {
  const rootDir = resolveSoilPublishRoot(input);
  const raw = await readJsonFileOrNull(getSoilPublishConfigPath(rootDir));
  const parsed = SoilPublishConfigSchema.safeParse(raw ?? {});
  const config = parsed.success ? parsed.data : SoilPublishConfigSchema.parse({});
  if (process.env.NOTION_TOKEN) {
    return SoilPublishConfigSchema.parse({
      ...config,
      notion: {
        enabled: config.notion?.enabled ?? false,
        titlePrefix: config.notion?.titlePrefix ?? "Soil",
        parentPageId: config.notion?.parentPageId,
        token: process.env.NOTION_TOKEN,
      },
    });
  }
  return config;
}

export async function loadSoilPublishState(rootDir: string): Promise<SoilPublishState> {
  const raw = await readJsonFileOrNull(getSoilPublishStatePath(rootDir));
  const parsed = SoilPublishStateSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : SoilPublishStateSchema.parse({});
}

export async function saveSoilPublishState(rootDir: string, state: SoilPublishState): Promise<void> {
  await writeJsonFileAtomic(getSoilPublishStatePath(rootDir), SoilPublishStateSchema.parse(state));
}

export function configuredSoilPublishProviders(config: SoilPublishConfig): Array<"notion" | "apple_notes"> {
  const providers: Array<"notion" | "apple_notes"> = [];
  if (config.notion?.enabled && config.notion.token && config.notion.parentPageId) {
    providers.push("notion");
  }
  if (config.apple_notes?.enabled && config.apple_notes.shortcutName && process.platform === "darwin") {
    providers.push("apple_notes");
  }
  return providers;
}

export async function hasConfiguredSoilPublishProvider(input: SoilPublishConfigInput = {}): Promise<boolean> {
  return configuredSoilPublishProviders(await loadSoilPublishConfig(input)).length > 0;
}
