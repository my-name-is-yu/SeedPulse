import * as path from "node:path";

const POSIX_SEP = "/";

function toPosixPath(value: string): string {
  return value.replaceAll("\\", POSIX_SEP);
}

function assertSafeSegmentPath(value: string): void {
  if (!value) {
    throw new Error("Soil path cannot be empty");
  }
  if (path.posix.isAbsolute(value)) {
    throw new Error(`Soil path must be relative: ${value}`);
  }
  if (value.includes("\0")) {
    throw new Error("Soil path cannot contain NUL bytes");
  }
}

function normalizeRelativePath(value: string): string {
  const posixValue = toPosixPath(value.trim());
  assertSafeSegmentPath(posixValue);
  const normalized = path.posix.normalize(posixValue);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new Error(`Soil path escapes the root: ${value}`);
  }
  const trimmed = normalized.replace(/^\.\/+/, "");
  if (!trimmed || trimmed === ".") {
    throw new Error(`Soil path cannot be empty: ${value}`);
  }
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error(`Soil path contains unsafe segment: ${value}`);
    }
  }
  return trimmed;
}

function stripMdExtension(value: string): string {
  return value.endsWith(".md") ? value.slice(0, -3) : value;
}

export function normalizeSoilId(input: string): string {
  return stripMdExtension(normalizeRelativePath(input));
}

export function normalizeSoilRelativePath(input: string): string {
  const normalized = normalizeRelativePath(input);
  return normalized.endsWith(".md") ? normalized : `${normalized}.md`;
}

export function soilIdToRelativePath(soilId: string): string {
  return normalizeSoilRelativePath(soilId);
}

export function relativePathToSoilId(relativePath: string): string {
  return normalizeSoilId(relativePath);
}

export function resolveSoilPageRelativePath(input: string): string {
  return normalizeSoilRelativePath(input);
}

export function resolveSoilPageFilePath(rootDir: string, input: string): string {
  const relativePath = normalizeSoilRelativePath(input);
  const absolutePath = path.resolve(rootDir, relativePath);
  const resolvedRoot = path.resolve(rootDir);
  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (absolutePath !== resolvedRoot && !absolutePath.startsWith(rootPrefix)) {
    throw new Error(`Soil path escapes the root: ${input}`);
  }
  return absolutePath;
}

export function soilPageRelativePathFromAbsolute(rootDir: string, absolutePath: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedFile = path.resolve(absolutePath);
  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(rootPrefix)) {
    throw new Error(`Soil file path escapes the root: ${absolutePath}`);
  }
  const relative = path.relative(resolvedRoot, resolvedFile);
  return normalizeSoilRelativePath(relative);
}

export function isLikelySoilMarkdownPath(value: string): boolean {
  return value.endsWith(".md");
}
