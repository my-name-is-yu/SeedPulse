import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";
import { PIDManager } from "../pid-manager.js";
import { RuntimeWatchdog } from "../watchdog.js";
import { RuntimeHealthStore } from "../store/index.js";
import { LeaderLockManager } from "../leader-lock-manager.js";

class FakeChildProcess extends EventEmitter {
  readonly kills: Array<NodeJS.Signals | number | undefined> = [];

  constructor(public readonly pid: number) {
    super();
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    queueMicrotask(() => {
      this.emit("exit", signal === "SIGKILL" ? 137 : 0, typeof signal === "string" ? signal : null);
    });
    return true;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 20
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

async function writeLeaderRecord(runtimeRoot: string, pid: number, leaseUntil: number): Promise<void> {
  const leaderPath = path.join(runtimeRoot, "leader", "leader.json");
  await fsp.mkdir(path.dirname(leaderPath), { recursive: true });
  await fsp.writeFile(
    leaderPath,
    JSON.stringify({
      owner_token: `owner-${pid}`,
      pid,
      acquired_at: Date.now(),
      last_renewed_at: Date.now(),
      lease_until: leaseUntil,
    }),
    "utf-8"
  );
}

describe("RuntimeWatchdog", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      cleanupTempDir(tmpDir);
    }
  });

  it("restarts the child when the daemon heartbeat goes stale", async () => {
    tmpDir = makeTempDir();
    const runtimeRoot = path.join(tmpDir, "runtime");
    const pidManager = new PIDManager(tmpDir);
    const healthStore = new RuntimeHealthStore(runtimeRoot);
    const leaderLockManager = new LeaderLockManager(runtimeRoot, 60);
    await healthStore.ensureReady();

    const children: FakeChildProcess[] = [];
    const watchdog = new RuntimeWatchdog({
      pidManager,
      healthStore,
      leaderLockManager,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      startChild: () => {
        const child = new FakeChildProcess(10_000 + children.length);
        children.push(child);
        return child;
      },
      pollIntervalMs: 20,
      heartbeatTimeoutMs: 50,
      startupGraceMs: 40,
      restartBackoffMs: 10,
      maxRestartBackoffMs: 20,
      childShutdownGraceMs: 10,
    });

    const startPromise = watchdog.start();

    await waitFor(() => children.length === 1);
    await writeLeaderRecord(runtimeRoot, children[0]!.pid, Date.now() + 100);
    await healthStore.saveDaemonHealth({
      status: "ok",
      leader: true,
      checked_at: Date.now(),
      details: { pid: children[0]!.pid },
    });

    await waitFor(() => children.length === 2, 2_000, 20);
    expect(children[0]!.kills).toContain("SIGTERM");

    await writeLeaderRecord(runtimeRoot, children[1]!.pid, Date.now() + 100);
    await healthStore.saveDaemonHealth({
      status: "ok",
      leader: true,
      checked_at: Date.now(),
      details: { pid: children[1]!.pid },
    });

    watchdog.stop();
    await startPromise;

    expect(fs.existsSync(pidManager.getPath())).toBe(false);
    expect(children[1]!.kills).toContain("SIGTERM");
  });
});
