import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { findPackageRoot, getPulseedVersion } from "../pulseed-meta.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";

describe("pulseed-meta", () => {
  it("resolves the package version from the nearest package.json", () => {
    const tmpDir = makeTempDir();
    try {
      const nestedDir = path.join(tmpDir, "src", "interface", "tui");
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ version: "9.8.7" }), "utf-8");

      const importMetaUrl = pathToFileURL(path.join(nestedDir, "app.tsx")).href;

      expect(findPackageRoot(importMetaUrl)).toBe(tmpDir);
      expect(getPulseedVersion(importMetaUrl)).toBe("9.8.7");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});
