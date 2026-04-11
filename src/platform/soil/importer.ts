import * as path from "node:path";
import { z } from "zod";
import { computeSoilChecksum } from "./checksum.js";
import { createSoilConfig, type SoilConfigInput } from "./config.js";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../../base/utils/json-io.js";
import { loadSoilManifest } from "./retriever.js";

const OVERLAY_BEGIN = "<!-- soil:overlay-begin -->";
const OVERLAY_END = "<!-- soil:overlay-end -->";
const OVERLAY_QUEUE_FILE = "overlay-queue.json";

export const SoilOverlayStatusSchema = z.enum(["candidate", "approved", "rejected", "superseded"]);
export type SoilOverlayStatus = z.infer<typeof SoilOverlayStatusSchema>;

export const SoilOverlayCandidateSchema = z.object({
  overlay_id: z.string().min(1),
  status: SoilOverlayStatusSchema,
  soil_id: z.string().min(1),
  relative_path: z.string().min(1),
  target_ref: z.string().min(1),
  content: z.string(),
  content_hash: z.string().min(1),
  detected_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  decision_note: z.string().optional(),
});
export type SoilOverlayCandidate = z.infer<typeof SoilOverlayCandidateSchema>;

export const SoilOverlayQueueSchema = z.object({
  version: z.literal("soil-overlay-queue-v1"),
  updated_at: z.string().datetime(),
  overlays: z.array(SoilOverlayCandidateSchema),
});
export type SoilOverlayQueue = z.infer<typeof SoilOverlayQueueSchema>;

export interface SoilImportOptions {
  clock?: () => Date;
}

function nowIso(clock?: () => Date): string {
  return (clock?.() ?? new Date()).toISOString();
}

function overlayQueuePath(rootDir: string): string {
  return path.join(rootDir, ".index", OVERLAY_QUEUE_FILE);
}

function overlayId(relativePath: string, index: number, content: string): string {
  return computeSoilChecksum({ relativePath, index, content }).replace(/^sha256:/, "overlay-");
}

function extractOverlayBlocks(body: string): Array<{ index: number; content: string }> {
  const blocks: Array<{ index: number; content: string }> = [];
  let cursor = 0;
  while (cursor < body.length) {
    const begin = body.indexOf(OVERLAY_BEGIN, cursor);
    if (begin < 0) {
      break;
    }
    const contentStart = begin + OVERLAY_BEGIN.length;
    const end = body.indexOf(OVERLAY_END, contentStart);
    if (end < 0) {
      break;
    }
    const content = body.slice(contentStart, end).trim();
    if (content) {
      blocks.push({ index: blocks.length, content });
    }
    cursor = end + OVERLAY_END.length;
  }
  return blocks;
}

export async function loadSoilOverlayQueue(configInput: SoilConfigInput = {}): Promise<SoilOverlayQueue> {
  const config = createSoilConfig(configInput);
  const raw = await readJsonFileOrNull(overlayQueuePath(config.rootDir));
  const parsed = SoilOverlayQueueSchema.safeParse(raw);
  return parsed.success
    ? parsed.data
    : { version: "soil-overlay-queue-v1", updated_at: new Date(0).toISOString(), overlays: [] };
}

export async function scanSoilOverlays(
  configInput: SoilConfigInput = {},
  options: SoilImportOptions = {}
): Promise<SoilOverlayCandidate[]> {
  const config = createSoilConfig(configInput);
  const detectedAt = nowIso(options.clock);
  const manifest = await loadSoilManifest({ rootDir: config.rootDir, indexPath: config.indexPath });
  const overlays: SoilOverlayCandidate[] = [];
  for (const page of manifest.pages) {
    const blocks = extractOverlayBlocks(page.body);
    for (const block of blocks) {
      const contentHash = computeSoilChecksum(block.content);
      overlays.push(SoilOverlayCandidateSchema.parse({
        overlay_id: overlayId(page.relativePath, block.index, block.content),
        status: "candidate",
        soil_id: page.soilId,
        relative_path: page.relativePath,
        target_ref: `${page.soilId}#overlay-${block.index}`,
        content: block.content,
        content_hash: contentHash,
        detected_at: detectedAt,
        updated_at: detectedAt,
      }));
    }
  }
  return overlays;
}

export async function scanAndStoreSoilOverlays(
  configInput: SoilConfigInput = {},
  options: SoilImportOptions = {}
): Promise<SoilOverlayQueue> {
  const config = createSoilConfig(configInput);
  const now = nowIso(options.clock);
  const existing = await loadSoilOverlayQueue(config);
  const existingById = new Map(existing.overlays.map((overlay) => [overlay.overlay_id, overlay]));
  const detected = await scanSoilOverlays(config, options);
  const merged = detected.map((overlay) => {
    const previous = existingById.get(overlay.overlay_id);
    if (!previous) {
      return overlay;
    }
    return SoilOverlayCandidateSchema.parse({
      ...overlay,
      status: previous.status,
      detected_at: previous.detected_at,
      updated_at: previous.updated_at,
      decision_note: previous.decision_note,
    });
  });
  const queue = SoilOverlayQueueSchema.parse({
    version: "soil-overlay-queue-v1",
    updated_at: now,
    overlays: merged,
  });
  await writeJsonFileAtomic(overlayQueuePath(config.rootDir), queue);
  return queue;
}

export async function updateSoilOverlayStatus(
  overlayId: string,
  status: SoilOverlayStatus,
  configInput: SoilConfigInput = {},
  options: SoilImportOptions & { decisionNote?: string } = {}
): Promise<SoilOverlayQueue> {
  const config = createSoilConfig(configInput);
  const queue = await loadSoilOverlayQueue(config);
  const now = nowIso(options.clock);
  let found = false;
  const overlays = queue.overlays.map((overlay) => {
    if (overlay.overlay_id !== overlayId) {
      return overlay;
    }
    found = true;
    return SoilOverlayCandidateSchema.parse({
      ...overlay,
      status,
      updated_at: now,
      decision_note: options.decisionNote ?? overlay.decision_note,
    });
  });
  if (!found) {
    throw new Error(`Soil overlay not found: ${overlayId}`);
  }
  const next = SoilOverlayQueueSchema.parse({
    version: "soil-overlay-queue-v1",
    updated_at: now,
    overlays,
  });
  await writeJsonFileAtomic(overlayQueuePath(config.rootDir), next);
  return next;
}
