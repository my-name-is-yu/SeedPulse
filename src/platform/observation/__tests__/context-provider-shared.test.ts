import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import {
  classifyTier,
  resolveGitRoot,
  sanitizeNumberedContent,
  tailLines,
  toRelativePath,
  truncateToBudget,
} from "../context-provider/shared.js";

describe("context-provider shared helpers", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
    tmpDir = "";
  });

  it("classifies labels into expected tiers", () => {
    expect(classifyTier("Goal status")).toBe("core");
    expect(classifyTier("Recent changes")).toBe("recall");
    expect(classifyTier("Archive snapshot")).toBe("archival");
    expect(classifyTier("plain file section")).toBe("recall");
  });

  it("truncates oversized content and keeps both head and tail", () => {
    const text = `${"a".repeat(40)}${"b".repeat(40)}`;
    const truncated = truncateToBudget(text, 50);

    expect(truncated).toContain("[... truncated to fit token budget ...]");
    expect(truncated.startsWith("a".repeat(30))).toBe(true);
    expect(truncated.endsWith("b".repeat(20))).toBe(true);
  });

  it("sanitizes numbered content and returns tail lines and relative paths", () => {
    expect(sanitizeNumberedContent("1\talpha\n2\tbeta")).toBe("alpha\nbeta");
    expect(tailLines("a\nb\nc\nd", 2)).toBe("c\nd");
    expect(toRelativePath("/repo", "/repo/src/file.ts")).toBe("src/file.ts");
  });

  it("resolves git root by walking parent directories", async () => {
    tmpDir = makeTempDir("context-provider-root-");
    const repoRoot = path.join(tmpDir, "repo");
    const nested = path.join(repoRoot, "src", "deep");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.mkdir(nested, { recursive: true });

    expect(resolveGitRoot(nested)).toBe(repoRoot);
  });

  it("falls back to resolved cwd when no git root exists", async () => {
    tmpDir = makeTempDir("context-provider-no-git-");
    const nested = path.join(tmpDir, "workspace", "nested");
    await fs.mkdir(nested, { recursive: true });

    expect(resolveGitRoot(nested)).toBe(nested);
  });
});

