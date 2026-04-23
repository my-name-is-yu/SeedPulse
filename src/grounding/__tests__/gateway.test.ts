import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StateManager } from "../../base/state/state-manager.js";
import { createGroundingGateway } from "../gateway.js";

function makeStateManager(overrides: Partial<StateManager> = {}): StateManager {
  return {
    listGoalIds: vi.fn().mockResolvedValue(["goal-1"]),
    loadGoal: vi.fn().mockResolvedValue({
      title: "Ship grounding",
      status: "active",
      loop_status: "running",
    }),
    readRaw: vi.fn().mockResolvedValue(null),
    loadGapHistory: vi.fn().mockResolvedValue([]),
    getBaseDir: vi.fn().mockReturnValue(path.join(os.tmpdir(), "pulseed-grounding-home")),
    ...overrides,
  } as unknown as StateManager;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GroundingGateway", () => {
  it("keeps history out of chat/general_turn but includes it for chat/handoff", async () => {
    const gateway = createGroundingGateway({ stateManager: makeStateManager() });
    const common = {
      workspaceRoot: "/repo",
      recentMessages: [
        { role: "user" as const, content: "First" },
        { role: "assistant" as const, content: "Second" },
      ],
    };

    const general = await gateway.build({
      surface: "chat",
      purpose: "general_turn",
      ...common,
    });
    const handoff = await gateway.build({
      surface: "chat",
      purpose: "handoff",
      ...common,
    });

    expect(general.dynamicSections.some((section) => section.key === "session_history")).toBe(false);
    expect(handoff.dynamicSections.some((section) => section.key === "session_history")).toBe(true);
  });

  it("trust-gates AGENTS files from untrusted paths and records the rejection", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-grounding-agents-"));
    const homeDir = path.join(tmpRoot, "home");
    const repoDir = path.join(tmpRoot, "repo");
    const nestedDir = path.join(repoDir, "node_modules", "pkg");
    fs.mkdirSync(path.join(homeDir, ".pulseed"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".pulseed", "AGENTS.md"), "Home instruction");
    fs.writeFileSync(path.join(repoDir, "AGENTS.md"), "Repo instruction");
    fs.writeFileSync(path.join(nestedDir, "AGENTS.md"), "Node modules instruction");
    vi.stubEnv("HOME", homeDir);

    const gateway = createGroundingGateway({ stateManager: makeStateManager() });
    const bundle = await gateway.build({
      surface: "agent_loop",
      purpose: "task_execution",
      workspaceRoot: nestedDir,
      userMessage: "Implement the change safely",
      query: "Implement the change safely",
    });

    const repoInstructions = bundle.dynamicSections.find((section) => section.key === "repo_instructions");
    expect(repoInstructions?.content).toContain("Repo instruction");
    expect(repoInstructions?.content).not.toContain("Node modules instruction");
    expect(bundle.warnings.some((warning) => warning.includes("Rejected repo instructions"))).toBe(true);
    expect(bundle.traces.source.some((source) => source.path?.endsWith("node_modules/pkg/AGENTS.md") && source.accepted === false)).toBe(true);
  });

  it("prefers Soil knowledge over broader knowledge results when Soil hits exist", async () => {
    const gateway = createGroundingGateway({ stateManager: makeStateManager() });
    const knowledgeQuery = vi.fn().mockResolvedValue({
      retrievalId: "knowledge:test",
      items: [{ id: "k1", content: "Fallback knowledge", source: "test" }],
    });

    const bundle = await gateway.build({
      surface: "agent_loop",
      purpose: "task_execution",
      workspaceRoot: "/repo",
      userMessage: "Implement the grounding gateway",
      query: "Implement the grounding gateway",
      soilQuery: async () => ({
        retrievalSource: "prefetch",
        warnings: [],
        hits: [{ soilId: "soil:1", title: "Grounding plan", summary: "Use Soil first" }],
      }),
      knowledgeQuery,
    });

    expect(bundle.dynamicSections.some((section) => section.key === "soil_knowledge")).toBe(true);
    expect(bundle.dynamicSections.some((section) => section.key === "knowledge_query")).toBe(false);
    expect(knowledgeQuery).not.toHaveBeenCalled();
  });

  it("caps chat/general_turn grounding to the profile token budget", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-grounding-budget-"));
    const repoDir = path.join(tmpRoot, "repo");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    const largeInstructions = "A".repeat(15_000);
    fs.writeFileSync(path.join(repoDir, "AGENTS.md"), largeInstructions);

    const gateway = createGroundingGateway({ stateManager: makeStateManager() });
    const bundle = await gateway.build({
      surface: "chat",
      purpose: "general_turn",
      workspaceRoot: repoDir,
      userMessage: "Summarize the current task",
      query: "Summarize the current task",
    });

    const repoInstructions = bundle.dynamicSections.find((section) => section.key === "repo_instructions");
    expect(bundle.metrics.totalEstimatedTokens).toBeLessThanOrEqual(2200);
    expect(repoInstructions?.content.length).toBeLessThan(largeInstructions.length);
    expect(bundle.warnings.some((warning) => warning.includes("Truncated repo_instructions"))).toBe(true);
  });
});
