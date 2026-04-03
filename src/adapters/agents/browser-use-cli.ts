// ─── BrowserUseCLIAdapter ───
//
// IAdapter implementation that spawns the `browser-use` CLI process.
// The task prompt is passed via stdin to avoid exposing it in the
// process argument list (visible via `ps aux`).
// Uses --headless for non-interactive browser automation and --json
// for structured output.
//
// Invocation pattern:
//   echo "<prompt>" | browser-use run --headless --json
//
// The CLI takes a natural language task, controls a browser with AI,
// and returns the result (JSON when --json is used).

import type { IAdapter, AgentTask, AgentResult } from "../execution/adapter-layer.js";
import { spawnWithTimeout } from "./spawn-helper.js";

export interface BrowserUseCLIAdapterConfig {
  /** The executable name / path for the browser-use CLI. Default: "browser-use" */
  cliPath?: string;
  /** Whether to run the browser in headless mode. Default: true */
  headless?: boolean;
  /** Whether to request JSON-formatted output. Default: true */
  jsonOutput?: boolean;
}

export class BrowserUseCLIAdapter implements IAdapter {
  readonly adapterType = "browser_use_cli";
  readonly capabilities = ["browse_web", "web_scraping", "form_filling", "screenshot"] as const;

  private readonly cliPath: string;
  private readonly headless: boolean;
  private readonly jsonOutput: boolean;

  constructor(config: BrowserUseCLIAdapterConfig = {}) {
    this.cliPath = config.cliPath ?? "browser-use";
    this.headless = config.headless !== false;
    this.jsonOutput = config.jsonOutput !== false;
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const startedAt = Date.now();

    // Build argument list: run [--headless] [--json]
    // Prompt is written to stdin to avoid exposure in `ps aux`.
    const spawnArgs: string[] = ["run"];

    if (this.headless) {
      spawnArgs.push("--headless");
    }

    if (this.jsonOutput) {
      spawnArgs.push("--json");
    }

    const result = await spawnWithTimeout(
      this.cliPath,
      spawnArgs,
      { env: process.env, stdinData: task.system_prompt ? `[System Context]
${task.system_prompt}

[User Request]
${task.prompt}` : task.prompt },
      task.timeout_ms
    );

    const elapsed = Date.now() - startedAt;

    if (result.timedOut) {
      return {
        success: false,
        output: result.stdout,
        error: `Timed out after ${task.timeout_ms}ms`,
        exit_code: result.exitCode,
        elapsed_ms: elapsed,
        stopped_reason: "timeout",
      };
    }

    if (result.exitCode === null) {
      return {
        success: false,
        output: result.stdout,
        error: result.stderr,
        exit_code: null,
        elapsed_ms: elapsed,
        stopped_reason: "error",
      };
    }

    const success = result.exitCode === 0;
    return {
      success,
      output: result.stdout,
      error: success ? null : result.stderr || `Process exited with code ${result.exitCode}`,
      exit_code: result.exitCode,
      elapsed_ms: elapsed,
      stopped_reason: success ? "completed" : "error",
    };
  }
}
