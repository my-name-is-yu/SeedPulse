import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { splitSoilFrontmatter } from "./frontmatter.js";
import { SoilPageFrontmatterSchema, type SoilPageFrontmatter } from "./types.js";
import {
  createSoilConfig,
  type SoilConfig,
  type SoilConfigInput,
} from "./config.js";
import {
  normalizeSoilId,
  normalizeSoilRelativePath,
  relativePathToSoilId,
  soilIdToRelativePath,
  soilPageRelativePathFromAbsolute,
} from "./paths.js";

export interface SoilPageRecord {
  soilId: string;
  relativePath: string;
  absolutePath: string;
  frontmatter: SoilPageFrontmatter;
  body: string;
  content: string;
  metadataText: string;
  searchText: string;
}

export interface SoilQueryHit {
  soilId: string;
  relativePath: string;
  absolutePath: string;
  score: number;
  frontmatter: SoilPageFrontmatter;
  snippet: string;
}

export interface SoilScanStats {
  rootDir: string;
  scannedDirs: number;
  matchedFiles: number;
  maxFiles: number;
  maxDepth: number;
  deadlineMs: number;
  truncated: boolean;
  reason?: "max_files" | "max_depth" | "deadline";
}

export interface SoilScanOptions {
  maxFiles?: number;
  maxDepth?: number;
  deadlineMs?: number;
  ignoredDirectoryNames?: readonly string[];
}

export interface SoilPageStore {
  listMarkdownFiles(rootDir: string): Promise<string[]>;
  readMarkdownFile(filePath: string): Promise<string>;
  getLastScanStats?(): SoilScanStats | null;
}

const DEFAULT_SOIL_SCAN_OPTIONS = {
  maxFiles: 500,
  maxDepth: 8,
  deadlineMs: 5_000,
  ignoredDirectoryNames: [
    "node_modules",
    "dist",
    "build",
    "coverage",
    "tmp",
    "temp",
    "vendor",
    "Library",
    "Applications",
    "Downloads",
    "Movies",
    "Music",
    "Pictures",
  ],
} satisfies Required<SoilScanOptions>;

export class FileSoilPageStore implements SoilPageStore {
  private readonly options: Required<SoilScanOptions>;
  private lastScanStats: SoilScanStats | null = null;

  constructor(options: SoilScanOptions = {}) {
    this.options = {
      maxFiles: options.maxFiles ?? DEFAULT_SOIL_SCAN_OPTIONS.maxFiles,
      maxDepth: options.maxDepth ?? DEFAULT_SOIL_SCAN_OPTIONS.maxDepth,
      deadlineMs: options.deadlineMs ?? DEFAULT_SOIL_SCAN_OPTIONS.deadlineMs,
      ignoredDirectoryNames: options.ignoredDirectoryNames ?? DEFAULT_SOIL_SCAN_OPTIONS.ignoredDirectoryNames,
    };
  }

  async listMarkdownFiles(rootDir: string): Promise<string[]> {
    const files: string[] = [];
    const resolvedRoot = path.resolve(rootDir);
    const startedAt = Date.now();
    this.lastScanStats = {
      rootDir: resolvedRoot,
      scannedDirs: 0,
      matchedFiles: 0,
      maxFiles: this.options.maxFiles,
      maxDepth: this.options.maxDepth,
      deadlineMs: this.options.deadlineMs,
      truncated: false,
    };
    await this.walk(resolvedRoot, files, 0, startedAt + this.options.deadlineMs);
    if (this.lastScanStats) {
      this.lastScanStats.matchedFiles = files.length;
    }
    return files;
  }

  async readMarkdownFile(filePath: string): Promise<string> {
    return fsp.readFile(filePath, "utf-8");
  }

  getLastScanStats(): SoilScanStats | null {
    return this.lastScanStats;
  }

