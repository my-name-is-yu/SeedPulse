export interface ChatDisplayFinalAnswerSection {
  title?: string;
  bullets?: unknown[];
}

export interface ChatDisplayFinalAnswer {
  summary?: string;
  sections?: ChatDisplayFinalAnswerSection[];
  evidence?: unknown[];
  blockers?: unknown[];
  nextActions?: unknown[];
  nextAction?: unknown;
}

export interface ChatDisplayOutput {
  status?: unknown;
  message?: unknown;
  answer?: unknown;
  evidence?: unknown;
  blockers?: unknown;
  finalAnswer?: ChatDisplayFinalAnswer | null;
  [key: string]: unknown;
}

export interface NormalizeAssistantDisplayTextInput {
  finalText?: string | null;
  output?: ChatDisplayOutput | null;
}

export function normalizeAssistantDisplayText(input: NormalizeAssistantDisplayTextInput): string | null {
  const formattedOutput = formatChatOutput(input.output);
  if (formattedOutput) return formattedOutput;

  const formattedFinalText = formatStructuredFinalText(input.finalText);
  if (formattedFinalText) return formattedFinalText;

  const raw = input.finalText?.trim();
  if (!raw) return null;
  if (isJsonObjectString(raw) && input.output !== null && input.output !== undefined) return null;
  return raw;
}

function formatChatOutput(output?: ChatDisplayOutput | null): string | null {
  if (!output) return null;

  const finalAnswer = isRecord(output.finalAnswer) ? output.finalAnswer : null;
  const outputEvidence = stringArray(output.evidence);
  const outputBlockers = stringArray(output.blockers);
  const summary = firstDisplayText([
    finalAnswer ? displayTextFromValue(finalAnswer.summary) : null,
    displayTextFromValue(output.message),
    displayTextFromValue(output.answer),
  ]);
  const sections: string[] = [];
  const handledKeys = new Set<string>(["status", "message", "answer", "evidence", "blockers", "finalAnswer"]);

  if (summary) {
    sections.push(summary);
  }

  for (const section of Array.isArray(finalAnswer?.sections) ? finalAnswer.sections : []) {
    if (!isRecord(section)) continue;
    const title = typeof section.title === "string" ? section.title.trim() : "";
    const bullets = stringArray(section.bullets);
    if (!title || bullets.length === 0) continue;
    sections.push(`### ${title}\n${bullets.map((bullet) => `- ${bullet}`).join("\n")}`);
  }

  const evidence = uniqueStrings([
    ...stringArray(finalAnswer?.evidence),
    ...outputEvidence,
  ]);
  if (evidence.length > 0) {
    sections.push(`### Evidence\n${evidence.map((item) => `- ${item}`).join("\n")}`);
  }

  const blockers = uniqueStrings([
    ...stringArray(finalAnswer?.blockers),
    ...outputBlockers,
  ]);
  if (blockers.length > 0) {
    sections.push(`### Blockers\n${blockers.map((item) => `- ${item}`).join("\n")}`);
  }

  const nextActions = stringArray(finalAnswer?.nextActions);
  const nextAction = displayTextFromValue(finalAnswer?.nextAction);
  if (nextAction) nextActions.push(nextAction);
  if (nextActions.length > 0) {
    sections.push(`### Next steps\n${nextActions.map((item) => `- ${item}`).join("\n")}`);
  }

  for (const [key, fieldValue] of Object.entries(output)) {
    if (handledKeys.has(key) || !Array.isArray(fieldValue)) continue;
    const lines = stringArray(fieldValue);
    if (lines.length === 0) continue;
    sections.push(`### ${humanizeFieldLabel(normalizeOutputFieldLabel(key))}\n${lines.map((line) => `- ${line}`).join("\n")}`);
  }

  for (const [key, fieldValue] of Object.entries(output)) {
    if (handledKeys.has(key) || typeof fieldValue !== "string") continue;
    const value = displayTextFromValue(fieldValue);
    if (!value) continue;
    if (key === "nextAction" || key === "next_action" || key === "nextStep" || key === "next_step") {
      sections.push(`### Next step\n- ${value}`);
    }
  }

  const rendered = sections.join("\n\n").trim();
  return rendered.length > 0 ? rendered : null;
}

function formatStructuredFinalText(finalText?: string | null): string | null {
  const parsed = parseJsonObject(finalText);
  if (!parsed) return null;
  return formatChatOutput(parsed);
}

function displayTextFromValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;

  const parsed = parseJsonObject(raw);
  if (!parsed) return raw;

  return firstDisplayText([
    displayTextFromValue(parsed.message),
    displayTextFromValue(parsed.answer),
    isRecord(parsed.finalAnswer) ? displayTextFromValue(parsed.finalAnswer.summary) : null,
  ]);
}

function firstDisplayText(values: Array<string | null>): string | null {
  return values.find((value): value is string => typeof value === "string" && value.length > 0) ?? null;
}

function parseJsonObject(value?: string | null): Record<string, unknown> | null {
  const raw = value?.trim();
  if (!raw || !isJsonObjectString(raw)) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isJsonObjectString(value: string): boolean {
  const raw = value.trim();
  return raw.startsWith("{") && raw.endsWith("}");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => displayTextFromValue(item))
    .filter((item): item is string => typeof item === "string" && item.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter((item) => item.length > 0))];
}

function humanizeFieldLabel(key: string): string {
  return key
    .split(/[_\s-]+/g)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function normalizeOutputFieldLabel(key: string): string {
  switch (key) {
    case "steps":
      return "recommended_steps";
    case "files":
    case "relevantFiles":
      return "relevant_files";
    case "nextActions":
    case "next_actions":
      return "next_steps";
    default:
      return key;
  }
}
