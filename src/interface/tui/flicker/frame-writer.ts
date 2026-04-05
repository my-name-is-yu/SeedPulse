import { BSU, ESU, CURSOR_HOME, ERASE_SCREEN, parkCursor } from "./dec.js";
import { isSynchronizedOutputSupported } from "./terminal-detect.js";

export interface FrameWriter {
  /** Write a frame to the terminal, wrapped in BSU/ESU with cursor-home */
  write(frame: string): void;
  /** Request an erase-screen on the next write (deferred into BSU/ESU block) */
  requestErase(): void;
  /** Clean up resources */
  destroy(): void;
}

/**
 * Create a FrameWriter that wraps Ink's stdout output with the
 * BSU/ESU + cursor-home + deferred-erase sequence.
 *
 * Reference: Claude Code src/ink/ink.tsx render loop
 */
export function createFrameWriter(stream: NodeJS.WriteStream): FrameWriter {
  const syncSupported = isSynchronizedOutputSupported();
  // Capture raw write BEFORE any monkey-patching to avoid infinite recursion:
  // entry.ts patches process.stdout.write -> frameWriter.write -> stream.write
  // If stream.write is the patched version, it loops forever.
  const rawWrite = stream.write.bind(stream) as (s: string) => boolean;
  let needsErase = false;
  let destroyed = false;

  function getTermRows(): number {
    return stream.rows ?? 24;
  }

  return {
    write(frame: string): void {
      if (destroyed) return;

      const rows = getTermRows();
      const prefix = syncSupported ? BSU : "";
      const suffix = syncSupported ? ESU : "";
      const erase = needsErase ? ERASE_SCREEN : "";
      const park = parkCursor(rows);

      // Single rawWrite() call for atomicity — bypasses any stdout patches
      rawWrite(prefix + erase + CURSOR_HOME + frame + park + suffix);

      needsErase = false;
    },

    requestErase(): void {
      needsErase = true;
    },

    destroy(): void {
      destroyed = true;
    },
  };
}
