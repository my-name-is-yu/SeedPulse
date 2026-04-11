import { execFileNoThrow, type ExecFileResult } from "../../../base/utils/execFileNoThrow.js";
import type { SoilPublishConfig, SoilPublishPageResult, SoilPublishState, SoilSnapshotFile } from "./types.js";

export type AppleNotesRunner = (command: string, args: string[], options?: { timeoutMs?: number }) => Promise<ExecFileResult>;

export async function publishAppleNotesSnapshot(input: {
  config: SoilPublishConfig;
  files: SoilSnapshotFile[];
  state: SoilPublishState;
  dryRun?: boolean;
  runner?: AppleNotesRunner;
  platform?: NodeJS.Platform;
  clock?: () => Date;
}): Promise<SoilPublishPageResult[]> {
  const config = input.config.apple_notes;
  if (!config?.enabled) {
    return [{ provider: "apple_notes", relativePath: "", status: "skipped", message: "Apple Notes publish is disabled" }];
  }
  if ((input.platform ?? process.platform) !== "darwin") {
    return [{ provider: "apple_notes", relativePath: "", status: "skipped", message: "Apple Notes publish requires macOS" }];
  }
  if (!config.shortcutName) {
    return [{ provider: "apple_notes", relativePath: "", status: "skipped", message: "Apple Notes shortcutName is required" }];
  }

  const runner = input.runner ?? execFileNoThrow;
  const results: SoilPublishPageResult[] = [];
  for (const file of input.files) {
    const existing = input.state.apple_notes.pages[file.relativePath];
    if (existing?.source_hash === file.sourceHash) {
      results.push({
        provider: "apple_notes",
        relativePath: file.relativePath,
        status: "skipped",
        sourceHash: file.sourceHash,
        message: "source hash unchanged",
      });
      continue;
    }
    if (input.dryRun) {
      results.push({ provider: "apple_notes", relativePath: file.relativePath, status: "dry_run", sourceHash: file.sourceHash });
      continue;
    }

    const args = ["run", config.shortcutName, "--input-path", file.absolutePath];
    const result = await runner("shortcuts", args, { timeoutMs: 30_000 });
    if (result.exitCode === 0) {
      input.state.apple_notes.pages[file.relativePath] = {
        source_hash: file.sourceHash,
        published_at: (input.clock?.() ?? new Date()).toISOString(),
      };
      results.push({
        provider: "apple_notes",
        relativePath: file.relativePath,
        status: "published",
        sourceHash: file.sourceHash,
        destinationId: config.folderName,
      });
    } else {
      results.push({
        provider: "apple_notes",
        relativePath: file.relativePath,
        status: "error",
        sourceHash: file.sourceHash,
        message: result.stderr || `shortcuts exited with ${result.exitCode}`,
      });
    }
  }
  return results;
}
