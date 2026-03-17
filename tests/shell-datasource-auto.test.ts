import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  autoRegisterShellDataSources,
  SHELL_DIMENSION_PATTERNS,
} from "../src/cli/commands/goal.js";

// ─── Minimal StateManager stub ───

function makeFakeStateManager(baseDir: string) {
  return {
    getBaseDir: () => baseDir,
  };
}

// ─── Helpers ───

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-shell-auto-test-"));
}

function readDsConfigs(datasourcesDir: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(datasourcesDir)) return [];
  return fs
    .readdirSync(datasourcesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(datasourcesDir, f), "utf-8")));
}

// ─── Tests ───

describe("autoRegisterShellDataSources", () => {
  let tmpDir: string;
  let datasourcesDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    datasourcesDir = path.join(tmpDir, "datasources");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a shell datasource config for todo_count dimension", () => {
    const sm = makeFakeStateManager(tmpDir);
    autoRegisterShellDataSources(
      sm as never,
      [{ name: "todo_count" }],
      "goal_abc"
    );

    const configs = readDsConfigs(datasourcesDir);
    expect(configs).toHaveLength(1);
    const cfg = configs[0];
    expect(cfg.type).toBe("shell");
    expect(cfg.scope_goal_id).toBe("goal_abc");
    expect(cfg.enabled).toBe(true);
    const commands = cfg.commands as Record<string, { argv: string[]; output_type: string }>;
    expect(commands).toHaveProperty("todo_count");
    expect(commands.todo_count.argv).toContain("grep");
    expect(commands.todo_count.output_type).toBe("number");
  });

  it("creates a shell datasource config for fixme_count dimension", () => {
    const sm = makeFakeStateManager(tmpDir);
    autoRegisterShellDataSources(
      sm as never,
      [{ name: "fixme_count" }],
      "goal_xyz"
    );

    const configs = readDsConfigs(datasourcesDir);
    expect(configs).toHaveLength(1);
    const commands = configs[0].commands as Record<string, { argv: string[]; output_type: string }>;
    expect(commands).toHaveProperty("fixme_count");
    expect(commands.fixme_count.argv.some((a: string) => a.includes("FIXME"))).toBe(true);
    expect(commands.fixme_count.output_type).toBe("number");
  });

  it("skips dimensions with no matching pattern", () => {
    const sm = makeFakeStateManager(tmpDir);
    autoRegisterShellDataSources(
      sm as never,
      [{ name: "readme_quality" }, { name: "some_unknown_metric" }],
      "goal_skip"
    );

    const configs = readDsConfigs(datasourcesDir);
    expect(configs).toHaveLength(0);
  });

  it("produces valid JSON with the correct structure", () => {
    const sm = makeFakeStateManager(tmpDir);
    autoRegisterShellDataSources(
      sm as never,
      [{ name: "todo_count" }],
      "goal_json"
    );

    const configs = readDsConfigs(datasourcesDir);
    expect(configs).toHaveLength(1);
    const cfg = configs[0];

    // Required top-level fields
    expect(typeof cfg.id).toBe("string");
    expect(typeof cfg.name).toBe("string");
    expect(cfg.type).toBe("shell");
    expect(typeof cfg.created_at).toBe("string");
    expect(cfg.enabled).toBe(true);

    // connection must have path
    const conn = cfg.connection as { path: string };
    expect(typeof conn.path).toBe("string");

    // commands must be an object with at least one key
    const commands = cfg.commands as Record<string, unknown>;
    expect(Object.keys(commands).length).toBeGreaterThan(0);
  });

  it("creates a single datasource with multiple commands for multiple matching dimensions", () => {
    const sm = makeFakeStateManager(tmpDir);
    autoRegisterShellDataSources(
      sm as never,
      [{ name: "todo_count" }, { name: "fixme_count" }],
      "goal_multi"
    );

    const configs = readDsConfigs(datasourcesDir);
    // Both dimensions should be packed into ONE datasource file
    expect(configs).toHaveLength(1);
    const commands = configs[0].commands as Record<string, unknown>;
    expect(commands).toHaveProperty("todo_count");
    expect(commands).toHaveProperty("fixme_count");
  });

  it("does not create a datasource when dimensions array is empty", () => {
    const sm = makeFakeStateManager(tmpDir);
    autoRegisterShellDataSources(sm as never, [], "goal_empty");

    const configs = readDsConfigs(datasourcesDir);
    expect(configs).toHaveLength(0);
  });

  it("creates the datasources directory if it does not exist", () => {
    const sm = makeFakeStateManager(tmpDir);
    expect(fs.existsSync(datasourcesDir)).toBe(false);

    autoRegisterShellDataSources(
      sm as never,
      [{ name: "todo_count" }],
      "goal_mkdir"
    );

    expect(fs.existsSync(datasourcesDir)).toBe(true);
  });
});

// ─── SHELL_DIMENSION_PATTERNS sanity checks ───

describe("SHELL_DIMENSION_PATTERNS", () => {
  it("contains entries for todo_count and fixme_count", () => {
    expect(SHELL_DIMENSION_PATTERNS).toHaveProperty("todo_count");
    expect(SHELL_DIMENSION_PATTERNS).toHaveProperty("fixme_count");
  });

  it("all entries have an argv array and valid output_type", () => {
    for (const [name, spec] of Object.entries(SHELL_DIMENSION_PATTERNS)) {
      expect(Array.isArray(spec.argv), `${name}.argv should be array`).toBe(true);
      expect(spec.argv.length, `${name}.argv should be non-empty`).toBeGreaterThan(0);
      expect(["number", "boolean", "raw"]).toContain(spec.output_type);
    }
  });

  it("todo_count uses grep with comment-aware pattern", () => {
    const spec = SHELL_DIMENSION_PATTERNS.todo_count;
    expect(spec.argv[0]).toBe("grep");
    expect(spec.argv).toContain("-rEc");
    expect(spec.argv.some(a => a.includes("TODO"))).toBe(true);
  });

  it("fixme_count uses grep with comment-aware pattern", () => {
    const spec = SHELL_DIMENSION_PATTERNS.fixme_count;
    expect(spec.argv[0]).toBe("grep");
    expect(spec.argv).toContain("-rEc");
    expect(spec.argv.some(a => a.includes("FIXME"))).toBe(true);
  });
});
