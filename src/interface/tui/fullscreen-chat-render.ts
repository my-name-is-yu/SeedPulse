import { copyToClipboard, type ClipboardResult } from "./clipboard.js";
import { theme } from "./theme.js";
import {
  CARET_MARKER,
} from "./cursor-tracker.js";
import { measureCharWidth, measureTextWidth } from "./text-width.js";
import type { buildChatViewport } from "./chat/viewport.js";
import { getMatchingSuggestions, type Suggestion } from "./chat/suggestions.js";
import type { ChatMessage, ChatDisplayRow } from "./chat/types.js";

const DEFAULT_PROMPT = "◉";
const BASH_PROMPT = "!";
const SUGGESTION_HINT = " arrows to navigate, tab/enter to select, esc to dismiss";
const INPUT_MARGIN = 4;
const SELECTION_BACKGROUND = theme.text;
const SELECTION_FOREGROUND = "#1F2329";
const FAKE_CURSOR_GLYPH = "▌";
const COLLAPSED_PASTE_MIN_CHARS = 120;
const COLLAPSED_PASTE_MIN_MULTILINE_CHARS = 40;

export type RenderSegment = {
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
};

export type RenderLine = {
  key: string;
  text?: string;
  segments?: RenderSegment[];
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
  protected?: boolean;
};

export type FullscreenChatRenderLinesInput = {
  availableCols: number;
  availableRows: number;
  viewport: ReturnType<typeof buildChatViewport>;
  composerLines: RenderLine[];
  isProcessing: boolean;
  spinnerGlyph: string;
  spinnerVerb: string;
  bodySelection?: BodySelectionRange | null;
  transcriptStatus?: string | null;
};

export type SelectionState = {
  anchor: number;
  focus: number;
};

export type SelectionRange = {
  start: number;
  end: number;
};

export type CollapsedPasteRange = {
  start: number;
  end: number;
  label: string;
};

export type BodySelectionPoint = {
  rowIndex: number;
  offset: number;
};

export type BodySelectionState = {
  anchor: BodySelectionPoint;
  focus: BodySelectionPoint;
};

export type BodySelectionRange = {
  start: BodySelectionPoint;
  end: BodySelectionPoint;
};

export type InputCell = {
  text: string;
  width: number;
  offsetBefore: number;
  offsetAfter: number;
  selected?: boolean;
  placeholder?: boolean;
  dim?: boolean;
};

export type InputRow = {
  cells: InputCell[];
  startOffset: number;
  endOffset: number;
};

export type ComposerRender = {
  lines: RenderLine[];
  inputRows: InputRow[];
  inputRowStartIndex: number;
  contentStartCol: number;
};

export type ComposerLayout = {
  startLine: number;
  contentStartCol: number;
  rows: InputRow[];
};

function charWidth(ch: string): number {
  return measureCharWidth(ch);
}

function stringWidth(text: string): number {
  return measureTextWidth(text);
}

function trimToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  let out = "";
  let used = 0;
  for (const ch of text) {
    const next = charWidth(ch);
    if (used + next > width) break;
    out += ch;
    used += next;
  }
  return out;
}

function padToWidth(text: string, width: number): string {
  const trimmed = trimToWidth(text, width);
  const padding = Math.max(0, width - stringWidth(trimmed));
  return trimmed + " ".repeat(padding);
}

function getPromptLabel(bashMode: boolean): string {
  return bashMode ? BASH_PROMPT : DEFAULT_PROMPT;
}

function getPlaceholder(bashMode: boolean): string {
  return bashMode ? "! for bash mode" : "/ for commands";
}

function formatSuggestionLabel(suggestion: Suggestion): string {
  return suggestion.type === "goal"
    ? `  ${suggestion.name} ${suggestion.description.padEnd(20)}  [goal]`
    : `  ${suggestion.name.padEnd(20)}${suggestion.description}`;
}

function countTextLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

export function shouldCollapsePastedText(rawInput: string, normalizedInput: string): boolean {
  const isBracketedPaste = rawInput.includes("[200~") || rawInput.includes("\u001b[200~");
  if (normalizedInput.length >= COLLAPSED_PASTE_MIN_CHARS) {
    return true;
  }
  if (normalizedInput.includes("\n") && normalizedInput.length >= COLLAPSED_PASTE_MIN_MULTILINE_CHARS) {
    return true;
  }
  return isBracketedPaste && normalizedInput.length >= COLLAPSED_PASTE_MIN_MULTILINE_CHARS;
}

