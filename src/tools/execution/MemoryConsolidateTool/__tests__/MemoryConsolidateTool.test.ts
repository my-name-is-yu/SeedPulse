import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryConsolidateTool } from "../MemoryConsolidateTool.js";
import type { KnowledgeManager } from "../../../../platform/knowledge/knowledge-manager.js";
import type { ToolCallContext } from "../../../types.js";
import type { AgentMemoryEntry } from "../../../../platform/knowledge/types/agent-memory.js";

const makeContext = (): ToolCallContext => ({
  cwd: "/tmp",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
  sessionId: "session-1",
});

function makeCompiledEntry(): AgentMemoryEntry {
  return {
    id: crypto.randomUUID(),
    key: "consolidated-key",
    value: "consolidated value",
    tags: ["tag1"],
    memory_type: "fact",
    status: "compiled",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    summary: "consolidated summary",
  } as AgentMemoryEntry;
}

function makeMockKM(overrides: Partial<KnowledgeManager> = {}): KnowledgeManager {
  return {
    consolidateAgentMemory: vi.fn().mockResolvedValue({
      compiled: [makeCompiledEntry()],
      archived: 3,
    }),
    ...overrides,
  } as unknown as KnowledgeManager;
}

describe("MemoryConsolidateTool", () => {
  let km: KnowledgeManager;
  let llmCall: (prompt: string) => Promise<string>;
  let tool: MemoryConsolidateTool;

  beforeEach(() => {
    km = makeMockKM();
    llmCall = vi.fn().mockResolvedValue(
      JSON.stringify({ key: "k", value: "v", summary: "s", tags: [] })
    );
    tool = new MemoryConsolidateTool(km, llmCall);
  });

  describe("metadata", () => {
    it("has correct name", () => {
      expect(tool.metadata.name).toBe("memory_consolidate");
    });

    it("has consolidate alias", () => {
      expect(tool.metadata.aliases).toContain("consolidate_memory");
    });

    it("is not read-only", () => {
      expect(tool.metadata.isReadOnly).toBe(false);
    });

    it("is not destructive", () => {
      expect(tool.metadata.isDestructive).toBe(false);
    });

    it("has write_local permission", () => {
      expect(tool.metadata.permissionLevel).toBe("write_local");
    });

    it("has memory and consolidate tags", () => {
      expect(tool.metadata.tags).toContain("memory");
      expect(tool.metadata.tags).toContain("consolidate");
    });
  });

  describe("isConcurrencySafe", () => {
    it("returns false", () => {
      expect(tool.isConcurrencySafe({})).toBe(false);
    });
  });

  describe("checkPermissions", () => {
    it("always returns allowed", async () => {
      const result = await tool.checkPermissions({}, makeContext());
      expect(result.status).toBe("allowed");
    });
  });

  describe("description", () => {
    it("returns non-empty string", () => {
      expect(tool.description()).toBeTruthy();
    });
  });

  describe("successful execution", () => {
    it("consolidates entries and returns correct ToolResult format with counts", async () => {
      const result = await tool.call({}, makeContext());

      expect(result.success).toBe(true);
      const data = result.data as { compiledCount: number; archivedCount: number; stats: object };
      expect(data.compiledCount).toBe(1);
      expect(data.archivedCount).toBe(3);
      expect(data.stats).toBeDefined();
    });

    it("passes category filter to consolidateAgentMemory", async () => {
      await tool.call({ category: "infra" }, makeContext());
      expect(vi.mocked(km.consolidateAgentMemory)).toHaveBeenCalledWith(
        expect.objectContaining({ category: "infra" })
      );
    });

    it("passes memory_type filter to consolidateAgentMemory", async () => {
      await tool.call({ memory_type: "procedure" }, makeContext());
      expect(vi.mocked(km.consolidateAgentMemory)).toHaveBeenCalledWith(
        expect.objectContaining({ memory_type: "procedure" })
      );
    });

    it("includes max_entries in stats output", async () => {
      const result = await tool.call({ max_entries: 20 }, makeContext());
      expect(result.success).toBe(true);
      const data = result.data as { stats: { max_entries: number } };
      expect(data.stats.max_entries).toBe(20);
    });

    it("returns summary with compiled and archived counts", async () => {
      const result = await tool.call({}, makeContext());
      expect(result.summary).toContain("1");
      expect(result.summary).toContain("3");
    });
  });

  describe("error handling", () => {
    it("returns failure when consolidateAgentMemory throws", async () => {
      vi.mocked(km.consolidateAgentMemory).mockRejectedValue(new Error("llm error"));
      const result = await tool.call({}, makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain("llm error");
    });

    it("returns failure when llmCall is not configured (stub throws)", async () => {
      const stubLlmCall = () => Promise.reject(new Error("LLM not configured"));
      const stubTool = new MemoryConsolidateTool(
        { consolidateAgentMemory: vi.fn().mockRejectedValue(new Error("LLM not configured")) } as unknown as KnowledgeManager,
        stubLlmCall
      );
      const result = await stubTool.call({}, makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain("LLM not configured");
    });
  });
});
