import * as fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import * as yaml from "js-yaml";
import {
  parseSoilMarkdown,
  serializeSoilMarkdown,
  splitSoilFrontmatter,
} from "./frontmatter.js";
import type { SoilPageFrontmatter } from "./types.js";

export interface SoilMarkdownFile {
  frontmatter: SoilPageFrontmatter;
  body: string;
  content: string;
}

export async function writeTextFileAtomic(filePath: string, content: string): Promise<void> {
  await fsp.mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tmpPath, content, "utf-8");
    await fsp.rename(tmpPath, filePath);
  } catch (error) {
    try {
      await fsp.unlink(tmpPath);
    } catch {
      // Ignore cleanup errors.
    }
    throw error;
  }
}

export async function readTextFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

export async function readSoilMarkdownFile(filePath: string): Promise<SoilMarkdownFile | null> {
  const content = await readTextFileOrNull(filePath);
  if (content === null) {
    return null;
  }
  const parsed = parseSoilMarkdown(content);
  return { ...parsed, content };
}

export async function writeSoilMarkdownFile(
  filePath: string,
  frontmatter: SoilPageFrontmatter,
  body: string
): Promise<void> {
  await writeTextFileAtomic(filePath, serializeSoilMarkdown(frontmatter, body));
}

export function parseSoilMarkdownLoose(content: string): {
  hasFrontmatter: boolean;
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const split = splitSoilFrontmatter(content);
  return split;
}

export function dumpSoilFrontmatter(frontmatter: SoilPageFrontmatter): string {
  return serializeSoilMarkdown(frontmatter, "");
}

export function parseFrontmatterYaml(content: string): Record<string, unknown> {
  const parsed = yaml.load(content);
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}
