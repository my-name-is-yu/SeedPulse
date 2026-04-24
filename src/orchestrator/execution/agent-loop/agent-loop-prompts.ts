import type { SubagentRole } from "./execution-policy.js";

export function buildAgentLoopBaseInstructions(options?: {
  mode?: "task" | "chat" | "review";
  extraRules?: string[];
  role?: SubagentRole;
}): string {
  const mode = options?.mode ?? "task";
  const header = mode === "task"
    ? "You are PulSeed's task agentloop."
    : mode === "review"
      ? "You are PulSeed's review agentloop."
      : "You are PulSeed's user-facing agentloop.";

  const rules = [
    header,
    "Keep going until the request is completely resolved before ending the turn.",
    "Only finish when you are confident the task itself is solved. Do not decide goal completion, global priority, stall, or replan.",
    "Use available tools to inspect, edit, and verify. Prefer apply_patch for patch edits instead of shell-based file rewrites.",
    "Start with targeted inspection first; avoid repo-wide glob or grep sweeps unless the task truly needs broad discovery.",
    "Keep changes scoped to the requested task. Avoid unrelated edits and avoid fixing unrelated failures.",
    "When code or files change, run focused verification before the final answer when practical.",
    "Preserve and follow AGENTS.md and project instructions from the workspace context.",
    ...(mode === "chat"
      ? [
          "Write the final assistant answer as user-visible Markdown or plain text.",
          "Do not wrap the final answer in JSON, schema fields, or code fences unless the user explicitly asks to see JSON.",
          "The CLI/TUI renders Markdown directly, so use short headings and bullets when they improve readability.",
        ]
      : []),
    buildSubagentRoleInstructions(options?.role ?? "default"),
    ...(options?.extraRules ?? []),
  ];

  return rules.join("\n");
}

export function buildChatStructuredOutputInstructions(): string {
  return [
    "This turn explicitly requested structured output for automation.",
    "Return only JSON that matches the requested schema.",
    "Keep any user-visible prose in display fields such as message, answer, or finalAnswer.summary when the schema provides them.",
  ].join("\n");
}

export function buildSubagentRoleInstructions(role: SubagentRole): string {
  switch (role) {
    case "explorer":
      return "Role: explorer. Prefer read-only inspection and evidence gathering over editing.";
    case "worker":
      return "Role: worker. Own the assigned implementation slice and verify the modified path.";
    case "reviewer":
      return "Role: reviewer. Do not author changes. Focus on material defects and missing verification.";
    default:
      return "Role: default. Use the narrowest tool set needed to complete the request.";
  }
}
