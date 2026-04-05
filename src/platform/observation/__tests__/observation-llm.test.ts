import { describe, it, expect, vi } from "vitest";
import { observeWithLLM } from "../observation-llm.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import type { Logger } from "../../../runtime/logger.js";

function createMockLLMClient(score: number, reason = "test reason"): ILLMClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({
      content: JSON.stringify({ score, reason }),
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: "end_turn",
    }),
    parseJSON: vi.fn().mockReturnValue({ score, reason }),
  };
}

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

const noopApply = vi.fn();

describe("Observation LLM malformed JSON regression", () => {
  it("logs malformed threshold JSON, returns an observation, and does not throw", async () => {
    const gitContextFetcher = vi.fn().mockReturnValue("");
    const mockLLMClient = createMockLLMClient(0.65, "malformed threshold should not block");
    const logger = makeLogger();

    const entry = await observeWithLLM(
      "goal-malformed-threshold",
      "dim-malformed",
      "Improve code quality",
      "Code Quality",
      "{not valid json",
      mockLLMClient,
      { gitContextFetcher },
      noopApply,
      undefined,
      null,
      true,
      logger
    );

    expect(entry.extracted_value).toBe(0.65);
    expect(entry.raw_result).toMatchObject({ score: 0.65 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to parse thresholdDescription for binary check")
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to parse thresholdDescription JSON goal=")
    );
  });
});

describe("fetchGitDiffContext with ToolExecutor", () => {
  it("uses toolExecutor when provided and gitContextFetcher is not set", async () => {
    const { fetchGitDiffContext } = await import("../observation-llm.js");

    const mockExecute = vi.fn().mockResolvedValue({
      success: true,
      data: "diff --git a/foo.ts b/foo.ts\n+added line",
      summary: "git diff (unstaged): 2 lines",
      durationMs: 5,
    });
    const mockToolExecutor = { execute: mockExecute } as any;

    const result = await fetchGitDiffContext({}, 3000, "/tmp/workspace", mockToolExecutor);

    expect(mockExecute).toHaveBeenCalledWith(
      "git_diff",
      { target: "unstaged", maxLines: 200 },
      expect.objectContaining({ cwd: "/tmp/workspace", goalId: "observation" })
    );
    expect(result).toContain("[git diff]");
    expect(result).toContain("added line");
  });

  it("returns empty string when toolExecutor returns no diff", async () => {
    const { fetchGitDiffContext } = await import("../observation-llm.js");

    const mockExecute = vi.fn().mockResolvedValue({
      success: true,
      data: "",
      summary: "No changes found",
      durationMs: 3,
    });
    const mockToolExecutor = { execute: mockExecute } as any;

    const result = await fetchGitDiffContext({}, 3000, "/tmp/workspace", mockToolExecutor);
    expect(result).toBe("");
  });

  it("falls through to empty string when toolExecutor throws", async () => {
    const { fetchGitDiffContext } = await import("../observation-llm.js");

    const mockExecute = vi.fn().mockRejectedValue(new Error("executor error"));
    const mockToolExecutor = { execute: mockExecute } as any;

    const result = await fetchGitDiffContext({}, 3000, "/tmp/workspace", mockToolExecutor);
    expect(result).toBe("");
  });

  it("gitContextFetcher override takes priority over toolExecutor", async () => {
    const { fetchGitDiffContext } = await import("../observation-llm.js");

    const mockExecute = vi.fn();
    const mockToolExecutor = { execute: mockExecute } as any;
    const gitContextFetcher = vi.fn().mockReturnValue("override context");

    const result = await fetchGitDiffContext({ gitContextFetcher }, 3000, "/tmp/workspace", mockToolExecutor);

    expect(result).toBe("override context");
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
