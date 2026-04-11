import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { computeSoilChecksum } from "../checksum.js";
import type { SoilSnapshotFile } from "./types.js";

const HIDDEN_DIRS = new Set([".index", ".publish", ".stale"]);

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

async function walk(rootDir: string, dir: string, files: SoilSnapshotFile[]): Promise<void> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".") || HIDDEN_DIRS.has(entry.name)) {
      continue;
    }
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(rootDir, absolutePath, files);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const content = await fsp.readFile(absolutePath, "utf-8");
    files.push({
      relativePath: toPosix(path.relative(rootDir, absolutePath)),
      absolutePath,
      content,
      sourceHash: computeSoilChecksum(content),
    });
  }
}

export async function collectSoilSnapshotFiles(rootDir: string): Promise<SoilSnapshotFile[]> {
  const files: SoilSnapshotFile[] = [];
  await walk(rootDir, rootDir, files);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function filterAppleNotesSnapshotFiles(files: SoilSnapshotFile[]): SoilSnapshotFile[] {
  const allowed = new Set(["status.md", "schedule/active.md"]);
  return files.filter((file) => allowed.has(file.relativePath));
}
