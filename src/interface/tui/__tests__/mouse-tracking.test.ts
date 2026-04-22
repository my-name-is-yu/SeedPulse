import { describe, expect, it, vi } from "vitest";
import { isMouseTrackingEnabled } from "../flicker/index.js";
import { attachMouseTracking } from "../flicker/MouseTracking.js";
import { DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING } from "../flicker/dec.js";

function createMockStream(): NodeJS.WriteStream & { _written: string[] } {
  const written: string[] = [];
  return {
    write: vi.fn((chunk: string) => {
      written.push(chunk);
      return true;
    }),
    _written: written,
  } as unknown as NodeJS.WriteStream & { _written: string[] };
}

describe("mouse tracking", () => {
  it("stays disabled by default so terminal selection still works", () => {
    delete process.env.PULSEED_TUI_MOUSE_TRACKING;
    expect(isMouseTrackingEnabled()).toBe(false);
  });

  it("can be re-enabled explicitly through env", () => {
    process.env.PULSEED_TUI_MOUSE_TRACKING = "true";
    expect(isMouseTrackingEnabled()).toBe(true);
    delete process.env.PULSEED_TUI_MOUSE_TRACKING;
  });

  it("enables mouse tracking on attach and disables it on cleanup", () => {
    const stream = createMockStream();

    const cleanup = attachMouseTracking(stream);

    expect(stream.write).toHaveBeenCalledWith(ENABLE_MOUSE_TRACKING);
    expect(stream._written).toContain(ENABLE_MOUSE_TRACKING);

    cleanup();

    expect(stream._written.at(-1)).toBe(DISABLE_MOUSE_TRACKING);
  });
});
