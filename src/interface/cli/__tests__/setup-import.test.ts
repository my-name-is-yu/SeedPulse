import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ForeignPluginCompatibilityReport } from "../../../runtime/foreign-plugins/types.js";
import type { SetupImportSelection, SetupImportSource } from "../commands/setup/import/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-setup-import-test-"));
});

afterEach(async () => {
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
  it("detects Hermes provider, skills, MCP servers, and plugins", async () => {
    const hermesHome = path.join(tmpDir, "hermes");
    process.env["PULSEED_IMPORT_HERMES_HOME"] = hermesHome;

    await writeJson(path.join(hermesHome, "settings.json"), {
      provider: "openai",
      model: "gpt-5.4-mini",
      adapter: "agent_loop",
      apiKey: "sk-imported",
      baseUrl: "https://example.test",
    });
    await fsp.mkdir(path.join(hermesHome, "skills", "review"), { recursive: true });
    await fsp.writeFile(path.join(hermesHome, "skills", "review", "SKILL.md"), "# Review\n", "utf-8");
    await writeJson(path.join(hermesHome, "mcp.json"), {
      mcpServers: {
        filesystem: {
          command: "node",
          args: ["server.js"],
          env: { ROOT: "/tmp" },
        },
      },
    });
    await fsp.mkdir(path.join(hermesHome, "plugins", "notifier"), { recursive: true });
    await writeJson(path.join(hermesHome, "plugins", "notifier", "plugin.json"), {
      name: "notifier",
      version: "1.0.0",
      type: "notifier",
      capabilities: ["notify"],
      description: "test",
      permissions: {
        network: false,
        file_read: false,
        file_write: false,
        shell: false,
      },
    });
    await fsp.writeFile(path.join(hermesHome, "USER.md"), "# About You\n\nName: Imported User\n", "utf-8");

    const { detectSetupImportSources } = await import("../commands/setup/import/discovery.js");
    const sources = detectSetupImportSources();
    const hermes = sources.find((source) => source.id === "hermes");

    expect(hermes).toBeDefined();
    expect(hermes?.items.map((item) => item.kind).sort()).toEqual([
      "mcp",
      "plugin",
      "provider",
      "skill",
      "user",
    ]);
    expect(hermes?.items.find((item) => item.kind === "provider")?.providerSettings).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-mini",
      adapter: "agent_loop",
      apiKey: "sk-imported",
      baseUrl: "https://example.test",
    });
    expect(hermes?.items.find((item) => item.kind === "mcp")?.mcpServer).toMatchObject({
      id: "hermes-filesystem",
      enabled: false,
      command: "node",
      args: ["server.js"],
    });
    expect(hermes?.items.find((item) => item.kind === "plugin")?.pluginCompatibility?.status).toBe("convertible");
    expect(hermes?.items.find((item) => item.kind === "user")?.userSettings).toEqual({
      content: "# About You\n\nName: Imported User\n",
    });
  });

  it("imports provider API keys from the workspace env file selected by Hermes config", async () => {
    const hermesHome = path.join(tmpDir, "hermes");
    process.env["PULSEED_IMPORT_HERMES_HOME"] = hermesHome;

    await fsp.mkdir(path.join(hermesHome, "workspace-main"), { recursive: true });
    await fsp.writeFile(
      path.join(hermesHome, "workspace-main", ".env"),
      "OPENAI_API_KEY=sk-workspace-openai\n",
      "utf-8"
    );
    await writeJson(path.join(hermesHome, "settings.json"), {
      provider: "openai",
      model: "gpt-5.4",
      adapter: "agent_loop",
      workspace: "workspace-main",
      openai: {
        apiKey: "OPENAI_API_KEY",
      },
    });

    const { detectSetupImportSources } = await import("../commands/setup/import/discovery.js");
    const sources = detectSetupImportSources();
    const hermes = sources.find((source) => source.id === "hermes");
    const provider = hermes?.items.find((item) => item.kind === "provider");

    expect(provider?.providerSettings).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
      adapter: "agent_loop",
      apiKey: "sk-workspace-openai",
    });
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
      permissions: {
        network: true,
        file_read: false,
        file_write: false,
        shell: false,
      },
    });
    await writeJson(path.join(baseDir, "mcp-servers.json"), {
      servers: [
        {
          id: "hermes-filesystem",
          name: "existing",
          transport: "stdio",
          command: "node",
          tool_mappings: [],
          enabled: true,
        },
      ],
    });

    const selection: SetupImportSelection = {
      sources: [{ id: "hermes", label: "Hermes Agent", rootDir: sourceRoot, items: [] }],
      items: [
        {
          id: "hermes:skill:review",
          source: "hermes",
          sourceLabel: "Hermes Agent",
          kind: "skill",
          label: "review",
          sourcePath: skillDir,
          decision: "import",
          reason: "SKILL.md found",
        },
        {
          id: "hermes:plugin:notifier",
          source: "hermes",
          sourceLabel: "Hermes Agent",
          kind: "plugin",
          label: "notifier",
          sourcePath: pluginDir,
          decision: "copy_disabled",
          reason: "quarantine",
          pluginCompatibility: {
            source: "hermes",
            status: "quarantined",
            issues: ["requested permissions: network"],
            permissions: {
              network: true,
              file_read: false,
              file_write: false,
              shell: false,
            },
            manifestPath: path.join(pluginDir, "plugin.json"),
            manifest: {
              name: "notifier",
              version: "1.0.0",
              type: "notifier",
              capabilities: ["notify"],
              description: "test",
              entry_point: "dist/index.js",
            },
          } satisfies ForeignPluginCompatibilityReport,
        },
        {
          id: "hermes:mcp:filesystem",
          source: "hermes",
          sourceLabel: "Hermes Agent",
          kind: "mcp",
          label: "filesystem",
          decision: "copy_disabled",
          reason: "disabled until reviewed",
          mcpServer: {
            id: "hermes-filesystem",
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

    expect(fs.existsSync(path.join(baseDir, "skills", "imported", "hermes", "review", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, "plugins-imported-disabled", "hermes", "notifier", "plugin.json"))).toBe(true);

    const mcp = JSON.parse(
      await fsp.readFile(path.join(baseDir, "mcp-servers.json"), "utf-8")
    ) as { servers: Array<{ id: string; enabled: boolean }> };
    expect(mcp.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "hermes-filesystem", enabled: true }),
        expect.objectContaining({ id: "hermes-filesystem-2", enabled: false }),
      ])
    );
    expect(report.items.filter((item) => item.status === "applied")).toHaveLength(3);
    expect(report.items.find((item) => item.kind === "plugin")?.pluginCompatibility?.status).toBe("quarantined");
    const reportRoots = await fsp.readdir(path.join(baseDir, "imports", "hermes"));
    expect(reportRoots).toHaveLength(1);
    expect(fs.existsSync(path.join(baseDir, "imports", "hermes", reportRoots[0]!, "report.json"))).toBe(true);
  });
});

describe("setup import flow", () => {
  it("does not prompt when no import sources are detected", async () => {
    vi.resetModules();
    const selectMock = vi.fn();
    vi.doMock("@clack/prompts", () => ({
      select: selectMock,
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
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("imports all items from the detected Hermes source without a second item-selection prompt", async () => {
    vi.resetModules();
    const selectMock = vi.fn().mockResolvedValueOnce("hermes");
    const multiselectMock = vi.fn();
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
            },
          },
          {
            id: "hermes-skill",
            source: "hermes",
            sourceLabel: "Hermes Agent",
            kind: "skill",
            label: "review",
            decision: "import",
            reason: "SKILL.md found",
            sourcePath: "/tmp/hermes/skills/review",
          },
        ],
      },
    ];

    vi.doMock("@clack/prompts", () => ({
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

    expect(selection?.providerSettings).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-mini",
      adapter: "agent_loop",
    });
    expect(selection?.sources.map((source) => source.id)).toEqual(["hermes"]);
    expect(selection?.items.find((item) => item.id === "hermes-provider")?.decision).toBe("import");
    expect(selection?.items.find((item) => item.id === "hermes-skill")?.decision).toBe("import");
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(multiselectMock).not.toHaveBeenCalled();
  });
});
