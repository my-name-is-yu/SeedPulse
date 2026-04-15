import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PIDManager } from "../../../runtime/pid-manager.js";
import * as daemonClient from "../../../runtime/daemon/client.js";
import { resolveRunningDaemonConnection } from "../entry.js";

describe("resolveRunningDaemonConnection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-tui-entry-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("attaches to a live daemon process once health responds", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "daemon.json"),
      JSON.stringify({ event_server_port: 41888 }),
      "utf-8"
    );

    vi.spyOn(PIDManager.prototype, "inspect").mockResolvedValue({
      info: {
        pid: 12345,
        started_at: new Date().toISOString(),
        runtime_started_at: new Date().toISOString(),
        owner_pid: 12345,
        owner_started_at: new Date().toISOString(),
        runtime_pid: 12345,
      },
      running: true,
      runtimePid: 12345,
      ownerPid: 12345,
      alivePids: [12345],
      stalePids: [],
      verifiedPids: [12345],
      unverifiedLegacyPids: [],
    });
    const probeSpy = vi.spyOn(daemonClient, "probeDaemonHealth").mockResolvedValue({
      ok: true,
      port: 41888,
      latency_ms: 1,
      health: {
        ok: true,
        accepting_commands: true,
        task_execution_ok: true,
        runtime_kpi: null,
      },
    });
    const runningSpy = vi.spyOn(daemonClient, "isDaemonRunning");

    await expect(resolveRunningDaemonConnection(tmpDir)).resolves.toEqual({
      port: 41888,
      authToken: null,
    });
    expect(probeSpy).toHaveBeenCalledWith({ host: "127.0.0.1", port: 41888 });
    expect(runningSpy).not.toHaveBeenCalled();
  });

  it("falls back when the pid is live but daemon health never comes up", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "daemon.json"),
      JSON.stringify({ event_server_port: 41888 }),
      "utf-8"
    );

    vi.spyOn(PIDManager.prototype, "inspect")
      .mockResolvedValueOnce({
        info: {
          pid: 12345,
          started_at: new Date().toISOString(),
          runtime_started_at: new Date().toISOString(),
          owner_pid: 12345,
          owner_started_at: new Date().toISOString(),
          runtime_pid: 12345,
        },
        running: true,
        runtimePid: 12345,
        ownerPid: 12345,
        alivePids: [12345],
        stalePids: [],
        verifiedPids: [12345],
        unverifiedLegacyPids: [],
      })
      .mockResolvedValueOnce({
        info: {
          pid: 12345,
          started_at: new Date().toISOString(),
          runtime_started_at: new Date().toISOString(),
          owner_pid: 12345,
          owner_started_at: new Date().toISOString(),
          runtime_pid: 12345,
        },
        running: false,
        runtimePid: null,
        ownerPid: null,
        alivePids: [],
        stalePids: [12345],
        verifiedPids: [],
        unverifiedLegacyPids: [],
      });
    vi.spyOn(daemonClient, "probeDaemonHealth").mockResolvedValue({
      ok: false,
      port: 41888,
      latency_ms: 1,
      error: "connection refused",
    });
    const runningSpy = vi.spyOn(daemonClient, "isDaemonRunning").mockResolvedValue({
      running: false,
      port: 41888,
    });

    await expect(resolveRunningDaemonConnection(tmpDir)).resolves.toBeNull();
    expect(runningSpy).toHaveBeenCalledWith(tmpDir);
  });
});
