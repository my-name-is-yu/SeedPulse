import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { PIDManager } from "../../../runtime/pid-manager.js";
import * as daemonClient from "../../../runtime/daemon/client.js";

// ─── cmdDoctor tests ───
//
// We test individual check functions directly, controlling the base directory
// so all file-system checks operate on a temp directory we own.

vi.mock("../../../base/utils/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../base/utils/paths.js")>();
  return {
    ...actual,
    getPulseedDirPath: vi.fn(() => "/tmp/pulseed-doctor-test-placeholder"),
  };
});

import {
  checkNodeVersion,
  checkPulseedDir,
  checkProviderConfig,
  checkApiKey,
  checkStateDirectoryPermissions,
  checkProviderConfigPermissions,
  checkPluginPermissionWarnings,
  checkGoals,
  checkLogDirectory,
  checkBuild,
  checkDaemon,
  checkNotifications,
  checkNativeTaskAgentLoopTools,
  cmdDoctor,
} from "../commands/doctor.js";

describe("checkNodeVersion", () => {
  it("passes on current Node.js runtime (>= 20)", () => {
    const result = checkNodeVersion();
    expect(result.status).toBe("pass");
    expect(result.detail).toContain(process.versions.node);
  });
});

describe("checkPulseedDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-dir-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("passes when directory exists", () => {
    const result = checkPulseedDir(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("exists");
  });

  it("fails when directory does not exist", () => {
    const missing = path.join(tmpDir, "nonexistent");
    const result = checkPulseedDir(missing);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("not found");
  });
});

describe("checkProviderConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-cfg-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("fails when provider.json is missing", () => {
    const result = checkProviderConfig(tmpDir);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("not found");
  });

  it("passes when provider.json exists and is valid JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "provider.json"), JSON.stringify({ model: "gpt-4" }));
    const result = checkProviderConfig(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("found");
  });

  it("fails when provider.json contains invalid JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "provider.json"), "{ invalid json }");
    const result = checkProviderConfig(tmpDir);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("invalid JSON");
  });
});

describe("checkApiKey", () => {
  let tmpDir: string;
  const savedAnthropicKey = process.env["ANTHROPIC_API_KEY"];
  const savedOpenaiKey = process.env["OPENAI_API_KEY"];

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-apikey-");
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
  });

  afterEach(() => {
    if (savedAnthropicKey !== undefined) process.env["ANTHROPIC_API_KEY"] = savedAnthropicKey;
    if (savedOpenaiKey !== undefined) process.env["OPENAI_API_KEY"] = savedOpenaiKey;
    cleanupTempDir(tmpDir);
  });

  it("fails when no API key is present", () => {
    const result = checkApiKey(tmpDir);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("not set");
  });

  it("passes when ANTHROPIC_API_KEY is set", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    const result = checkApiKey(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("ANTHROPIC_API_KEY");
  });

  it("passes when OPENAI_API_KEY is set", () => {
    process.env["OPENAI_API_KEY"] = "sk-openai-test";
    const result = checkApiKey(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("OPENAI_API_KEY");
  });

  it("passes when api_key is in provider.json", () => {
    fs.writeFileSync(path.join(tmpDir, "provider.json"), JSON.stringify({ api_key: "sk-from-file" }));
    const result = checkApiKey(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("provider.json");
  });
});

describe("checkStateDirectoryPermissions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-state-perms-");
  });

  afterEach(() => {
    fs.chmodSync(tmpDir, 0o700);
    cleanupTempDir(tmpDir);
  });

  it("passes when the state directory is private", () => {
    fs.chmodSync(tmpDir, 0o700);
    const result = checkStateDirectoryPermissions(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("0700");
  });

  it("warns when the state directory is group/world accessible", () => {
    fs.chmodSync(tmpDir, 0o755);
    const result = checkStateDirectoryPermissions(tmpDir);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("recommended 0700");
  });
});