export function buildCollapsedPasteRange(text: string, start: number): CollapsedPasteRange {
  const lineCount = countTextLines(text);
  const charCount = Array.from(text).length;
  const label = lineCount > 1
    ? `[pasted ${lineCount} lines, ${charCount} chars]`
    : `[pasted ${charCount} chars]`;
  return {
    start,
    end: start + text.length,
    label,
  };
}

export function normalizeSelection(selection: SelectionState | null): SelectionRange | null {
  if (!selection || selection.anchor === selection.focus) {
    return null;
  }

  return {
    start: Math.min(selection.anchor, selection.focus),
    end: Math.max(selection.anchor, selection.focus),
  };
}

export function getSelectedInputText(input: string, selection: SelectionState | null): string {
  const range = normalizeSelection(selection);
  return range ? input.slice(range.start, range.end) : "";
}

export async function copySelectedInputText(
  input: string,
  selection: SelectionState | null,
  copy: (text: string) => Promise<ClipboardResult> = copyToClipboard,
): Promise<ClipboardResult> {
  const selectedText = getSelectedInputText(input, selection);
  if (!selectedText) {
    return { ok: false };
  }
  return copy(selectedText);
}

export function formatCopyToast(charCount: number, result: ClipboardResult): string {
  const suffix = result.method ? ` via ${result.method}` : "";
  return `copied ${charCount} chars${suffix}`;
}

function pushSegment(
  segments: RenderSegment[],
  text: string,
  style: Omit<RenderSegment, "text"> = {},
): void {
  if (text.length === 0) return;

  const previous = segments[segments.length - 1];
  if (
    previous &&
    previous.color === style.color &&
    previous.backgroundColor === style.backgroundColor &&
    previous.bold === style.bold &&
    previous.dim === style.dim
  ) {
    previous.text += text;
    return;
  }

  segments.push({ text, ...style });
}

function buildInputRows(
  input: string,
  cursorOffset: number,
  contentWidth: number,
  placeholder: string,
  selection: SelectionRange | null,
  collapsedPaste: CollapsedPasteRange | null,
): { rows: InputRow[] } {
  if (contentWidth <= 0) {
    return {
      rows: [{
        cells: [{
          text: CARET_MARKER,
          width: 0,
          offsetBefore: cursorOffset,
          offsetAfter: cursorOffset,
        }],
        startOffset: cursorOffset,
        endOffset: cursorOffset,
      }],
    };
  }

  if (input.length === 0) {
    const cells: InputCell[] = [{
      text: CARET_MARKER,
      width: 0,
      offsetBefore: 0,
      offsetAfter: 0,
    }];

    for (const ch of trimToWidth(placeholder, Math.max(0, contentWidth - 1))) {
      cells.push({
        text: ch,
        width: charWidth(ch),
        offsetBefore: 0,
        offsetAfter: 0,
        placeholder: true,
      });
    }

    return {
      rows: [{
        cells,
        startOffset: 0,
        endOffset: 0,
      }],
    };
  }

  const rows: InputRow[] = [];
  let currentCells: InputCell[] = [];
  let currentWidth = 0;
  let rowStartOffset = 0;
  let rowEndOffset = 0;
  const activeCollapsedPaste = collapsedPaste
    && !(cursorOffset > collapsedPaste.start && cursorOffset < collapsedPaste.end)
    && !(selection && selection.start < collapsedPaste.end && selection.end > collapsedPaste.start)
    ? collapsedPaste
    : null;
  const pushRow = () => {
    rows.push({
      cells: currentCells,
      startOffset: rowStartOffset,
      endOffset: rowEndOffset,
    });
    currentCells = [];
    currentWidth = 0;
  };

  let offset = 0;
  while (offset <= input.length) {
    if (offset === cursorOffset) {
      if (currentWidth >= contentWidth && currentCells.length > 0) {
        pushRow();
        rowStartOffset = offset;
        rowEndOffset = offset;
      }
      currentCells.push({
        text: CARET_MARKER,
        width: 0,
        offsetBefore: offset,
        offsetAfter: offset,
      });
    }

    if (offset === input.length) {
      break;
    }

    if (activeCollapsedPaste && offset === activeCollapsedPaste.start) {
      const label = stringWidth(activeCollapsedPaste.label) <= contentWidth
        ? activeCollapsedPaste.label
        : trimToWidth("[paste]", contentWidth);
      const labelWidth = stringWidth(label);
      if (currentWidth + labelWidth > contentWidth && currentCells.length > 0) {
        pushRow();
        rowStartOffset = offset;
        rowEndOffset = offset;
      }
      currentCells.push({
        text: label,
        width: labelWidth,
        offsetBefore: activeCollapsedPaste.start,
        offsetAfter: activeCollapsedPaste.end,
        dim: true,
      });
      currentWidth += labelWidth;
      rowEndOffset = activeCollapsedPaste.end;
      offset = activeCollapsedPaste.end;
      continue;
    }

    const codePoint = input.codePointAt(offset) ?? 0;
    const ch = String.fromCodePoint(codePoint);
    const nextOffset = offset + ch.length;

    if (ch === "\n") {
      pushRow();
      rowStartOffset = nextOffset;
      rowEndOffset = nextOffset;
      offset = nextOffset;
      continue;
    }

    const width = charWidth(ch);
    if (currentWidth + width > contentWidth && currentCells.length > 0) {
      pushRow();
      rowStartOffset = offset;
      rowEndOffset = offset;
    }

    currentCells.push({
      text: ch,
      width,
      offsetBefore: offset,
      offsetAfter: nextOffset,
      selected:
        selection !== null &&
        offset < selection.end &&
        nextOffset > selection.start,
    });
    currentWidth += width;
    rowEndOffset = nextOffset;
    offset = nextOffset;
  }

  rows.push({
    cells: currentCells,
    startOffset: rowStartOffset,
    endOffset: rowEndOffset,
  });

  return { rows };
}

