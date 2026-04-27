import React, { useCallback, useState } from "react";
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { Box, Text, useInput } from "ink";
import { copyToClipboard, getClipboardContent, type ClipboardResult } from "./clipboard.js";
import { logTuiDebug } from "./debug-log.js";
import { pickSpinnerVerb } from "./spinner-verbs.js";
import {
  buildHiddenCursorEscapeFromPosition,
  PROTECTED_ROW_MARKER,
  setActiveCursorEscape,
} from "./cursor-tracker.js";
import { isBashModeInput } from "./bash-mode.js";
import { buildChatViewport } from "./chat/viewport.js";
import {
  getScrollLineStep,
  getScrollRequest,
  normalizeTerminalInputChunk,
  parseMouseEvent,
} from "./chat/scroll.js";
import type { ChatMessage } from "./chat/types.js";
import { writeTrustedTuiControl } from "./terminal-output.js";
import {
  CURSOR_HOME,
  ENTER_ALT_SCREEN,
  ERASE_SCREEN,
  EXIT_ALT_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
} from "./flicker/dec.js";
import {
  buildCollapsedPasteRange,
  buildComposerLines,
  buildFullscreenChatRenderLines,
  buildTranscriptRenderLines,
  buildTranscriptRows,
  copySelectedInputText,
  extractClickableTargetAt,
  formatCopyToast,
  formatTranscript,
  getCursorPositionFromComposerLayout,
  getMouseOffsetFromComposer,
  getMousePositionFromBody,
  getSelectedBodyText,
  getSelectedInputText,
  getSuggestions,
  normalizeBodySelection,
  normalizeSelection,
  shouldCollapsePastedText,
  type BodySelectionPoint,
  type BodySelectionRange,
  type BodySelectionState,
  type CollapsedPasteRange,
  type ComposerLayout,
  type RenderLine,
  type SelectionRange,
  type SelectionState,
} from "./fullscreen-chat-render.js";

export {
  buildComposerLines,
  buildFullscreenChatRenderLines,
  buildTranscriptRenderLines,
  buildCollapsedPasteRange,
  copySelectedInputText,
  extractClickableTargetAt,
  formatTranscript,
  getSelectedBodyText,
  getSelectedInputText,
  shouldCollapsePastedText,
} from "./fullscreen-chat-render.js";

interface FullscreenChatProps {
  messages: ChatMessage[];
  onSubmit: (input: string) => void;
  onClear?: () => void;
  isProcessing: boolean;
  goalNames?: string[];
  availableRows: number;
  availableCols: number;
  cursorOriginX?: number;
  cursorOriginY?: number;
}

const SCROLL_LINE_STEP = 1;
const SCROLL_ANIMATION_INTERVAL_MS = 16;
const PROCESSING_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const PROCESSING_SPINNER_INTERVAL_MS = 80;

function getPreviousOffset(text: string, offset: number): number {
  if (offset <= 0) return 0;
  const previous = offset - 1;
  const previousCode = text.charCodeAt(previous);
  if (
    previous > 0 &&
    previousCode >= 0xdc00 &&
    previousCode <= 0xdfff
  ) {
    const lead = text.charCodeAt(previous - 1);
    if (lead >= 0xd800 && lead <= 0xdbff) {
      return previous - 1;
    }
  }
  return previous;
}

function getNextOffset(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  const code = text.charCodeAt(offset);
  if (
    offset + 1 < text.length &&
    code >= 0xd800 &&
    code <= 0xdbff
  ) {
    const trail = text.charCodeAt(offset + 1);
    if (trail >= 0xdc00 && trail <= 0xdfff) {
      return offset + 2;
    }
  }
  return offset + 1;
}

function isBackspaceInput(
  inputChar: string,
  key: { backspace?: boolean; delete?: boolean; ctrl?: boolean },
): boolean {
  return (
    key.backspace === true ||
    inputChar === "\u007f" ||
    inputChar === "\b" ||
    (key.ctrl === true && inputChar === "h") ||
    (key.delete === true && inputChar === "")
  );
}

