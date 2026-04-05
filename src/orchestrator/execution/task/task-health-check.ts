/**
 * Shell command execution helper for post-execution health checks.
 *
 * runPostExecutionHealthCheck is extracted here as a standalone function.
 * The class method in TaskLifecycle is a thin wrapper that passes
 * `this.runShellCommand.bind(this)` so vi.spyOn(lifecycle, "runShellCommand") still works.
 */

import type { ToolExecutor } from "../../tools/executor.js";

type ShellCommandFn = (
  argv: string[],
  options: { timeout: number; cwd: string }
) => Promise<{ success: boolean; stdout: string; stderr: string }>;

/**
 * Run build and test checks after successful task execution to verify
 * the codebase remains healthy. Opt-in via healthCheckEnabled constructor option.
 *
 * If toolExecutor is provided, shell commands are routed through the 5-gate
 * security pipeline instead of being run directly with execFileSync.
 */
export async function runPostExecutionHealthCheck(
  runShellCommandFn: ShellCommandFn,
  toolExecutor?: ToolExecutor,
): Promise<{ healthy: boolean; output: string }> {
  const cwd = process.cwd();

  if (toolExecutor) {
    // Route through 5-gate security pipeline
    const context = {
      cwd,
      goalId: "health-check",
      trustBalance: 0,
      preApproved: true,
      approvalFn: async () => true,
    };

    // Run build check
    try {
      const buildResult = await toolExecutor.execute(
        "shell",
        { command: "npm run build", cwd },
        context,
      );
      if (!buildResult.success) {
        return {
          healthy: false,
          output: `Build failed: ${buildResult.error ?? buildResult.summary}`,
        };
      }
    } catch (err) {
      return { healthy: false, output: `Build check error: ${err}` };
    }

    // Run quick test check
    try {
      const testResult = await toolExecutor.execute(
        "shell",
        { command: "npx vitest run --reporter=dot", cwd },
        context,
      );
      if (!testResult.success) {
        return {
          healthy: false,
          output: `Tests failed: ${testResult.error ?? testResult.summary}`,
        };
      }
    } catch (err) {
      return { healthy: false, output: `Test check error: ${err}` };
    }
  } else {
    // Fallback: use raw shell command function
    // Run build check
    try {
      const buildResult = await runShellCommandFn(["npm", "run", "build"], {
        timeout: 60000,
        cwd,
      });
      if (!buildResult.success) {
        return {
          healthy: false,
          output: `Build failed: ${buildResult.stderr || buildResult.stdout}`,
        };
      }
    } catch (err) {
      return { healthy: false, output: `Build check error: ${err}` };
    }

    // Run quick test check (just verify tests still pass)
    try {
      const testResult = await runShellCommandFn(
        ["npx", "vitest", "run", "--reporter=dot"],
        { timeout: 120000, cwd }
      );
      if (!testResult.success) {
        return {
          healthy: false,
          output: `Tests failed: ${testResult.stderr || testResult.stdout}`,
        };
      }
    } catch (err) {
      return { healthy: false, output: `Test check error: ${err}` };
    }
  }

  return { healthy: true, output: "Build and tests passed" };
}

/**
 * Run a shell command safely using execFile (not exec) to avoid shell injection.
 */
export async function runShellCommand(
  argv: string[],
  options: { timeout: number; cwd: string }
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  try {
    const { stdout, stderr } = await execFileAsync(argv[0]!, argv.slice(1), {
      timeout: options.timeout,
      cwd: options.cwd,
    });
    return { success: true, stdout, stderr };
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "stdout" in err) {
      const e = err as { stdout: string; stderr: string };
      return { success: false, stdout: e.stdout || "", stderr: e.stderr || "" };
    }
    return { success: false, stdout: "", stderr: String(err) };
  }
}