function buildInputContentSegments(
  row: InputRow,
  contentWidth: number,
  bashMode: boolean,
): RenderSegment[] {
  const segments: RenderSegment[] = [];
  const defaultColor = bashMode ? theme.command : undefined;
  let usedWidth = 0;

  for (const cell of row.cells) {
    if (cell.text === CARET_MARKER) {
      pushSegment(segments, FAKE_CURSOR_GLYPH, {
        color: theme.text,
        bold: true,
      });
      usedWidth += 1;
      continue;
    }

    usedWidth += cell.width;

    if (cell.selected) {
      pushSegment(segments, cell.text, {
        color: SELECTION_FOREGROUND,
        backgroundColor: SELECTION_BACKGROUND,
      });
      continue;
    }

    pushSegment(segments, cell.text, {
      color: defaultColor,
      dim: cell.placeholder || cell.dim,
    });
  }

  if (usedWidth < contentWidth) {
    pushSegment(segments, " ".repeat(contentWidth - usedWidth), {
      color: defaultColor,
    });
  }

  return segments;
}

function compareBodySelectionPoints(a: BodySelectionPoint, b: BodySelectionPoint): number {
  if (a.rowIndex !== b.rowIndex) {
    return a.rowIndex - b.rowIndex;
  }
  return a.offset - b.offset;
}

export function normalizeBodySelection(selection: BodySelectionState | null): BodySelectionRange | null {
  if (!selection || compareBodySelectionPoints(selection.anchor, selection.focus) === 0) {
    return null;
  }

  return compareBodySelectionPoints(selection.anchor, selection.focus) <= 0
    ? { start: selection.anchor, end: selection.focus }
    : { start: selection.focus, end: selection.anchor };
}

function getBodySelectionForRow(
  selection: BodySelectionRange | null,
  rowIndex: number,
  textLength: number,
): SelectionRange | null {
  if (!selection || rowIndex < selection.start.rowIndex || rowIndex > selection.end.rowIndex) {
    return null;
  }

  const start = rowIndex === selection.start.rowIndex ? selection.start.offset : 0;
  const end = rowIndex === selection.end.rowIndex ? selection.end.offset : textLength;
  if (start === end) return null;
  return { start: Math.max(0, start), end: Math.min(textLength, end) };
}

function getDisplayOffsetForText(text: string, col: number): number {
  if (col <= 0) return 0;
  let usedWidth = 0;
  let offset = 0;
  for (const ch of text) {
    const width = charWidth(ch);
    const midpoint = usedWidth + width / 2;
    if (col <= midpoint) return offset;
    offset += ch.length;
    usedWidth += width;
    if (col <= usedWidth) return offset;
  }
  return text.length;
}

