import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock heavy dependencies so no real clients are constructed ───

vi.mock("../src/llm/llm-client.js", () => ({
  LLMClient: vi.fn().mockImplementation(() => ({ _tag: "LLMClient" })),
}));

vi.mock("../src/llm/ollama-client.js", () => ({
  OllamaLLMClient: vi.fn().mockImplementation(() => ({ _tag: "OllamaLLMClient" })),
}));

vi.mock("../src/llm/openai-client.js", () => ({
  OpenAILLMClient: vi.fn().mockImplementation(() => ({ _tag: "OpenAILLMClient" })),
}));

vi.mock("../src/llm/codex-llm-client.js", () => ({
  CodexLLMClient: vi.fn().mockImplementation(() => ({ _tag: "CodexLLMClient" })),
}));

vi.mock("../src/execution/adapter-layer.js", () => ({
  AdapterRegistry: vi.fn().mockImplementation(() => ({ register: vi.fn() })),
}));

vi.mock("../src/adapters/claude-code-cli.js", () => ({
  ClaudeCodeCLIAdapter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/adapters/claude-api.js", () => ({
  ClaudeAPIAdapter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/adapters/openai-codex.js", () => ({
  OpenAICodexCLIAdapter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/adapters/github-issue.js", () => ({
  GitHubIssueAdapter: vi.fn().mockImplementation(() => ({})),
}));

// ─── Mock provider-config so we control what each test sees ───

const mockLoadProviderConfig = vi.fn();

vi.mock("../src/llm/provider-config.js", () => ({
  loadProviderConfig: () => mockLoadProviderConfig(),
}));

import { buildLLMClient } from "../src/llm/provider-factory.js";

// ─── Tests ───

describe("buildLLMClient — early API key validation", () => {
  beforeEach(() => {
    mockLoadProviderConfig.mockReset();
  });

  // ── anthropic ──────────────────────────────────────────────────────────────

  describe("provider: anthropic", () => {
    it("throws when ANTHROPIC_API_KEY is absent", () => {
      mockLoadProviderConfig.mockReturnValue({
        llm_provider: "anthropic",
        default_adapter: "claude_api",
        // anthropic section absent → no api_key
      });

      expect(() => buildLLMClient()).toThrowError(/ANTHROPIC_API_KEY is not set/);
    });

    it("throws with setup instructions mentioning export", () => {
      mockLoadProviderConfig.mockReturnValue({
        llm_provider: "anthropic",
        default_adapter: "claude_api",
      });

      expect(() => buildLLMClient()).toThrowError(/export ANTHROPIC_API_KEY/);
    });

    it("succeeds when ANTHROPIC_API_KEY is present", () => {
      mockLoadProviderConfig.mockReturnValue({
        llm_provider: "anthropic",
        default_adapter: "claude_api",
        anthropic: { api_key: "sk-ant-test" },
      });

      expect(() => buildLLMClient()).not.toThrow();
    });
  });

  // ── openai ─────────────────────────────────────────────────────────────────

  describe("provider: openai", () => {
    it("throws when OPENAI_API_KEY is absent", () => {
      mockLoadProviderConfig.mockReturnValue({
        llm_provider: "openai",
        default_adapter: "openai_api",
        // openai section absent → no api_key
      });

      expect(() => buildLLMClient()).toThrowError(/OPENAI_API_KEY is not set/);
    });

    it("throws with setup instructions mentioning export", () => {
      mockLoadProviderConfig.mockReturnValue({
        llm_provider: "openai",
        default_adapter: "openai_api",
      });

      expect(() => buildLLMClient()).toThrowError(/export OPENAI_API_KEY/);
    });

    it("succeeds when OPENAI_API_KEY is present", () => {
      mockLoadProviderConfig.mockReturnValue({
        llm_provider: "openai",
        default_adapter: "openai_api",
        openai: { api_key: "sk-test" },
      });

      expect(() => buildLLMClient()).not.toThrow();
    });
  });

  // ── codex ──────────────────────────────────────────────────────────────────

  describe("provider: codex", () => {
    it("throws when OPENAI_API_KEY is absent", () => {
      mockLoadProviderConfig.mockReturnValue({
        llm_provider: "codex",
        default_adapter: "openai_codex_cli",
        // openai section absent → no api_key
      });

      expect(() => buildLLMClient()).toThrowError(/OPENAI_API_KEY is not set/);
    });

    it("throws with setup instructions mentioning export", () => {
      mockLoadProviderConfig.mockReturnValue({
        llm_provider: "codex",
        default_adapter: "openai_codex_cli",
      });

      expect(() => buildLLMClient()).toThrowError(/export OPENAI_API_KEY/);
    });

    it("succeeds when OPENAI_API_KEY is present", () => {
      mockLoadProviderConfig.mockReturnValue({
        llm_provider: "codex",
        default_adapter: "openai_codex_cli",
        openai: { api_key: "sk-test" },
      });

      expect(() => buildLLMClient()).not.toThrow();
    });
  });

  // ── ollama ─────────────────────────────────────────────────────────────────

  describe("provider: ollama", () => {
    it("succeeds without any API key (ollama needs no key)", () => {
      mockLoadProviderConfig.mockReturnValue({
        llm_provider: "ollama",
        default_adapter: "claude_api",
        // no anthropic or openai section
      });

      expect(() => buildLLMClient()).not.toThrow();
    });
  });

  // ── default fallback (unknown provider → OpenAI) ───────────────────────────

  describe("provider: default fallback", () => {
    it("throws when OPENAI_API_KEY is absent in default fallback path", () => {
      mockLoadProviderConfig.mockReturnValue({
        // @ts-expect-error intentionally unknown provider to exercise default branch
        llm_provider: "unknown-provider",
        default_adapter: "openai_api",
      });

      expect(() => buildLLMClient()).toThrowError(/OPENAI_API_KEY is not set/);
    });

    it("succeeds when OPENAI_API_KEY is present in default fallback path", () => {
      mockLoadProviderConfig.mockReturnValue({
        // @ts-expect-error intentionally unknown provider to exercise default branch
        llm_provider: "unknown-provider",
        default_adapter: "openai_api",
        openai: { api_key: "sk-test" },
      });

      expect(() => buildLLMClient()).not.toThrow();
    });
  });
});
