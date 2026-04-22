import type { MarkdownSegment } from "../markdown-renderer.js";

export interface ChatMessage {
  id: string;
  role: "user" | "pulseed";
  text: string;
  timestamp: Date;
  messageType?: "info" | "error" | "warning" | "success";
}

export interface ChatDisplayRow {
  key: string;
  kind: "user" | "pulseed" | "spacer";
  text: string;
  segments?: MarkdownSegment[];
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  marginLeft?: number;
  paddingX?: number;
}

export interface ChatViewport {
  rows: ChatDisplayRow[];
  hiddenAboveRows: number;
  hiddenBelowRows: number;
  totalRows: number;
  maxVisibleRows: number;
}

export interface ScrollRequest {
  direction: "up" | "down";
  kind: "page" | "line";
}
