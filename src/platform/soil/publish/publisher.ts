import {
  getSoilPublishStatePath,
  loadSoilPublishConfig,
  loadSoilPublishState,
  resolveSoilPublishRoot,
  saveSoilPublishState,
  type SoilPublishConfigInput,
} from "./config.js";
import { publishAppleNotesSnapshot, type AppleNotesRunner } from "./apple-notes.js";
import { publishNotionSnapshot, type NotionPublishClient } from "./notion.js";
import { collectSoilSnapshotFiles, filterAppleNotesSnapshotFiles } from "./snapshot.js";
import { prepareSoilDisplaySnapshot } from "../display/index.js";
import {
  SoilPublishProviderSchema,
  type SoilPublishProvider,
  type SoilPublishProviderResult,
  type SoilPublishResult,
} from "./types.js";

function providerStatus(pages: Array<{ status: string }>): SoilPublishProviderResult["status"] {
  if (pages.length === 0 || pages.every((page) => page.status === "skipped")) {
    return "skipped";
  }
  if (pages.some((page) => page.status === "error")) {
    return "error";
  }
  return "ok";
}

export async function publishSoilSnapshots(input: SoilPublishConfigInput & {
  provider?: SoilPublishProvider;
  dryRun?: boolean;
  notionClient?: NotionPublishClient;
  appleNotesRunner?: AppleNotesRunner;
  appleNotesPlatform?: NodeJS.Platform;
  clock?: () => Date;
} = {}): Promise<SoilPublishResult> {
  const provider = SoilPublishProviderSchema.parse(input.provider ?? "all");
  const rootDir = resolveSoilPublishRoot(input);
  const config = await loadSoilPublishConfig({ rootDir });
  const state = await loadSoilPublishState(rootDir);
  await prepareSoilDisplaySnapshot({ rootDir, indexPath: input.indexPath, clock: input.clock });
  const files = await collectSoilSnapshotFiles(rootDir);
  const providers: SoilPublishProviderResult[] = [];

  if (provider === "all" || provider === "notion") {
    const pages = await publishNotionSnapshot({
      config,
      files,
      state,
      dryRun: input.dryRun,
      client: input.notionClient,
      clock: input.clock,
    });
    providers.push({ provider: "notion", status: providerStatus(pages), pages });
  }

  if (provider === "all" || provider === "apple_notes") {
    const pages = await publishAppleNotesSnapshot({
      config,
      files: filterAppleNotesSnapshotFiles(files),
      state,
      dryRun: input.dryRun,
      runner: input.appleNotesRunner,
      platform: input.appleNotesPlatform,
      clock: input.clock,
    });
    providers.push({ provider: "apple_notes", status: providerStatus(pages), pages });
  }

  if (!input.dryRun) {
    await saveSoilPublishState(rootDir, state);
  }

  return {
    rootDir,
    dryRun: input.dryRun ?? false,
    providers,
    statePath: getSoilPublishStatePath(rootDir),
  };
}
