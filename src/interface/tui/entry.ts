#!/usr/bin/env node
// ─── TUI Entry Point ───
//
// Reads daemon_mode from global config and routes to:
//   - Standalone mode (default): wires all deps in-process
//   - Daemon mode: connects to a running PulSeed daemon via SSE

import { StateManager } from "../../base/state/state-manager.js";
import { loadProviderConfig } from "../../base/llm/provider-config.js";
import { getPulseedDirPath } from "../../base/utils/paths.js";
import { App } from "./app.js";
import { getCliLogger } from "../cli/cli-logger.js";
import { ensureProviderConfig } from "../cli/ensure-api-key.js";
import { isNoFlickerEnabled, isMouseTrackingEnabled, AlternateScreen, MouseTracking } from "./flicker/index.js";
import { DEFAULT_CURSOR_STYLE, HIDE_CURSOR, SHOW_CURSOR, STEADY_BAR_CURSOR } from "./flicker/dec.js";
import { setTrustedTuiControlStream } from "./terminal-output.js";
import { createNoFlickerOutputController } from "./output-controller.js";
import {
  buildDaemonModeChatSurface,
  buildStandaloneTuiDeps,
} from "./entry-deps.js";
import {
  getDisplayCwd,
  resolveRunningDaemonConnection,
  startDaemonDetached,
  waitForDaemon,
} from "./entry-daemon.js";

// ─── Standalone mode ───

async function startTUIStandaloneMode(): Promise<void> {
  const noFlicker = await isNoFlickerEnabled();
  const mouseTrackingEnabled = isMouseTrackingEnabled(noFlicker);
  const outputController = noFlicker ? createNoFlickerOutputController() : null;
  outputController?.install();
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (noFlicker) {
      outputController?.writeTerminal(DEFAULT_CURSOR_STYLE + SHOW_CURSOR);
    }
    outputController?.destroy();
    setTrustedTuiControlStream(null);
  };

  try {
    let deps: Awaited<ReturnType<typeof buildStandaloneTuiDeps>>;
    try {
      deps = await buildStandaloneTuiDeps();
    } catch (err) {
      cleanup();
      const message = err instanceof Error ? err.message : String(err);
      getCliLogger().error(`Error: Failed to initialise dependencies: ${message}`);
      process.exit(1);
    }

    const { stateManager, trustManager, coreLoop, actionHandler, intentRecognizer, setRequestApproval, chatRunner } = deps;

    process.on("SIGTERM", () => { coreLoop.stop(); process.exit(0); });

    const providerConfig = await loadProviderConfig();
    const breadcrumb = {
      cwd: getDisplayCwd(),
      gitBranch: (await import("./git-branch.js")).getGitBranch(),
      providerName: providerConfig.provider,
    };

    const { render } = await import("ink");
    const React = await import("react");
    const terminalStream = outputController?.terminalStream ?? process.stdout;
    setTrustedTuiControlStream(terminalStream);
    if (noFlicker) {
      outputController?.writeTerminal(STEADY_BAR_CURSOR + HIDE_CURSOR);
    }

    const appElement = React.createElement(App, {
      coreLoop,
      stateManager,
      trustManager,
      actionHandler,
      intentRecognizer,
      chatRunner,
      onApprovalReady: setRequestApproval,
      noFlicker,
      controlStream: terminalStream,
      ...breadcrumb,
    });

    const { waitUntilExit } = render(
      React.createElement(
        AlternateScreen,
        { enabled: noFlicker, stream: terminalStream },
        React.createElement(
          MouseTracking,
          { enabled: mouseTrackingEnabled, stream: terminalStream },
          appElement,
        ),
      ),
      {
        exitOnCtrlC: false,
        incrementalRendering: noFlicker,
        maxFps: noFlicker ? 60 : 30,
        patchConsole: false,
        stdout: outputController?.renderStdout ?? process.stdout,
        stderr: outputController?.renderStderr ?? process.stderr,
      }
    );
    await waitUntilExit();
  } finally {
    cleanup();
  }
}

export { resolveRunningDaemonConnection };

