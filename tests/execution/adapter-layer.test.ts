import { describe, it, expect, beforeEach, vi } from "vitest";
import { AdapterRegistry } from "../../src/execution/adapter-layer.js";
import type { IAdapter, AgentTask, AgentResult } from "../../src/execution/adapter-layer.js";

// ─── Helpers ───

function makeAdapter(type: string, capabilities?: string[]): IAdapter {
  return {
    adapterType: type,
    capabilities,
    execute: vi.fn<[AgentTask], Promise<AgentResult>>(),
  };
}

// ─── Tests ───

describe("AdapterRegistry — circuit breaker", () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
    registry.register(makeAdapter("alpha", ["code"]));
  });

  it("starts in closed state", () => {
    expect(registry.getCircuitState("alpha")).toBe("closed");
  });

  it("records failures and opens circuit after 5", () => {
    for (let i = 0; i < 4; i++) {
      registry.recordFailure("alpha");
      expect(registry.getCircuitState("alpha")).toBe("closed");
    }
    registry.recordFailure("alpha");
    expect(registry.getCircuitState("alpha")).toBe("open");
  });

  it("open circuit makes adapter unavailable", () => {
    for (let i = 0; i < 5; i++) {
      registry.recordFailure("alpha");
    }
    expect(registry.isAvailable("alpha")).toBe(false);
  });

  it("cooldown elapsed transitions to half_open and returns available", () => {
    for (let i = 0; i < 5; i++) {
      registry.recordFailure("alpha");
    }
    // Simulate cooldown elapsed by setting last_failure_at in the past.
    // Access via a fresh call that checks elapsed — we manipulate Date.now instead.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 61_000);

    expect(registry.isAvailable("alpha")).toBe(true);
    expect(registry.getCircuitState("alpha")).toBe("half_open");

    vi.restoreAllMocks();
  });

  it("success in half_open resets to closed", () => {
    for (let i = 0; i < 5; i++) {
      registry.recordFailure("alpha");
    }
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    registry.isAvailable("alpha"); // transitions to half_open
    vi.restoreAllMocks();

    registry.recordSuccess("alpha");
    expect(registry.getCircuitState("alpha")).toBe("closed");
    expect(registry.isAvailable("alpha")).toBe(true);
  });
});

describe("AdapterRegistry — selectByCapability", () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
    registry.register(makeAdapter("alpha", ["code", "shell"]));
    registry.register(makeAdapter("beta", ["code", "api"]));
    registry.register(makeAdapter("gamma", ["shell"]));
  });

  it("finds matching adapter for required capabilities", () => {
    const result = registry.selectByCapability(["code", "shell"]);
    expect(result).toBe("alpha");
  });

  it("excludes specified adapter", () => {
    const result = registry.selectByCapability(["code"], "alpha");
    expect(result).toBe("beta");
  });

  it("excludes open-circuit adapters", () => {
    for (let i = 0; i < 5; i++) {
      registry.recordFailure("alpha");
    }
    const result = registry.selectByCapability(["code", "shell"]);
    // alpha is open, beta doesn't have "shell", gamma doesn't have "code"
    expect(result).toBeNull();
  });

  it("returns null when no adapter matches", () => {
    const result = registry.selectByCapability(["unknown_capability"]);
    expect(result).toBeNull();
  });
});