function applySelectionToTextSegments(
  text: string,
  selection: SelectionRange | null,
  style: Omit<RenderSegment, "text">,
): RenderSegment[] {
  if (!selection) {
    return [{ text, ...style }];
  }

  const segments: RenderSegment[] = [];
  const before = text.slice(0, selection.start);
  const selected = text.slice(selection.start, selection.end);
  const after = text.slice(selection.end);
  pushSegment(segments, before, style);
  pushSegment(segments, selected, {
    ...style,
    color: SELECTION_FOREGROUND,
    backgroundColor: SELECTION_BACKGROUND,
  });
  pushSegment(segments, after, style);
  return segments;
}

export function getSelectedBodyText(
  rows: ChatDisplayRow[],
  selection: BodySelectionState | null,
): string {
  const range = normalizeBodySelection(selection);
  if (!range) return "";

  const selectedRows: string[] = [];
  for (let rowIndex = range.start.rowIndex; rowIndex <= range.end.rowIndex; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row || row.kind === "spacer") continue;
    const rowRange = getBodySelectionForRow(range, rowIndex, row.text.length);
    if (!rowRange) continue;
    selectedRows.push(row.text.slice(rowRange.start, rowRange.end).trimEnd());
  }

  return selectedRows.join("\n").trim();
}

export function extractClickableTargetAt(text: string, offset: number): string | null {
  const patterns = [
    /https?:\/\/[^\s)>\]}]+/g,
    /(?:\.{1,2}\/|\/)[^\s:]+(?::\d+)?/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      const start = match.index ?? 0;
      const end = start + value.length;
      if (offset >= start && offset <= end) {
        return value;
      }
    }
  }

  return null;
}

export function formatTranscript(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const label = message.role === "user" ? "User" : "PulSeed";
      return `${label}:\n${message.text.trimEnd()}`;
    })
    .join("\n\n");
}

function wrapPlainTextToRows(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const sourceLine of text.split("\n")) {
    if (sourceLine.length === 0) {
      rows.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const ch of sourceLine) {
      const widthOfChar = charWidth(ch);
      if (currentWidth + widthOfChar > width && current.length > 0) {
        rows.push(current);
        current = "";
        currentWidth = 0;
      }
      current += ch;
      currentWidth += widthOfChar;
    }
    rows.push(current);
  }
  return rows;
}

export function buildTranscriptRows(messages: ChatMessage[], cols: number): string[] {
  const rows: string[] = [];
  for (const message of messages) {
    const label = message.role === "user" ? "User" : "PulSeed";
    rows.push(...wrapPlainTextToRows(`${label}:`, cols));
    rows.push(...wrapPlainTextToRows(message.text.trimEnd(), cols));
    rows.push("");
  }
  return rows;
}

export function buildTranscriptRenderLines(args: {
  messages: ChatMessage[];
  cols: number;
  rows: number;
  scrollOffset: number;
  searchQuery: string;
  searchMode: boolean;
  status?: string | null;
}): { lines: RenderLine[]; totalRows: number; maxScrollOffset: number } {
  const { messages, cols, rows, scrollOffset, searchQuery, searchMode, status } = args;
  const bodyRows = Math.max(1, rows - 2);
  const transcriptRows = buildTranscriptRows(messages, cols);
  const maxScrollOffset = Math.max(0, transcriptRows.length - bodyRows);
  const clampedOffset = Math.max(0, Math.min(maxScrollOffset, scrollOffset));
  const visibleRows = transcriptRows.slice(clampedOffset, clampedOffset + bodyRows);
  const lines: RenderLine[] = [{
    key: "transcript-header",
    text: padToWidth("transcript  / search  n/N next  [ write scrollback  v editor  Esc return", cols),
    color: theme.command,
  }];

  visibleRows.forEach((row, index) => {
    lines.push({
      key: `transcript-${clampedOffset + index}`,
      text: padToWidth(row, cols),
      backgroundColor:
        searchQuery.length > 0 && row.toLowerCase().includes(searchQuery.toLowerCase())
          ? "#3A3A22"
          : undefined,
    });
  });

  while (lines.length < rows - 1) {
    lines.push({ key: `transcript-filler-${lines.length}`, text: " ".repeat(cols) });
  }

  lines.push({
    key: "transcript-footer",
    text: padToWidth(
      searchMode
        ? `/${searchQuery}`
        : status
          ? status
          : `${clampedOffset + 1}-${Math.min(clampedOffset + bodyRows, transcriptRows.length)} / ${transcriptRows.length}`,
      cols,
    ),
    dim: !searchMode && !status,
    color: searchMode ? theme.command : undefined,
  });

  return { lines: lines.slice(0, rows), totalRows: transcriptRows.length, maxScrollOffset };
}