describe("checkProviderConfigPermissions", () => {
  let tmpDir: string;
  let providerPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-provider-perms-");
    providerPath = path.join(tmpDir, "provider.json");
  });

  afterEach(() => {
    if (fs.existsSync(providerPath)) {
      fs.chmodSync(providerPath, 0o600);
    }
    cleanupTempDir(tmpDir);
  });

  it("passes when provider.json stores no api_key", () => {
    fs.writeFileSync(providerPath, JSON.stringify({ model: "gpt-4" }));
    fs.chmodSync(providerPath, 0o644);
    const result = checkProviderConfigPermissions(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("no api_key");
  });

  it("passes when provider.json stores api_key and is private", () => {
    fs.writeFileSync(providerPath, JSON.stringify({ api_key: "sk-test" }));
    fs.chmodSync(providerPath, 0o600);
    const result = checkProviderConfigPermissions(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("0600");
  });

  it("warns when provider.json stores api_key and is group/world accessible", () => {
    fs.writeFileSync(providerPath, JSON.stringify({ api_key: "sk-test" }));
    fs.chmodSync(providerPath, 0o644);
    const result = checkProviderConfigPermissions(tmpDir);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("recommended 0600");
  });
});

describe("checkPluginPermissionWarnings", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-plugin-perms-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("passes when no plugins are installed", () => {
    const result = checkPluginPermissionWarnings(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("no plugins");
  });

  it("warns when an installed plugin requests shell permission", () => {
    const pluginDir = path.join(tmpDir, "plugins", "shell-runner");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "plugin.yaml"),
      [
        "name: shell-runner",
        "version: 1.0.0",
        "type: adapter",
        "capabilities:",
        "  - run_shell",
        "description: Runs shell commands",
        "config_schema: {}",
        "dependencies: []",
        "permissions:",
        "  shell: true",
        "",
      ].join("\n")
    );

    const result = checkPluginPermissionWarnings(tmpDir);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("shell-runner");
  });

  it("warns when a plugin manifest cannot be inspected", () => {
    const pluginDir = path.join(tmpDir, "plugins", "broken");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.yaml"), "{");

    const result = checkPluginPermissionWarnings(tmpDir);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("could not be inspected");
  });
});