function isDeleteInput(inputChar: string, key: { delete?: boolean }): boolean {
  return inputChar === "[3~" || inputChar === "\u001b[3~";
}

function summarizeKey(key: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(key).filter(([, value]) => value === true),
  );
}

function openClickableTarget(target: string): boolean {
  if (/^https?:\/\//.test(target)) {
    if (process.platform === "darwin") {
      return spawnSync("open", [target], { stdio: "ignore" }).status === 0;
    }
    if (process.platform === "linux") {
      return spawnSync("xdg-open", [target], { stdio: "ignore" }).status === 0;
    }
    return false;
  }

  const [filePart, linePart] = target.split(/:(\d+)$/);
  const resolvedPath = path.resolve(process.cwd(), filePart || target);
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (editor) {
    const editorTarget = linePart ? `${resolvedPath}:${linePart}` : resolvedPath;
    return spawnSync(editor, [editorTarget], { stdio: "ignore", shell: true }).status === 0;
  }
  if (process.platform === "darwin") {
    return spawnSync("open", [resolvedPath], { stdio: "ignore" }).status === 0;
  }
  if (process.platform === "linux") {
    return spawnSync("xdg-open", [resolvedPath], { stdio: "ignore" }).status === 0;
  }
  return false;
}

function writeTranscriptToNativeScrollback(messages: ChatMessage[]): void {
  const transcript = formatTranscript(messages);
  writeTrustedTuiControl(
    SHOW_CURSOR +
      EXIT_ALT_SCREEN +
      `\n${transcript}\n` +
      ENTER_ALT_SCREEN +
      ERASE_SCREEN +
      CURSOR_HOME +
      HIDE_CURSOR,
  );
}

function openTranscriptInEditor(messages: ChatMessage[]): ClipboardResult {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) {
    return { ok: false };
  }

  const dir = mkdtempSync(path.join(tmpdir(), "pulseed-transcript-"));
  const filePath = path.join(dir, "transcript.md");
  writeFileSync(filePath, formatTranscript(messages), "utf8");
  writeTrustedTuiControl(SHOW_CURSOR + EXIT_ALT_SCREEN);
  const result = spawnSync(editor, [filePath], { stdio: "inherit", shell: true });
  writeTrustedTuiControl(ENTER_ALT_SCREEN + ERASE_SCREEN + CURSOR_HOME + HIDE_CURSOR);
  return result.status === 0 ? { ok: true, method: "osc52" } : { ok: false };
}


