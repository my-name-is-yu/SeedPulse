import { describe, expect, it } from "vitest";
import { BUILTIN_INTEGRATIONS, listBuiltinIntegrations } from "../builtin-integrations.js";

describe("builtin integrations", () => {
  it("exposes the Soil, MCP, and foreign plugin builtin descriptors", () => {
    expect(BUILTIN_INTEGRATIONS.map((integration) => integration.id)).toEqual([
      "soil-display",
      "mcp-bridge",
      "foreign-plugin-bridge",
    ]);
    expect(listBuiltinIntegrations()).toEqual(BUILTIN_INTEGRATIONS);
    expect(BUILTIN_INTEGRATIONS.every((integration) => integration.source === "builtin")).toBe(true);
    expect(BUILTIN_INTEGRATIONS.every((integration) => integration.capabilities.length > 0)).toBe(true);
  });
});