export function getCursorPositionFromComposerLayout(
  layout: ComposerLayout,
): { x: number; y: number } | null {
  for (let rowIndex = 0; rowIndex < layout.rows.length; rowIndex += 1) {
    const row = layout.rows[rowIndex];
    if (!row) continue;

    let colOffset = 0;
    for (const cell of row.cells) {
      if (cell.text === CARET_MARKER) {
        return {
          x: layout.contentStartCol + colOffset - 1,
          y: layout.startLine + rowIndex - 1,
        };
      }
      colOffset += cell.width;
    }
  }

  return null;
}

export function buildComposerLines(args: {
  cols: number;
  input: string;
  cursorOffset: number;
  bashMode: boolean;
  emptyHint: boolean;
  matches: Suggestion[];
  selectedIdx: number;
  copyToast: string | null;
  selection: SelectionRange | null;
  collapsedPaste: CollapsedPasteRange | null;
}): ComposerRender {
  const {
    cols,
    input,
    cursorOffset,
    bashMode,
    emptyHint,
    matches,
    selectedIdx,
    copyToast,
    selection,
    collapsedPaste,
  } = args;

  const lines: RenderLine[] = [];
  lines.push({
    key: "copy-toast",
    text: padToWidth(copyToast ?? "", cols),
    color: copyToast ? "cyan" : undefined,
  });

  const innerWidth = Math.max(1, cols - 2);
  const promptLabel = getPromptLabel(bashMode);
  const prompt = `${promptLabel} `;
  const promptWidth = stringWidth(prompt);
  const contentWidth = Math.max(1, innerWidth - INPUT_MARGIN - promptWidth);
  const inputRender = buildInputRows(
    input,
    cursorOffset,
    contentWidth,
    getPlaceholder(bashMode),
    selection,
    collapsedPaste,
  );
  const inputRows = inputRender.rows;

  lines.push({
    key: "composer-top",
    text: padToWidth(`┌${"─".repeat(Math.max(0, cols - 2))}┐`, cols),
    color: bashMode ? theme.command : theme.border,
  });

  inputRows.forEach((row, index) => {
    const segments: RenderSegment[] = [];
    const borderColor = bashMode ? theme.command : undefined;
    const promptColor = bashMode ? theme.command : theme.userPrompt;

    pushSegment(segments, "│ ", { color: borderColor });
    if (index === 0) {
      pushSegment(segments, promptLabel, { color: promptColor, bold: true });
      pushSegment(segments, " ", { color: promptColor, bold: true });
    } else {
      pushSegment(segments, " ".repeat(promptWidth), { color: borderColor });
    }
    segments.push(...buildInputContentSegments(row, contentWidth, bashMode));
    pushSegment(segments, " │", { color: borderColor });

    lines.push({
      key: `composer-row-${index}`,
      segments,
      protected: true,
    });
  });

  lines.push({
    key: "composer-bottom",
    text: padToWidth(`└${"─".repeat(Math.max(0, cols - 2))}┘`, cols),
    color: bashMode ? theme.command : theme.border,
  });

  if (bashMode) {
    lines.push({
      key: "bash-hint",
      text: padToWidth("! for bash mode", cols),
      color: theme.command,
    });
  }

  if (emptyHint) {
    lines.push({
      key: "empty-hint",
      text: padToWidth(" Type a message or /help for commands", cols),
      dim: true,
    });
  }

  if (matches.length > 0) {
    matches.forEach((suggestion, index) => {
      lines.push({
        key: `suggestion-${index}`,
        text: padToWidth(formatSuggestionLabel(suggestion), cols),
        color: index === selectedIdx ? theme.selected : undefined,
        bold: index === selectedIdx,
        dim: index !== selectedIdx,
      });
    });
    lines.push({
      key: "suggestion-hint",
      text: padToWidth(SUGGESTION_HINT, cols),
      dim: true,
    });
  }

  return {
    lines,
    inputRows,
    inputRowStartIndex: 2,
    contentStartCol: 3 + promptWidth,
  };
}

