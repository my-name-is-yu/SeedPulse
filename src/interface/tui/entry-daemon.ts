import os from "os";
import path from "path";
import * as fs from "node:fs/promises";
import { PIDManager } from "../../runtime/pid-manager.js";
import { probeDaemonHealth, readDaemonAuthToken } from "../../runtime/daemon/client.js";
import { DEFAULT_PORT } from "../../runtime/port-utils.js";

const EXISTING_DAEMON_HEALTH_TIMEOUT_MS = 10_000;
const EXISTING_DAEMON_HEALTH_POLL_MS = 250;

export function getDisplayCwd(): string {
  const raw = process.cwd();
  const home = os.homedir();
  return raw.startsWith(home) ? `~${raw.slice(home.length)}` : raw;
}

export async function startDaemonDetached(baseDir: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const scriptPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "cli",
    "cli-runner.js"
  );

  const child = spawn(process.execPath, [scriptPath, "daemon", "start", "--detach"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PULSEED_HOME: baseDir },
  });
  child.unref();
}

export async function readDaemonPort(baseDir: string): Promise<number> {
  try {
    const configPath = path.join(baseDir, "daemon.json");
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const port = parsed.event_server_port;
    return typeof port === "number" && Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

export async function resolveRunningDaemonConnection(
  baseDir: string
): Promise<{ port: number; authToken?: string | null } | null> {
  const pidManager = new PIDManager(baseDir);
  const status = await pidManager.inspect();
  if (status.running) {
    const port = await readDaemonPort(baseDir);
    const authToken = readDaemonAuthToken(baseDir, port);
    const deadline = Date.now() + EXISTING_DAEMON_HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const probe = await probeDaemonHealth({ host: "127.0.0.1", port });
      if (probe.ok) {
        return { port, authToken };
      }
      const refreshed = await pidManager.inspect();
      if (!refreshed.running) break;
      await new Promise((resolve) => setTimeout(resolve, EXISTING_DAEMON_HEALTH_POLL_MS));
    }
  }

  const { isDaemonRunning } = await import("../../runtime/daemon/client.js");
  const running = await isDaemonRunning(baseDir);
  if (!running.running) return null;
  return {
    port: running.port,
    authToken: running.authToken ?? readDaemonAuthToken(baseDir, running.port),
  };
}

export async function waitForDaemon(
  baseDir: string,
  timeoutMs: number
): Promise<{ port: number; authToken?: string | null }> {
  const { isDaemonRunning } = await import("../../runtime/daemon/client.js");
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { running, port, authToken } = await isDaemonRunning(baseDir);
    if (running) return { port, authToken };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("Daemon failed to start within timeout");
}
