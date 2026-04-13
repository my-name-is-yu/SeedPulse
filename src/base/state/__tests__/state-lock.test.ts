import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { acquireLock, releaseLock } from "../state-lock.js";

describe("state-lock", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
  });

  it("basic acquire and release round-trip", async () => {
    tmpDir = makeTempDir();
    await acquireLock("goal-1", tmpDir);
    const lockDir = path.join(tmpDir, "locks", "goals", "goal-1.lock");
    expect(fs.existsSync(lockDir)).toBe(true);
    await releaseLock("goal-1", tmpDir);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("pid file is written with current process pid", async () => {
    tmpDir = makeTempDir();
    await acquireLock("goal-pid", tmpDir);
    const pidFile = path.join(tmpDir, "locks", "goals", "goal-pid.lock", "pid");
    const written = await fsp.readFile(pidFile, "utf-8");
    expect(parseInt(written.trim(), 10)).toBe(process.pid);
    await releaseLock("goal-pid", tmpDir);
  });

  it("also acquires the legacy goal-dir lock when the goal directory exists", async () => {
    tmpDir = makeTempDir();
    await fsp.mkdir(path.join(tmpDir, "goals", "goal-legacy"), { recursive: true });

    await acquireLock("goal-legacy", tmpDir);

    const stableLockDir = path.join(tmpDir, "locks", "goals", "goal-legacy.lock");
    const legacyLockDir = path.join(tmpDir, "goals", "goal-legacy", ".lock");
    expect(fs.existsSync(stableLockDir)).toBe(true);
    expect(fs.existsSync(legacyLockDir)).toBe(true);

    await releaseLock("goal-legacy", tmpDir);
    expect(fs.existsSync(stableLockDir)).toBe(false);
    expect(fs.existsSync(legacyLockDir)).toBe(false);
  });

  it("release on non-existent lock is a no-op (does not throw)", async () => {
    tmpDir = makeTempDir();
    await expect(releaseLock("no-such-goal", tmpDir)).resolves.toBeUndefined();
  });

  it("locks are per-goal: acquiring goal-A does not block goal-B", async () => {
    tmpDir = makeTempDir();
    await acquireLock("goal-A", tmpDir);
    // goal-B should acquire without contention
    await expect(acquireLock("goal-B", tmpDir)).resolves.toBeUndefined();
    await releaseLock("goal-A", tmpDir);
    await releaseLock("goal-B", tmpDir);
  });

  it("stale lock (dead PID) is cleared and re-acquired", async () => {
    tmpDir = makeTempDir();
    // Write a fake lock with a PID that cannot be alive (PID 0 is always invalid for kill)
    const lockDir = path.join(tmpDir, "locks", "goals", "goal-stale.lock");
    await fsp.mkdir(lockDir, { recursive: true });
    await fsp.writeFile(path.join(lockDir, "pid"), "999999999", "utf-8");

    // acquireLock should detect stale, remove, and succeed
    await expect(
      acquireLock("goal-stale", tmpDir, { maxRetries: 2, maxTotalMs: 300 })
    ).resolves.toBeUndefined();

    await releaseLock("goal-stale", tmpDir);
  });

  it("second acquire waits then succeeds after release", async () => {
    tmpDir = makeTempDir();
    await acquireLock("goal-seq", tmpDir);

    // Release after 80ms in background
    const releaseTimer = new Promise<void>((resolve) => {
      setTimeout(async () => {
        await releaseLock("goal-seq", tmpDir);
        resolve();
      }, 80);
    });

    // Second acquire should wait and then succeed
    const acquirePromise = acquireLock("goal-seq", tmpDir, {
      maxRetries: 8,
      initialDelayMs: 30,
      maxTotalMs: 1000,
    });

    await Promise.all([releaseTimer, acquirePromise]);
    // If we get here without throwing, the second acquire succeeded
    await releaseLock("goal-seq", tmpDir);
  });

  it("times out when lock is held by live process", async () => {
    tmpDir = makeTempDir();
    // Acquire and never release
    await acquireLock("goal-timeout", tmpDir);

    await expect(
      acquireLock("goal-timeout", tmpDir, {
        maxRetries: 2,
        initialDelayMs: 10,
        maxTotalMs: 60,
      })
    ).rejects.toThrow(/timeout|max retries/i);

    await releaseLock("goal-timeout", tmpDir);
  });
});
