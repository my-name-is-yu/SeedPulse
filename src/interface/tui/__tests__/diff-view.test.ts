import { describe, expect, it } from "vitest";
import { diffLineColor } from "../diff-view.js";
import { theme } from "../theme.js";

describe("diffLineColor", () => {
  it("colors added lines as success", () => {
    expect(diffLineColor("+added line")).toBe(theme.success);
  });

  it("colors removed lines as error", () => {
    expect(diffLineColor("-removed line")).toBe(theme.error);
  });

  it("colors hunk headers as info", () => {
    expect(diffLineColor("@@ -1 +1 @@")).toBe(theme.info);
  });

  it("colors file headers distinctly from content changes", () => {
    expect(diffLineColor("+++ b/src/example.ts")).toBe(theme.warning);
    expect(diffLineColor("--- a/src/example.ts")).toBe(theme.warning);
  });
});
