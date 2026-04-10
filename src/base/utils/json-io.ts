// ─── JSON IO Utilities ───
//
// Shared helpers for reading and writing JSON files.
// Async versions (writeJsonFileAtomic, readJsonFileOrNull, readJsonFileWithSchema)
// are preferred over the legacy sync-style async functions below.

import * as fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * Write data to a JSON file atomically (write to a unique .tmp, then rename).
 * Creates parent directories as needed.
 */
export async function writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
  await fsp.mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    await fsp.rename(tmpPath, filePath);
  } catch (err) {
    try {
      await fsp.unlink(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Read and parse a JSON file asynchronously.
 * Returns null on ENOENT or invalid JSON (does not throw).
 */
export async function readJsonFileOrNull<T = unknown>(filePath: string): Promise<T | null> {
  try {
    const content = await fsp.readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * Read, parse, and validate a JSON file against a Zod schema.
 * Returns null on ENOENT, invalid JSON, or schema validation failure (does not throw).
 */
export async function readJsonFileWithSchema<T>(
  filePath: string,
  schema: z.ZodType<T>
): Promise<T | null> {
  const raw = await readJsonFileOrNull(filePath);
  if (raw === null) return null;
  const result = schema.safeParse(raw);
  return result.success ? result.data : null;
}

// ─── Legacy helpers (async, kept for backward compatibility) ───
// Prefer the atomic/null-safe versions above for new code.

/**
 * Read and parse a JSON file asynchronously.
 * Throws if the file does not exist or contains invalid JSON.
 * @deprecated Prefer readJsonFileOrNull
 */
export async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await fsp.readFile(filePath, "utf-8");
  return JSON.parse(content) as T;
}

/**
 * Write data to a JSON file asynchronously with 2-space indent.
 * @deprecated Prefer writeJsonFileAtomic
 */
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}