// ─── Daemon mode ───

async function startTUIDaemonMode(): Promise<void> {
  const { DaemonClient } = await import("../../runtime/daemon/client.js");
  const baseDir = process.env.PULSEED_HOME ?? getPulseedDirPath();
  const noFlicker = await isNoFlickerEnabled();
  const mouseTrackingEnabled = isMouseTrackingEnabled(noFlicker);
  const outputController = noFlicker ? createNoFlickerOutputController() : null;
  outputController?.install();
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (noFlicker) {
      outputController?.writeTerminal(DEFAULT_CURSOR_STYLE + SHOW_CURSOR);
    }
    outputController?.destroy();
    setTrustedTuiControlStream(null);
  };

  try {
    let daemonClient: InstanceType<typeof DaemonClient>;
    let daemonPort: number;

    try {
      const existingConnection = await resolveRunningDaemonConnection(baseDir);

      if (existingConnection) {
        daemonClient = new DaemonClient({ host: "127.0.0.1", ...existingConnection, baseDir });
        daemonPort = existingConnection.port;
      } else {
        await startDaemonDetached(baseDir);
        const ready = await waitForDaemon(baseDir, 10_000);
        daemonClient = new DaemonClient({ host: "127.0.0.1", port: ready.port, authToken: ready.authToken, baseDir });
        daemonPort = ready.port;
      }

      daemonClient.connect();
    } catch (err) {
      cleanup();
      const message = err instanceof Error ? err.message : String(err);
      getCliLogger().error(`Error: Failed to connect to daemon: ${message}`);
      process.exit(1);
    }

    const stateManager = new StateManager(baseDir);
    await stateManager.init();
    const { chatRunner, setRequestApproval } = await buildDaemonModeChatSurface(
      baseDir,
      stateManager,
      daemonClient,
      daemonPort
    );

    const providerConfig = await loadProviderConfig();
    const cwd = getDisplayCwd();
    const gitBranch = (await import("./git-branch.js")).getGitBranch();
    const providerName = providerConfig.provider;

    process.on("SIGTERM", () => {
      daemonClient.disconnect();
      process.exit(0);
    });

    const { render } = await import("ink");
    const React = await import("react");
    const terminalStream = outputController?.terminalStream ?? process.stdout;
    setTrustedTuiControlStream(terminalStream);
    if (noFlicker) {
      outputController?.writeTerminal(STEADY_BAR_CURSOR + HIDE_CURSOR);
    }

    const appElement = React.createElement(App, {
      daemonClient,
      stateManager,
      cwd,
      gitBranch,
      providerName,
      noFlicker,
      chatRunner,
      onApprovalReady: setRequestApproval,
      controlStream: terminalStream,
    });

    const { waitUntilExit } = render(
      React.createElement(
        AlternateScreen,
        { enabled: noFlicker, stream: terminalStream },
        React.createElement(
          MouseTracking,
          { enabled: mouseTrackingEnabled, stream: terminalStream },
          appElement,
        ),
      ),
      {
        exitOnCtrlC: false,
        incrementalRendering: noFlicker,
        maxFps: noFlicker ? 60 : 30,
        patchConsole: false,
        stdout: outputController?.renderStdout ?? process.stdout,
        stderr: outputController?.renderStderr ?? process.stderr,
      }
    );
    await waitUntilExit();
  } finally {
    cleanup();
  }
}

// ─── Main entry ───

export async function startTUI(): Promise<void> {
  try {
    await ensureProviderConfig();
  } catch (err) {
    getCliLogger().error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const { loadGlobalConfig } = await import("../../base/config/global-config.js");
  const config = await loadGlobalConfig();

  if (config.daemon_mode) {
    await startTUIDaemonMode();
  } else {
    await startTUIStandaloneMode();
  }
}

// ─── CLI entry (when run directly as a binary) ───

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("entry.js") || process.argv[1].endsWith("entry.ts"));

if (isMain) {
  startTUI().catch((err) => {
    getCliLogger().error(String(err));
    process.exit(1);
  });
}
