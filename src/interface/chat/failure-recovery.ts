export type FailureRecoveryKind =
  | "permission"
  | "tool_input"
  | "verification"
  | "runtime_interruption"
  | "daemon_loop"
  | "resume"
  | "adapter"
  | "unknown";

export interface FailureRecoveryGuidance {
  kind: FailureRecoveryKind;
  label: string;
  summary: string;
  nextActions: string[];
}

export function classifyFailureRecovery(error: string): FailureRecoveryGuidance {
  const normalized = error.toLowerCase();
  if (/\b(permission|approval|approved|denied|sandbox|eacces|eperm|unauthorized|forbidden)\b/.test(normalized)) {
    return {
      kind: "permission",
      label: "Permission failure",
      summary: "The turn stopped because the requested action was blocked by permissions or approval policy.",
      nextActions: [
        "Inspect the requested action before retrying.",
        "Use /permissions to review the current execution policy.",
        "Re-run with a narrower request or explicit approval if the action is expected.",
      ],
    };
  }
  if (/\b(verification|checks?|tests?|vitest|typecheck|lint)\b.*\b(fail|failing|failed|error)\b|\b(fail|failing|failed)\b.*\b(verification|checks?|tests?|vitest|typecheck|lint)\b/.test(normalized)) {
    return {
      kind: "verification",
      label: "Verification failure",
      summary: "Changes were made, but the configured checks did not pass.",
      nextActions: [
        "Run /review to inspect the current diff and verification context.",
        "Inspect the test output shown with this failure.",
        "Ask for a focused fix for the failing check before continuing.",
      ],
    };
  }
  if (/\b(resume|resumable|session state|agentloop state)\b/.test(normalized)) {
    return {
      kind: "resume",
      label: "Resume failure",
      summary: "PulSeed could not find or load the session state needed to continue this turn.",
      nextActions: [
        "Run /sessions to find the intended chat session.",
        "Run /resume <id|title> when the target session is available.",
        "Start a new turn with the missing context if no resumable state exists.",
      ],
    };
  }
  if (/\b(daemon|core loop|goal stalled|loop ended|runtime control|background)\b/.test(normalized)) {
    return {
      kind: "daemon_loop",
      label: "Daemon loop failure",
      summary: "A background loop or runtime-control path stopped before completing successfully.",
      nextActions: [
        "Run /status to inspect the active goal or daemon state.",
        "Use /resume when the session has resumable state.",
        "Check the daemon logs if the failure references runtime internals.",
      ],
    };
  }
  if (/\b(timed out|timeout|aborted|interrupted|cancelled|canceled|signal|disconnect|stream)\b/.test(normalized)) {
    return {
      kind: "runtime_interruption",
      label: "Runtime interruption",
      summary: "The active turn was interrupted before it could produce a complete final response.",
      nextActions: [
        "Use /resume if PulSeed reports resumable agent-loop state.",
        "Ask for a narrower continuation from the last visible step.",
        "Run /review first if files may have changed before the interruption.",
      ],
    };
  }
  if (/\b(schema|invalid|parse|missing|required|argument|input)\b/.test(normalized)) {
    return {
      kind: "tool_input",
      label: "Tool input failure",
      summary: "A tool or command received input it could not validate.",
      nextActions: [
        "Retry with the exact file, command, or option you want PulSeed to use.",
        "Ask PulSeed to inspect the target before attempting the tool again.",
        "Use /review if the failure happened after a file change.",
      ],
    };
  }
  if (/\b(adapter|model|provider|api|rate limit|llm)\b/.test(normalized)) {
    return {
      kind: "adapter",
      label: "Adapter failure",
      summary: "The configured model or adapter path failed before the turn completed.",
      nextActions: [
        "Retry the turn after checking provider availability.",
        "Use /model to confirm the active provider and adapter.",
        "Narrow the request if the failure happened during a long turn.",
      ],
    };
  }
  return {
    kind: "unknown",
    label: "Unclassified failure",
    summary: "PulSeed could not classify this failure from the error text alone.",
    nextActions: [
      "Run /review if the turn may have changed files.",
      "Retry with a narrower request that names the intended next step.",
      "Use /sessions or /status when the failure relates to session or daemon state.",
    ],
  };
}

export function formatFailureRecovery(guidance: FailureRecoveryGuidance): string {
  return [
    "Recovery",
    `Type: ${guidance.label}`,
    guidance.summary,
    "Next actions:",
    ...guidance.nextActions.map((action) => `- ${action}`),
  ].join("\n");
}

export function formatLifecycleFailureMessage(
  error: string,
  partialText: string,
  guidance: FailureRecoveryGuidance = classifyFailureRecovery(error)
): string {
  const normalizedPartial = partialText.trim();
  const normalizedError = error.trim();
  const base = normalizedPartial && normalizedPartial !== normalizedError
    ? `${partialText}\n\n[interrupted: ${error}]`
    : normalizedPartial || `Error: ${error}`;
  return `${base}\n\n${formatFailureRecovery(guidance)}`;
}
