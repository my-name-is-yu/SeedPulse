import type { Goal } from "../types/goal.js";

// ─── Threshold type sanitizer ───

const THRESHOLD_TYPE_MAP: Record<string, string> = {
  exact: "match",
  scale: "min",
  qualitative: "min",
  boolean: "present",
  percentage: "min",
  count: "min",
};

const VALID_THRESHOLD_TYPES = new Set(["min", "max", "range", "present", "match"]);

/**
 * Sanitizes LLM-returned threshold_type strings to valid enum values.
 * Handles the union of all known non-standard values from both
 * GoalRefiner (leaf test) and GoalTreeManager (subgoal decomposition).
 *
 * Uses regex replacement so it works on raw JSON strings before parsing.
 */
export function sanitizeThresholdTypes(raw: string): string {
  return raw.replace(
    /"threshold_type"\s*:\s*"([^"]+)"/g,
    (_match: string, val: string) => {
      if (VALID_THRESHOLD_TYPES.has(val)) return `"threshold_type": "${val}"`;
      const mapped = THRESHOLD_TYPE_MAP[val] ?? "min";
      return `"threshold_type": "${mapped}"`;
    }
  );
}

/**
 * Sanitizes LLM-returned threshold_value when threshold_type is "present".
 * When the LLM returns an object (e.g. `{"type":"present"}`) as the value for
 * a present threshold, replace it with null so downstream Zod schemas accept it.
 *
 * Operates on the raw JSON string before parsing to avoid any type-safety issues
 * with the un-parsed LLM output.
 */
export function sanitizeThresholdValues(raw: string): string {
  // Find any "threshold_value": <object> that immediately follows a "present" threshold_type.
  // Strategy: parse and re-serialize only the threshold_value fields for present dimensions.
  // We use a two-pass approach on the raw string to avoid fragile regex on nested JSON.
  try {
    const parsed: unknown = JSON.parse(raw);
    const sanitized = sanitizePresentThresholdValues(parsed);
    return JSON.stringify(sanitized);
  } catch {
    // If JSON parsing fails, return as-is and let downstream parsers handle it.
    return raw;
  }
}

function sanitizePresentThresholdValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizePresentThresholdValues);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      result[k] = sanitizePresentThresholdValues(v);
    }
    // If this object has threshold_type === "present" and threshold_value is an object, null it out.
    if (result["threshold_type"] === "present" && typeof result["threshold_value"] === "object" && result["threshold_value"] !== null) {
      result["threshold_value"] = null;
    }
    return result;
  }
  return value;
}

/**
 * Builds the leaf test prompt for the GoalRefiner.
 *
 * The returned prompt asks an LLM to evaluate whether the given goal is
 * directly measurable and, when it is, to specify concrete dimensions.
 */
export function buildLeafTestPrompt(
  goal: Goal,
  availableDataSources: string[]
): string {
  const constraintsSection =
    goal.constraints.length > 0
      ? `Constraints: ${goal.constraints.join(", ")}`
      : "Constraints: none";

  const dataSourcesSection =
    availableDataSources.length > 0
      ? availableDataSources.join(", ")
      : "shell, file_existence";

  return `You are evaluating whether a goal is directly measurable.

Goal: "${goal.description}"
${constraintsSection}
Available data sources: ${dataSourcesSection}
Depth: ${goal.decomposition_depth}

A goal is measurable when you can specify ALL of these for EACH aspect:
1. data_source — where to observe (shell command, file check, API, etc.)
2. observation_command — exact command or check to run
3. threshold_type — min/max/range/present/match
4. threshold_value — concrete target value

Return JSON:
{
  "is_measurable": true/false,
  "dimensions": [
    {
      "name": "snake_case_name",
      "label": "Human Label",
      "threshold_type": "min",
      "threshold_value": 80,
      "data_source": "shell",
      "observation_command": "npm test -- --coverage | grep Statements"
    },
    {
      "name": "config_file",
      "label": "Config File Present",
      "threshold_type": "present",
      "threshold_value": null,
      "data_source": "file_existence",
      "observation_command": "test -f config.json"
    }
  ],
  "reason": "Brief explanation"
}

When is_measurable is false, set "dimensions" to null.
For "present" threshold_type, always set "threshold_value" to null.`;
}
