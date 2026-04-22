import type { ScrollRequest } from "./types.js";

const SGR_MOUSE_SEQUENCE = /(?:\u001b)?\[<(\d+);(\d+);(\d+)([mM])/;
const SGR_MOUSE_SEQUENCE_GLOBAL = /(?:\u001b)?\[<(\d+);(\d+);(\d+)([mM])/g;
const SHIFT_ENTER_SEQUENCE_GLOBAL = /(?:\u001b)?\[27;2;13~/g;
const BRACKETED_PASTE_START_SEQUENCE_GLOBAL = /(?:\u001b)?\[200~/g;
const BRACKETED_PASTE_END_SEQUENCE_GLOBAL = /(?:\u001b)?\[201~/g;

type ScrollKey = {
  upArrow?: boolean;
  downArrow?: boolean;
  shift?: boolean;
  meta?: boolean;
  ctrl?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
};

export type ParsedMouseEvent =
  | {
      kind: "wheel";
      direction: "up" | "down";
      x: number;
      y: number;
    }
  | {
      kind: "press" | "drag" | "release";
      button: "left" | "middle" | "right" | "other";
      x: number;
      y: number;
    };

export function parseMouseEvent(input: string): ParsedMouseEvent | null {
  const sgrMouseMatch = SGR_MOUSE_SEQUENCE.exec(input);
  if (!sgrMouseMatch) {
    return null;
  }

  const buttonCode = Number.parseInt(sgrMouseMatch[1] ?? "", 10);
  const x = Number.parseInt(sgrMouseMatch[2] ?? "", 10);
  const y = Number.parseInt(sgrMouseMatch[3] ?? "", 10);
  const suffix = sgrMouseMatch[4];
  if (
    !Number.isFinite(buttonCode) ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !suffix
  ) {
    return null;
  }

  if (buttonCode >= 64) {
    const wheelButton = buttonCode & 0b11;
    if (wheelButton === 0) {
      return { kind: "wheel", direction: "up", x, y };
    }
    if (wheelButton === 1) {
      return { kind: "wheel", direction: "down", x, y };
    }
    return null;
  }

  const button = (() => {
    switch (buttonCode & 0b11) {
      case 0:
        return "left";
      case 1:
        return "middle";
      case 2:
        return "right";
      default:
        return "other";
    }
  })();

  if (suffix === "m") {
    return { kind: "release", button, x, y };
  }

  if ((buttonCode & 0b100000) !== 0) {
    return { kind: "drag", button, x, y };
  }

  return { kind: "press", button, x, y };
}

export function getScrollRequest(
  inputChar: string,
  key: ScrollKey,
): ScrollRequest | null {
  const mouseEvent = parseMouseEvent(inputChar);
  if (mouseEvent?.kind === "wheel") {
    return { direction: mouseEvent.direction, kind: "line" };
  }
  if (key.pageUp || inputChar === "[5~") {
    return { direction: "up", kind: "page" };
  }
  if (key.pageDown || inputChar === "[6~") {
    return { direction: "down", kind: "page" };
  }
  if (key.ctrl && (inputChar === "u" || inputChar === "U")) {
    return { direction: "up", kind: "page" };
  }
  if (key.ctrl && (inputChar === "d" || inputChar === "D")) {
    return { direction: "down", kind: "page" };
  }
  if (key.meta && key.upArrow) {
    return { direction: "up", kind: "line" };
  }
  if (key.meta && key.downArrow) {
    return { direction: "down", kind: "line" };
  }
  if (key.shift && key.upArrow) {
    return { direction: "up", kind: "line" };
  }
  if (key.shift && key.downArrow) {
    return { direction: "down", kind: "line" };
  }
  return null;
}

export function stripMouseEscapeSequences(input: string): string {
  return input
    .replace(SGR_MOUSE_SEQUENCE_GLOBAL, "")
    .replace(BRACKETED_PASTE_START_SEQUENCE_GLOBAL, "")
    .replace(BRACKETED_PASTE_END_SEQUENCE_GLOBAL, "")
    .replace(SHIFT_ENTER_SEQUENCE_GLOBAL, "\n");
}
