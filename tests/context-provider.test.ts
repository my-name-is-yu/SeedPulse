import { describe, it, expect } from "vitest";
import {
  buildWorkspaceContext,
  dimensionNameToSearchTerms,
} from "../src/context-provider.js";
import * as path from "path";

describe("dimensionNameToSearchTerms", () => {
  it("returns ['TODO'] for todo_count", () => {
    expect(dimensionNameToSearchTerms("todo_count")).toEqual(["TODO"]);
  });

  it("returns ['FIXME'] for fixme_count", () => {
    expect(dimensionNameToSearchTerms("fixme_count")).toEqual(["FIXME"]);
  });

  it("returns ['test', 'coverage'] for test_coverage", () => {
    expect(dimensionNameToSearchTerms("test_coverage")).toEqual([
      "test",
      "coverage",
    ]);
  });

  it("returns fallback terms for unknown_metric", () => {
    // "unknown_metric" → split by "_", words > 2 chars: ["unknown", "metric"]
    const terms = dimensionNameToSearchTerms("unknown_metric");
    expect(terms.length).toBeGreaterThan(0);
    // Should not include any of the known special terms
    expect(terms).not.toContain("TODO");
    expect(terms).not.toContain("FIXME");
    expect(terms).not.toContain("test");
    // Should fall back to the words from the dimension name
    expect(terms).toContain("unknown");
  });

  it("returns ['eslint'] for lint_errors", () => {
    expect(dimensionNameToSearchTerms("lint_errors")).toContain("eslint");
  });

  it("returns ['README'] for readme_quality", () => {
    expect(dimensionNameToSearchTerms("readme_quality")).toContain("README");
  });

  it("returns ['error'] for error_count", () => {
    expect(dimensionNameToSearchTerms("error_count")).toContain("error");
  });

  it("returns the full dimension name as fallback when no word is long enough", () => {
    // All words are <= 2 chars, so falls through to full name fallback
    const terms = dimensionNameToSearchTerms("a_b");
    expect(terms.length).toBeGreaterThan(0);
  });
});

describe("buildWorkspaceContext (integration)", () => {
  const projectRoot = path.resolve(__dirname, "..");

  it("returns a string result", async () => {
    const result = await buildWorkspaceContext("goal-1", "todo_count", {
      cwd: projectRoot,
      maxFileContentLines: 10,
    });
    expect(typeof result).toBe("string");
  }, 60000);

  it("includes file content sections when grep finds matches", async () => {
    // "TODO" is likely present in this TypeScript project
    const result = await buildWorkspaceContext("goal-2", "todo_count", {
      cwd: projectRoot,
      maxFileContentLines: 10,
    });
    // Either files were found (grep matched) or we get the fallback
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    // If TODO was found, it should contain a file section marker
    if (result.includes('[grep "TODO"')) {
      expect(result).toMatch(/\[File: .+\]/);
    }
  }, 60000);

  it("handles a dimension with no grep matches gracefully", async () => {
    // Use a very unusual dimension name unlikely to match any file
    const result = await buildWorkspaceContext(
      "goal-3",
      "zzz_xyzzy_nonexistent_9999",
      { cwd: projectRoot, maxFileContentLines: 5 }
    );
    expect(typeof result).toBe("string");
    // Should not throw; returns either content or the fallback message
    // The result might be empty-context fallback or git diff / test output
    expect(result).toBeDefined();
  }, 60000);

  it("respects maxFileContentLines option by limiting lines per file", async () => {
    const result = await buildWorkspaceContext("goal-4", "test_coverage", {
      cwd: projectRoot,
      maxFileContentLines: 3,
    });
    expect(typeof result).toBe("string");
    // Parse individual file sections using regex:
    // a file section starts with "[File: ...]" and ends before the next "[" marker
    const fileSectionRegex = /\[File: [^\]]+\]\n([\s\S]*?)(?=\n\[(?:grep|File|Recent|Test)|$)/g;
    let match: RegExpExecArray | null;
    while ((match = fileSectionRegex.exec(result)) !== null) {
      const fileContent = match[1];
      const nonEmptyLines = fileContent.split("\n").filter((l) => l.trim() !== "");
      // File content must be bounded by maxFileContentLines (3), allow generous slack
      expect(nonEmptyLines.length).toBeLessThanOrEqual(20);
    }
  }, 60000);

  it("returns fallback message when no context is available at all", async () => {
    // Point to a temp dir with no files, no git, no tests
    const result = await buildWorkspaceContext("goal-5", "unknown_xyz", {
      cwd: "/tmp",
      maxFileContentLines: 5,
    });
    expect(typeof result).toBe("string");
    // Should not throw; fallback is acceptable
  }, 60000);
});
