import * as os from "node:os";
import * as path from "node:path";
import { getPulseedDirPath } from "../../base/utils/paths.js";

export interface SoilConfig {
  rootDir: string;
  indexPath: string;
}

export interface SoilConfigInput {
  rootDir?: string;
  indexPath?: string;
}

export function getDefaultSoilRootDir(baseDir?: string): string {
  return path.join(baseDir ?? getPulseedDirPath(), "soil");
}

export function getDefaultSoilIndexPath(rootDir?: string): string {
  return path.join(rootDir ?? getDefaultSoilRootDir(), ".index", "soil.db");
}

export function resolveSoilRootDir(rootDir?: string): string {
  if (!rootDir) {
    return getDefaultSoilRootDir();
  }
  return path.resolve(rootDir);
}

export function createSoilConfig(input: SoilConfigInput = {}): SoilConfig {
  const rootDir = resolveSoilRootDir(input.rootDir);
  const indexPath = input.indexPath ? path.resolve(input.indexPath) : getDefaultSoilIndexPath(rootDir);
  return { rootDir, indexPath };
}

export function getDefaultSoilHomeDir(): string {
  return getPulseedDirPath();
}

export function getDefaultSoilRootFromHome(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), ".pulseed", "soil");
}
