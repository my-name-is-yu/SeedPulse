// ─── Global Config ───
//
// Manages ~/.pulseed/config.json — single source for all PulSeed user preferences.

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const GlobalConfigSchema = z.object({
  daemon_mode: z.boolean().default(false),
  no_flicker: z.boolean().default(true),
});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

const DEFAULT_CONFIG: GlobalConfig = {
  daemon_mode: false,
  no_flicker: true,
};

function getConfigPath(): string {
  const baseDir = process.env.PULSEED_HOME ?? path.join(process.env.HOME ?? "~", ".pulseed");
  return path.join(baseDir, "config.json");
}

export async function loadGlobalConfig(): Promise<GlobalConfig> {
  try {
    const raw = await fs.readFile(getConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return GlobalConfigSchema.parse({ ...DEFAULT_CONFIG, ...parsed });
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
  const configPath = getConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
}

export async function updateGlobalConfig(updates: Partial<GlobalConfig>): Promise<GlobalConfig> {
  const current = await loadGlobalConfig();
  const updated = GlobalConfigSchema.parse({ ...current, ...updates });
  await saveGlobalConfig(updated);
  return updated;
}

export function getConfigKeys(): string[] {
  return Object.keys(DEFAULT_CONFIG);
}

export { GlobalConfigSchema, DEFAULT_CONFIG };
