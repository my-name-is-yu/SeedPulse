import * as yaml from "js-yaml";
import {
  SoilPageFrontmatterSchema,
  type SoilPageFrontmatter,
} from "./types.js";

export interface SoilMarkdownSplit {
  frontmatter: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .map((item) => stripUndefined(item))
      .filter((item) => item !== undefined) as T;
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) {
        continue;
      }
      const normalized = stripUndefined(entry);
      if (normalized !== undefined) {
        result[key] = normalized;
      }
    }
    return result as T;
  }

  return value;
}

export function splitSoilFrontmatter(content: string): SoilMarkdownSplit {
  const lines = content.split("\n");

  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: content, hasFrontmatter: false };
  }

  const closeIdx = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closeIdx === -1) {
    return { frontmatter: {}, body: content, hasFrontmatter: false };
  }

  const yamlLines = lines.slice(1, closeIdx).join("\n");
  const body = lines.slice(closeIdx + 1).join("\n");

  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(yamlLines);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch {
    frontmatter = {};
  }

  return { frontmatter, body, hasFrontmatter: true };
}

export function parseSoilFrontmatter(content: string): SoilPageFrontmatter {
  const split = splitSoilFrontmatter(content);
  if (!split.hasFrontmatter) {
    throw new Error("Soil frontmatter block is missing");
  }

  return SoilPageFrontmatterSchema.parse(split.frontmatter);
}

export function parseSoilMarkdown(content: string): { frontmatter: SoilPageFrontmatter; body: string } {
  const split = splitSoilFrontmatter(content);
  if (!split.hasFrontmatter) {
    throw new Error("Soil frontmatter block is missing");
  }

  return {
    frontmatter: SoilPageFrontmatterSchema.parse(split.frontmatter),
    body: split.body,
  };
}

export function serializeSoilFrontmatter(frontmatter: SoilPageFrontmatter): string {
  const normalized = SoilPageFrontmatterSchema.parse(frontmatter);
  const yamlText = yaml.dump(stripUndefined(normalized), {
    noRefs: true,
    lineWidth: -1,
    sortKeys: false,
  });
  return `---\n${yamlText}---\n`;
}

export function serializeSoilMarkdown(frontmatter: SoilPageFrontmatter, body = ""): string {
  const normalized = SoilPageFrontmatterSchema.parse(frontmatter);
  const yamlText = yaml.dump(stripUndefined(normalized), {
    noRefs: true,
    lineWidth: -1,
    sortKeys: false,
  });
  return `---\n${yamlText}---\n${body}`;
}

