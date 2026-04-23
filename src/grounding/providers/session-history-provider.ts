import * as fs from "node:fs";
import * as path from "node:path";
import type { GroundingMessage, GroundingProvider } from "../contracts.js";
import { makeSection, makeSource } from "./helpers.js";

function formatRecentMessages(messages: GroundingMessage[]): string {
  return messages
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n");
}

export const sessionHistoryProvider: GroundingProvider = {
  key: "session_history",
  kind: "dynamic",
  async build(context) {
    if (context.request.recentMessages && context.request.recentMessages.length > 0) {
      const recent = context.request.recentMessages.slice(-context.profile.budgets.maxHistoryMessages);
      const parts = [
        context.request.compactionSummary?.trim()
          ? `Compacted previous conversation summary:\n${context.request.compactionSummary.trim()}`
          : "",
        `Previous conversation:\n${formatRecentMessages(recent)}`,
      ].filter(Boolean);
      return makeSection(
        "session_history",
        parts.join("\n\n"),
        [
          makeSource("session_history", "request.recentMessages", {
            type: "derived",
            trusted: true,
            accepted: true,
            retrievalId: "session:recent_messages",
          }),
        ],
      );
    }

    const stateManager = context.deps.stateManager;
    if (!stateManager) {
      return null;
    }
    const baseDir = stateManager.getBaseDir?.();
    if (!baseDir) {
      return null;
    }
    const sessionsDir = path.join(baseDir, "sessions");
    if (!fs.existsSync(sessionsDir)) {
      return makeSection("session_history", "No recorded session history.", [
        makeSource("session_history", "sessions directory", {
          type: "none",
          path: sessionsDir,
          trusted: true,
          accepted: true,
          retrievalId: "none:session_history",
        }),
      ]);
    }

    const files = fs.readdirSync(sessionsDir).filter((entry) => entry.endsWith(".json")).slice(0, context.profile.budgets.maxHistoryMessages);
    const lines: string[] = [];
    for (const file of files) {
      const raw = await stateManager.readRaw(`sessions/${file}`) as Record<string, unknown> | null;
      if (!raw) continue;
      const id = typeof raw["id"] === "string" ? raw["id"] : file;
      const goalId = typeof raw["goal_id"] === "string" ? raw["goal_id"] : "unknown-goal";
      const summary = typeof raw["result_summary"] === "string" ? raw["result_summary"] : "No summary";
      lines.push(`- ${id} (${goalId}): ${summary}`);
    }

    return makeSection(
      "session_history",
      lines.length > 0 ? lines.join("\n") : "No recorded session history.",
      [
        makeSource("session_history", "sessions directory", {
          type: lines.length > 0 ? "state" : "none",
          path: sessionsDir,
          trusted: true,
          accepted: true,
          retrievalId: lines.length > 0 ? "session:stored" : "none:session_history",
        }),
      ],
    );
  },
};