export function FullscreenChat({
  messages,
  onSubmit,
  onClear,
  isProcessing,
  goalNames = [],
  availableRows,
  availableCols,
  cursorOriginX = 0,
  cursorOriginY = 0,
}: FullscreenChatProps) {
  const [input, setInput] = useState("");
  const [cursorOffset, setCursorOffset] = useState(0);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [collapsedPaste, setCollapsedPaste] = useState<CollapsedPasteRange | null>(null);
  const selectionAnchor = React.useRef<number | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const justSelected = React.useRef(false);

  const [history, setHistory] = React.useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = React.useState(-1);
  const [draft, setDraft] = React.useState("");

  const [emptyHint, setEmptyHint] = React.useState(false);
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const emptyHintTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scrollOffset, setScrollOffset] = React.useState(0);
  const [targetScrollOffset, setTargetScrollOffset] = React.useState(0);
  const [bodySelection, setBodySelection] = React.useState<BodySelectionState | null>(null);
  const bodySelectionAnchor = React.useRef<BodySelectionPoint | null>(null);
  const [transcriptMode, setTranscriptMode] = React.useState(false);
  const [transcriptScrollOffset, setTranscriptScrollOffset] = React.useState(0);
  const [transcriptSearchQuery, setTranscriptSearchQuery] = React.useState("");
  const [transcriptSearchMode, setTranscriptSearchMode] = React.useState(false);
  const [spinnerVerb, setSpinnerVerb] = React.useState(() => pickSpinnerVerb());
  const [spinnerFrameIndex, setSpinnerFrameIndex] = React.useState(0);

  React.useEffect(() => {
    let lastClipboard = "";
    let mounted = true;

    getClipboardContent().then((content) => {
      if (mounted) lastClipboard = content;
    });

    const interval = setInterval(async () => {
      if (!mounted) return;
      const current = await getClipboardContent();
      if (current !== lastClipboard && current.length > 0) {
        lastClipboard = current;
        setCopyToast(`copied ${current.length} chars to clipboard`);
        setTimeout(() => {
          if (mounted) setCopyToast(null);
        }, 2000);
      }
    }, 500);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  React.useEffect(() => {
    if (!isProcessing) return;
    const interval = setInterval(() => {
      setSpinnerVerb(pickSpinnerVerb());
    }, 5000);
    return () => clearInterval(interval);
  }, [isProcessing]);

  React.useEffect(() => {
    if (!isProcessing) {
      setSpinnerFrameIndex(0);
      return;
    }

    const interval = setInterval(() => {
      setSpinnerFrameIndex((prev) => (prev + 1) % PROCESSING_SPINNER_FRAMES.length);
    }, PROCESSING_SPINNER_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isProcessing]);

  const clearSelection = useCallback(() => {
    selectionAnchor.current = null;
    setSelection(null);
  }, []);

  const clearBodySelection = useCallback(() => {
    bodySelectionAnchor.current = null;
    setBodySelection(null);
  }, []);

  const replaceInputRange = useCallback((
    start: number,
    end: number,
    replacement: string,
    nextCollapsedPaste: CollapsedPasteRange | null = null,
  ) => {
    const next = input.slice(0, start) + replacement + input.slice(end);
    setInput(next);
    setCursorOffset(start + replacement.length);
    setCollapsedPaste(nextCollapsedPaste);
    clearSelection();
  }, [clearSelection, input]);

  const insertText = useCallback((text: string, options: { collapsePaste?: boolean } = {}) => {
    justSelected.current = false;
    const selectedRange = normalizeSelection(selection);
    const start = selectedRange ? selectedRange.start : cursorOffset;
    const nextCollapsedPaste = options.collapsePaste
      ? buildCollapsedPasteRange(text, start)
      : null;
    if (selectedRange) {
      replaceInputRange(selectedRange.start, selectedRange.end, text, nextCollapsedPaste);
      return;
    }

    const next = input.slice(0, cursorOffset) + text + input.slice(cursorOffset);
    setInput(next);
    setCursorOffset(cursorOffset + text.length);
    setCollapsedPaste(nextCollapsedPaste);
    clearSelection();
  }, [clearSelection, cursorOffset, input, replaceInputRange, selection]);

  const deleteSelection = useCallback(() => {
    const selectedRange = normalizeSelection(selection);
    if (!selectedRange) {
      return false;
    }

    replaceInputRange(selectedRange.start, selectedRange.end, "");
    return true;
  }, [replaceInputRange, selection]);

  const copySelectedInput = useCallback((nextSelection: SelectionState | null) => {
    const selectedText = getSelectedInputText(input, nextSelection);
    if (!selectedText) {
      return;
    }

    void copySelectedInputText(input, nextSelection).then((result) => {
      if (!result.ok) {
        return;
      }

      setCopyToast(formatCopyToast(selectedText.length, result));
      setTimeout(() => setCopyToast(null), 2000);
    });
  }, [input]);

  const matches = justSelected.current ? [] : getSuggestions(input, goalNames);
  const hasMatches = matches.length > 0;
  const bashMode = isBashModeInput(input);
  const normalizedSelection = normalizeSelection(selection);
  const composer = buildComposerLines({
    cols: availableCols,
    input,
    cursorOffset,
    bashMode,
    emptyHint,
    matches,
    selectedIdx,
    copyToast,
    selection: normalizedSelection,
    collapsedPaste,
  });

  const messageRows = Math.max(
    1,
    availableRows - composer.lines.length - 3,
  );
  const viewport = buildChatViewport(messages, availableCols, messageRows, scrollOffset);
  const maxScrollOffset = Math.max(
    0,
    viewport.totalRows - viewport.maxVisibleRows,
  );
  const bodySelectionRange = normalizeBodySelection(bodySelection);
  const viewportFillerRows = Math.max(0, viewport.maxVisibleRows - viewport.rows.length);
  const transcript = buildTranscriptRenderLines({
    messages,
    cols: availableCols,
    rows: availableRows,
    scrollOffset: transcriptScrollOffset,
    searchQuery: transcriptSearchQuery,
    searchMode: transcriptSearchMode,
    status: copyToast,
  });
  const composerLayout: ComposerLayout = {
    startLine: viewport.maxVisibleRows + 3 + composer.inputRowStartIndex + 1,
    contentStartCol: composer.contentStartCol,
    rows: composer.inputRows,
  };
  const cursorPosition = getCursorPositionFromComposerLayout(composerLayout);
  const absoluteCursorPosition = cursorPosition
    ? {
        x: cursorOriginX + cursorPosition.x,
        y: cursorOriginY + cursorPosition.y,
      }
    : null;

  React.useEffect(() => {
    setActiveCursorEscape(
      absoluteCursorPosition
        ? buildHiddenCursorEscapeFromPosition(absoluteCursorPosition)
        : null,
    );
    return () => {
      setActiveCursorEscape(null);
    };
  }, [absoluteCursorPosition]);

  React.useEffect(() => {
    setScrollOffset((prev) => Math.min(prev, maxScrollOffset));
    setTargetScrollOffset((prev) => Math.min(prev, maxScrollOffset));
  }, [maxScrollOffset]);

  React.useEffect(() => {
    setTranscriptScrollOffset((prev) => Math.min(prev, transcript.maxScrollOffset));
  }, [transcript.maxScrollOffset]);

  React.useEffect(() => {
    if (scrollOffset === targetScrollOffset) {
      return;
    }

    const interval = setInterval(() => {
      setScrollOffset((prev) => {
        if (prev === targetScrollOffset) {
          return prev;
        }

        const delta = targetScrollOffset - prev;
        const step = Math.max(
          1,
          Math.min(Math.abs(delta), Math.ceil(Math.abs(delta) * 0.35)),
        );
        return prev + Math.sign(delta) * step;
      });
    }, SCROLL_ANIMATION_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [scrollOffset, targetScrollOffset]);

  const applyScroll = useCallback((direction: "up" | "down", kind: "page" | "line" | "top" | "bottom") => {
    setTargetScrollOffset((prev) => {
      if (kind === "top") return maxScrollOffset;
      if (kind === "bottom") return 0;
      const amount = kind === "page" ? viewport.maxVisibleRows : SCROLL_LINE_STEP;
      const effectiveAmount = kind === "line" ? amount * getScrollLineStep() : amount;
      const delta = direction === "up" ? effectiveAmount : -effectiveAmount;
      return Math.max(0, Math.min(maxScrollOffset, prev + delta));
    });
  }, [maxScrollOffset, viewport.maxVisibleRows]);

  const applyTranscriptScroll = useCallback((direction: "up" | "down", kind: "page" | "line" | "top" | "bottom") => {
    setTranscriptScrollOffset((prev) => {
      if (kind === "top") return 0;
      if (kind === "bottom") return transcript.maxScrollOffset;
      const pageRows = Math.max(1, availableRows - 2);
      const amount = kind === "page" ? pageRows : getScrollLineStep();
      const delta = direction === "up" ? -amount : amount;
      return Math.max(0, Math.min(transcript.maxScrollOffset, prev + delta));
    });
  }, [availableRows, transcript.maxScrollOffset]);

  const jumpToTranscriptMatch = useCallback((direction: "next" | "previous") => {
    if (!transcriptSearchQuery) return;
    const rows = buildTranscriptRows(messages, availableCols);
    const query = transcriptSearchQuery.toLowerCase();
    const matches = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.toLowerCase().includes(query))
      .map(({ index }) => index);
    if (matches.length === 0) return;
    const current = direction === "next"
      ? matches.find((index) => index > transcriptScrollOffset)
      : [...matches].reverse().find((index) => index < transcriptScrollOffset);
    setTranscriptScrollOffset(current ?? (direction === "next" ? matches[0]! : matches[matches.length - 1]!));
  }, [availableCols, messages, transcriptScrollOffset, transcriptSearchQuery]);

  useInput((inputChar, key) => {
    if (transcriptMode) return;
    const scrollRequest = getScrollRequest(inputChar, key);
    if (!scrollRequest) return;
    logTuiDebug("fullscreen-chat", "processing-scroll-request", {
      direction: scrollRequest.direction,
      kind: scrollRequest.kind,
    });
    applyScroll(scrollRequest.direction, scrollRequest.kind);
  }, { isActive: isProcessing });

  const handleSubmit = useCallback((value: string) => {
    logTuiDebug("fullscreen-chat", "submit-attempt", {
      value,
      hasMatches,
      isProcessing,
    });
    if (hasMatches) return;
    if (!value.trim()) {
      setEmptyHint(true);
      if (emptyHintTimer.current) clearTimeout(emptyHintTimer.current);
      emptyHintTimer.current = setTimeout(() => setEmptyHint(false), 1500);
      return;
    }

    const trimmed = value.trim();
    if (trimmed === "/clear") {
      onClear?.();
      setInput("");
      setCursorOffset(0);
      setCollapsedPaste(null);
      clearSelection();
      setHistory((prev) => [...prev, trimmed]);
      setHistoryIdx(-1);
      setScrollOffset(0);
      setTargetScrollOffset(0);
      return;
    }

    onSubmit(value);
    setInput("");
    setCursorOffset(0);
    setCollapsedPaste(null);
    clearSelection();
    setHistory((prev) => [...prev, value]);
    setHistoryIdx(-1);
    setScrollOffset(0);
    setTargetScrollOffset(0);
  }, [clearSelection, hasMatches, isProcessing, onClear, onSubmit]);

  useInput((inputChar, key) => {
    if (key.ctrl && (inputChar === "o" || inputChar === "O")) {
      setTranscriptMode((prev) => !prev);
      setTranscriptSearchMode(false);
      return;
    }

    if (transcriptMode) {
      if (transcriptSearchMode) {
        if (key.escape) {
          setTranscriptSearchMode(false);
          return;
        }
        if (key.return) {
          setTranscriptSearchMode(false);
          jumpToTranscriptMatch("next");
          return;
        }
        if (isBackspaceInput(inputChar, key)) {
          setTranscriptSearchQuery((prev) => prev.slice(0, -1));
          return;
        }
        if (inputChar && !key.ctrl && !key.meta) {
          setTranscriptSearchQuery((prev) => prev + inputChar);
        }
        return;
      }

      if (key.escape || inputChar === "q") {
        setTranscriptMode(false);
        return;
      }
      if (inputChar === "/") {
        setTranscriptSearchMode(true);
        setTranscriptSearchQuery("");
        return;
      }
      if (inputChar === "n") {
        jumpToTranscriptMatch("next");
        return;
      }
      if (inputChar === "N") {
        jumpToTranscriptMatch("previous");
        return;
      }
      if (inputChar === "[") {
        writeTranscriptToNativeScrollback(messages);
        setCopyToast("wrote transcript to terminal scrollback");
        setTimeout(() => setCopyToast(null), 2000);
        return;
      }
      if (inputChar === "v") {
        const result = openTranscriptInEditor(messages);
        setCopyToast(result.ok ? "opened transcript in editor" : "set VISUAL or EDITOR to open transcript");
        setTimeout(() => setCopyToast(null), 2000);
        return;
      }
      if (inputChar === "g" || key.home) {
        applyTranscriptScroll("up", "top");
        return;
      }
      if (inputChar === "G" || key.end) {
        applyTranscriptScroll("down", "bottom");
        return;
      }
      if (inputChar === "j" || key.downArrow) {
        applyTranscriptScroll("down", "line");
        return;
      }
      if (inputChar === "k" || key.upArrow) {
        applyTranscriptScroll("up", "line");
        return;
      }
      const transcriptScrollRequest = getScrollRequest(inputChar, key);
      if (transcriptScrollRequest) {
        applyTranscriptScroll(transcriptScrollRequest.direction, transcriptScrollRequest.kind);
        return;
      }
      if (inputChar === " " || (key.ctrl && inputChar === "f")) {
        applyTranscriptScroll("down", "page");
        return;
      }
      if (inputChar === "b" || (key.ctrl && inputChar === "b")) {
        applyTranscriptScroll("up", "page");
        return;
      }
      return;
    }

    logTuiDebug("fullscreen-chat", "input-event", {
      inputChar,
      key: summarizeKey(key as Record<string, unknown>),
      input,
      cursorOffset,
      selection: normalizedSelection,
      historyIdx,
    });
    const scrollRequest = getScrollRequest(inputChar, key);
    if (scrollRequest) {
      logTuiDebug("fullscreen-chat", "scroll-request", {
        direction: scrollRequest.direction,
        kind: scrollRequest.kind,
      });
      if (!isProcessing) {
        applyScroll(scrollRequest.direction, scrollRequest.kind);
      }
      return;
    }

    const mouseEvent = parseMouseEvent(inputChar);
    if (mouseEvent && mouseEvent.kind !== "wheel" && mouseEvent.button === "left") {
      const localMouseX = mouseEvent.x - cursorOriginX;
      const localMouseY = mouseEvent.y - cursorOriginY;
      const offset = getMouseOffsetFromComposer(
        composerLayout,
        localMouseX,
        localMouseY,
        mouseEvent.kind !== "press" && selectionAnchor.current !== null,
      );

      if (mouseEvent.kind === "release" && offset === null) {
        selectionAnchor.current = null;
        return;
      }

      if (offset !== null) {
        justSelected.current = false;
        setCursorOffset(offset);

        if (mouseEvent.kind === "press") {
          selectionAnchor.current = offset;
          setSelection({ anchor: offset, focus: offset });
        } else if (mouseEvent.kind === "drag" && selectionAnchor.current !== null) {
          setSelection({ anchor: selectionAnchor.current, focus: offset });
        } else if (mouseEvent.kind === "release" && selectionAnchor.current !== null) {
          const nextSelection = { anchor: selectionAnchor.current, focus: offset };
          selectionAnchor.current = null;
          setSelection(nextSelection.anchor === nextSelection.focus ? null : nextSelection);
          copySelectedInput(nextSelection);
        }
        return;
      }

      const bodyPosition = getMousePositionFromBody(
        viewport.rows,
        localMouseX,
        localMouseY,
        viewportFillerRows,
      );
      if (bodyPosition !== null) {
        clearSelection();
        if (mouseEvent.kind === "press") {
          bodySelectionAnchor.current = bodyPosition;
          setBodySelection({ anchor: bodyPosition, focus: bodyPosition });
          return;
        }
        if (mouseEvent.kind === "drag" && bodySelectionAnchor.current !== null) {
          setBodySelection({ anchor: bodySelectionAnchor.current, focus: bodyPosition });
          return;
        }
        if (mouseEvent.kind === "release" && bodySelectionAnchor.current !== null) {
          const nextSelection = { anchor: bodySelectionAnchor.current, focus: bodyPosition };
          bodySelectionAnchor.current = null;
          setBodySelection(nextSelection);
          const selectedText = getSelectedBodyText(viewport.rows, nextSelection);
          if (selectedText) {
            void copyToClipboard(selectedText).then((result) => {
              if (!result.ok) return;
              setCopyToast(formatCopyToast(selectedText.length, result));
              setTimeout(() => setCopyToast(null), 2000);
            });
          } else {
            const row = viewport.rows[bodyPosition.rowIndex];
            const target = row ? extractClickableTargetAt(row.text, bodyPosition.offset) : null;
            if (target) {
              const opened = openClickableTarget(target);
              setCopyToast(opened ? `opened ${target}` : `could not open ${target}`);
              setTimeout(() => setCopyToast(null), 2000);
            }
          }
          return;
        }
      }
    }

    if (key.return && key.shift) {
      logTuiDebug("fullscreen-chat", "insert-newline", { cursorOffset });
      clearBodySelection();
      insertText("\n");
      return;
    }

    if (hasMatches) {
      if (key.upArrow) {
        setSelectedIdx((prev) => (prev <= 0 ? matches.length - 1 : prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIdx((prev) => (prev >= matches.length - 1 ? 0 : prev + 1));
        return;
      }
      if (key.tab || key.return) {
        const selected = matches[selectedIdx];
        if (selected) {
          const value =
            selected.type === "goal"
              ? `${selected.name} ${selected.description}`
              : selected.name;
          setInput(value);
          setCursorOffset(value.length);
          setCollapsedPaste(null);
          clearSelection();
          setSelectedIdx(0);
          justSelected.current = true;
        }
        return;
      }
      if (key.escape) {
        setSelectedIdx(0);
        setInput("");
        setCursorOffset(0);
        setCollapsedPaste(null);
        clearSelection();
        clearBodySelection();
        return;
      }
    }

    if (key.return) {
      handleSubmit(input);
      return;
    }

    if (key.leftArrow) {
      if (normalizedSelection) {
        setCursorOffset(normalizedSelection.start);
        clearSelection();
        return;
      }
      setCursorOffset((prev) => getPreviousOffset(input, prev));
      return;
    }
    if (key.rightArrow) {
      if (normalizedSelection) {
        setCursorOffset(normalizedSelection.end);
        clearSelection();
        return;
      }
      setCursorOffset((prev) => getNextOffset(input, prev));
      return;
    }
    if ((key.ctrl && inputChar === "a") || key.home) {
      setCursorOffset(0);
      clearSelection();
      return;
    }
    if ((key.ctrl && inputChar === "e") || key.end) {
      setCursorOffset(input.length);
      clearSelection();
      return;
    }
    if (isBackspaceInput(inputChar, key)) {
      logTuiDebug("fullscreen-chat", "backspace-detected", {
        inputChar,
        key: summarizeKey(key as Record<string, unknown>),
        cursorOffset,
        input,
        selection: normalizedSelection,
      });
      if (deleteSelection()) {
        logTuiDebug("fullscreen-chat", "backspace-delete-selection", {});
        return;
      }
      if (cursorOffset > 0) {
        const previousOffset = getPreviousOffset(input, cursorOffset);
        const next = input.slice(0, previousOffset) + input.slice(cursorOffset);
        setInput(next);
        setCursorOffset(previousOffset);
        setCollapsedPaste(null);
        logTuiDebug("fullscreen-chat", "backspace-applied", {
          previousOffset,
          next,
        });
      } else {
        logTuiDebug("fullscreen-chat", "backspace-at-start", {});
      }
      return;
    }
    if (isDeleteInput(inputChar, key)) {
      logTuiDebug("fullscreen-chat", "delete-detected", {
        inputChar,
        key: summarizeKey(key as Record<string, unknown>),
        cursorOffset,
        input,
        selection: normalizedSelection,
      });
      if (deleteSelection()) {
        logTuiDebug("fullscreen-chat", "delete-selection", {});
        return;
      }
      if (cursorOffset < input.length) {
        const nextOffset = getNextOffset(input, cursorOffset);
        const next = input.slice(0, cursorOffset) + input.slice(nextOffset);
        setInput(next);
        setCollapsedPaste(null);
        logTuiDebug("fullscreen-chat", "delete-applied", {
          nextOffset,
          next,
        });
      } else {
        logTuiDebug("fullscreen-chat", "delete-at-end", {});
      }
      return;
    }

    if (key.upArrow) {
      if (history.length > 0) {
        clearSelection();
        if (historyIdx === -1) {
          setDraft(input);
          const idx = history.length - 1;
          setHistoryIdx(idx);
          setInput(history[idx]!);
          setCursorOffset(history[idx]!.length);
          setCollapsedPaste(null);
        } else if (historyIdx > 0) {
          const idx = historyIdx - 1;
          setHistoryIdx(idx);
          setInput(history[idx]!);
          setCursorOffset(history[idx]!.length);
          setCollapsedPaste(null);
        }
      }
      return;
    }
    if (key.downArrow && historyIdx !== -1) {
      clearSelection();
      if (historyIdx < history.length - 1) {
        const idx = historyIdx + 1;
        setHistoryIdx(idx);
        setInput(history[idx]!);
        setCursorOffset(history[idx]!.length);
        setCollapsedPaste(null);
      } else {
        setHistoryIdx(-1);
        setInput(draft);
        setCursorOffset(draft.length);
        setCollapsedPaste(null);
      }
      return;
    }

    if (inputChar && !key.ctrl && !key.meta) {
      const clean = normalizeTerminalInputChunk(inputChar);
      if (clean.length === 0) return;
      clearBodySelection();
      insertText(clean, {
        collapsePaste: shouldCollapsePastedText(inputChar, clean),
      });
    }
  }, { isActive: true });

  React.useEffect(() => {
    setSelectedIdx(0);
  }, [matches.map((match) => match.name).join(",")]);

  React.useEffect(() => {
    return () => {
      if (emptyHintTimer.current) clearTimeout(emptyHintTimer.current);
    };
  }, []);

  const spinnerGlyph = PROCESSING_SPINNER_FRAMES[spinnerFrameIndex] ?? PROCESSING_SPINNER_FRAMES[0];
  const visibleLines = transcriptMode
    ? transcript.lines
    : buildFullscreenChatRenderLines({
        availableCols,
        availableRows,
        viewport,
        composerLines: composer.lines,
        isProcessing,
        spinnerGlyph,
        spinnerVerb,
        bodySelection: bodySelectionRange,
        transcriptStatus: copyToast,
      });

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {visibleLines.map((line) => (
        <Box key={line.key} height={1} overflow="hidden">
          {line.segments ? (
            line.segments.map((segment, index) => (
              <Text
                key={`${line.key}-${index}`}
                color={segment.color ?? line.color}
                backgroundColor={segment.backgroundColor ?? line.backgroundColor}
                bold={segment.bold ?? line.bold}
                dimColor={segment.dim ?? line.dim}
              >
                {index === 0 && line.protected
                  ? `${PROTECTED_ROW_MARKER}${segment.text}`
                  : segment.text}
              </Text>
            ))
          ) : (
            <Text
              color={line.color}
              backgroundColor={line.backgroundColor}
              bold={line.bold}
              dimColor={line.dim}
            >
              {line.protected
                ? `${PROTECTED_ROW_MARKER}${line.text ?? ""}`
                : (line.text ?? "")}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
