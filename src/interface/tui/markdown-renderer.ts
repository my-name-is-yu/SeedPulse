// ─── Markdown Renderer ───
//
// Simple markdown-to-plain-text conversion for Ink's <Text> component.
// We intentionally avoid marked-terminal because its ANSI escape codes
// with embedded newlines conflict with Ink's layout engine, causing
// text overlap and incorrect line-height calculations.
//
// Instead, we do lightweight manual conversion that produces clean text
// which Ink can properly measure and render.

import * as os from "node:os";
import * as path from "node:path";
import { theme } from "./theme.js";

export interface MarkdownSegment {
  text: string;
  bold?: boolean;
  code?: boolean;
  italic?: boolean;
  color?: string;
}

export interface MarkdownLine {
  text: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  segments?: MarkdownSegment[];
  language?: string;
}

const WORD_SEGMENTER =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("en", { granularity: "word" })
    : null;

/**
 * Wrap plain text to terminal rows at the given width.
 * This is intentionally lightweight and shared by the TUI viewport logic.
 */
export function wrapTextToRows(text: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const paragraphs = text.split("\n");
  const rows: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph === "") {
      rows.push("");
      continue;
    }

    const pieces = WORD_SEGMENTER
      ? Array.from(WORD_SEGMENTER.segment(paragraph), (segment) => segment.segment)
      : paragraph.match(/\S+\s*|\s+/g) ?? [paragraph];

    let current = "";

    for (const piece of pieces) {
      if (!piece) continue;

      if (piece.length > safeWidth) {
        if (current) {
          rows.push(current);
          current = "";
        }
        for (let i = 0; i < piece.length; i += safeWidth) {
          rows.push(piece.slice(i, i + safeWidth));
        }
        continue;
      }

      if (current.length + piece.length <= safeWidth) {
        current += piece;
        continue;
      }

      if (current) {
        rows.push(current);
      }
      current = piece.trimStart();
    }

    if (current) {
      rows.push(current);
    }
  }

  return rows.length > 0 ? rows : [""];
}

/**
 * Estimate how many terminal rows a plain text line will occupy at the given width.
 * This is intentionally approximate but good enough for TUI window sizing.
 */
export function estimateWrappedLineCount(text: string, width: number): number {
  return wrapTextToRows(text, width).length;
}

/**
 * Expand a rendered markdown line into terminal rows at the given width.
 * Inline segment styling is preserved on wrapped rows.
 */
export function splitMarkdownLineToRows(line: MarkdownLine, width: number): MarkdownLine[] {
  if (!line.segments || line.segments.length === 0) {
    return wrapTextToRows(line.text, width).map((text) => ({
      text,
      bold: line.bold,
      dim: line.dim,
      italic: line.italic,
    }));
  }

  const safeWidth = Math.max(1, Math.floor(width));
  const rows: MarkdownLine[] = [];
  let currentSegments: MarkdownSegment[] = [];
  let currentText = "";
  let currentWidth = 0;

  const pushRow = (): void => {
    rows.push({
      text: currentText,
      bold: line.bold,
      dim: line.dim,
      italic: line.italic,
      segments: currentSegments.length > 0 ? currentSegments : undefined,
      language: line.language,
    });
    currentSegments = [];
    currentText = "";
    currentWidth = 0;
  };

  const appendPiece = (piece: string, segment: MarkdownSegment): void => {
    if (!piece) return;
    const last = currentSegments[currentSegments.length - 1];
    if (
      last &&
      last.bold === segment.bold &&
      last.code === segment.code &&
      last.italic === segment.italic &&
      last.color === segment.color
    ) {
      last.text += piece;
      currentText += piece;
      return;
    }

    const nextSegment: MarkdownSegment = { ...segment, text: piece };
    currentSegments.push(nextSegment);
    currentText += piece;
  };

  const piecesFor = (text: string): string[] => {
    if (text === "") {
      return [""];
    }
    return WORD_SEGMENTER
      ? Array.from(WORD_SEGMENTER.segment(text), (segment) => segment.segment)
      : text.match(/\S+\s*|\s+/g) ?? [text];
  };

  for (const segment of line.segments) {
    const pieces = piecesFor(segment.text);
    for (const piece of pieces) {
      if (!piece) continue;

      if (piece.length > safeWidth) {
        if (currentWidth > 0) {
          pushRow();
        }
        for (let index = 0; index < piece.length; index += safeWidth) {
          rows.push({
            text: piece.slice(index, index + safeWidth),
            bold: line.bold,
            dim: line.dim,
            italic: line.italic,
            segments: [{ ...segment, text: piece.slice(index, index + safeWidth) }],
            language: line.language,
          });
        }
        continue;
      }

      if (currentWidth + piece.length > safeWidth && currentWidth > 0) {
        pushRow();
      }

      const rowPiece = currentWidth === 0 ? piece : piece.trimStart();
      if (!rowPiece) {
        continue;
      }

      appendPiece(rowPiece, segment);
      currentWidth += rowPiece.length;

      if (currentWidth >= safeWidth) {
        pushRow();
      }
    }
  }

  if (currentWidth > 0 || rows.length === 0) {
    rows.push({
      text: currentText,
      bold: line.bold,
      dim: line.dim,
      italic: line.italic,
      segments: currentSegments.length > 0 ? currentSegments : undefined,
      language: line.language,
    });
  }

  return rows;
}