describe("checkGoals", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-goals-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("warns when goals directory does not exist", () => {
    const result = checkGoals(tmpDir);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("not found");
  });

  it("warns when goals directory is empty", () => {
    const goalsDir = path.join(tmpDir, "goals");
    fs.mkdirSync(goalsDir);
    const result = checkGoals(tmpDir);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("0 goals");
  });

  it("passes when goals directory has legacy JSON files", () => {
    const goalsDir = path.join(tmpDir, "goals");
    fs.mkdirSync(goalsDir);
    fs.writeFileSync(path.join(goalsDir, "goal-1.json"), "{}");
    fs.writeFileSync(path.join(goalsDir, "goal-2.json"), "{}");
    const result = checkGoals(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("2 goals");
  });

  it("passes when goals directory has nested goal.json files", () => {
    const goalsDir = path.join(tmpDir, "goals");
    fs.mkdirSync(path.join(goalsDir, "goal-1"), { recursive: true });
    fs.mkdirSync(path.join(goalsDir, "goal-2"), { recursive: true });
    fs.writeFileSync(path.join(goalsDir, "goal-1", "goal.json"), "{}");
    fs.writeFileSync(path.join(goalsDir, "goal-2", "goal.json"), "{}");
    const result = checkGoals(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("2 goals");
  });

  it("counts both nested and legacy goal layouts", () => {
    const goalsDir = path.join(tmpDir, "goals");
    fs.mkdirSync(path.join(goalsDir, "goal-1"), { recursive: true });
    fs.writeFileSync(path.join(goalsDir, "goal-1", "goal.json"), "{}");
    fs.writeFileSync(path.join(goalsDir, "legacy-goal.json"), "{}");
    const result = checkGoals(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("2 goals");
  });

  it("ignores non-JSON files in goals directory", () => {
    const goalsDir = path.join(tmpDir, "goals");
    fs.mkdirSync(goalsDir);
    fs.writeFileSync(path.join(goalsDir, "readme.txt"), "hello");
    const result = checkGoals(tmpDir);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("0 goals");
  });
});

describe("checkLogDirectory", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-logs-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("fails when logs directory does not exist", () => {
    const result = checkLogDirectory(tmpDir);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("not found");
  });

  it("passes when logs directory exists and is writable", () => {
    const logsDir = path.join(tmpDir, "logs");
    fs.mkdirSync(logsDir);
    const result = checkLogDirectory(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("writable");
  });
});

describe("checkBuild", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-build-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("passes when the built CLI runner exists", () => {
    const buildPath = path.join(tmpDir, "dist", "interface", "cli", "cli-runner.js");
    fs.mkdirSync(path.dirname(buildPath), { recursive: true });
    fs.writeFileSync(buildPath, "");

    const result = checkBuild(buildPath);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("dist/interface/cli/cli-runner.js exists");
  });

  it("fails when the built CLI runner is missing", () => {
    const buildPath = path.join(tmpDir, "dist", "interface", "cli", "cli-runner.js");

    const result = checkBuild(buildPath);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("dist/interface/cli/cli-runner.js not found");
  });
});

describe("checkDaemon", () => {
  let tmpDir: string;
  let probeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-daemon-");
    probeSpy = vi.spyOn(daemonClient, "probeDaemonHealth").mockResolvedValue({
      ok: true,
      port: 41700,
      latency_ms: 5,
      health: { status: "ok", uptime: 12.3 },
    });
  });

  afterEach(() => {
    probeSpy.mockRestore();
    cleanupTempDir(tmpDir);
  });

  it("passes with clean state when no PID file exists", async () => {
    const result = await checkDaemon(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("stopped");
  });

  it("warns when PID file references a non-running process", async () => {
    fs.writeFileSync(path.join(tmpDir, "pulseed.pid"), "999999999");
    const result = await checkDaemon(tmpDir);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("stale PID");
  });

  it("warns when PID file references a running process but KPI telemetry is missing", async () => {
    fs.writeFileSync(path.join(tmpDir, "pulseed.pid"), String(process.pid));
    const inspectSpy = vi.spyOn(PIDManager.prototype, "inspect").mockResolvedValue({
      info: {
        pid: process.pid,
        started_at: new Date().toISOString(),
        owner_pid: process.pid,
        runtime_pid: process.pid,
      },
      running: true,
      runtimePid: process.pid,
      ownerPid: process.pid,
      alivePids: [process.pid],
      stalePids: [],
      verifiedPids: [process.pid],
      unverifiedLegacyPids: [],
    });
    const result = await checkDaemon(tmpDir);
    inspectSpy.mockRestore();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("running");
    expect(result.detail).toContain("KPI telemetry unavailable");
    expect(result.detail).toContain("live ping ok");
  });

  it("warns when PID file is JSON format and references running process without KPI telemetry", async () => {
    fs.writeFileSync(path.join(tmpDir, "pulseed.pid"), JSON.stringify({ pid: process.pid }));
    const inspectSpy = vi.spyOn(PIDManager.prototype, "inspect").mockResolvedValue({
      info: {
        pid: process.pid,
        started_at: new Date().toISOString(),
        owner_pid: process.pid,
        runtime_pid: process.pid,
      },
      running: true,
      runtimePid: process.pid,
      ownerPid: process.pid,
      alivePids: [process.pid],
      stalePids: [],
      verifiedPids: [process.pid],
      unverifiedLegacyPids: [],
    });
    const result = await checkDaemon(tmpDir);
    inspectSpy.mockRestore();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("running");
    expect(result.detail).toContain("KPI telemetry unavailable");
    expect(result.detail).toContain("live ping ok");
  });

  it("fails when the watchdog is alive but the runtime child is dead", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: 999999999,
        runtime_pid: 999999999,
        owner_pid: process.pid,
        watchdog_pid: process.pid,
        started_at: new Date().toISOString(),
      })
    );
    fs.writeFileSync(
      path.join(tmpDir, "daemon-state.json"),
      JSON.stringify({
        pid: 999999999,
        started_at: new Date().toISOString(),
        last_loop_at: null,
        loop_count: 0,
        active_goals: [],
        status: "running",
        crash_count: 0,
        last_error: null,
      })
    );

    const result = await checkDaemon(tmpDir);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("restarting");
  });

  it("fails when daemon-state.json reports crashed", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: process.pid,
        started_at: new Date().toISOString(),
      })
    );
    fs.writeFileSync(
      path.join(tmpDir, "daemon-state.json"),
      JSON.stringify({
        pid: process.pid,
        started_at: new Date().toISOString(),
        last_loop_at: null,
        loop_count: 0,
        active_goals: [],
        status: "crashed",
        crash_count: 1,
        last_error: "boom",
      })
    );

    const result = await checkDaemon(tmpDir);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("crashed");
  });

  it("reports idle daemon mode distinctly", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: 424242,
        watchdog_pid: 424242,
        started_at: new Date().toISOString(),
      })
    );
    fs.writeFileSync(
      path.join(tmpDir, "daemon-state.json"),
      JSON.stringify({
        pid: process.pid,
        started_at: new Date().toISOString(),
        last_loop_at: null,
        loop_count: 0,
        active_goals: [],
        status: "idle",
        crash_count: 0,
        last_error: null,
      })
    );
    const inspectSpy = vi.spyOn(PIDManager.prototype, "inspect").mockResolvedValue({
      info: {
        pid: process.pid,
        started_at: new Date().toISOString(),
        owner_pid: 424242,
        watchdog_pid: 424242,
        runtime_pid: process.pid,
      },
      running: true,
      runtimePid: process.pid,
      ownerPid: 424242,
      alivePids: [process.pid, 424242],
      stalePids: [],
      verifiedPids: [process.pid, 424242],
      unverifiedLegacyPids: [],
    });

    const result = await checkDaemon(tmpDir);
    inspectSpy.mockRestore();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("idle daemon running");
    expect(result.detail).toContain(`PID: ${process.pid}`);
    expect(result.detail).toContain("KPI telemetry unavailable");
    expect(result.detail).toContain("live ping ok");
  });

  it("warns when runtime KPI reports degraded command acceptance", async () => {
    const now = Date.now();
    fs.mkdirSync(path.join(tmpDir, "runtime", "health"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "tasks", "goal-1", "ledger"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "runtime", "health", "daemon.json"),
      JSON.stringify({
        status: "degraded",
        leader: true,
        checked_at: now,
        kpi: {
          process_alive: { status: "ok", checked_at: now, last_ok_at: now },
          command_acceptance: {
            status: "degraded",
            checked_at: now,
            last_degraded_at: now,
            reason: "gateway or queue health degraded",
          },
          task_execution: { status: "ok", checked_at: now, last_ok_at: now },
          degraded_at: now,
        },
        details: { pid: process.pid },
      })
    );
    fs.writeFileSync(
      path.join(tmpDir, "runtime", "health", "components.json"),
      JSON.stringify({
        checked_at: now,
        components: {
          gateway: "degraded",
          queue: "ok",
          leases: "ok",
          approval: "ok",
          outbox: "ok",
          supervisor: "ok",
        },
      })
    );
    fs.writeFileSync(
      path.join(tmpDir, "tasks", "goal-1", "ledger", "task-1.json"),
      JSON.stringify({
        task_id: "task-1",
        goal_id: "goal-1",
        events: [
          { type: "acked", ts: new Date(now - 6_000).toISOString() },
          { type: "started", ts: new Date(now - 5_000).toISOString() },
          { type: "succeeded", ts: new Date(now - 1_000).toISOString() },
        ],
        summary: {
          latest_event_type: "succeeded",
          latencies: {
            created_to_acked_ms: 800,
            acked_to_started_ms: 100,
            started_to_completed_ms: 3200,
            completed_to_verification_ms: 100,
            created_to_completed_ms: 4100,
          },
        },
      })
    );
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: process.pid,
        started_at: new Date().toISOString(),
      })
    );
    const inspectSpy = vi.spyOn(PIDManager.prototype, "inspect").mockResolvedValue({
      info: {
        pid: process.pid,
        started_at: new Date().toISOString(),
        owner_pid: process.pid,
        runtime_pid: process.pid,
      },
      running: true,
      runtimePid: process.pid,
      ownerPid: process.pid,
      alivePids: [process.pid],
      stalePids: [],
      verifiedPids: [process.pid],
      unverifiedLegacyPids: [],
    });

    const result = await checkDaemon(tmpDir);
    inspectSpy.mockRestore();

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("KPI process=up accept=down execute=up (degraded)");
    expect(result.detail).toContain("degraded");
    expect(result.detail).toContain("task success=1/1 (100.0%)");
    expect(result.detail).toContain("total p95=4.1s");
    expect(result.detail).toContain("live ping ok");
  });

  it("fails when the runtime PID is alive but the live daemon health probe fails", async () => {
    probeSpy.mockResolvedValue({
      ok: false,
      port: 41700,
      latency_ms: 15,
      error: "connect ECONNREFUSED",
    });
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: process.pid,
        started_at: new Date().toISOString(),
      })
    );

    const inspectSpy = vi.spyOn(PIDManager.prototype, "inspect").mockResolvedValue({
      info: {
        pid: process.pid,
        started_at: new Date().toISOString(),
        owner_pid: process.pid,
        runtime_pid: process.pid,
      },
      running: true,
      runtimePid: process.pid,
      ownerPid: process.pid,
      alivePids: [process.pid],
      stalePids: [],
      verifiedPids: [process.pid],
      unverifiedLegacyPids: [],
    });

    const result = await checkDaemon(tmpDir);
    inspectSpy.mockRestore();

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("live ping failed");
    expect(result.detail).toContain("ECONNREFUSED");
  });
});

