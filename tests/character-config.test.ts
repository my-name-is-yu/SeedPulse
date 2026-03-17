import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../src/state-manager.js";
import { CharacterConfigManager } from "../src/traits/character-config.js";
import {
  CharacterConfigSchema,
  DEFAULT_CHARACTER_CONFIG,
} from "../src/types/character.js";
import type { CharacterConfig } from "../src/types/character.js";

// ─── Test helpers ───

function makeTempDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `motiva-character-test-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;
let manager: CharacterConfigManager;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
  manager = new CharacterConfigManager(stateManager);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── CharacterConfigSchema validation ───

describe("CharacterConfigSchema — valid values", () => {
  it("accepts all axes at minimum value (1)", () => {
    const result = CharacterConfigSchema.parse({
      caution_level: 1,
      stall_flexibility: 1,
      communication_directness: 1,
      proactivity_level: 1,
    });
    expect(result.caution_level).toBe(1);
    expect(result.stall_flexibility).toBe(1);
    expect(result.communication_directness).toBe(1);
    expect(result.proactivity_level).toBe(1);
  });

  it("accepts all axes at maximum value (5)", () => {
    const result = CharacterConfigSchema.parse({
      caution_level: 5,
      stall_flexibility: 5,
      communication_directness: 5,
      proactivity_level: 5,
    });
    expect(result.caution_level).toBe(5);
    expect(result.stall_flexibility).toBe(5);
    expect(result.communication_directness).toBe(5);
    expect(result.proactivity_level).toBe(5);
  });

  it("accepts mid-range values (2, 3, 4)", () => {
    const result = CharacterConfigSchema.parse({
      caution_level: 2,
      stall_flexibility: 3,
      communication_directness: 4,
      proactivity_level: 2,
    });
    expect(result.caution_level).toBe(2);
    expect(result.stall_flexibility).toBe(3);
    expect(result.communication_directness).toBe(4);
    expect(result.proactivity_level).toBe(2);
  });
});

describe("CharacterConfigSchema — defaults", () => {
  it("applies default values when no fields are provided", () => {
    const result = CharacterConfigSchema.parse({});
    expect(result.caution_level).toBe(2);
    expect(result.stall_flexibility).toBe(1);
    expect(result.communication_directness).toBe(3);
    expect(result.proactivity_level).toBe(2);
  });

  it("DEFAULT_CHARACTER_CONFIG matches schema defaults", () => {
    expect(DEFAULT_CHARACTER_CONFIG.caution_level).toBe(2);
    expect(DEFAULT_CHARACTER_CONFIG.stall_flexibility).toBe(1);
    expect(DEFAULT_CHARACTER_CONFIG.communication_directness).toBe(3);
    expect(DEFAULT_CHARACTER_CONFIG.proactivity_level).toBe(2);
  });

  it("applies partial defaults when some fields are omitted", () => {
    const result = CharacterConfigSchema.parse({ caution_level: 4 });
    expect(result.caution_level).toBe(4);
    expect(result.stall_flexibility).toBe(1);
    expect(result.communication_directness).toBe(3);
    expect(result.proactivity_level).toBe(2);
  });
});

describe("CharacterConfigSchema — invalid values", () => {
  it("rejects caution_level = 0 (below minimum)", () => {
    expect(() =>
      CharacterConfigSchema.parse({ caution_level: 0 })
    ).toThrow();
  });

  it("rejects caution_level = 6 (above maximum)", () => {
    expect(() =>
      CharacterConfigSchema.parse({ caution_level: 6 })
    ).toThrow();
  });

  it("rejects negative values", () => {
    expect(() =>
      CharacterConfigSchema.parse({ stall_flexibility: -1 })
    ).toThrow();
  });

  it("rejects float values (non-integer)", () => {
    expect(() =>
      CharacterConfigSchema.parse({ communication_directness: 1.5 })
    ).toThrow();
  });

  it("rejects string values", () => {
    expect(() =>
      CharacterConfigSchema.parse({ proactivity_level: "a" })
    ).toThrow();
  });

  it("rejects stall_flexibility = 0", () => {
    expect(() =>
      CharacterConfigSchema.parse({ stall_flexibility: 0 })
    ).toThrow();
  });

  it("rejects proactivity_level = 6", () => {
    expect(() =>
      CharacterConfigSchema.parse({ proactivity_level: 6 })
    ).toThrow();
  });
});

// ─── CharacterConfigManager.load ───

describe("CharacterConfigManager.load", () => {
  it("returns DEFAULT_CHARACTER_CONFIG when no file exists", () => {
    const config = manager.load();
    expect(config).toEqual(DEFAULT_CHARACTER_CONFIG);
  });

  it("returns DEFAULT_CHARACTER_CONFIG values: caution=2, stall=1, directness=3, proactivity=2", () => {
    const config = manager.load();
    expect(config.caution_level).toBe(2);
    expect(config.stall_flexibility).toBe(1);
    expect(config.communication_directness).toBe(3);
    expect(config.proactivity_level).toBe(2);
  });

  it("loads existing config from disk correctly", () => {
    const saved: CharacterConfig = {
      caution_level: 4,
      stall_flexibility: 3,
      communication_directness: 5,
      proactivity_level: 1,
    };
    manager.save(saved);

    const loaded = manager.load();
    expect(loaded.caution_level).toBe(4);
    expect(loaded.stall_flexibility).toBe(3);
    expect(loaded.communication_directness).toBe(5);
    expect(loaded.proactivity_level).toBe(1);
  });

  it("validates config from disk with Zod on load", () => {
    // Write invalid data directly to the file
    const configPath = path.join(tempDir, "character-config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ caution_level: 99 }),
      "utf-8"
    );

    expect(() => manager.load()).toThrow();
  });

  it("persists across manager instances (same stateManager)", () => {
    const config: CharacterConfig = {
      caution_level: 5,
      stall_flexibility: 5,
      communication_directness: 1,
      proactivity_level: 4,
    };
    manager.save(config);

    const manager2 = new CharacterConfigManager(stateManager);
    const loaded = manager2.load();
    expect(loaded.caution_level).toBe(5);
    expect(loaded.stall_flexibility).toBe(5);
  });
});

// ─── CharacterConfigManager.save ───

describe("CharacterConfigManager.save", () => {
  it("saves config and file exists afterward", () => {
    const config: CharacterConfig = {
      caution_level: 3,
      stall_flexibility: 2,
      communication_directness: 4,
      proactivity_level: 3,
    };
    manager.save(config);

    const configPath = path.join(tempDir, "character-config.json");
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it("saved data round-trips correctly", () => {
    const config: CharacterConfig = {
      caution_level: 1,
      stall_flexibility: 5,
      communication_directness: 2,
      proactivity_level: 5,
    };
    manager.save(config);
    const loaded = manager.load();
    expect(loaded).toEqual(config);
  });

  it("overwrites existing config on second save", () => {
    manager.save({
      caution_level: 1,
      stall_flexibility: 1,
      communication_directness: 1,
      proactivity_level: 1,
    });
    manager.save({
      caution_level: 5,
      stall_flexibility: 5,
      communication_directness: 5,
      proactivity_level: 5,
    });

    const loaded = manager.load();
    expect(loaded.caution_level).toBe(5);
    expect(loaded.stall_flexibility).toBe(5);
    expect(loaded.communication_directness).toBe(5);
    expect(loaded.proactivity_level).toBe(5);
  });

  it("saves boundary values (1 and 5) without error", () => {
    expect(() =>
      manager.save({
        caution_level: 1,
        stall_flexibility: 5,
        communication_directness: 1,
        proactivity_level: 5,
      })
    ).not.toThrow();
  });

  it("throws when saving invalid config (value out of range)", () => {
    expect(() =>
      manager.save({
        caution_level: 0,
        stall_flexibility: 1,
        communication_directness: 3,
        proactivity_level: 2,
      } as unknown as CharacterConfig)
    ).toThrow();
  });
});

// ─── CharacterConfigManager.reset ───

describe("CharacterConfigManager.reset", () => {
  it("resets to DEFAULT_CHARACTER_CONFIG values", () => {
    manager.save({
      caution_level: 5,
      stall_flexibility: 5,
      communication_directness: 5,
      proactivity_level: 5,
    });

    manager.reset();
    const loaded = manager.load();

    expect(loaded).toEqual(DEFAULT_CHARACTER_CONFIG);
  });

  it("reset creates file if it did not exist", () => {
    manager.reset();
    const configPath = path.join(tempDir, "character-config.json");
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it("reset is idempotent (calling twice still yields defaults)", () => {
    manager.reset();
    manager.reset();
    const loaded = manager.load();
    expect(loaded).toEqual(DEFAULT_CHARACTER_CONFIG);
  });
});

// ─── CharacterConfigManager.update ───

describe("CharacterConfigManager.update", () => {
  it("updates a single field and preserves others", () => {
    const updated = manager.update({ caution_level: 5 });
    expect(updated.caution_level).toBe(5);
    expect(updated.stall_flexibility).toBe(DEFAULT_CHARACTER_CONFIG.stall_flexibility);
    expect(updated.communication_directness).toBe(DEFAULT_CHARACTER_CONFIG.communication_directness);
    expect(updated.proactivity_level).toBe(DEFAULT_CHARACTER_CONFIG.proactivity_level);
  });

  it("updates multiple fields simultaneously", () => {
    const updated = manager.update({
      caution_level: 3,
      proactivity_level: 4,
    });
    expect(updated.caution_level).toBe(3);
    expect(updated.proactivity_level).toBe(4);
    expect(updated.stall_flexibility).toBe(DEFAULT_CHARACTER_CONFIG.stall_flexibility);
    expect(updated.communication_directness).toBe(DEFAULT_CHARACTER_CONFIG.communication_directness);
  });

  it("returns the updated config", () => {
    const result = manager.update({ stall_flexibility: 3 });
    expect(result.stall_flexibility).toBe(3);
  });

  it("persists the updated config to disk", () => {
    manager.update({ communication_directness: 1 });
    const loaded = manager.load();
    expect(loaded.communication_directness).toBe(1);
  });

  it("update with empty object preserves all current values", () => {
    manager.save({
      caution_level: 4,
      stall_flexibility: 2,
      communication_directness: 5,
      proactivity_level: 3,
    });
    const updated = manager.update({});
    expect(updated.caution_level).toBe(4);
    expect(updated.stall_flexibility).toBe(2);
    expect(updated.communication_directness).toBe(5);
    expect(updated.proactivity_level).toBe(3);
  });

  it("update merges on top of previously saved config (not defaults)", () => {
    manager.save({
      caution_level: 4,
      stall_flexibility: 4,
      communication_directness: 4,
      proactivity_level: 4,
    });
    const updated = manager.update({ caution_level: 1 });
    expect(updated.caution_level).toBe(1);
    expect(updated.stall_flexibility).toBe(4);
    expect(updated.communication_directness).toBe(4);
    expect(updated.proactivity_level).toBe(4);
  });

  it("throws when update produces an invalid config", () => {
    expect(() =>
      manager.update({ caution_level: 0 as unknown as 1 })
    ).toThrow();
  });

  it("chained updates apply sequentially", () => {
    manager.update({ caution_level: 3 });
    const final = manager.update({ stall_flexibility: 5 });
    expect(final.caution_level).toBe(3);
    expect(final.stall_flexibility).toBe(5);
  });
});
