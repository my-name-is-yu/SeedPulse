import React from "react";
import { render } from "ink";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../../../runtime/daemon/client.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { TuiChatSurface } from "../chat-surface.js";
import { App, formatDaemonConnectionState } from "../app.js";

const testState = vi.hoisted(() => ({
  lastChatProps: null as null | { onSubmit: (value: string) => Promise<void> },
}));

vi.mock("ink", async () => {
  const actual = await vi.importActual<typeof import("ink")>("ink");
  return {
    ...actual,
    useInput: vi.fn(),
    useStdout: () => ({ stdout: { columns: 80, rows: 24 } }),
  };
});

vi.mock("../chat.js", async () => {
  return {
    Chat: (props: Record<string, unknown>) => {
      testState.lastChatProps = props as any;
      return null;
    },
  };
});

vi.mock("../fullscreen-chat.js", async () => {
  return {
    FullscreenChat: (props: Record<string, unknown>) => {
      testState.lastChatProps = props as any;
      return null;
    },
  };
});

vi.mock("../dashboard.js", () => ({
  Dashboard: () => null,
  statusLabel: (status: string) => status,
}));

vi.mock("../help-overlay.js", () => ({ HelpOverlay: () => null }));
vi.mock("../settings-overlay.js", () => ({ SettingsOverlay: () => null }));
vi.mock("../approval-overlay.js", () => ({ ApprovalOverlay: () => null }));
vi.mock("../report-view.js", () => ({ ReportView: () => null }));

function createDaemonClientMock() {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    handlers,
    isConnected: vi.fn(() => true),
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
    }),
    off: vi.fn((event: string) => {
      handlers.delete(event);
    }),
    connect: vi.fn(),
    disconnect: vi.fn(),
    startGoal: vi.fn(async () => {}),
    stopGoal: vi.fn(async () => {}),
    chat: vi.fn(async () => {}),
    approve: vi.fn(async () => {}),
  };
}

function createStateManagerMock() {
  return {
    listGoalIds: vi.fn(async () => [] as string[]),
    loadGoal: vi.fn(async () => null),
  };
}

function createChatRunnerMock() {
  return {
    startSession: vi.fn(),
    execute: vi.fn(async () => ({ success: true, output: "", elapsed_ms: 0 })),
    executeIngressMessage: vi.fn(async () => ({ success: true, output: "", elapsed_ms: 0 })),
    onEvent: undefined,
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("formatDaemonConnectionState", () => {
  it("renders connected, connecting, and disconnected labels", () => {
    expect(formatDaemonConnectionState("connected")).toBe("  [daemon connected]");
    expect(formatDaemonConnectionState("connecting")).toBe("  [daemon connecting]");
    expect(formatDaemonConnectionState("disconnected")).toBe("  [daemon disconnected]");
  });

  it("omits the badge when no daemon state is available", () => {
    expect(formatDaemonConnectionState(undefined)).toBeUndefined();
  });
});

describe("standalone slash command routing", () => {
  beforeEach(() => {
    testState.lastChatProps = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes /permissions to ChatRunner instead of standalone intent handlers", async () => {
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    const intentRecognizer = {
      recognize: vi.fn(async () => ({ intent: "unknown", raw: "/permissions" })),
    };
    const actionHandler = {
      handle: vi.fn(async () => ({ messages: ["unexpected"] })),
    };

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      intentRecognizer: intentRecognizer as any,
      actionHandler: actionHandler as any,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("/permissions workspace-write");

    expect(chatRunner.execute).toHaveBeenCalledWith("/permissions workspace-write", "~/workspace");
    expect(intentRecognizer.recognize).not.toHaveBeenCalled();
    expect(actionHandler.handle).not.toHaveBeenCalled();

    screen.unmount();
  });
});

describe("daemon-mode chat routing", () => {
  beforeEach(() => {
    testState.lastChatProps = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses ChatRunner when daemon mode has no active goal", async () => {
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();

    const screen = render(React.createElement(App, {
      daemonClient: daemonClient as unknown as DaemonClient,
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();

    expect(chatRunner.startSession).toHaveBeenCalledWith("~/workspace");
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("free form question");

    expect(chatRunner.execute).toHaveBeenCalledWith("free form question", "~/workspace");
    expect(chatRunner.executeIngressMessage).not.toHaveBeenCalled();
    expect(daemonClient.chat).not.toHaveBeenCalled();

    screen.unmount();
  });

  it("keeps free-form text on ChatRunner even when a daemon goal is active", async () => {
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();

    const screen = render(React.createElement(App, {
      daemonClient: daemonClient as unknown as DaemonClient,
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();

    daemonClient.handlers.get("loop_update")?.({
      goalId: "goal-123",
      running: true,
      iteration: 1,
      status: "running",
      trustScore: 0,
    });
    await flush();

    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("question for the active goal");

    expect(chatRunner.execute).toHaveBeenCalledWith("question for the active goal", "~/workspace");
    expect(daemonClient.chat).not.toHaveBeenCalled();
    expect(chatRunner.executeIngressMessage).not.toHaveBeenCalled();

    screen.unmount();
  });

  it("routes /permissions to ChatRunner in daemon mode", async () => {
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();

    const screen = render(React.createElement(App, {
      daemonClient: daemonClient as unknown as DaemonClient,
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("/permissions read-only");

    expect(chatRunner.execute).toHaveBeenCalledWith("/permissions read-only", "~/workspace");
    expect(daemonClient.chat).not.toHaveBeenCalled();

    screen.unmount();
  });
});
