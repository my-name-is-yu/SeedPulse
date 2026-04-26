import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConcurrencyController } from "../../../concurrency.js";
import { ToolExecutor } from "../../../executor.js";
import { ToolPermissionManager } from "../../../permission.js";
import { ToolRegistry } from "../../../registry.js";
import { clearCodeSearchSessionsForTests } from "../../../../platform/code-search/session-store.js";
import { CodeReadContextTool } from "../../CodeReadContextTool/CodeReadContextTool.js";
import { CodeSearchRepairTool } from "../../CodeSearchRepairTool/CodeSearchRepairTool.js";
import { CodeSearchTool } from "../CodeSearchTool.js";
import { MAX_OUTPUT_CHARS } from "../constants.js";
import { MAX_OUTPUT_CHARS as READ_CONTEXT_MAX_OUTPUT_CHARS } from "../../CodeReadContextTool/constants.js";
import type { ToolCallContext } from "../../../types.js";

describe("code search tools", () => {
  let root: string;
  let context: ToolCallContext;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-code-search-tool-"));
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    await fsp.writeFile(path.join(root, "src", "alpha.ts"), "export function alphaValue() { return 1; }\n");
    context = {
      cwd: root,
      goalId: "goal-1",
      trustBalance: 0,
      preApproved: true,
      approvalFn: async () => true,
    };
  });

  afterEach(async () => {
    clearCodeSearchSessionsForTests();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("code_search and code_read_context provide structured context through queryId handles", async () => {
    const search = await new CodeSearchTool().call({ task: "find alphaValue", intent: "explain" }, context);
    expect(search.success).toBe(true);
    const data = search.data as { queryId: string; candidateIds: string[]; candidates: Array<{ id: string; file: string }> };
    expect(data.candidates.length).toBeGreaterThan(0);
    expect(JSON.stringify(data.candidates[0])).not.toContain("signals");

    const read = await new CodeReadContextTool().call({
      candidates: [],
      queryId: data.queryId,
      candidateIds: data.candidateIds.slice(0, 1),
      phase: "locate",
      maxReadRanges: 1,
    }, context);
    expect(read.success).toBe(true);
    expect(JSON.stringify(read.data)).toContain("alphaValue");
  });

  it("keeps ToolExecutor output below truncation while code_read_context resolves full candidates by queryId", async () => {
    for (let i = 0; i < 120; i += 1) {
      await fsp.writeFile(path.join(root, "src", `alpha-${i}.ts`), `export function alphaValue${i}() { return ${i}; }\n`);
    }
    const registry = new ToolRegistry();
    registry.register(new CodeSearchTool());
    registry.register(new CodeReadContextTool());
    const executor = new ToolExecutor({
      registry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });

    const search = await executor.execute("code_search", {
      task: "find alphaValue route selection",
      intent: "explain",
      queryTerms: ["alphaValue"],
      outputLimit: 40,
    }, context);

    expect(search.success).toBe(true);
    expect(search.truncated).toBeUndefined();
    expect(typeof search.data).toBe("object");
    expect(JSON.stringify(search.data).length).toBeLessThan(MAX_OUTPUT_CHARS);
    const data = search.data as { queryId: string; candidateIds: string[]; totalCandidates: number };
    expect(data.totalCandidates).toBeGreaterThan(40);

    const read = await executor.execute("code_read_context", {
      queryId: data.queryId,
      candidateIds: data.candidateIds.slice(0, 2),
      phase: "locate",
      maxReadRanges: 2,
    }, context);
    expect(read.success).toBe(true);
    expect(read.truncated).toBeUndefined();
    expect(JSON.stringify(read.data).length).toBeLessThan(READ_CONTEXT_MAX_OUTPUT_CHARS);
    expect(JSON.stringify(read.data)).toContain("alphaValue");
  });

  it("uses the saved search root for queryId reads from scoped paths", async () => {
    await fsp.mkdir(path.join(root, "pkg", "src"), { recursive: true });
    await fsp.writeFile(path.join(root, "pkg", "src", "alpha.ts"), "export function scopedAlphaValue() { return 2; }\n");
    const registry = new ToolRegistry();
    registry.register(new CodeSearchTool());
    registry.register(new CodeReadContextTool());
    const executor = new ToolExecutor({
      registry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });

    const search = await executor.execute("code_search", {
      task: "find scopedAlphaValue",
      intent: "explain",
      path: "pkg",
    }, context);
    expect(search.success).toBe(true);
    const data = search.data as { queryId: string; candidateIds: string[] };

    const read = await executor.execute("code_read_context", {
      queryId: data.queryId,
      candidateIds: data.candidateIds.slice(0, 1),
      phase: "locate",
      maxReadRanges: 1,
    }, context);

    expect(read.success).toBe(true);
    expect(JSON.stringify(read.data)).toContain("scopedAlphaValue");
    expect((read.data as { ranges: Array<{ file: string }> }).ranges[0].file).toBe("src/alpha.ts");
  });

  it("refuses to default-search the home directory", async () => {
    const result = await new CodeSearchTool().call(
      { task: "find alphaValue", intent: "explain" },
      { ...context, cwd: os.homedir() },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("refused broad root");
  });

  it("defaults nested package searches to the project root", async () => {
    const nested = path.join(root, "src");
    const result = await new CodeSearchTool().call(
      { task: "find alphaValue", intent: "explain" },
      { ...context, cwd: nested },
    );

    expect(result.success).toBe(true);
    const data = result.data as { candidates: Array<{ file: string }> };
    expect(data.candidates[0]?.file).toBe("src/alpha.ts");
  });

  it("code_search_repair parses verification output and suggests candidates", async () => {
    const result = await new CodeSearchRepairTool().call({
      priorTask: { task: "fix alphaValue", intent: "bugfix" },
      verificationOutput: "ReferenceError: alphaValue is not defined\n    at src/alpha.ts:1:1",
    }, context);

    expect(result.success).toBe(true);
    expect((result.data as { signal: { kind: string }; candidates: unknown[] }).signal.kind).toBe("undefined_symbol");
    expect((result.data as { candidates: unknown[] }).candidates.length).toBeGreaterThan(0);
  });
});
