import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SetupImportSelection, SetupImportSource } from "../commands/setup/import/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-setup-import-test-"));
});

afterEach(async () => {
  delete process.env["PULSEED_IMPORT_OPENCLAW_HOME"];
  delete process.env["PULSEED_IMPORT_HERMES_HOME"];
  vi.doUnmock("@clack/prompts");
  vi.doUnmock("../commands/setup/import/discovery.js");
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

describe("setup import discovery", () => {
  it("detects OpenClaw provider, skills, MCP servers, and plugins", async () => {
    const openclawHome = path.join(tmpDir, "openclaw");
    process.env["PULSEED_IMPORT_OPENCLAW_HOME"] = openclawHome;

    await writeJson(path.join(openclawHome, "config.json"), {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      adapter: "agent_loop",
      apiKey: "sk-imported",
      baseUrl: "https://example.test",
    });
    await fsp.mkdir(path.join(openclawHome, "skills", "review"), { recursive: true });
    await fsp.writeFile(path.join(openclawHome, "skills", "review", "SKILL.md"), "# Review\n", "utf-8");
    await writeJson(path.join(openclawHome, "mcp.json"), {
      mcpServers: {
        filesystem: {
          command: "node",
          args: ["server.js"],
          env: { ROOT: "/tmp" },
          tool_mappings: [
            {
              tool_name: "read_file",
              dimension_pattern: "filesystem_*",
              args_template: { path: "$path" },
            },
          ],
        },
      },
    });
    await fsp.mkdir(path.join(openclawHome, "plugins", "notifier"), { recursive: true });
    await writeJson(path.join(openclawHome, "plugins", "notifier", "plugin.json"), {
      name: "notifier",
      version: "1.0.0",
      type: "notifier",
      capabilities: ["notify"],
      description: "test",
    });

    const { detectSetupImportSources } = await import("../commands/setup/import/discovery.js");
    const sources = detectSetupImportSources();

    expect(sources).toHaveLength(1);
    expect(sources[0]?.id).toBe("openclaw");
    expect(sources[0]?.items.map((item) => item.kind).sort()).toEqual([
      "mcp",
      "plugin",
      "provider",
      "skill",
    ]);
    expect(sources[0]?.items.find((item) => item.kind === "provider")?.providerSettings).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      adapter: "agent_loop",
      apiKey: "sk-imported",
      baseUrl: "https://example.test",
    });
    expect(sources[0]?.items.find((item) => item.kind === "mcp")?.mcpServer).toMatchObject({
      id: "openclaw-filesystem",
      enabled: false,
      transport: "stdio",
      command: "node",
      tool_mappings: [
        {
          tool_name: "read_file",
          dimension_pattern: "filesystem_*",
          args_template: { path: "$path" },
        },
      ],
    });
    expect(sources[0]?.items.find((item) => item.kind === "plugin")?.decision).toBe("copy_disabled");
  });
});

describe("setup import apply", () => {
  it("copies skills and quarantined plugins, merges disabled MCP servers, and writes a report", async () => {
    const sourceRoot = path.join(tmpDir, "source");
    const baseDir = path.join(tmpDir, "pulseed");
    const skillDir = path.join(sourceRoot, "skills", "review");
    const pluginDir = path.join(sourceRoot, "plugins", "notifier");
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(path.join(skillDir, "SKILL.md"), "# Review\n", "utf-8");
    await fsp.mkdir(pluginDir, { recursive: true });
    await writeJson(path.join(pluginDir, "plugin.json"), {
      name: "notifier",
      version: "1.0.0",
      type: "notifier",
      capabilities: ["notify"],
      description: "test",
    });
    await writeJson(path.join(baseDir, "mcp-servers.json"), {
      servers: [
        {
          id: "openclaw-filesystem",
          name: "existing",
          transport: "stdio",
          command: "node",
          tool_mappings: [],
          enabled: true,
        },
      ],
    });

    const selection: SetupImportSelection = {
      sources: [{ id: "openclaw", label: "OpenClaw", rootDir: sourceRoot, items: [] }],
      items: [
        {
          id: "openclaw:skill:review",
          source: "openclaw",
          sourceLabel: "OpenClaw",
          kind: "skill",
          label: "review",
          sourcePath: skillDir,
          decision: "import",
          reason: "SKILL.md found",
        },
        {
          id: "openclaw:plugin:notifier",
          source: "openclaw",
          sourceLabel: "OpenClaw",
          kind: "plugin",
          label: "notifier",
          sourcePath: pluginDir,
          decision: "copy_disabled",
          reason: "quarantine",
        },
        {
          id: "openclaw:mcp:filesystem",
          source: "openclaw",
          sourceLabel: "OpenClaw",
          kind: "mcp",
          label: "filesystem",
          decision: "copy_disabled",
          reason: "disabled until reviewed",
          mcpServer: {
            id: "openclaw-filesystem",
            name: "filesystem",
            transport: "stdio",
            command: "node",
            args: ["server.js"],
            tool_mappings: [],
            enabled: false,
          },
        },
      ],
    };

    const { applySetupImportSelection } = await import("../commands/setup/import/apply.js");
    const report = await applySetupImportSelection(baseDir, selection);

    expect(fs.existsSync(path.join(baseDir, "skills", "imported", "openclaw", "review", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, "plugins-imported-disabled", "openclaw", "notifier", "plugin.json"))).toBe(true);

    const mcp = JSON.parse(
      await fsp.readFile(path.join(baseDir, "mcp-servers.json"), "utf-8")
    ) as { servers: Array<{ id: string; enabled: boolean }> };
    expect(mcp.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "openclaw-filesystem", enabled: true }),
        expect.objectContaining({ id: "openclaw-filesystem-2", enabled: false }),
      ])
    );
    expect(report.items.filter((item) => item.status === "applied")).toHaveLength(3);

    const reportRoots = await fsp.readdir(path.join(baseDir, "imports", "openclaw"));
    expect(reportRoots).toHaveLength(1);
    expect(fs.existsSync(path.join(baseDir, "imports", "openclaw", reportRoots[0]!, "report.json"))).toBe(true);
  });
});