/**
 * Estimate how many terminal rows a rendered markdown block will occupy.
 */
export function estimateMarkdownHeight(text: string, width: number): number {
  const lines = renderMarkdownLines(text);
  return lines.reduce((total, line) => total + splitMarkdownLineToRows(line, width).length, 0);
}

/**
 * Clamp rendered markdown lines to a maximum number of rows.
 * If the content overflows, the tail is replaced with a truncation note.
 */
export function clampMarkdownLines(lines: MarkdownLine[], maxLines: number): MarkdownLine[] {
  if (maxLines <= 0 || lines.length <= maxLines) {
    return lines;
  }

  const keptCount = Math.max(1, maxLines - 1);
  const truncatedCount = lines.length - keptCount;
  return [
    ...lines.slice(0, keptCount),
    { text: `... ${truncatedCount} more line${truncatedCount === 1 ? "" : "s"}`, dim: true },
  ];
}

/**
 * Convert markdown text to an array of MarkdownLine objects.
 * Each line represents a visual line in the output.
 * Ink will render each as a separate <Text> element inside a vertical <Box>.
 */
export function renderMarkdownLines(text: string): MarkdownLine[] {
  const lines = text.split('\n');
  const result: MarkdownLine[] = [];

  let inCodeBlock = false;
  let codeLanguage = '';

  for (const line of lines) {
    // Code block toggle
    if (line.trim().startsWith('```')) {
      if (!inCodeBlock) {
        // Extract language from opening fence (e.g. ```ts -> "ts")
        const fenceMatch = line.trim().match(/^```(\w+)?/);
        codeLanguage = fenceMatch?.[1] ?? '';
      } else {
        codeLanguage = '';
      }
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      const codeLine = '  ' + line;
      const segs = codeLanguage
        ? highlightCodeLine(line, codeLanguage)
        : undefined;
      result.push({ text: codeLine, dim: true, language: codeLanguage, segments: segs });
      continue;
    }

    const trimmed = line.trim();

    // Empty line -> blank separator
    if (trimmed === '') {
      result.push({ text: '' });
      continue;
    }

    // Headers -> bold text (strip # markers)
    const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      result.push({ text: headerMatch[2], bold: true });
      continue;
    }

    // Unordered list items -> bullet points
    const listMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (listMatch) {
      const prefix = '  \u2022 ';
      const segs = parseInlineSegments(listMatch[1]);
      result.push({ text: prefix + flattenSegments(segs), segments: prependText(prefix, segs) });
      continue;
    }

    // Ordered list items -> numbered
    const orderedMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (orderedMatch) {
      const prefix = '  ' + orderedMatch[1] + '. ';
      const segs = parseInlineSegments(orderedMatch[2]);
      result.push({ text: prefix + flattenSegments(segs), segments: prependText(prefix, segs) });
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(trimmed)) {
      result.push({ text: '\u2500'.repeat(40), dim: true });
      continue;
    }

    // Normal text -> parse inline segments
    const segs = parseInlineSegments(trimmed);
    const hasFormatting = segs.some((s) => s.bold || s.code || s.italic || s.color);
    if (hasFormatting) {
      result.push({ text: flattenSegments(segs), segments: segs });
    } else {
      result.push({ text: flattenSegments(segs) });
    }
  }

  return result;
}

/** Helper: convert segments back to plain text */
function flattenSegments(segs: MarkdownSegment[]): string {
  return segs.map((s) => s.text).join('');
}

/** Helper: prepend plain text before an array of segments */
function prependText(prefix: string, segs: MarkdownSegment[]): MarkdownSegment[] {
  return [{ text: prefix }, ...segs];
}

/**
 * Parse inline markdown formatting into segments.
 * Handles: **bold**, __bold__, *italic*, _italic_, `code`, [links](url)
 */
export function parseInlineSegments(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  // Pattern: bold+italic (***), bold (**/__), italic (*/_), code (`), link ([text](url))
  const pattern = /(\*{3}.+?\*{3}|\*{2}.+?\*{2}|_{2}.+?_{2}|\*.+?\*|_.+?_|`[^`]+`|\[[^\]]+\]\((?:[^()]|\([^)]*\))+(?:\s+"[^"]*")?\))/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(text)) !== null) {
    // Plain text before this match
    if (m.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, m.index) });
    }

    const raw = m[0];

    if (raw.startsWith('***') && raw.endsWith('***')) {
      segments.push({ text: raw.slice(3, -3), bold: true, italic: true });
    } else if ((raw.startsWith('**') && raw.endsWith('**')) ||
               (raw.startsWith('__') && raw.endsWith('__'))) {
      segments.push({ text: raw.slice(2, -2), bold: true });
    } else if (raw.startsWith('`') && raw.endsWith('`')) {
      segments.push({ text: raw.slice(1, -1), code: true });
    } else if ((raw.startsWith('*') && raw.endsWith('*')) ||
               (raw.startsWith('_') && raw.endsWith('_'))) {
      segments.push({ text: raw.slice(1, -1), italic: true });
    } else if (raw.startsWith('[')) {
      const linkMatch = raw.match(/^\[(.+?)\]\(((?:[^()]|\([^)]*\))+?)(?:\s+"[^"]*")?\)$/);
      const label = linkMatch?.[1] ?? raw;
      const destination = linkMatch?.[2] ?? "";
      segments.push({
        text: renderMarkdownLinkText(label, destination),
        color: theme.info,
      });
    } else {
      segments.push({ text: raw });
    }

    lastIndex = m.index + raw.length;
  }

  // Remaining plain text
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ text }];
}

function renderMarkdownLinkText(label: string, destination: string): string {
  if (!destination || !isLocalPathLikeLink(destination)) {
    return label;
  }

  return shortenLocalPath(destination.replace(/^file:\/\//, ""));
}

function isLocalPathLikeLink(destination: string): boolean {
  return destination.startsWith("/")
    || destination.startsWith("./")
    || destination.startsWith("../")
    || destination.startsWith("~/")
    || destination.startsWith("file://");
}

function shortenLocalPath(destination: string): string {
  if (destination.startsWith("~/")) {
    return destination;
  }

  const homeDir = os.homedir();
  if (destination.startsWith(homeDir)) {
    return `~/${destination.slice(homeDir.length + 1)}`;
  }

  if (path.isAbsolute(destination)) {
    const relative = path.relative(process.cwd(), destination);
    if (relative && !relative.startsWith("..")) {
      return relative;
    }
  }

  return destination;
}

// ─── Code Syntax Highlighting ───

const JS_TS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'do', 'break', 'continue', 'switch', 'case', 'default', 'new', 'delete',
  'typeof', 'instanceof', 'in', 'of', 'import', 'export', 'from', 'as',
  'class', 'extends', 'super', 'this', 'static', 'get', 'set', 'async',
  'await', 'try', 'catch', 'finally', 'throw', 'void', 'null', 'undefined',
  'true', 'false', 'type', 'interface', 'enum', 'namespace', 'implements',
  'abstract', 'readonly', 'public', 'private', 'protected', 'declare',
]);

const PY_KEYWORDS = new Set([
  'def', 'class', 'return', 'import', 'from', 'as', 'if', 'elif', 'else',
  'for', 'while', 'break', 'continue', 'pass', 'and', 'or', 'not', 'in',
  'is', 'lambda', 'with', 'yield', 'raise', 'try', 'except', 'finally',
  'global', 'nonlocal', 'del', 'assert', 'True', 'False', 'None', 'async',
  'await',
]);

function getKeywords(language: string): Set<string> {
  const lang = language.toLowerCase();
  if (['js', 'ts', 'javascript', 'typescript', 'tsx', 'jsx'].includes(lang)) {
    return JS_TS_KEYWORDS;
  }
  if (lang === 'python' || lang === 'py') {
    return PY_KEYWORDS;
  }
  // Generic fallback: combine both
  return new Set([...JS_TS_KEYWORDS, ...PY_KEYWORDS]);
}

/**
 * Apply basic keyword-based syntax highlighting to a single code line.
 * Returns an array of MarkdownSegment with color hints.
 */
export function highlightCodeLine(line: string, language: string): MarkdownSegment[] {
  // Comment lines
  if (/^\s*(\/\/|#)/.test(line)) {
    return [{ text: '  ' + line, color: theme.codeComment }];
  }

  const indentMatch = line.match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : '';
  const content = line.slice(indent.length);

  if (content === '') {
    return [{ text: '  ' + indent }];
  }

  const keywords = getKeywords(language);
  const segments: MarkdownSegment[] = [];

  // Leading indentation prefix
  segments.push({ text: '  ' + indent });

  // Tokenize: strings, numbers, identifiers, other chars
  const tokenPattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+\.?\d*\b|\b[A-Za-z_$][\w$]*\b|[^\w\s"'`]|\s+)/g;
  let tm: RegExpExecArray | null;

  while ((tm = tokenPattern.exec(content)) !== null) {
    const token = tm[0];

    if (/^["'`]/.test(token)) {
      // String literal
      segments.push({ text: token, color: theme.codeString });
    } else if (/^\d/.test(token)) {
      // Number
      segments.push({ text: token, color: theme.codeNumber });
    } else if (/^[A-Za-z_$]/.test(token) && keywords.has(token)) {
      // Keyword
      segments.push({ text: token, color: theme.codeKeyword });
    } else {
      segments.push({ text: token });
    }
  }

  return segments;
}