  private async walk(dir: string, files: string[], depth: number, deadlineAt: number): Promise<void> {
    if (this.shouldStop(files, deadlineAt)) {
      return;
    }
    if (depth > this.options.maxDepth) {
      this.markTruncated("max_depth");
      return;
    }
    this.lastScanStats!.scannedDirs += 1;
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (this.shouldStop(files, deadlineAt)) {
        return;
      }
      if (entry.name.startsWith(".") || this.options.ignoredDirectoryNames.includes(entry.name)) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(fullPath, files, depth + 1, deadlineAt);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
        if (files.length >= this.options.maxFiles) {
          this.markTruncated("max_files");
          return;
        }
      }
    }
  }

  private shouldStop(files: string[], deadlineAt: number): boolean {
    if (files.length >= this.options.maxFiles) {
      this.markTruncated("max_files");
      return true;
    }
    if (Date.now() >= deadlineAt) {
      this.markTruncated("deadline");
      return true;
    }
    return false;
  }

  private markTruncated(reason: SoilScanStats["reason"]): void {
    if (!this.lastScanStats) {
      return;
    }
    if (!this.lastScanStats.truncated) {
      this.lastScanStats = {
        ...this.lastScanStats,
        truncated: true,
        ...(reason ? { reason } : {}),
      };
    }
  }
}

export interface SoilManifest {
  rootDir: string;
  pages: SoilPageRecord[];
  bySoilId: Map<string, SoilPageRecord[]>;
  byRelativePath: Map<string, SoilPageRecord>;
  scan?: SoilScanStats;
}

export async function loadSoilManifest(
  configInput: SoilConfigInput = {},
  store: SoilPageStore = new FileSoilPageStore()
): Promise<SoilManifest> {
  const config = createSoilConfig(configInput);
  const pages: SoilPageRecord[] = [];
  const bySoilId = new Map<string, SoilPageRecord[]>();
  const byRelativePath = new Map<string, SoilPageRecord>();
  const files = await store.listMarkdownFiles(config.rootDir);

  for (const filePath of files) {
    const content = await store.readMarkdownFile(filePath).catch(() => null);
    if (content === null) {
      continue;
    }
    const split = splitSoilFrontmatter(content);
    if (!split.hasFrontmatter) {
      continue;
    }
    const parsed = SoilPageFrontmatterSchema.safeParse(split.frontmatter);
    if (!parsed.success) {
      continue;
    }
    const relativePath = soilPageRelativePathFromAbsolute(config.rootDir, filePath);
    let soilId: string;
    try {
      soilId = normalizeSoilId(parsed.data.soil_id);
    } catch {
      continue;
    }
    const record: SoilPageRecord = {
      soilId,
      relativePath,
      absolutePath: filePath,
      frontmatter: parsed.data,
      body: split.body,
      content,
      metadataText: buildMetadataText(parsed.data),
      searchText: buildSearchText(parsed.data, split.body),
    };
    pages.push(record);
    const soilRecords = bySoilId.get(soilId) ?? [];
    soilRecords.push(record);
    bySoilId.set(soilId, soilRecords);
    byRelativePath.set(relativePath, record);
  }

  const scan = store.getLastScanStats?.() ?? undefined;
  return { rootDir: config.rootDir, pages, bySoilId, byRelativePath, ...(scan ? { scan } : {}) };
}

