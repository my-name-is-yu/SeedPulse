/**
 * XML tag formatting and token trimming utilities for PromptGateway.
 */

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

export function wrapXmlTag(tag: string, content: string): string {
  if (!content || !content.trim()) return "";
  return `<${tag}>\n${content}\n</${tag}>`;
}

import { estimateTokens } from "../execution/context/context-budget.js";
export { estimateTokens };

export function trimToTokenBudget(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;

  const maxChars = maxTokens * 4;
  const trimmed = text.slice(0, maxChars);

  // Try to trim at a line boundary
  const lastNewline = trimmed.lastIndexOf("\n");
  const result = lastNewline > 0 ? trimmed.slice(0, lastNewline) : trimmed;

  return result + "\n... (truncated)";
}

// ---------------------------------------------------------------------------
// Context formatters (each returns inner content; caller wraps with wrapXmlTag)
// ---------------------------------------------------------------------------

export function formatGoalContext(
  goal: { title?: string; description?: string },
  strategy?: { hypothesis?: string }
): string {
  const lines: string[] = [];

  if (goal.title) lines.push(`Goal: ${goal.title}`);
  if (goal.description) lines.push(`Description: ${goal.description}`);
  if (strategy?.hypothesis) lines.push(`Active Strategy: ${strategy.hypothesis}`);

  return lines.join("\n");
}

export function formatCurrentState(
  dimensions: Array<{ name: string; current: string | number | boolean | null; target?: string | number; gap?: number }>
): string {
  if (!dimensions.length) return "";

  return dimensions
    .map((d) => {
      let line = `${d.name}: ${String(d.current ?? "")}`;
      if (d.target !== undefined) line += ` (target: ${d.target}`;
      if (d.gap !== undefined) line += `, gap: ${d.gap}`;
      if (d.target !== undefined) line += ")";
      return line;
    })
    .join("\n");
}

export function formatObservationHistory(
  history: Array<{ timestamp: string; score: number }>,
  direction?: string
): string {
  if (!history.length) return "";

  const recent = history.slice(-5);
  const trend = recent.map((h) => `${h.timestamp}: ${h.score}`).join(", ");
  const lines = [`Trend (last ${recent.length}): ${trend}`];

  if (direction) lines.push(`Direction: ${direction}`);

  return lines.join("\n");
}

export function formatLessons(
  lessons: Array<{ importance: string; content: string }>
): string {
  if (!lessons.length) return "";

  const importanceOrder: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

  return [...lessons]
    .sort(
      (a, b) =>
        (importanceOrder[a.importance.toUpperCase()] ?? 99) -
        (importanceOrder[b.importance.toUpperCase()] ?? 99)
    )
    .map((l) => `- [${l.importance.toUpperCase()}] ${l.content}`)
    .join("\n");
}

export function formatKnowledge(
  entries: Array<{ question?: string; answer?: string; content?: string; confidence?: number }>
): string {
  if (!entries.length) return "";

  return entries
    .map((e) => {
      if (e.question && e.answer) {
        let line = `Q: ${e.question}\nA: ${e.answer}`;
        if (e.confidence !== undefined) line += ` (confidence: ${e.confidence})`;
        return line;
      }
      if (e.content) {
        let line = e.content;
        if (e.confidence !== undefined) line += ` (confidence: ${e.confidence})`;
        return line;
      }
      return null;
    })
    .filter(Boolean)
    .join("\n");
}

export function formatReflections(
  reflections: Array<{ what_failed?: string; suggestion?: string; content?: string }>
): string {
  if (!reflections.length) return "";

  return reflections
    .map((r) => {
      if (r.what_failed && r.suggestion) {
        return `Failed: ${r.what_failed}\nSuggestion: ${r.suggestion}`;
      }
      return r.content ?? null;
    })
    .filter(Boolean)
    .join("\n---\n");
}

export function formatWorkspaceState(items: string[]): string {
  if (!items.length) return "";
  return items.join("\n");
}

export function formatStrategyTemplates(
  templates: Array<{ hypothesis_pattern: string; effectiveness_score: number }>
): string {
  if (!templates.length) return "";

  return templates
    .map((t) => `- ${t.hypothesis_pattern} (effectiveness: ${t.effectiveness_score})`)
    .join("\n");
}

export function formatFailureContext(context: string): string {
  if (!context || !context.trim()) return "";
  return `Failure Context:\n${context}`;
}

export function formatTaskResults(
  results: Array<{ task_description: string; outcome: string; success: boolean }>
): string {
  if (!results.length) return "";

  return results
    .map((r) => {
      const status = r.success ? "SUCCESS" : "FAILURE";
      return `[${status}] ${r.task_description}\n  Outcome: ${r.outcome}`;
    })
    .join("\n");
}