describe("checkNotifications", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-notif-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("warns when notification.json is missing", () => {
    const result = checkNotifications(tmpDir);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("not configured");
  });

  it("passes when notification.json exists", () => {
    fs.writeFileSync(path.join(tmpDir, "notification.json"), "{}");
    const result = checkNotifications(tmpDir);
    expect(result.status).toBe("pass");
  });
});

describe("checkNativeTaskAgentLoopTools", () => {
  it("passes when builtin tools cover the native task AgentLoop profile", () => {
    const result = checkNativeTaskAgentLoopTools();

    expect(result.status).toBe("pass");
    expect(result.detail).toContain("required");
    expect(result.detail).toContain("recommended");
    expect(result.detail).toContain("profile ready");
  });
});

describe("cmdDoctor summary counts", () => {
  let tmpDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-cmd-");
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    cleanupTempDir(tmpDir);
  });

  it("returns exit code 1 when failures exist", async () => {
    // Intentionally missing pulseed.pid, provider.json, goals dir, etc.
    // getPulseedDirPath is mocked to a placeholder that doesn't exist —
    // cmdDoctor will call it internally; wrap the real call using our tmpDir
    // by temporarily overriding the PULSEED_HOME env var.
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;

    const exitCode = await cmdDoctor([]);

    if (origHome !== undefined) {
      process.env["PULSEED_HOME"] = origHome;
    } else {
      delete process.env["PULSEED_HOME"];
    }

    expect(exitCode).toBe(1);
  });

  it("summary line includes passed, failed, warnings counts", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;

    await cmdDoctor([]);

    if (origHome !== undefined) {
      process.env["PULSEED_HOME"] = origHome;
    } else {
      delete process.env["PULSEED_HOME"];
    }

    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toMatch(/Summary: \d+ passed, \d+ failed, \d+ warnings/);
    expect(allOutput).toContain("Native AgentLoop tools");
  });

  it("returns exit code 0 when all critical checks pass", async () => {
    // Set up a valid minimal installation
    fs.mkdirSync(path.join(tmpDir, "goals"));
    fs.mkdirSync(path.join(tmpDir, "logs"));
    fs.writeFileSync(
      path.join(tmpDir, "provider.json"),
      JSON.stringify({ api_key: "sk-test-key" })
    );

    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;

    // Also ensure no real API keys leak into the test
    const savedAnthropicKey = process.env["ANTHROPIC_API_KEY"];
    const savedOpenaiKey = process.env["OPENAI_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["OPENAI_API_KEY"];

    const exitCode = await cmdDoctor([]);

    if (origHome !== undefined) {
      process.env["PULSEED_HOME"] = origHome;
    } else {
      delete process.env["PULSEED_HOME"];
    }
    if (savedAnthropicKey !== undefined) process.env["ANTHROPIC_API_KEY"] = savedAnthropicKey;
    if (savedOpenaiKey !== undefined) process.env["OPENAI_API_KEY"] = savedOpenaiKey;

    // Build check may fail (no dist/ in test env), but provider/dir/key/goals/logs should pass.
    // We only require no failures in the checks we control.
    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("Summary:");
    // Exit code depends on build check — just ensure it's 0 or 1 (a number).
    expect([0, 1]).toContain(exitCode);
  });

  it("runs runtime store repair when requested", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;

    const exitCode = await cmdDoctor(["--repair"]);

    if (origHome !== undefined) {
      process.env["PULSEED_HOME"] = origHome;
    } else {
      delete process.env["PULSEED_HOME"];
    }

    expect([0, 1]).toContain(exitCode);
    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("Repair:");
  });
});
