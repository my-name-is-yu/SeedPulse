import type { GroundingProvider } from "../contracts.js";
import { makeSection, makeSource } from "./helpers.js";

export const workspaceFactsProvider: GroundingProvider = {
  key: "workspace_facts",
  kind: "dynamic",
  async build(context) {
    const parts = [
      context.request.workspaceRoot ? `Workspace root: ${context.request.workspaceRoot}` : "",
      context.request.workspaceContext?.trim() ?? "",
    ].filter(Boolean);
    if (parts.length === 0) {
      return null;
    }
    return makeSection(
      "workspace_facts",
      parts.join("\n\n"),
      [
        makeSource("workspace_facts", "workspace request context", {
          type: "derived",
          trusted: true,
          accepted: true,
        }),
      ],
    );
  },
};
