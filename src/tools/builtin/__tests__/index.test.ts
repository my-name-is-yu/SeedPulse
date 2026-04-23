import { describe, expect, it } from "vitest";
import { createBuiltinTools as createBuiltinToolsFromFactory } from "../factory.js";
import { GitHubReadTool as GitHubReadToolFromExports } from "../exports.js";
import { createBuiltinTools, GitHubReadTool } from "../index.js";

describe("tools builtin index", () => {
  it("re-exports the factory and public tool classes", () => {
    expect(createBuiltinTools).toBe(createBuiltinToolsFromFactory);
    expect(GitHubReadTool).toBe(GitHubReadToolFromExports);
  });
});
