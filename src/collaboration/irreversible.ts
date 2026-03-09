export const IRREVERSIBLE_PATTERNS: RegExp[] = [
  /git\s+push/,
  /rm\s+-rf/,
  /curl\s+-X\s+(POST|PUT|DELETE|PATCH)/i,
  /docker\s+(push|rm)\b/i,
  /npm\s+publish/,
  /\bdeploy\b/i,
  /DROP\s+TABLE/i,
  /DELETE\s+FROM/i,
];

/**
 * Flatten all string values from a nested object into a single space-joined string.
 */
function flattenValues(obj: unknown): string {
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(flattenValues).join(' ');
  if (obj !== null && typeof obj === 'object') {
    return Object.values(obj as Record<string, unknown>).map(flattenValues).join(' ');
  }
  return '';
}

/**
 * Returns true if any irreversible pattern is detected in the tool name or tool input.
 * For Bash tools, checks tool_input.command. For all tools, checks all string values.
 */
export function isIrreversibleAction(toolName: string, toolInput: Record<string, unknown>): boolean {
  // First check against the tool name itself
  for (const pattern of IRREVERSIBLE_PATTERNS) {
    if (pattern.test(toolName)) return true;
  }

  // Build a searchable corpus from all string values in the tool input
  const corpus = flattenValues(toolInput);
  for (const pattern of IRREVERSIBLE_PATTERNS) {
    if (pattern.test(corpus)) return true;
  }

  return false;
}
