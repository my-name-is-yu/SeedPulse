import {
  renderMarkdownLines,
  splitMarkdownLineToRows,
  wrapTextToRows,
} from "../markdown-renderer.js";
import { getMessageTypeColor } from "../theme.js";
import type { ChatDisplayRow, ChatMessage, ChatViewport } from "./types.js";
const DEFAULT_MESSAGE_WIDTH_PADDING = 4;
const MESSAGE_INNER_PADDING = 2;
const MIN_MESSAGE_WIDTH = 10;

function getRowWidth(termCols: number): number {
  return Math.max(
    MIN_MESSAGE_WIDTH,
    termCols - DEFAULT_MESSAGE_WIDTH_PADDING - MESSAGE_INNER_PADDING,
  );
}

function wrapUserMessageRows(text: string, width: number): string[] {
  const wrapped = wrapTextToRows(text, width);
  return wrapped.map((line, index) => (index === 0 ? `◉ ${line}` : `  ${line}`));
}

function buildMessageRows(msg: ChatMessage, width: number): ChatDisplayRow[] {
  if (msg.role === "user") {
    const rows = wrapUserMessageRows(msg.text, width);
    return rows.map((text, index) => ({
      key: `${msg.id}:user:${index}`,
      kind: "user",
      text,
      backgroundColor: "#D9D9D9",
      color: "#1A1A1A",
      paddingX: 1,
    }));
  }

  const typeColor = getMessageTypeColor(msg.messageType);
  const rendered = renderMarkdownLines(msg.text);
  const rows: ChatDisplayRow[] = [];

  rendered.forEach((line, lineIndex) => {
    const wrappedLines = splitMarkdownLineToRows(line, width);
    wrappedLines.forEach((wrappedLine, rowIndex) => {
      rows.push({
        key: `${msg.id}:pulseed:${lineIndex}:${rowIndex}`,
        kind: "pulseed",
        text: wrappedLine.text,
        segments: wrappedLine.segments,
        color: typeColor,
        bold: wrappedLine.bold,
        dim: wrappedLine.dim,
        italic: wrappedLine.italic,
        marginLeft: 2,
      });
    });
  });

  if (rows.length === 0) {
    rows.push({
      key: `${msg.id}:pulseed:empty`,
      kind: "pulseed",
      text: "",
      color: typeColor,
      marginLeft: 2,
    });
  }

  return rows;
}

export function buildChatViewport(
  messages: ChatMessage[],
  termCols: number,
  availableRows: number,
  scrollOffsetRows: number,
): ChatViewport {
  const maxVisibleRows = Math.max(1, Math.floor(availableRows));
  const rowWidth = getRowWidth(termCols);
  const flatRows: ChatDisplayRow[] = [];

  for (const msg of messages) {
    flatRows.push(...buildMessageRows(msg, rowWidth));
    flatRows.push({
      key: `${msg.id}:spacer`,
      kind: "spacer",
      text: "",
    });
  }

  const totalRows = flatRows.length;
  const visibleEndIdx = Math.max(0, totalRows - scrollOffsetRows);
  const visibleStartIdx = Math.max(0, visibleEndIdx - maxVisibleRows);

  return {
    rows: flatRows.slice(visibleStartIdx, visibleEndIdx),
    hiddenAboveRows: visibleStartIdx,
    hiddenBelowRows: totalRows - visibleEndIdx,
    totalRows,
    maxVisibleRows,
  };
}