describe("setup import flow", () => {
  it("does not prompt when no import sources are detected", async () => {
    vi.resetModules();
    const confirmMock = vi.fn();
    vi.doMock("@clack/prompts", () => ({
      confirm: confirmMock,
      select: vi.fn(),
      note: vi.fn(),
      multiselect: vi.fn(),
      log: { info: vi.fn() },
      isCancel: vi.fn(() => false),
    }));
    vi.doMock("../commands/setup/import/discovery.js", () => ({
      detectSetupImportSources: () => [],
    }));

    const { stepSetupImport } = await import("../commands/setup/import/flow.js");
    await expect(stepSetupImport()).resolves.toBeUndefined();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("asks which provider defaults to use when multiple provider configs are selected", async () => {
    vi.resetModules();
    const confirmMock = vi.fn(async () => true);
    const selectMock = vi.fn()
      .mockResolvedValueOnce("recommended")
      .mockResolvedValueOnce("openclaw-provider");
    const logInfoMock = vi.fn();
    const sources: SetupImportSource[] = [
      {
        id: "hermes",
        label: "Hermes Agent",
        rootDir: "/tmp/hermes",
        items: [
          {
            id: "hermes-provider",
            source: "hermes",
            sourceLabel: "Hermes Agent",
            kind: "provider",
            label: "openai / gpt-5.4-mini / agent_loop",
            decision: "import",
            reason: "provider defaults",
            providerSettings: {
              provider: "openai",
              model: "gpt-5.4-mini",
              adapter: "agent_loop",
              apiKey: "sk-hermes",
            },
          },
        ],
      },
      {
        id: "openclaw",
        label: "OpenClaw",
        rootDir: "/tmp/openclaw",
        items: [
          {
            id: "openclaw-provider",
            source: "openclaw",
            sourceLabel: "OpenClaw",
            kind: "provider",
            label: "anthropic / claude-sonnet-4-6 / agent_loop",
            decision: "import",
            reason: "provider defaults",
            providerSettings: {
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              adapter: "agent_loop",
              apiKey: "sk-openclaw",
            },
          },
        ],
      },
    ];

    vi.doMock("@clack/prompts", () => ({
      confirm: confirmMock,
      select: selectMock,
      note: vi.fn(),
      multiselect: vi.fn(),
      log: { info: logInfoMock },
      isCancel: vi.fn(() => false),
    }));
    vi.doMock("../commands/setup/import/discovery.js", () => ({
      detectSetupImportSources: () => sources,
    }));

    const { stepSetupImport } = await import("../commands/setup/import/flow.js");
    const selection = await stepSetupImport();

    expect(selection?.providerSettings).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      adapter: "agent_loop",
      apiKey: "sk-openclaw",
    });
    expect(selection?.items.find((item) => item.id === "hermes-provider")?.decision).toBe("skip");
    expect(selection?.items.find((item) => item.id === "openclaw-provider")?.decision).toBe("import");
    expect(selectMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message: expect.stringContaining("Which provider settings"),
      })
    );
  });

  it("respects manual item selection and does not seed skipped provider defaults", async () => {
    vi.resetModules();
    const confirmMock = vi.fn(async () => true);
    const selectMock = vi.fn(async () => "choose");
    const multiselectMock = vi.fn(async () => ["openclaw-skill"]);
    const sources: SetupImportSource[] = [
      {
        id: "openclaw",
        label: "OpenClaw",
        rootDir: "/tmp/openclaw",
        items: [
          {
            id: "openclaw-provider",
            source: "openclaw",
            sourceLabel: "OpenClaw",
            kind: "provider",
            label: "openai / gpt-5.4-mini / agent_loop",
            decision: "import",
            reason: "provider defaults",
            providerSettings: {
              provider: "openai",
              model: "gpt-5.4-mini",
              adapter: "agent_loop",
            },
          },
          {
            id: "openclaw-skill",
            source: "openclaw",
            sourceLabel: "OpenClaw",
            kind: "skill",
            label: "review",
            decision: "import",
            reason: "SKILL.md found",
            sourcePath: "/tmp/openclaw/skills/review",
          },
        ],
      },
    ];

    vi.doMock("@clack/prompts", () => ({
      confirm: confirmMock,
      select: selectMock,
      note: vi.fn(),
      multiselect: multiselectMock,
      log: { info: vi.fn() },
      isCancel: vi.fn(() => false),
    }));
    vi.doMock("../commands/setup/import/discovery.js", () => ({
      detectSetupImportSources: () => sources,
    }));

    const { stepSetupImport } = await import("../commands/setup/import/flow.js");
    const selection = await stepSetupImport();

    expect(selection?.providerSettings).toBeUndefined();
    expect(selection?.items.find((item) => item.id === "openclaw-provider")?.decision).toBe("skip");
    expect(selection?.items.find((item) => item.id === "openclaw-skill")?.decision).toBe("import");
    expect(multiselectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Select items to import:",
      })
    );
  });
});
