import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// ─── Mock child_process.spawn ───
//
// vi.mock() is hoisted to the top of the file by vitest, so any variables
// referenced inside the factory must themselves be declared via vi.hoisted()
// to be available before the mock factory runs.

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

import { BrowserUseCLIAdapter } from "../src/adapters/agents/browser-use-cli.js";
import type { AgentTask } from "../src/execution/adapter-layer.js";

// ─── Helpers ───

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = {
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  };
  readonly kill = vi.fn();
}

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    prompt: "go to example.com and get the title",
    timeout_ms: 5000,
    adapter_type: "browser_use_cli",
    ...overrides,
  };
}

function makeFakeChild(): FakeChildProcess {
  const child = new FakeChildProcess();
  mockSpawn.mockReturnValueOnce(child);
  return child;
}

// ─── Tests ───

describe("BrowserUseCLIAdapter", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  // ─── Constructor and properties ───

  describe("constructor and properties", () => {
    it("adapterType is 'browser_use_cli'", () => {
      const adapter = new BrowserUseCLIAdapter();
      expect(adapter.adapterType).toBe("browser_use_cli");
    });

    it("capabilities include browse_web, web_scraping, form_filling, screenshot", () => {
      const adapter = new BrowserUseCLIAdapter();
      expect(adapter.capabilities).toContain("browse_web");
      expect(adapter.capabilities).toContain("web_scraping");
      expect(adapter.capabilities).toContain("form_filling");
      expect(adapter.capabilities).toContain("screenshot");
    });

    it("uses 'browser-use' as the default cliPath", async () => {
      const adapter = new BrowserUseCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.emit("close", 0);
      await executePromise;

      const [cliPath] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cliPath).toBe("browser-use");
    });

    it("uses a custom cliPath when provided", async () => {
      const adapter = new BrowserUseCLIAdapter({ cliPath: "/usr/local/bin/browser-use" });
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.emit("close", 0);
      await executePromise;

      const [cliPath] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cliPath).toBe("/usr/local/bin/browser-use");
    });
  });

  // ─── Spawn arguments ───

  describe("spawn arguments", () => {
    it("passes --headless and --json by default and writes prompt to stdin", async () => {
      const adapter = new BrowserUseCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask({ prompt: "scrape prices" }));
      child.emit("close", 0);
      await executePromise;

      const [, spawnArgs] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(spawnArgs).toEqual(["run", "--headless", "--json"]);
      expect(child.stdin.write).toHaveBeenCalledWith("scrape prices", "utf8");
    });

    it("omits --headless when headless is false", async () => {
      const adapter = new BrowserUseCLIAdapter({ headless: false });
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask({ prompt: "take screenshot" }));
      child.emit("close", 0);
      await executePromise;

      const [, spawnArgs] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(spawnArgs).not.toContain("--headless");
      expect(spawnArgs).toContain("--json");
    });

    it("omits --json when jsonOutput is false", async () => {
      const adapter = new BrowserUseCLIAdapter({ jsonOutput: false });
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask({ prompt: "fill form" }));
      child.emit("close", 0);
      await executePromise;

      const [, spawnArgs] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(spawnArgs).not.toContain("--json");
      expect(spawnArgs).toContain("--headless");
    });
  });

  // ─── Success path ───

  describe("success result (exit code 0)", () => {
    it("returns success: true on exit code 0", async () => {
      const adapter = new BrowserUseCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.stdout.emit("data", Buffer.from('{"result": "page title"}'));
      child.emit("close", 0);
      const result = await executePromise;

      expect(result.success).toBe(true);
      expect(result.exit_code).toBe(0);
      expect(result.stopped_reason).toBe("completed");
      expect(result.error).toBeNull();
    });

    it("captures stdout from the process", async () => {
      const adapter = new BrowserUseCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.stdout.emit("data", Buffer.from('{"result":'));
      child.stdout.emit("data", Buffer.from('"done"}'));
      child.emit("close", 0);
      const result = await executePromise;

      expect(result.output).toBe('{"result":"done"}');
    });

    it("elapsed_ms is a non-negative number", async () => {
      const adapter = new BrowserUseCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.emit("close", 0);
      const result = await executePromise;

      expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── Error handling ───

  describe("error result (non-zero exit code)", () => {
    it("returns success: false on non-zero exit code", async () => {
      const adapter = new BrowserUseCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.stderr.emit("data", Buffer.from("browser launch failed"));
      child.emit("close", 1);
      const result = await executePromise;

      expect(result.success).toBe(false);
      expect(result.exit_code).toBe(1);
      expect(result.stopped_reason).toBe("error");
    });

    it("includes stderr in error field when process exits with non-zero code", async () => {
      const adapter = new BrowserUseCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.stderr.emit("data", Buffer.from("error: browser-use not found"));
      child.emit("close", 127);
      const result = await executePromise;

      expect(result.error).toContain("error: browser-use not found");
    });

    it("falls back to exit code message when stderr is empty", async () => {
      const adapter = new BrowserUseCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.emit("close", 2);
      const result = await executePromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain("2");
    });
  });

  // ─── Spawn error (CLI not found) ───

  describe("spawn error (CLI not found)", () => {
    it("returns error result when the process emits an error event", async () => {
      const adapter = new BrowserUseCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.emit("error", new Error("spawn ENOENT"));
      child.emit("close", null); // Node.js always follows error with close
      const result = await executePromise;

      expect(result.success).toBe(false);
      expect(result.stopped_reason).toBe("error");
      expect(result.error).toContain("spawn ENOENT");
    });

    it("exit_code is null when process emits an error event", async () => {
      const adapter = new BrowserUseCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.emit("error", new Error("spawn ENOENT"));
      child.emit("close", null); // Node.js always follows error with close
      const result = await executePromise;

      expect(result.exit_code).toBeNull();
    });

    it("captures any stdout emitted before the error", async () => {
      const adapter = new BrowserUseCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.stdout.emit("data", Buffer.from("partial output"));
      child.emit("error", new Error("crash"));
      child.emit("close", null); // Node.js always follows error with close
      const result = await executePromise;

      expect(result.output).toBe("partial output");
    });
  });

  // ─── Timeout ───

  describe("timeout", () => {
    it("sends SIGTERM and returns timeout result when timeout_ms elapses", async () => {
      vi.useFakeTimers();

      const adapter = new BrowserUseCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask({ timeout_ms: 1000 }));

      await vi.advanceTimersByTimeAsync(1001);

      // Simulate the process being killed: emit close after SIGTERM
      child.emit("close", null);

      const result = await executePromise;
      vi.useRealTimers();

      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(result.success).toBe(false);
      expect(result.stopped_reason).toBe("timeout");
      expect(result.error).toMatch(/Timed out after 1000ms/);
    });
  });
});
