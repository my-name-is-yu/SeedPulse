import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationConfig } from "../../../runtime/types/notification.js";
import type { SetupImportSelection } from "../commands/setup/import/types.js";

const confirmMock = vi.fn();
const textMock = vi.fn();
const selectMock = vi.fn();
const noteMock = vi.fn();
const introMock = vi.fn();
const outroMock = vi.fn();
const cancelMock = vi.fn();
const logWarnMock = vi.fn();
const logInfoMock = vi.fn();
const logErrorMock = vi.fn();
const logSuccessMock = vi.fn();
const updateGlobalConfigMock = vi.fn(async () => ({
  daemon_mode: true,
  no_flicker: false,
}));

vi.mock("@clack/prompts", () => ({
  confirm: confirmMock,
  text: textMock,
  select: selectMock,
  note: noteMock,
  intro: introMock,
  outro: outroMock,
  cancel: cancelMock,
  log: {
    warn: logWarnMock,
    info: logInfoMock,
    error: logErrorMock,
    success: logSuccessMock,
  },
  isCancel: vi.fn(() => false),
}));

vi.mock("../../../base/config/global-config.js", () => ({
  updateGlobalConfig: updateGlobalConfigMock,
}));

describe("setup notification step", () => {
  beforeEach(() => {
    vi.resetModules();
    confirmMock.mockReset();
    textMock.mockReset();
    selectMock.mockReset();
    noteMock.mockReset();
    introMock.mockReset();
    outroMock.mockReset();
    cancelMock.mockReset();
    logWarnMock.mockReset();
    logInfoMock.mockReset();
    logErrorMock.mockReset();
    logSuccessMock.mockReset();
    updateGlobalConfigMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../commands/setup/steps-identity.js");
    vi.doUnmock("../commands/setup/steps-provider.js");
    vi.doUnmock("../commands/setup/steps-adapter.js");
    vi.doUnmock("../commands/setup/steps-runtime.js");
    vi.doUnmock("../commands/setup/steps-notification.js");
    vi.doUnmock("../../../base/llm/provider-config.js");
    vi.doUnmock("../../../base/config/global-config.js");
    vi.doUnmock("../../../base/config/identity-loader.js");
    vi.doUnmock("../../../runtime/daemon/client.js");
    vi.doUnmock("node:child_process");
    vi.doUnmock("node:fs");
    vi.doUnmock("../commands/setup/import/flow.js");
    vi.doUnmock("../commands/setup/import/apply.js");
  });

  it("returns null when notifications are skipped", async () => {
    confirmMock.mockResolvedValue(false);

    const { stepNotification } = await import("../commands/setup/steps-notification.js");
    const result = await stepNotification();

    expect(result).toBeNull();
    expect(textMock).not.toHaveBeenCalled();
  });

  it("returns config data without writing files", async () => {
    confirmMock.mockResolvedValue(true);
    textMock.mockResolvedValue("https://example.com/webhook");

    const { stepNotification } = await import("../commands/setup/steps-notification.js");
    const result = await stepNotification();

    expect(result).toEqual<NotificationConfig>({
      channels: [
        {
          type: "webhook",
          url: "https://example.com/webhook",
          report_types: [],
          format: "json",
        },
      ],
      plugin_notifiers: {
        mode: "all",
        routes: [],
      },
      do_not_disturb: {
        enabled: false,
        start_hour: 22,
        end_hour: 7,
        exceptions: ["urgent_alert", "approval_request"],
      },
      cooldown: {
        urgent_alert: 0,
        approval_request: 0,
        stall_escalation: 60,
        strategy_change: 30,
        goal_completion: 0,
        capability_escalation: 60,
      },
      goal_overrides: [],
      batching: {
        enabled: false,
        window_minutes: 30,
        digest_format: "compact",
      },
    });
  });

  it("rejects URLs without an http or https scheme", async () => {
    const { validateUrl } = await import("../commands/setup/steps-notification.js");

    expect(validateUrl("ftp://example.com/webhook")).toBe(
      "URL must start with http:// or https://"
    );
  });

  it("preselects custom model for non-OpenAI providers when modifying an unknown current model", async () => {
    selectMock.mockResolvedValueOnce("__custom__");
    textMock.mockResolvedValueOnce("my-custom-model");

    const { stepModel } = await import("../commands/setup/steps-provider.js");
    const result = await stepModel("anthropic", "my-custom-model");

    expect(result).toBe("my-custom-model");
    expect(selectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "__custom__",
      })
    );
    expect(textMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "my-custom-model",
      })
    );
  });

  it("shows the OpenAI model list without recommended hints", async () => {
    selectMock.mockResolvedValueOnce("gpt-5.4");

    const { stepModel } = await import("../commands/setup/steps-provider.js");
    const result = await stepModel("openai");

    expect(result).toBe("gpt-5.4");
    const prompt = selectMock.mock.calls[0]?.[0] as {
      options: Array<{ label: string; value: string; hint?: string }>;
    };
    expect(prompt.options.map((option) => option.label)).toEqual([
      "GPT-5.4",
      "GPT-5.2-Codex",
      "GPT-5.1-Codex-Max",
      "GPT-5.4-Mini",
      "GPT-5.3-Codex",
      "GPT-5.3-Codex-Spark",
      "GPT-5.2",
      "GPT-5.1-Codex-Mini",
    ]);
    expect(prompt.options.every((option) => option.hint !== "recommended")).toBe(true);
  });

  it("does not show recommended hints for execution adapters", async () => {
    selectMock.mockResolvedValueOnce("agent_loop");

    const { stepAdapter } = await import("../commands/setup/steps-adapter.js");
    const result = await stepAdapter("gpt-5.4", "openai");

    expect(result).toBe("agent_loop");
    const prompt = selectMock.mock.calls[0]?.[0] as {
      options: Array<{ hint?: string }>;
    };
    expect(prompt.options.some((option) => option.hint?.includes("recommended"))).toBe(false);
  });

  it("writes notification.json only after final confirmation", async () => {
    vi.doMock("../commands/setup/steps-identity.js", () => ({
      getBanner: () => "banner",
      stepExistingConfig: vi.fn(async () => "overwrite"),
      stepUserName: vi.fn(async () => "User"),
      stepSeedyName: vi.fn(async () => "Seedy"),
    }));
    vi.doMock("../commands/setup/steps-provider.js", () => ({
      stepRootPreset: vi.fn(async () => "default"),
      stepProvider: vi.fn(async () => "openai"),
      stepModel: vi.fn(async () => "gpt-5.4-mini"),
      stepApiKey: vi.fn(async () => "sk-test"),
    }));
    vi.doMock("../commands/setup/steps-adapter.js", () => ({
      stepAdapter: vi.fn(async () => "openai_codex_cli"),
    }));
    vi.doMock("../commands/setup/steps-runtime.js", () => ({
      ensurePulseedDir: vi.fn(() => "/tmp/pulseed-test"),
      stepDaemon: vi.fn(async () => ({ start: false, port: 41700 })),
      writeSeedMd: vi.fn(),
      writeRootMd: vi.fn(),
      writeUserMd: vi.fn(),
    }));
    vi.doMock("../../../base/llm/provider-config.js", () => ({
      MODEL_REGISTRY: {
        "gpt-5.4-mini": {
          provider: "openai",
          adapters: ["openai_codex_cli", "openai_api", "agent_loop"],
        },
      },
      loadProviderConfig: vi.fn(),
      saveProviderConfig: vi.fn(async () => {}),
      validateProviderConfig: vi.fn(() => ({ valid: true, errors: [] })),
    }));
    vi.doMock("../../../base/config/identity-loader.js", () => ({
      clearIdentityCache: vi.fn(),
    }));
    const mkdirSyncMock = vi.fn();
    const writeFileSyncMock = vi.fn();
    vi.doMock("node:fs", () => ({
      mkdirSync: mkdirSyncMock,
      writeFileSync: writeFileSyncMock,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    }));

    confirmMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    textMock.mockResolvedValueOnce("https://example.com/webhook");
    selectMock
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("save");

    const { runSetupWizard } = await import("../commands/setup-wizard.js");
    const code = await runSetupWizard();

    expect(code).toBe(0);
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      "/tmp/pulseed-test/notification.json",
      expect.stringContaining("\"channels\"")
    );
    expect(writeFileSyncMock).not.toHaveBeenCalledWith(
      expect.stringContaining("notification.json"),
      expect.anything(),
      "utf-8"
    );
    expect(mkdirSyncMock).toHaveBeenCalledWith("/tmp/pulseed-test", { recursive: true });
  });

  it("can go back to a previous setup section before saving", async () => {
    const stepUserNameMock = vi.fn()
      .mockResolvedValueOnce("User 1")
      .mockResolvedValueOnce("User 2");
    const stepSeedyNameMock = vi.fn()
      .mockResolvedValueOnce("Seedy 1")
      .mockResolvedValueOnce("Seedy 2");
    const stepProviderMock = vi.fn(async () => "openai");
    const saveProviderConfigMock = vi.fn(async () => {});
    const writeUserMdMock = vi.fn();
    const writeSeedMdMock = vi.fn();

    vi.doMock("../commands/setup/steps-identity.js", () => ({
      getBanner: () => "banner",
      stepExistingConfig: vi.fn(async () => "reset"),
      stepUserName: stepUserNameMock,
      stepSeedyName: stepSeedyNameMock,
    }));
    vi.doMock("../commands/setup/steps-provider.js", () => ({
      stepRootPreset: vi.fn(async () => "default"),
      stepProvider: stepProviderMock,
      stepModel: vi.fn(async () => "gpt-5.4-mini"),
      stepApiKey: vi.fn(async () => "sk-test"),
    }));
    vi.doMock("../commands/setup/steps-adapter.js", () => ({
      stepAdapter: vi.fn(async () => "openai_codex_cli"),
    }));
    vi.doMock("../commands/setup/steps-runtime.js", () => ({
      ensurePulseedDir: vi.fn(() => "/tmp/pulseed-test"),
      stepDaemon: vi.fn(async () => ({ start: false, port: 41700 })),
      writeSeedMd: writeSeedMdMock,
      writeRootMd: vi.fn(),
      writeUserMd: writeUserMdMock,
    }));
    vi.doMock("../commands/setup/steps-notification.js", () => ({
      stepNotification: vi.fn(async () => null),
    }));
    vi.doMock("../../../base/llm/provider-config.js", () => ({
      MODEL_REGISTRY: {
        "gpt-5.4-mini": {
          provider: "openai",
          adapters: ["openai_codex_cli", "openai_api", "agent_loop"],
        },
      },
      loadProviderConfig: vi.fn(),
      saveProviderConfig: saveProviderConfigMock,
      validateProviderConfig: vi.fn(() => ({ valid: true, errors: [] })),
    }));
    vi.doMock("../../../base/config/identity-loader.js", () => ({
      clearIdentityCache: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    }));

    confirmMock.mockResolvedValueOnce(true);
    selectMock
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("back")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("save");

    const { runSetupWizard } = await import("../commands/setup-wizard.js");
    const code = await runSetupWizard();

    expect(code).toBe(0);
    expect(stepUserNameMock).toHaveBeenCalledTimes(2);
    expect(stepProviderMock).toHaveBeenCalledTimes(2);
    expect(writeUserMdMock).toHaveBeenCalledWith("/tmp/pulseed-test", "User 2");
    expect(writeSeedMdMock).toHaveBeenCalledWith("/tmp/pulseed-test", "Seedy 2");
    expect(saveProviderConfigMock).toHaveBeenCalledTimes(1);
  });

  it("can go back from runtime settings to provider settings", async () => {
    const stepProviderMock = vi.fn(async () => "openai");
    const stepDaemonMock = vi.fn(async () => ({ start: false, port: 41700 }));
    const saveProviderConfigMock = vi.fn(async () => {});

    vi.doMock("../commands/setup/steps-identity.js", () => ({
      getBanner: () => "banner",
      stepExistingConfig: vi.fn(async () => "reset"),
      stepUserName: vi.fn(async () => "User"),
      stepSeedyName: vi.fn(async () => "Seedy"),
    }));
    vi.doMock("../commands/setup/steps-provider.js", () => ({
      stepRootPreset: vi.fn(async () => "default"),
      stepProvider: stepProviderMock,
      stepModel: vi.fn(async () => "gpt-5.4-mini"),
      stepApiKey: vi.fn(async () => "sk-test"),
    }));
    vi.doMock("../commands/setup/steps-adapter.js", () => ({
      stepAdapter: vi.fn(async () => "openai_codex_cli"),
    }));
    vi.doMock("../commands/setup/steps-runtime.js", () => ({
      ensurePulseedDir: vi.fn(() => "/tmp/pulseed-test"),
      stepDaemon: stepDaemonMock,
      writeSeedMd: vi.fn(),
      writeRootMd: vi.fn(),
      writeUserMd: vi.fn(),
    }));
    vi.doMock("../commands/setup/steps-notification.js", () => ({
      stepNotification: vi.fn(async () => null),
    }));
    vi.doMock("../../../base/llm/provider-config.js", () => ({
      MODEL_REGISTRY: {
        "gpt-5.4-mini": {
          provider: "openai",
          adapters: ["openai_codex_cli", "openai_api", "agent_loop"],
        },
      },
      loadProviderConfig: vi.fn(),
      saveProviderConfig: saveProviderConfigMock,
      validateProviderConfig: vi.fn(() => ({ valid: true, errors: [] })),
    }));
    vi.doMock("../../../base/config/identity-loader.js", () => ({
      clearIdentityCache: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    }));

    confirmMock.mockResolvedValueOnce(true);
    selectMock
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("back")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("save");

    const { runSetupWizard } = await import("../commands/setup-wizard.js");
    const code = await runSetupWizard();

    expect(code).toBe(0);
    expect(stepProviderMock).toHaveBeenCalledTimes(2);
    expect(stepDaemonMock).toHaveBeenCalledTimes(2);
    expect(saveProviderConfigMock).toHaveBeenCalledTimes(1);
  });

  it("updates only provider settings when modifying an existing config", async () => {
    const stepUserNameMock = vi.fn(async () => "User");
    const stepSeedyNameMock = vi.fn(async () => "Seedy");
    const stepDaemonMock = vi.fn(async () => ({ start: false, port: 41700 }));
    const stepNotificationMock = vi.fn(async () => null);
    const saveProviderConfigMock = vi.fn(async () => {});

    vi.doMock("../commands/setup/steps-identity.js", () => ({
      getBanner: () => "banner",
      stepExistingConfig: vi.fn(async () => "modify"),
      stepUserName: stepUserNameMock,
      stepSeedyName: stepSeedyNameMock,
    }));
    vi.doMock("../commands/setup/steps-provider.js", () => ({
      stepRootPreset: vi.fn(async () => "default"),
      stepProvider: vi.fn(async () => "openai"),
      stepModel: vi.fn(async () => "gpt-5.4-mini"),
      stepApiKey: vi.fn(async () => "sk-existing"),
    }));
    vi.doMock("../commands/setup/steps-adapter.js", () => ({
      stepAdapter: vi.fn(async () => "agent_loop"),
    }));
    vi.doMock("../commands/setup/steps-runtime.js", () => ({
      ensurePulseedDir: vi.fn(() => "/tmp/pulseed-test"),
      stepDaemon: stepDaemonMock,
      writeSeedMd: vi.fn(),
      writeRootMd: vi.fn(),
      writeUserMd: vi.fn(),
    }));
    vi.doMock("../commands/setup/steps-notification.js", () => ({
      stepNotification: stepNotificationMock,
    }));
    vi.doMock("../../../base/llm/provider-config.js", () => ({
      MODEL_REGISTRY: {
        "gpt-5.4-mini": {
          provider: "openai",
          adapters: ["openai_codex_cli", "openai_api", "agent_loop"],
        },
      },
      loadProviderConfig: vi.fn(async () => ({
        provider: "openai",
        model: "gpt-5.4-mini",
        adapter: "openai_codex_cli",
        api_key: "sk-existing",
        codex_cli_path: "/usr/local/bin/codex",
      })),
      saveProviderConfig: saveProviderConfigMock,
      validateProviderConfig: vi.fn(() => ({ valid: true, errors: [] })),
    }));
    vi.doMock("../../../base/config/identity-loader.js", () => ({
      clearIdentityCache: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    }));

    confirmMock.mockResolvedValueOnce(true);
    selectMock.mockResolvedValueOnce("save");

    const { runSetupWizard } = await import("../commands/setup-wizard.js");
    const code = await runSetupWizard();

    expect(code).toBe(0);
    expect(stepUserNameMock).not.toHaveBeenCalled();
    expect(stepSeedyNameMock).not.toHaveBeenCalled();
    expect(stepDaemonMock).not.toHaveBeenCalled();
    expect(stepNotificationMock).not.toHaveBeenCalled();
    expect(saveProviderConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.4-mini",
        adapter: "agent_loop",
        codex_cli_path: "/usr/local/bin/codex",
      })
    );
    expect((saveProviderConfigMock.mock.calls[0] as unknown[] | undefined)?.[0]).not.toHaveProperty("api_key");
  });

  it("starts daemon and gateway after saving daemon config", async () => {
    const spawnChild = {
      pid: 12345,
      unref: vi.fn(),
      once: vi.fn(),
    };
    spawnChild.once.mockImplementation((event: string, callback: () => void) => {
      if (event === "spawn") queueMicrotask(callback);
      return spawnChild;
    });
    const spawnMock = vi.fn(() => spawnChild);
    const isDaemonRunningMock = vi.fn(async () => ({ running: true, port: 41701 }));
    const updateGlobalConfigMock = vi.fn(async () => ({ daemon_mode: true, no_flicker: false }));

    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));
    vi.doMock("../../../runtime/daemon/client.js", () => ({
      isDaemonRunning: isDaemonRunningMock,
    }));
    vi.doMock("../commands/setup/steps-identity.js", () => ({
      getBanner: () => "banner",
      stepExistingConfig: vi.fn(async () => "reset"),
      stepUserName: vi.fn(async () => "User"),
      stepSeedyName: vi.fn(async () => "Seedy"),
    }));
    vi.doMock("../commands/setup/steps-provider.js", () => ({
      stepRootPreset: vi.fn(async () => "default"),
      stepProvider: vi.fn(async () => "openai"),
      stepModel: vi.fn(async () => "gpt-5.4-mini"),
      stepApiKey: vi.fn(async () => "sk-test"),
    }));
    vi.doMock("../commands/setup/steps-adapter.js", () => ({
      stepAdapter: vi.fn(async () => "openai_codex_cli"),
    }));
    vi.doMock("../commands/setup/steps-runtime.js", () => ({
      ensurePulseedDir: vi.fn(() => "/tmp/pulseed-test"),
      stepDaemon: vi.fn(async () => ({ start: true, port: 41701 })),
      writeSeedMd: vi.fn(),
      writeRootMd: vi.fn(),
      writeUserMd: vi.fn(),
    }));
    vi.doMock("../commands/setup/steps-notification.js", () => ({
      stepNotification: vi.fn(async () => null),
    }));
    vi.doMock("../../../base/llm/provider-config.js", () => ({
      MODEL_REGISTRY: {
        "gpt-5.4-mini": {
          provider: "openai",
          adapters: ["openai_codex_cli", "openai_api", "agent_loop"],
        },
      },
      loadProviderConfig: vi.fn(),
      saveProviderConfig: vi.fn(async () => {}),
      validateProviderConfig: vi.fn(() => ({ valid: true, errors: [] })),
    }));
    vi.doMock("../../../base/config/global-config.js", () => ({
      updateGlobalConfig: updateGlobalConfigMock,
    }));
    vi.doMock("../../../base/config/identity-loader.js", () => ({
      clearIdentityCache: vi.fn(),
    }));
    const writeFileSyncMock = vi.fn();
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      writeFileSync: writeFileSyncMock,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    }));

    confirmMock.mockResolvedValueOnce(true);
    selectMock
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("save");

    const { runSetupWizard } = await import("../commands/setup-wizard.js");
    const code = await runSetupWizard();

    expect(code).toBe(0);
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      "/tmp/pulseed-test/daemon.json",
      expect.stringContaining("\"event_server_port\": 41701"),
      "utf-8"
    );
    expect(updateGlobalConfigMock).toHaveBeenCalledWith({ daemon_mode: true });
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [expect.any(String), "daemon", "start", "--detach"],
      expect.objectContaining({
        detached: true,
        stdio: "ignore",
        env: expect.objectContaining({ PULSEED_HOME: "/tmp/pulseed-test" }),
      })
    );
    expect(spawnChild.unref).toHaveBeenCalled();
    expect(isDaemonRunningMock).toHaveBeenCalledWith("/tmp/pulseed-test");
    expect(logSuccessMock).toHaveBeenCalledWith(
      "Daemon and gateway started (PID: 12345) on port 41701."
    );
  });

  it("does not enable daemon mode when daemon startup fails", async () => {
    const startupError = new Error("spawn failed");
    const spawnChild = {
      pid: 12345,
      unref: vi.fn(),
      once: vi.fn(),
    };
    spawnChild.once.mockImplementation((event: string, callback: (error?: Error) => void) => {
      if (event === "error") queueMicrotask(() => callback(startupError));
      return spawnChild;
    });
    const spawnMock = vi.fn(() => spawnChild);
    const updateGlobalConfigMock = vi.fn(async () => ({ daemon_mode: true, no_flicker: false }));

    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));
    vi.doMock("../../../runtime/daemon/client.js", () => ({
      isDaemonRunning: vi.fn(async () => ({ running: false, port: 41701 })),
    }));
    vi.doMock("../commands/setup/steps-identity.js", () => ({
      getBanner: () => "banner",
      stepExistingConfig: vi.fn(async () => "reset"),
      stepUserName: vi.fn(async () => "User"),
      stepSeedyName: vi.fn(async () => "Seedy"),
    }));
    vi.doMock("../commands/setup/steps-provider.js", () => ({
      stepRootPreset: vi.fn(async () => "default"),
      stepProvider: vi.fn(async () => "openai"),
      stepModel: vi.fn(async () => "gpt-5.4-mini"),
      stepApiKey: vi.fn(async () => "sk-test"),
    }));
    vi.doMock("../commands/setup/steps-adapter.js", () => ({
      stepAdapter: vi.fn(async () => "openai_codex_cli"),
    }));
    vi.doMock("../commands/setup/steps-runtime.js", () => ({
      ensurePulseedDir: vi.fn(() => "/tmp/pulseed-test"),
      stepDaemon: vi.fn(async () => ({ start: true, port: 41701 })),
      writeSeedMd: vi.fn(),
      writeRootMd: vi.fn(),
      writeUserMd: vi.fn(),
    }));
    vi.doMock("../commands/setup/steps-notification.js", () => ({
      stepNotification: vi.fn(async () => null),
    }));
    vi.doMock("../../../base/llm/provider-config.js", () => ({
      MODEL_REGISTRY: {
        "gpt-5.4-mini": {
          provider: "openai",
          adapters: ["openai_codex_cli", "openai_api", "agent_loop"],
        },
      },
      loadProviderConfig: vi.fn(),
      saveProviderConfig: vi.fn(async () => {}),
      validateProviderConfig: vi.fn(() => ({ valid: true, errors: [] })),
    }));
    vi.doMock("../../../base/config/global-config.js", () => ({
      updateGlobalConfig: updateGlobalConfigMock,
    }));
    vi.doMock("../../../base/config/identity-loader.js", () => ({
      clearIdentityCache: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    }));

    confirmMock.mockResolvedValueOnce(true);
    selectMock
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("save");

    const { runSetupWizard } = await import("../commands/setup-wizard.js");
    const code = await runSetupWizard();

    expect(code).toBe(0);
    expect(updateGlobalConfigMock).not.toHaveBeenCalled();
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("Setup saved, but daemon/gateway did not start: spawn failed.")
    );
  });

  it("uses imported provider settings without re-asking execution prompts after importing from OpenClaw", async () => {
    const stepExistingConfigMock = vi.fn(async () => "keep");
    const stepSeedyNameMock = vi.fn(async () => "Imported Seedy");
    const stepProviderMock = vi.fn(async (initial?: string) => initial ?? "openai");
    const stepModelMock = vi.fn(async (_provider: string, initial?: string) => initial ?? "gpt-5.4-mini");
    const stepApiKeyMock = vi.fn(async (_provider: string, _detected: Record<string, boolean>, initial?: string) => initial ?? "sk-test");
    const stepAdapterMock = vi.fn(async (_model: string, _provider: string, initial?: string) => initial ?? "agent_loop");
    const stepRootPresetMock = vi.fn(async () => "default");
    const saveProviderConfigMock = vi.fn(async () => {});
    const applySetupImportSelectionMock = vi.fn(async () => ({
      created_at: "2026-04-13T00:00:00.000Z",
      sources: [{ id: "openclaw", label: "OpenClaw", rootDir: "/tmp/openclaw" }],
      items: [],
    }));

    const importSelection: SetupImportSelection = {
      sources: [{ id: "openclaw", label: "OpenClaw", rootDir: "/tmp/openclaw", items: [] }],
      items: [
        {
          id: "openclaw:provider:config.json",
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
            apiKey: "sk-imported",
          },
        },
      ],
      providerSettings: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        adapter: "agent_loop",
        apiKey: "sk-imported",
      },
    };

    vi.doMock("../commands/setup/import/flow.js", () => ({
      stepSetupImport: vi.fn(async () => importSelection),
      providerConfigPatchFromImport: vi.fn((settings: NonNullable<SetupImportSelection["providerSettings"]>) => ({
        provider: settings.provider,
        model: settings.model,
        adapter: settings.adapter,
        api_key: settings.apiKey,
      })),
    }));
    vi.doMock("../commands/setup/import/apply.js", () => ({
      applySetupImportSelection: applySetupImportSelectionMock,
    }));
    vi.doMock("../commands/setup/steps-identity.js", () => ({
      getBanner: () => "banner",
      stepExistingConfig: stepExistingConfigMock,
      stepUserName: vi.fn(async () => "User"),
      stepSeedyName: stepSeedyNameMock,
    }));
    vi.doMock("../commands/setup/steps-provider.js", () => ({
      stepRootPreset: stepRootPresetMock,
      stepProvider: stepProviderMock,
      stepModel: stepModelMock,
      stepApiKey: stepApiKeyMock,
      runCodexOAuthLogin: vi.fn(),
    }));
    vi.doMock("../commands/setup/steps-adapter.js", () => ({
      stepAdapter: stepAdapterMock,
    }));
    vi.doMock("../commands/setup/steps-runtime.js", () => ({
      ensurePulseedDir: vi.fn(() => "/tmp/pulseed-test"),
      stepDaemon: vi.fn(async () => ({ start: false, port: 41700 })),
      writeSeedMd: vi.fn(),
      writeRootMd: vi.fn(),
      writeUserMd: vi.fn(),
    }));
    vi.doMock("../commands/setup/steps-notification.js", () => ({
      stepNotification: vi.fn(async () => null),
    }));
    vi.doMock("../../../base/llm/provider-config.js", () => ({
      MODEL_REGISTRY: {
        "claude-sonnet-4-6": {
          provider: "anthropic",
          adapters: ["claude_code_cli", "claude_api", "agent_loop"],
        },
      },
      loadProviderConfig: vi.fn(),
      saveProviderConfig: saveProviderConfigMock,
      validateProviderConfig: vi.fn(() => ({ valid: true, errors: [] })),
    }));
    vi.doMock("../../../base/config/identity-loader.js", () => ({
      clearIdentityCache: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    }));

    confirmMock.mockResolvedValueOnce(true);
    selectMock
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("save");

    const { runSetupWizard } = await import("../commands/setup-wizard.js");
    const code = await runSetupWizard();

    expect(code).toBe(0);
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("API Key:   found in imported settings"),
      "Imported setup defaults"
    );
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("Provider settings were imported completely and applied as defaults."),
      "Imported setup defaults"
    );
    expect(stepExistingConfigMock).not.toHaveBeenCalled();
    expect(stepSeedyNameMock).toHaveBeenCalledTimes(1);
    expect(stepRootPresetMock).not.toHaveBeenCalled();
    expect(stepProviderMock).not.toHaveBeenCalled();
    expect(stepModelMock).not.toHaveBeenCalled();
    expect(stepAdapterMock).not.toHaveBeenCalled();
    expect(stepApiKeyMock).not.toHaveBeenCalled();
    expect(saveProviderConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        adapter: "agent_loop",
      })
    );
    expect((saveProviderConfigMock.mock.calls[0] as unknown[] | undefined)?.[0]).not.toHaveProperty("api_key");
    expect(applySetupImportSelectionMock).toHaveBeenCalledWith("/tmp/pulseed-test", importSelection);
  });

  it("uses imported USER.md and only asks for Seedy naming", async () => {
    const stepUserNameMock = vi.fn(async () => "User");
    const stepSeedyNameMock = vi.fn(async () => "Imported Seedy");
    const writeUserMdMock = vi.fn();
    const applySetupImportSelectionMock = vi.fn(async () => ({
      created_at: "2026-04-13T00:00:00.000Z",
      sources: [{ id: "hermes", label: "Hermes Agent", rootDir: "/tmp/hermes" }],
      items: [],
    }));

    const importSelection: SetupImportSelection = {
      sources: [{ id: "hermes", label: "Hermes Agent", rootDir: "/tmp/hermes", items: [] }],
      items: [
        {
          id: "hermes:user:USER.md",
          source: "hermes",
          sourceLabel: "Hermes Agent",
          kind: "user",
          label: "USER.md",
          decision: "import",
          reason: "USER.md found",
          userSettings: {
            content: "# About You\n\nName: Imported User\nPrefers concise updates.\n",
          },
        },
        {
          id: "hermes:provider:settings.json",
          source: "hermes",
          sourceLabel: "Hermes Agent",
          kind: "provider",
          label: "openai / gpt-5.4 / openai_codex_cli",
          decision: "import",
          reason: "provider defaults",
          providerSettings: {
            provider: "openai",
            model: "gpt-5.4",
            adapter: "openai_codex_cli",
          },
        },
      ],
      providerSettings: {
        provider: "openai",
        model: "gpt-5.4",
        adapter: "openai_codex_cli",
      },
      userSettings: {
        content: "# About You\n\nName: Imported User\nPrefers concise updates.\n",
      },
    };

    vi.doMock("../commands/setup/import/flow.js", () => ({
      stepSetupImport: vi.fn(async () => importSelection),
      providerConfigPatchFromImport: vi.fn((settings: NonNullable<SetupImportSelection["providerSettings"]>) => ({
        provider: settings.provider,
        model: settings.model,
        adapter: settings.adapter,
        api_key: settings.apiKey,
      })),
    }));
    vi.doMock("../commands/setup/import/apply.js", () => ({
      applySetupImportSelection: applySetupImportSelectionMock,
    }));
    vi.doMock("../commands/setup/steps-identity.js", () => ({
      getBanner: () => "banner",
      stepExistingConfig: vi.fn(async () => "keep"),
      stepUserName: stepUserNameMock,
      stepSeedyName: stepSeedyNameMock,
    }));
    vi.doMock("../commands/setup/steps-provider.js", () => ({
      stepRootPreset: vi.fn(async () => "default"),
      stepProvider: vi.fn(async () => "openai"),
      stepModel: vi.fn(async () => "gpt-5.4"),
      stepApiKey: vi.fn(async () => "sk-imported"),
      runCodexOAuthLogin: vi.fn(),
    }));
    vi.doMock("../commands/setup/steps-adapter.js", () => ({
      stepAdapter: vi.fn(async () => "openai_codex_cli"),
    }));
    vi.doMock("../commands/setup/steps-runtime.js", () => ({
      ensurePulseedDir: vi.fn(() => "/tmp/pulseed-test"),
      stepDaemon: vi.fn(async () => ({ start: false, port: 41700 })),
      writeSeedMd: vi.fn(),
      writeRootMd: vi.fn(),
      writeUserMd: writeUserMdMock,
    }));
    vi.doMock("../commands/setup/steps-notification.js", () => ({
      stepNotification: vi.fn(async () => null),
    }));
    vi.doMock("../../../base/llm/provider-config.js", () => ({
      MODEL_REGISTRY: {
        "gpt-5.4": {
          provider: "openai",
          adapters: ["openai_codex_cli", "openai_api", "agent_loop"],
        },
      },
      loadProviderConfig: vi.fn(),
      readCodexOAuthToken: vi.fn(async () => "oauth-token"),
      saveProviderConfig: vi.fn(async () => {}),
      validateProviderConfig: vi.fn(() => ({ valid: true, errors: [] })),
    }));
    vi.doMock("../../../base/config/identity-loader.js", () => ({
      clearIdentityCache: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    }));

    confirmMock.mockResolvedValueOnce(true);
    selectMock
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("save");

    const { runSetupWizard } = await import("../commands/setup-wizard.js");
    const code = await runSetupWizard();

    expect(code).toBe(0);
    expect(stepUserNameMock).not.toHaveBeenCalled();
    expect(stepSeedyNameMock).toHaveBeenCalledTimes(1);
    expect(writeUserMdMock).toHaveBeenCalledWith(
      "/tmp/pulseed-test",
      "Imported USER.md",
      "# About You\n\nName: Imported User\nPrefers concise updates.\n"
    );
    expect(applySetupImportSelectionMock).toHaveBeenCalledWith("/tmp/pulseed-test", importSelection);
  });

  it("skips execution prompts for imported Codex OAuth setups when a usable login already exists", async () => {
    const stepExistingConfigMock = vi.fn(async () => "keep");
    const stepSeedyNameMock = vi.fn(async () => "Imported Seedy");
    const stepProviderMock = vi.fn(async (initial?: string) => initial ?? "openai");
    const stepModelMock = vi.fn(async (_provider: string, initial?: string) => initial ?? "gpt-5.4");
    const stepApiKeyMock = vi.fn(async (_provider: string, _detected: Record<string, boolean>, initial?: string) => initial ?? "sk-test");
    const stepAdapterMock = vi.fn(async (_model: string, _provider: string, initial?: string) => initial ?? "openai_codex_cli");
    const stepRootPresetMock = vi.fn(async () => "default");
    const saveProviderConfigMock = vi.fn(async () => {});
    const readCodexOAuthTokenMock = vi.fn(async () => "eyJ.has.usable.oauth");
    const applySetupImportSelectionMock = vi.fn(async () => ({
      created_at: "2026-04-13T00:00:00.000Z",
      sources: [{ id: "hermes", label: "Hermes Agent", rootDir: "/tmp/hermes" }],
      items: [],
    }));

    const importSelection: SetupImportSelection = {
      sources: [{ id: "hermes", label: "Hermes Agent", rootDir: "/tmp/hermes", items: [] }],
      items: [
        {
          id: "hermes:provider:settings.json",
          source: "hermes",
          sourceLabel: "Hermes Agent",
          kind: "provider",
          label: "openai / gpt-5.4 / openai_codex_cli",
          decision: "import",
          reason: "provider defaults",
          providerSettings: {
            provider: "openai",
            model: "gpt-5.4",
            adapter: "openai_codex_cli",
          },
        },
      ],
      providerSettings: {
        provider: "openai",
        model: "gpt-5.4",
        adapter: "openai_codex_cli",
      },
    };

    vi.doMock("../commands/setup/import/flow.js", () => ({
      stepSetupImport: vi.fn(async () => importSelection),
      providerConfigPatchFromImport: vi.fn((settings: NonNullable<SetupImportSelection["providerSettings"]>) => ({
        provider: settings.provider,
        model: settings.model,
        adapter: settings.adapter,
        api_key: settings.apiKey,
      })),
    }));
    vi.doMock("../commands/setup/import/apply.js", () => ({
      applySetupImportSelection: applySetupImportSelectionMock,
    }));
    vi.doMock("../commands/setup/steps-identity.js", () => ({
      getBanner: () => "banner",
      stepExistingConfig: stepExistingConfigMock,
      stepUserName: vi.fn(async () => "User"),
      stepSeedyName: stepSeedyNameMock,
    }));
    vi.doMock("../commands/setup/steps-provider.js", () => ({
      stepRootPreset: stepRootPresetMock,
      stepProvider: stepProviderMock,
      stepModel: stepModelMock,
      stepApiKey: stepApiKeyMock,
    }));
    vi.doMock("../commands/setup/steps-adapter.js", () => ({
      stepAdapter: stepAdapterMock,
    }));
    vi.doMock("../commands/setup/steps-runtime.js", () => ({
      ensurePulseedDir: vi.fn(() => "/tmp/pulseed-test"),
      stepDaemon: vi.fn(async () => ({ start: false, port: 41700 })),
      writeSeedMd: vi.fn(),
      writeRootMd: vi.fn(),
      writeUserMd: vi.fn(),
    }));
    vi.doMock("../commands/setup/steps-notification.js", () => ({
      stepNotification: vi.fn(async () => null),
    }));
    vi.doMock("../../../base/llm/provider-config.js", () => ({
      MODEL_REGISTRY: {
        "gpt-5.4": {
          provider: "openai",
          adapters: ["openai_codex_cli", "openai_api", "agent_loop"],
        },
      },
      loadProviderConfig: vi.fn(),
      readCodexOAuthToken: readCodexOAuthTokenMock,
      saveProviderConfig: saveProviderConfigMock,
      validateProviderConfig: vi.fn(() => ({ valid: true, errors: [] })),
    }));
    vi.doMock("../../../base/config/identity-loader.js", () => ({
      clearIdentityCache: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    }));

    confirmMock.mockResolvedValueOnce(true);
    selectMock
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("save");

    const { runSetupWizard } = await import("../commands/setup-wizard.js");
    const code = await runSetupWizard();

    expect(code).toBe(0);
    expect(readCodexOAuthTokenMock).toHaveBeenCalledTimes(1);
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("Provider settings were imported completely and applied as defaults."),
      "Imported setup defaults"
    );
    expect(stepExistingConfigMock).not.toHaveBeenCalled();
    expect(stepSeedyNameMock).toHaveBeenCalledTimes(1);
    expect(stepRootPresetMock).not.toHaveBeenCalled();
    expect(stepProviderMock).not.toHaveBeenCalled();
    expect(stepModelMock).not.toHaveBeenCalled();
    expect(stepAdapterMock).not.toHaveBeenCalled();
    expect(stepApiKeyMock).not.toHaveBeenCalled();
    expect(saveProviderConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.4",
        adapter: "openai_codex_cli",
      })
    );
    expect((saveProviderConfigMock.mock.calls[0] as unknown[] | undefined)?.[0]).not.toHaveProperty("api_key");
    expect(applySetupImportSelectionMock).toHaveBeenCalledWith("/tmp/pulseed-test", importSelection);
  });

  it("falls back to execution auth handling when imported Codex OAuth setups have no usable login", async () => {
    const stepProviderMock = vi.fn(async () => "openai");
    const stepModelMock = vi.fn(async () => "gpt-5.4");
    const stepApiKeyMock = vi.fn(async () => undefined);
    const stepAdapterMock = vi.fn(async () => "openai_codex_cli");
    const saveProviderConfigMock = vi.fn(async () => {});
    const readCodexOAuthTokenMock = vi.fn(async () => undefined);

    const importSelection: SetupImportSelection = {
      sources: [{ id: "hermes", label: "Hermes Agent", rootDir: "/tmp/hermes", items: [] }],
      items: [],
      providerSettings: {
        provider: "openai",
        model: "gpt-5.4",
        adapter: "openai_codex_cli",
      },
    };

    vi.doMock("../commands/setup/import/flow.js", () => ({
      stepSetupImport: vi.fn(async () => importSelection),
      providerConfigPatchFromImport: vi.fn((settings: NonNullable<SetupImportSelection["providerSettings"]>) => ({
        provider: settings.provider,
        model: settings.model,
        adapter: settings.adapter,
        api_key: settings.apiKey,
      })),
    }));
    vi.doMock("../commands/setup/import/apply.js", () => ({
      applySetupImportSelection: vi.fn(async () => ({
        created_at: "2026-04-13T00:00:00.000Z",
        sources: [{ id: "hermes", label: "Hermes Agent", rootDir: "/tmp/hermes" }],
        items: [],
      })),
    }));
    vi.doMock("../commands/setup/steps-identity.js", () => ({
      getBanner: () => "banner",
      stepExistingConfig: vi.fn(),
      stepUserName: vi.fn(async () => "User"),
      stepSeedyName: vi.fn(async () => "Seedy"),
    }));
    vi.doMock("../commands/setup/steps-provider.js", () => ({
      stepRootPreset: vi.fn(async () => "default"),
      stepProvider: stepProviderMock,
      stepModel: stepModelMock,
      stepApiKey: stepApiKeyMock,
      runCodexOAuthLogin: vi.fn(),
    }));
    vi.doMock("../commands/setup/steps-adapter.js", () => ({
      stepAdapter: stepAdapterMock,
    }));
    vi.doMock("../commands/setup/steps-runtime.js", () => ({
      ensurePulseedDir: vi.fn(() => "/tmp/pulseed-test"),
      stepDaemon: vi.fn(async () => ({ start: false, port: 41700 })),
      writeSeedMd: vi.fn(),
      writeRootMd: vi.fn(),
      writeUserMd: vi.fn(),
    }));
    vi.doMock("../commands/setup/steps-notification.js", () => ({
      stepNotification: vi.fn(async () => null),
    }));
    vi.doMock("../../../base/llm/provider-config.js", () => ({
      MODEL_REGISTRY: {
        "gpt-5.4": {
          provider: "openai",
          adapters: ["openai_codex_cli", "openai_api", "agent_loop"],
        },
      },
      loadProviderConfig: vi.fn(),
      readCodexOAuthToken: readCodexOAuthTokenMock,
      saveProviderConfig: saveProviderConfigMock,
      validateProviderConfig: vi.fn(() => ({ valid: true, errors: [] })),
    }));
    vi.doMock("../../../base/config/identity-loader.js", () => ({
      clearIdentityCache: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    }));

    confirmMock.mockResolvedValueOnce(true);
    selectMock
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("save");

    const { runSetupWizard } = await import("../commands/setup-wizard.js");
    const code = await runSetupWizard();

    expect(code).toBe(0);
    expect(readCodexOAuthTokenMock).toHaveBeenCalledTimes(1);
    expect(stepProviderMock).not.toHaveBeenCalled();
    expect(stepModelMock).not.toHaveBeenCalled();
    expect(stepAdapterMock).not.toHaveBeenCalled();
    expect(stepApiKeyMock).toHaveBeenCalledTimes(1);
    expect(saveProviderConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.4",
        adapter: "openai_codex_cli",
      })
    );
  });

  it("explains missing imported OpenAI API key and can switch to Codex CLI", async () => {
    const stepProviderMock = vi.fn(async () => "openai");
    const stepModelMock = vi.fn(async () => "gpt-5.4");
    const stepApiKeyMock = vi.fn(async () => "sk-test");
    const stepAdapterMock = vi.fn(async () => "agent_loop");
    const saveProviderConfigMock = vi.fn(async () => {});

    const importSelection: SetupImportSelection = {
      sources: [{ id: "hermes", label: "Hermes Agent", rootDir: "/tmp/hermes", items: [] }],
      items: [],
      providerSettings: {
        provider: "openai",
        model: "gpt-5.4",
        adapter: "agent_loop",
      },
    };

    vi.doMock("../commands/setup/import/flow.js", () => ({
      stepSetupImport: vi.fn(async () => importSelection),
      providerConfigPatchFromImport: vi.fn((settings: NonNullable<SetupImportSelection["providerSettings"]>) => ({
        provider: settings.provider,
        model: settings.model,
        adapter: settings.adapter,
        api_key: settings.apiKey,
      })),
    }));
    vi.doMock("../commands/setup/import/apply.js", () => ({
      applySetupImportSelection: vi.fn(async () => ({
        created_at: "2026-04-13T00:00:00.000Z",
        sources: [{ id: "hermes", label: "Hermes Agent", rootDir: "/tmp/hermes" }],
        items: [],
      })),
    }));
    vi.doMock("../commands/setup/steps-identity.js", () => ({
      getBanner: () => "banner",
      stepExistingConfig: vi.fn(),
      stepUserName: vi.fn(async () => "User"),
      stepSeedyName: vi.fn(async () => "Seedy"),
    }));
    vi.doMock("../commands/setup/steps-provider.js", () => ({
      stepRootPreset: vi.fn(async () => "default"),
      stepProvider: stepProviderMock,
      stepModel: stepModelMock,
      stepApiKey: stepApiKeyMock,
      runCodexOAuthLogin: vi.fn(),
    }));
    vi.doMock("../commands/setup/steps-adapter.js", () => ({
      stepAdapter: stepAdapterMock,
    }));
    vi.doMock("../commands/setup/steps-runtime.js", () => ({
      ensurePulseedDir: vi.fn(() => "/tmp/pulseed-test"),
      stepDaemon: vi.fn(async () => ({ start: false, port: 41700 })),
      writeSeedMd: vi.fn(),
      writeRootMd: vi.fn(),
      writeUserMd: vi.fn(),
    }));
    vi.doMock("../commands/setup/steps-notification.js", () => ({
      stepNotification: vi.fn(async () => null),
    }));
    vi.doMock("../../../base/llm/provider-config.js", () => ({
      MODEL_REGISTRY: {
        "gpt-5.4": {
          provider: "openai",
          adapters: ["openai_codex_cli", "openai_api", "agent_loop"],
        },
      },
      loadProviderConfig: vi.fn(),
      saveProviderConfig: saveProviderConfigMock,
      validateProviderConfig: vi.fn((config: { api_key?: string; adapter: string }) => ({
        valid: config.adapter === "openai_codex_cli" || Boolean(config.api_key),
        errors: config.adapter === "openai_codex_cli" || config.api_key ? [] : ["API key required"],
      })),
    }));
    vi.doMock("../../../base/config/identity-loader.js", () => ({
      clearIdentityCache: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    }));

    delete process.env["OPENAI_API_KEY"];
    confirmMock.mockResolvedValueOnce(true);
    selectMock
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("skip")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("save");

    const { runSetupWizard } = await import("../commands/setup-wizard.js");
    const code = await runSetupWizard();

    expect(code).toBe(0);
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("OpenAI API key was not found in the imported settings."),
      "OpenAI authentication needed"
    );
    expect(stepProviderMock).not.toHaveBeenCalled();
    expect(stepModelMock).not.toHaveBeenCalled();
    expect(stepAdapterMock).not.toHaveBeenCalled();
    expect(stepApiKeyMock).not.toHaveBeenCalled();
    expect(logWarnMock).toHaveBeenCalledWith(
      "Skipping OpenAI API key. PulSeed will use OpenAI Codex CLI; run `codex login` before using it."
    );
    expect(saveProviderConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.4",
        adapter: "openai_codex_cli",
      })
    );
  });

  it("does not treat imported Codex OAuth tokens as complete OpenAI API keys", async () => {
    const stepApiKeyMock = vi.fn(async () => "sk-test");
    const runCodexOAuthLoginMock = vi.fn(async () => "eyJ.new.token");
    const saveProviderConfigMock = vi.fn(async () => {});

    const importSelection: SetupImportSelection = {
      sources: [{ id: "hermes", label: "Hermes Agent", rootDir: "/tmp/hermes", items: [] }],
      items: [],
      providerSettings: {
        provider: "openai",
        model: "gpt-5.4",
        adapter: "agent_loop",
        apiKey: "eyJ.imported.oauth",
      },
    };

    vi.doMock("../commands/setup/import/flow.js", () => ({
      stepSetupImport: vi.fn(async () => importSelection),
      providerConfigPatchFromImport: vi.fn((settings: NonNullable<SetupImportSelection["providerSettings"]>) => ({
        provider: settings.provider,
        model: settings.model,
        adapter: settings.adapter,
        api_key: settings.apiKey,
      })),
    }));
    vi.doMock("../commands/setup/import/apply.js", () => ({
      applySetupImportSelection: vi.fn(async () => ({
        created_at: "2026-04-13T00:00:00.000Z",
        sources: [{ id: "hermes", label: "Hermes Agent", rootDir: "/tmp/hermes" }],
        items: [],
      })),
    }));
    vi.doMock("../commands/setup/steps-identity.js", () => ({
      getBanner: () => "banner",
      stepExistingConfig: vi.fn(),
      stepUserName: vi.fn(async () => "User"),
      stepSeedyName: vi.fn(async () => "Seedy"),
    }));
    vi.doMock("../commands/setup/steps-provider.js", () => ({
      stepRootPreset: vi.fn(async () => "default"),
      stepProvider: vi.fn(),
      stepModel: vi.fn(),
      stepApiKey: stepApiKeyMock,
      runCodexOAuthLogin: runCodexOAuthLoginMock,
    }));
    vi.doMock("../commands/setup/steps-adapter.js", () => ({
      stepAdapter: vi.fn(),
    }));
    vi.doMock("../commands/setup/steps-runtime.js", () => ({
      ensurePulseedDir: vi.fn(() => "/tmp/pulseed-test"),
      stepDaemon: vi.fn(async () => ({ start: false, port: 41700 })),
      writeSeedMd: vi.fn(),
      writeRootMd: vi.fn(),
      writeUserMd: vi.fn(),
    }));
    vi.doMock("../commands/setup/steps-notification.js", () => ({
      stepNotification: vi.fn(async () => null),
    }));
    vi.doMock("../../../base/llm/provider-config.js", () => ({
      MODEL_REGISTRY: {
        "gpt-5.4": {
          provider: "openai",
          adapters: ["openai_codex_cli", "openai_api", "agent_loop"],
        },
      },
      loadProviderConfig: vi.fn(),
      saveProviderConfig: saveProviderConfigMock,
      validateProviderConfig: vi.fn((config: { api_key?: string; adapter: string }) => ({
        valid: config.adapter === "openai_codex_cli" || Boolean(config.api_key),
        errors: config.adapter === "openai_codex_cli" || config.api_key ? [] : ["API key required"],
      })),
    }));
    vi.doMock("../../../base/config/identity-loader.js", () => ({
      clearIdentityCache: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    }));

    delete process.env["OPENAI_API_KEY"];
    confirmMock.mockResolvedValueOnce(true);
    selectMock
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("oauth")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("save");

    const { runSetupWizard } = await import("../commands/setup-wizard.js");
    const code = await runSetupWizard();

    expect(code).toBe(0);
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("looks like a Codex OAuth token"),
      "OpenAI authentication needed"
    );
    expect(runCodexOAuthLoginMock).toHaveBeenCalledTimes(1);
    expect(stepApiKeyMock).not.toHaveBeenCalled();
    expect(saveProviderConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.4",
        adapter: "openai_codex_cli",
      })
    );
  });

  it("warns when notification config write fails", async () => {
    vi.doMock("../commands/setup/steps-identity.js", () => ({
      getBanner: () => "banner",
      stepExistingConfig: vi.fn(async () => "overwrite"),
      stepUserName: vi.fn(async () => "User"),
      stepSeedyName: vi.fn(async () => "Seedy"),
    }));
    vi.doMock("../commands/setup/steps-provider.js", () => ({
      stepRootPreset: vi.fn(async () => "default"),
      stepProvider: vi.fn(async () => "openai"),
      stepModel: vi.fn(async () => "gpt-5.4-mini"),
      stepApiKey: vi.fn(async () => "sk-test"),
    }));
    vi.doMock("../commands/setup/steps-adapter.js", () => ({
      stepAdapter: vi.fn(async () => "openai_codex_cli"),
    }));
    vi.doMock("../commands/setup/steps-runtime.js", () => ({
      ensurePulseedDir: vi.fn(() => "/tmp/pulseed-test"),
      stepDaemon: vi.fn(async () => ({ start: false, port: 41700 })),
      writeSeedMd: vi.fn(),
      writeRootMd: vi.fn(),
      writeUserMd: vi.fn(),
    }));
    vi.doMock("../../../base/llm/provider-config.js", () => ({
      MODEL_REGISTRY: {
        "gpt-5.4-mini": {
          provider: "openai",
          adapters: ["openai_codex_cli", "openai_api", "agent_loop"],
        },
      },
      loadProviderConfig: vi.fn(),
      saveProviderConfig: vi.fn(async () => {}),
      validateProviderConfig: vi.fn(() => ({ valid: true, errors: [] })),
    }));
    vi.doMock("../../../base/config/identity-loader.js", () => ({
      clearIdentityCache: vi.fn(),
    }));
    const mkdirSyncMock = vi.fn();
    const writeFileSyncMock = vi.fn((filePath: string) => {
      if (filePath.endsWith("notification.json")) {
        throw new Error("disk full");
      }
    });
    vi.doMock("node:fs", () => ({
      mkdirSync: mkdirSyncMock,
      writeFileSync: writeFileSyncMock,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    }));

    confirmMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    textMock.mockResolvedValueOnce("https://example.com/webhook");
    selectMock
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("save");

    const { runSetupWizard } = await import("../commands/setup-wizard.js");
    const code = await runSetupWizard();

    expect(code).toBe(0);
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("Setup saved, but could not save notification config: Error: disk full")
    );
  });
});
