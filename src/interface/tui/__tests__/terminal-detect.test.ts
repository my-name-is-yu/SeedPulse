import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("terminal-detect", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear all terminal-related env vars
    delete process.env.TMUX;
    delete process.env.TERM_PROGRAM;
    delete process.env.TERM;
    delete process.env.KITTY_WINDOW_ID;
    delete process.env.ZED_TERM;
    delete process.env.WT_SESSION;
    delete process.env.VTE_VERSION;
    delete process.env.WEZTERM_PANE;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  async function loadModule() {
    // Dynamic import to pick up env changes
    return import("../flicker/terminal-detect.js");
  }

  describe("isSynchronizedOutputSupported", () => {
    it("returns false for unknown terminal", async () => {
      const { isSynchronizedOutputSupported } = await loadModule();
      expect(isSynchronizedOutputSupported()).toBe(false);
    });

    it("returns false when TMUX is set", async () => {
      process.env.TMUX = "/tmp/tmux-501/default,12345,0";
      process.env.TERM_PROGRAM = "iTerm.app";
      const { isSynchronizedOutputSupported } = await loadModule();
      expect(isSynchronizedOutputSupported()).toBe(false);
    });

    it.each([
      ["iTerm.app"],
      ["WezTerm"],
      ["WarpTerminal"],
      ["ghostty"],
      ["contour"],
      ["vscode"],
      ["alacritty"],
    ])("returns true for TERM_PROGRAM=%s", async (termProgram) => {
      process.env.TERM_PROGRAM = termProgram;
      const { isSynchronizedOutputSupported } = await loadModule();
      expect(isSynchronizedOutputSupported()).toBe(true);
    });

    it("returns true for kitty via TERM", async () => {
      process.env.TERM = "xterm-kitty";
      const { isSynchronizedOutputSupported } = await loadModule();
      expect(isSynchronizedOutputSupported()).toBe(true);
    });

    it("returns true for kitty via KITTY_WINDOW_ID", async () => {
      process.env.KITTY_WINDOW_ID = "1";
      const { isSynchronizedOutputSupported } = await loadModule();
      expect(isSynchronizedOutputSupported()).toBe(true);
    });

    it("returns true for ghostty via TERM", async () => {
      process.env.TERM = "xterm-ghostty";
      const { isSynchronizedOutputSupported } = await loadModule();
      expect(isSynchronizedOutputSupported()).toBe(true);
    });

    it("returns true for foot terminal", async () => {
      process.env.TERM = "foot";
      const { isSynchronizedOutputSupported } = await loadModule();
      expect(isSynchronizedOutputSupported()).toBe(true);
    });

    it("returns true for Windows Terminal", async () => {
      process.env.WT_SESSION = "some-session-id";
      const { isSynchronizedOutputSupported } = await loadModule();
      expect(isSynchronizedOutputSupported()).toBe(true);
    });

    it("returns true for VTE >= 6800", async () => {
      process.env.VTE_VERSION = "7000";
      const { isSynchronizedOutputSupported } = await loadModule();
      expect(isSynchronizedOutputSupported()).toBe(true);
    });

    it("returns false for VTE < 6800", async () => {
      process.env.VTE_VERSION = "6700";
      const { isSynchronizedOutputSupported } = await loadModule();
      expect(isSynchronizedOutputSupported()).toBe(false);
    });

    it("returns true for Zed editor", async () => {
      process.env.ZED_TERM = "1";
      const { isSynchronizedOutputSupported } = await loadModule();
      expect(isSynchronizedOutputSupported()).toBe(true);
    });
  });

  describe("isTmuxCC", () => {
    it("returns false without TMUX", async () => {
      const { isTmuxCC } = await loadModule();
      expect(isTmuxCC()).toBe(false);
    });

    it("returns true for tmux control mode", async () => {
      process.env.TMUX = "/tmp/tmux-501/default,12345,0";
      process.env.TERM_PROGRAM = "tmux";
      const { isTmuxCC } = await loadModule();
      expect(isTmuxCC()).toBe(true);
    });

    it("returns false for tmux without TERM_PROGRAM=tmux", async () => {
      process.env.TMUX = "/tmp/tmux-501/default,12345,0";
      process.env.TERM_PROGRAM = "iTerm.app";
      const { isTmuxCC } = await loadModule();
      expect(isTmuxCC()).toBe(false);
    });
  });
});