function renderMessageRow(
  row: ChatDisplayRow,
  cols: number,
  rowIndex: number,
  bodySelection: BodySelectionRange | null,
): RenderLine {
  if (row.kind === "spacer") {
    return { key: row.key, text: " ".repeat(cols) };
  }

  const selection = getBodySelectionForRow(bodySelection, rowIndex, row.text.length);
  if (selection) {
    const text = padToWidth(row.text, cols);
    return {
      key: row.key,
      segments: applySelectionToTextSegments(text, selection, {
        color: row.color,
        backgroundColor: row.backgroundColor,
        bold: row.bold,
        dim: row.dim,
      }),
    };
  }

  return {
    key: row.key,
    text: padToWidth(row.text, cols),
    color: row.color,
    backgroundColor: row.backgroundColor,
    bold: row.bold,
    dim: row.dim,
  };
}

export function buildFullscreenChatRenderLines({
  availableCols,
  availableRows,
  viewport,
  composerLines,
  isProcessing,
  spinnerGlyph,
  spinnerVerb,
  bodySelection,
  transcriptStatus,
}: FullscreenChatRenderLinesInput): RenderLine[] {
  const lines: RenderLine[] = [];
  lines.push({
    key: "indicator-top",
    text: padToWidth(
      viewport.hiddenAboveRows > 0 ? `↑ ${viewport.hiddenAboveRows} earlier lines` : "",
      availableCols,
    ),
    dim: true,
  });

  const renderedRows = viewport.rows.map((row, index) => (
    renderMessageRow(row, availableCols, index, bodySelection ?? null)
  ));
  const fillerCount = Math.max(0, viewport.maxVisibleRows - renderedRows.length);
  for (let index = 0; index < fillerCount; index += 1) {
    lines.push({ key: `filler-${index}`, text: " ".repeat(availableCols) });
  }
  lines.push(...renderedRows);
  lines.push({
    key: "indicator-bottom",
    text: padToWidth(
      viewport.hiddenBelowRows > 0 ? `↓ ${viewport.hiddenBelowRows} newer lines` : "",
      availableCols,
    ),
    dim: true,
  });
  lines.push({
    key: "processing",
    text: padToWidth(transcriptStatus ?? (isProcessing ? `${spinnerGlyph} ${spinnerVerb}...` : ""), availableCols),
    color: isProcessing ? theme.command : undefined,
    dim: !isProcessing && !transcriptStatus,
  });
  lines.push(...composerLines);

  while (lines.length < availableRows) {
    lines.push({
      key: `tail-filler-${lines.length}`,
      text: " ".repeat(availableCols),
    });
  }

  return lines.slice(0, availableRows);
}

export function getMouseOffsetFromComposer(
  layout: ComposerLayout,
  x: number,
  y: number,
  clampOutside: boolean,
): number | null {
  if (layout.rows.length === 0) {
    return null;
  }

  let rowIndex = y - layout.startLine;
  if (rowIndex < 0) {
    if (!clampOutside) return null;
    rowIndex = 0;
  }
  if (rowIndex >= layout.rows.length) {
    if (!clampOutside) return null;
    rowIndex = layout.rows.length - 1;
  }

  const row = layout.rows[rowIndex];
  if (!row) {
    return null;
  }

  if (row.startOffset === row.endOffset) {
    return row.startOffset;
  }

  const localCol = x - layout.contentStartCol;
  if (localCol <= 0) {
    return row.startOffset;
  }

  let usedWidth = 0;
  for (const cell of row.cells) {
    if (cell.placeholder || cell.width <= 0) {
      continue;
    }

    const midpoint = usedWidth + cell.width / 2;
    if (localCol <= midpoint) {
      return cell.offsetBefore;
    }

    usedWidth += cell.width;
    if (localCol <= usedWidth) {
      return cell.offsetAfter;
    }
  }

  return row.endOffset;
}

export function getMousePositionFromBody(
  rows: ChatDisplayRow[],
  x: number,
  y: number,
  fillerRows: number,
): BodySelectionPoint | null {
  const rowIndex = y - 2 - fillerRows;
  if (rowIndex < 0 || rowIndex >= rows.length) {
    return null;
  }

  const row = rows[rowIndex];
  if (!row || row.kind === "spacer") {
    return null;
  }

  return {
    rowIndex,
    offset: getDisplayOffsetForText(row.text, x - 1),
  };
}

export function getSuggestions(input: string, goalNames: string[]): Suggestion[] {
  return getMatchingSuggestions(input, goalNames);
}
