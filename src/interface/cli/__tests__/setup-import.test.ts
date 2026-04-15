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
    await fsp.writeFile(path.join(openclawHome, "USER.md"), "# About You\n\nName: Imported User\n", "utf-8");

    const { detectSetupImportSources } = await import("../commands/setup/import/discovery.js");
    const sources = detectSetupImportSources();
    const openclaw = sources.find((source) => source.id === "openclaw");

    expect(openclaw).toBeDefined();
    expect(openclaw?.items.map((item) => item.kind).sort()).toEqual([
      "mcp",
      "plugin",
      "provider",
      "skill",
      "user",
    ]);
    expect(openclaw?.items.find((item) => item.kind === "provider")?.providerSettings).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      adapter: "agent_loop",
      apiKey: "sk-imported",
      baseUrl: "https://example.test",
    });
    expect(openclaw?.items.find((item) => item.kind === "mcp")?.mcpServer).toMatchObject({
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
    expect(openclaw?.items.find((item) => item.kind === "plugin")?.decision).toBe("copy_disabled");
    expect(openclaw?.items.find((item) => item.kind === "user")?.userSettings).toEqual({
      content: "# About You\n\nName: Imported User\n",
    });
  });

  it("detects OpenClaw migration-style YAML, env secrets, workspace skills, and nested MCP servers", async () => {
    const openclawHome = path.join(tmpDir, "openclaw");
    process.env["PULSEED_IMPORT_OPENCLAW_HOME"] = openclawHome;

    await fsp.mkdir(openclawHome, { recursive: true });
    await fsp.writeFile(
      path.join(openclawHome, ".env"),
      [
        "OPENAI_API_KEY=sk-env-openai",
        "TELEGRAM_BOT_TOKEN=123456:telegram-token",
      ].join("\n"),
      "utf-8"
    );
    await fsp.writeFile(
      path.join(openclawHome, "config.yaml"),
      [
        "agents:",
        "  defaults:",
        "    model: gpt-5.4-mini",
        "models:",
        "  providers:",
        "    openai:",
        "      apiKey:",
        "        source: env",
        "        id: OPENAI_API_KEY",
        "      baseUrl: https://api.openai.com/v1",
        "channels:",
        "  telegram:",
        "    botToken: ${TELEGRAM_BOT_TOKEN}",
        "mcp:",
        "  servers:",
        "    filesystem:",
        "      command: node",
        "      args:",
        "        - server.js",
      ].join("\n"),
      "utf-8"
    );
    await fsp.mkdir(path.join(openclawHome, "workspace-main", "skills", "review"), { recursive: true });
    await fsp.writeFile(path.join(openclawHome, "workspace-main", "skills", "review", "SKILL.md"), "# Review\n", "utf-8");

    const { detectSetupImportSources } = await import("../commands/setup/import/discovery.js");
    const sources = detectSetupImportSources();
    const openclaw = sources.find((source) => source.id === "openclaw");
    const provider = openclaw?.items.find((item) => item.kind === "provider");
    const skill = openclaw?.items.find((item) => item.kind === "skill");
    const mcp = openclaw?.items.find((item) => item.kind === "mcp");

    expect(provider?.providerSettings).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-mini",
      apiKey: "sk-env-openai",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(provider?.providerSettings?.apiKey).not.toBe("123456:telegram-token");
    expect(skill?.label).toBe("review");
    expect(mcp?.mcpServer).toMatchObject({
      id: "openclaw-filesystem",
      command: "node",
      args: ["server.js"],
      enabled: false,
    });
  });

  it("imports provider API keys from the workspace env file selected by the config", async () => {
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

  it("does not pull an api key from an unrelated Hermes workspace", async () => {
    const hermesHome = path.join(tmpDir, "hermes");
    process.env["PULSEED_IMPORT_HERMES_HOME"] = hermesHome;

    await fsp.mkdir(path.join(hermesHome, "workspace-main"), { recursive: true });
    await fsp.mkdir(path.join(hermesHome, "workspace-secondary"), { recursive: true });
    await fsp.writeFile(
      path.join(hermesHome, "workspace-main", ".env"),
      "OPENAI_API_KEY=sk-workspace-main\n",
      "utf-8"
    );
    await fsp.writeFile(
      path.join(hermesHome, "workspace-secondary", ".env"),
      "OPENAI_API_KEY=sk-workspace-secondary\n",
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
      apiKey: "sk-workspace-main",
    });
    expect(provider?.providerSettings?.apiKey).not.toBe("sk-workspace-secondary");
  });

  it("prefers the actual provider object over unrelated sibling model values", async () => {
    const hermesHome = path.join(tmpDir, "hermes");
    process.env["PULSEED_IMPORT_HERMES_HOME"] = hermesHome;

    await writeJson(path.join(hermesHome, "settings.json"), {
      agents: {
        defaults: {
          model: "gpt-4o-mini-tts",
        },
      },
      provider: {
        provider: "openai",
        model: "gpt-5.4",
        adapter: "openai_codex_cli",
        apiKey: "OPENAI_API_KEY",
      },
    });
    await fsp.writeFile(path.join(hermesHome, ".env"), "OPENAI_API_KEY=sk-hermes-openai\n", "utf-8");

    const { detectSetupImportSources } = await import("../commands/setup/import/discovery.js");
    const sources = detectSetupImportSources();
    const hermes = sources.find((source) => source.id === "hermes");
    const provider = hermes?.items.find((item) => item.kind === "provider");

    expect(provider?.providerSettings).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
      adapter: "openai_codex_cli",
      apiKey: "sk-hermes-openai",
    });
  });

  it("detects USER.md from Hermes for identity import", async () => {
    const hermesHome = path.join(tmpDir, "hermes");
    process.env["PULSEED_IMPORT_HERMES_HOME"] = hermesHome;

    await writeJson(path.join(hermesHome, "settings.json"), {
      provider: "openai",
      model: "gpt-5.4",
      adapter: "openai_codex_cli",
    });
    await fsp.writeFile(
      path.join(hermesHome, "USER.md"),
      "# About You\n\nName: Imported User\nPrefers concise updates.\n",
      "utf-8"
    );

    const { detectSetupImportSources } = await import("../commands/setup/import/discovery.js");
    const sources = detectSetupImportSources();
    const hermes = sources.find((source) => source.id === "hermes");
    const user = hermes?.items.find((item) => item.kind === "user");

    expect(user?.userSettings).toEqual({
      content: "# About You\n\nName: Imported User\nPrefers concise updates.\n",
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
        {
          id: "openclaw:telegram:config.json",
          source: "openclaw",
          sourceLabel: "OpenClaw",
          kind: "telegram",
          label: "bot token / 2 allowed user(s)",
          decision: "import",
          reason: "Telegram bot and allowed-user defaults",
          telegramSettings: {
            botToken: "123456:token",
            allowedUserIds: [111, 222],
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
    expect(report.items.filter((item) => item.status === "applied")).toHaveLength(4);
    const telegramConfig = JSON.parse(
      await fsp.readFile(path.join(baseDir, "plugins", "telegram-bot", "config.json"), "utf-8")
    ) as Record<string, unknown>;
    expect(telegramConfig).toMatchObject({
      bot_token: "123456:token",
      allowed_user_ids: [111, 222],
      runtime_control_allowed_user_ids: [111, 222],
      allow_all: false,
      polling_timeout: 30,
    });

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

  it("asks which source to import from when Hermes and OpenClaw are both detected", async () => {
    vi.resetModules();
    const confirmMock = vi.fn(async () => true);
    const selectMock = vi.fn().mockResolvedValueOnce("openclaw");
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
    expect(selection?.sources.map((source) => source.id)).toEqual(["openclaw"]);
    expect(selection?.items.find((item) => item.id === "hermes-provider")).toBeUndefined();
    expect(selection?.items.find((item) => item.id === "openclaw-provider")?.decision).toBe("import");
    expect(selectMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        message: "Found existing settings!",
        options: expect.arrayContaining([
          expect.objectContaining({ label: "Migrate Hermes Agent settings" }),
          expect.objectContaining({ label: "Migrate OpenClaw settings" }),
          expect.objectContaining({ label: "Do not migrate" }),
        ]),
      })
    );
    const firstPrompt = selectMock.mock.calls[0]?.[0] as { options: Array<{ label: string }> };
    expect(firstPrompt.options.map((option) => option.label)).toEqual([
      "Migrate OpenClaw settings",
      "Migrate Hermes Agent settings",
      "Do not migrate",
    ]);
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("imports all items from the selected source without a second item-selection prompt", async () => {
    vi.resetModules();
    const confirmMock = vi.fn(async () => true);
    const selectMock = vi.fn().mockResolvedValueOnce("openclaw");
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

    expect(selection?.providerSettings).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-mini",
      adapter: "agent_loop",
    });
    expect(selection?.items.find((item) => item.id === "openclaw-provider")?.decision).toBe("import");
    expect(selection?.items.find((item) => item.id === "openclaw-skill")?.decision).toBe("import");
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(multiselectMock).not.toHaveBeenCalled();
  });
});
