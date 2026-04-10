import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";

vi.mock("../../../base/utils/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../base/utils/paths.js")>();
  return {
    ...actual,
    getPulseedDirPath: vi.fn(() => "/tmp/pulseed-ping-test-placeholder"),
  };
});

import { getPulseedDirPath } from "../../../base/utils/paths.js";
import { cmdDaemonPing } from "../commands/daemon.js";
import { DaemonClient } from "../../../runtime/daemon/client.js";

describe("cmdDaemonPing", () => {
  let tmpDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-ping-test-");
    vi.mocked(getPulseedDirPath).mockReturnValue(tmpDir);
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
    cleanupTempDir(tmpDir);
  });

  it("reports success with timing, port, and uptime from /health", async () => {
    fs.writeFileSync(path.join(tmpDir, "daemon.json"), JSON.stringify({ event_server_port: 43123 }));
    vi.spyOn(DaemonClient.prototype, "getHealth").mockResolvedValue({
      status: "ok",
      uptime: 12.34,
    });

    const code = await cmdDaemonPing([]);

    expect(code).toBe(0);
    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Daemon pong: ok");
    expect(output).toContain("port 43123");
    expect(output).toContain("uptime 12.3s");
  });

  it("reports failure with port and daemon state detail when /health is unreachable", async () => {
    fs.writeFileSync(path.join(tmpDir, "daemon.json"), JSON.stringify({ event_server_port: 43123 }));
    fs.writeFileSync(
      path.join(tmpDir, "daemon-state.json"),
      JSON.stringify({ status: "running", pid: process.pid })
    );
    vi.spyOn(DaemonClient.prototype, "getHealth").mockRejectedValue(new Error("connect ECONNREFUSED"));
    vi.spyOn(DaemonClient.prototype, "healthCheck").mockResolvedValue(false);

    const code = await cmdDaemonPing([]);

    expect(code).toBe(1);
    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Daemon ping failed");
    expect(output).toContain("port 43123");
    expect(output).toContain("daemon state running");
    expect(output).toContain("ECONNREFUSED");
  });
});