function buildSearchText(frontmatter: SoilPageFrontmatter, body: string): string {
  return [
    frontmatter.title,
    frontmatter.summary,
    frontmatter.domain,
    frontmatter.owner,
    frontmatter.kind,
    frontmatter.route,
    frontmatter.status,
    frontmatter.source,
    frontmatter.soil_id,
    frontmatter.goal_id,
    frontmatter.task_id,
    frontmatter.schedule_id,
    frontmatter.decision_id,
    frontmatter.entry_id,
    JSON.stringify(frontmatter.source_refs),
    JSON.stringify(frontmatter.generation_watermark),
    JSON.stringify(frontmatter.manual_overlay),
    JSON.stringify(frontmatter),
    body,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function buildMetadataText(frontmatter: SoilPageFrontmatter): string {
  return [
    frontmatter.kind,
    frontmatter.status,
    frontmatter.route,
    frontmatter.source,
    frontmatter.version,
    frontmatter.domain,
    frontmatter.owner,
    frontmatter.goal_id,
    frontmatter.task_id,
    frontmatter.schedule_id,
    frontmatter.decision_id,
    frontmatter.entry_id,
    JSON.stringify(frontmatter.source_refs),
    JSON.stringify(frontmatter.generation_watermark),
    JSON.stringify(frontmatter.manual_overlay),
    JSON.stringify({
      import_status: frontmatter.import_status,
      approval_status: frontmatter.approval_status,
      approved_by: frontmatter.approved_by,
      supersedes: frontmatter.supersedes,
      superseded_by: frontmatter.superseded_by,
      source_truth: frontmatter.source_truth,
      rendered_from: frontmatter.rendered_from,
      page_format_version: frontmatter.page_format_version,
    }),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (index >= 0) {
    index = haystack.indexOf(needle, index);
    if (index >= 0) {
      count += 1;
      index += needle.length;
    }
  }
  return count;
}

function scorePage(queryTokens: string[], record: SoilPageRecord): number {
  if (queryTokens.length === 0) {
    return 0;
  }
  let score = 0;
  for (const token of queryTokens) {
    score += countOccurrences(record.frontmatter.title.toLowerCase(), token) * 8;
    score += countOccurrences(record.frontmatter.summary?.toLowerCase() ?? "", token) * 5;
    score += countOccurrences(record.body.toLowerCase(), token) * 2;
    score += countOccurrences(record.metadataText, token);
  }
  return score;
}

function buildSnippet(record: SoilPageRecord, queryTokens: string[]): string {
  const haystack = [
    record.frontmatter.title,
    record.frontmatter.summary,
    record.body,
  ]
    .filter(Boolean)
    .join("\n");
  const lower = haystack.toLowerCase();
  for (const token of queryTokens) {
    const index = lower.indexOf(token);
    if (index >= 0) {
      const start = Math.max(0, index - 60);
      const end = Math.min(haystack.length, index + token.length + 120);
      return haystack.slice(start, end);
    }
  }
  return record.frontmatter.title;
}

export class SoilRetriever {
  private manifest: SoilManifest | null = null;

  constructor(
    private readonly config: SoilConfig,
    private readonly store: SoilPageStore = new FileSoilPageStore()
  ) {}

  static create(configInput: SoilConfigInput = {}, store?: SoilPageStore): SoilRetriever {
    return new SoilRetriever(createSoilConfig(configInput), store);
  }

  async refresh(): Promise<SoilManifest> {
    this.manifest = await loadSoilManifest({ rootDir: this.config.rootDir, indexPath: this.config.indexPath }, this.store);
    return this.manifest;
  }

  async getManifest(): Promise<SoilManifest> {
    return this.manifest ?? this.refresh();
  }

  async list(): Promise<SoilPageRecord[]> {
    const manifest = await this.getManifest();
    return [...manifest.pages];
  }

  getLastScanStats(): SoilScanStats | null {
    return this.manifest?.scan ?? this.store.getLastScanStats?.() ?? null;
  }

  async getBySoilId(soilId: string): Promise<SoilPageRecord | null> {
    const manifest = await this.getManifest();
    const records = manifest.bySoilId.get(normalizeSoilId(soilId));
    return records?.[0] ?? null;
  }

  async getByPath(input: string): Promise<SoilPageRecord | null> {
    const manifest = await this.getManifest();
    const normalized = this.normalizeLookupPath(input);
    return manifest.byRelativePath.get(normalized) ?? null;
  }

  async query(query: string, limit = 10): Promise<SoilQueryHit[]> {
    const manifest = await this.getManifest();
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      return manifest.pages.slice(0, limit).map((record) => ({
        soilId: record.soilId,
        relativePath: record.relativePath,
        absolutePath: record.absolutePath,
        score: 0,
        frontmatter: record.frontmatter,
        snippet: buildSnippet(record, []),
      }));
    }
    return manifest.pages
      .map((record) => ({
        record,
        score: scorePage(queryTokens, record),
      }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.record.relativePath.localeCompare(right.record.relativePath))
      .slice(0, limit)
      .map(({ record, score }) => ({
        soilId: record.soilId,
        relativePath: record.relativePath,
        absolutePath: record.absolutePath,
        score,
        frontmatter: record.frontmatter,
        snippet: buildSnippet(record, queryTokens),
      }));
  }

  private normalizeLookupPath(input: string): string {
    if (path.isAbsolute(input)) {
      return soilPageRelativePathFromAbsolute(this.config.rootDir, input);
    }
    return normalizeSoilRelativePath(input);
  }
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9._/-]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function soilIdMatchesPath(soilId: string, relativePath: string): boolean {
  return soilIdToRelativePath(soilId) === normalizeSoilRelativePath(relativePath);
}
