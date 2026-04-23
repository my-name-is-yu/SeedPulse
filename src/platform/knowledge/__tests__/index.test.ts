import { describe, expect, it } from "vitest";
import { KnowledgeManager as KnowledgeManagerFromClass } from "../knowledge-manager.js";
import { detectKnowledgeGap as detectKnowledgeGapFromPublicApi } from "../public-api.js";
import { KnowledgeManager, detectKnowledgeGap } from "../index.js";

describe("platform knowledge index", () => {
  it("re-exports the class surface and standalone helpers", () => {
    expect(KnowledgeManager).toBe(KnowledgeManagerFromClass);
    expect(detectKnowledgeGap).toBe(detectKnowledgeGapFromPublicApi);
  });
});
