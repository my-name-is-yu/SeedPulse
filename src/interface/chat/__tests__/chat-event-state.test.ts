import { describe, expect, it } from "vitest";
import { applyChatEventToMessages } from "../chat-event-state.js";

describe("applyChatEventToMessages", () => {
  it("keeps activity as one updatable row per turn", () => {
    const first = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "lifecycle",
      message: "Received. Starting work...",
      sourceId: "lifecycle:start",
      transient: true,
    }, 20);

    const second = applyChatEventToMessages(first, {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      kind: "tool",
      message: "Running tool: grep - ChatEvent",
      sourceId: "tool-1",
      transient: true,
    }, 20);

    expect(second).toHaveLength(1);
    expect(second[0]!).toMatchObject({
      id: "activity:turn-1",
      role: "pulseed",
      text: "Running tool: grep - ChatEvent",
      messageType: "info",
    });
  });

  it("shows raw tool events as a current activity row", () => {
    const messages = applyChatEventToMessages([], {
      type: "tool_start",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      toolCallId: "tool-1",
      toolName: "shell_command",
      args: { command: "rg ChatEvent src/interface/chat", cwd: "/repo" },
    }, 20);

    expect(messages).toHaveLength(1);
    expect(messages[0]!).toMatchObject({
      id: "tool-log:turn-1",
      role: "pulseed",
      messageType: "info",
    });
    expect(messages[0]!.text).toContain("Current activity");
    expect(messages[0]!.text).toContain("Reading shell_command - command=rg ChatEvent src/interface/chat");
  });

  it("removes transient activity when assistant final arrives", () => {
    const withActivity = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "lifecycle",
      message: "Working...",
      transient: true,
    }, 20);

    const afterFinal = applyChatEventToMessages(withActivity, {
      type: "assistant_final",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      text: "Done",
      persisted: true,
    }, 20);

    expect(afterFinal).toHaveLength(1);
    expect(afterFinal[0]!.id).toBe("turn-1");
    expect(afterFinal[0]!.text).toBe("Done");
  });

  it("removes transient activity when lifecycle error arrives", () => {
    const withActivity = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "tool",
      message: "Running tool...",
      transient: true,
    }, 20);

    const afterError = applyChatEventToMessages(withActivity, {
      type: "lifecycle_error",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      error: "boom",
      partialText: "Partial",
      persisted: false,
    }, 20);

    expect(afterError).toHaveLength(1);
    expect(afterError[0]!.id).toBe("turn-1");
    expect(afterError[0]!.messageType).toBe("error");
  });

  it("removes transient activity on lifecycle end", () => {
    const withActivity = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "commentary",
      message: "Still working...",
      transient: true,
    }, 20);

    const afterEnd = applyChatEventToMessages(withActivity, {
      type: "lifecycle_end",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:02.000Z",
      status: "completed",
      elapsedMs: 2000,
      persisted: true,
    }, 20);

    expect(afterEnd).toEqual([]);
  });

  it("keeps non-transient activity rows after turn-ending events", () => {
    const withPersistentActivity = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "commentary",
      message: "Pinned note",
      transient: false,
    }, 20);

    const afterEnd = applyChatEventToMessages(withPersistentActivity, {
      type: "lifecycle_end",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      status: "completed",
      elapsedMs: 1000,
      persisted: true,
    }, 20);

    expect(afterEnd).toHaveLength(1);
    expect(afterEnd[0]!.id).toBe("activity:turn-1");
    expect(afterEnd[0]!.text).toBe("Pinned note");
  });

  it("keeps non-transient sourced activity separate from transient status updates", () => {
    const withIntent = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "commentary",
      message: "Intent\n- Confirm: inspect the repo",
      sourceId: "intent:first-step",
      transient: false,
    }, 20);

    const withStatus = applyChatEventToMessages(withIntent, {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      kind: "lifecycle",
      message: "Preparing context...",
      sourceId: "lifecycle:context",
      transient: true,
    }, 20);

    const afterEnd = applyChatEventToMessages(withStatus, {
      type: "lifecycle_end",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:02.000Z",
      status: "completed",
      elapsedMs: 2000,
      persisted: true,
    }, 20);

    expect(afterEnd).toHaveLength(1);
    expect(afterEnd[0]!).toMatchObject({
      id: "activity:turn-1:intent:first-step",
      text: "Intent\n- Confirm: inspect the repo",
      transient: false,
    });
  });

  it("keeps checkpoint rows visible after transient lifecycle activity ends", () => {
    const withCheckpoint = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "checkpoint",
      message: "Checkpoint\n- Context gathered: Workspace grounding is ready.",
      sourceId: "checkpoint:context",
      transient: false,
    }, 20);

    const withStatus = applyChatEventToMessages(withCheckpoint, {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      kind: "lifecycle",
      message: "Calling adapter...",
      sourceId: "lifecycle:adapter",
      transient: true,
    }, 20);

    const afterEnd = applyChatEventToMessages(withStatus, {
      type: "lifecycle_end",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:02.000Z",
      status: "completed",
      elapsedMs: 2000,
      persisted: true,
    }, 20);

    expect(afterEnd).toHaveLength(1);
    expect(afterEnd[0]!).toMatchObject({
      id: "activity:turn-1:checkpoint:context",
      text: "Checkpoint\n- Context gathered: Workspace grounding is ready.",
      transient: false,
    });
  });

  it("keeps diff artifact rows visible after transient lifecycle activity ends", () => {
    const withDiff = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "diff",
      message: "Changed files\nModified files\nM\tsrc/example.ts",
      sourceId: "diff:working-tree",
      transient: false,
    }, 20);

    const withStatus = applyChatEventToMessages(withDiff, {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      kind: "lifecycle",
      message: "Finalizing response...",
      sourceId: "lifecycle:finalizing",
      transient: true,
    }, 20);

    const afterEnd = applyChatEventToMessages(withStatus, {
      type: "lifecycle_end",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:02.000Z",
      status: "completed",
      elapsedMs: 2000,
      persisted: true,
    }, 20);

    expect(afterEnd).toHaveLength(1);
    expect(afterEnd[0]!).toMatchObject({
      id: "activity:turn-1:diff:working-tree",
      text: "Changed files\nModified files\nM\tsrc/example.ts",
      transient: false,
    });
  });

  it("preserves the latest few tool events and keeps tool logs after the turn ends", () => {
    let messages = [] as ReturnType<typeof applyChatEventToMessages>;
    for (let index = 1; index <= 6; index += 1) {
      messages = applyChatEventToMessages(messages, {
        type: "tool_start",
        runId: "run-1",
        turnId: "turn-1",
        createdAt: `2026-04-08T00:00:0${index}.000Z`,
        toolCallId: `tool-${index}`,
        toolName: "read_file",
        args: { path: `src/file-${index}.ts` },
      }, 20);
    }

    const toolLog = messages.find((message) => message.id === "tool-log:turn-1");
    expect(toolLog?.text).not.toContain("file-1.ts");
    expect(toolLog?.text).toContain("file-2.ts");
    expect(toolLog?.text).toContain("file-6.ts");

    const afterEnd = applyChatEventToMessages(messages, {
      type: "lifecycle_end",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:10.000Z",
      status: "completed",
      elapsedMs: 10_000,
      persisted: true,
    }, 20);

    expect(afterEnd.find((message) => message.id === "tool-log:turn-1")?.text).toContain("Recent activity");
  });

  it("keeps tool intent categories across updates and distinguishes waiting for approval", () => {
    const started = applyChatEventToMessages([], {
      type: "tool_start",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      toolCallId: "tool-1",
      toolName: "shell_command",
      args: { command: "npm run test:changed -- --run" },
    }, 20);

    const running = applyChatEventToMessages(started, {
      type: "tool_update",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      toolCallId: "tool-1",
      toolName: "shell_command",
      status: "running",
      message: "running",
    }, 20);

    expect(running[0]!.text).toContain("Verifying shell_command");
    expect(running[0]!.text).toContain("command=npm run test:changed -- --run");

    const waiting = applyChatEventToMessages(running, {
      type: "tool_update",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:02.000Z",
      toolCallId: "tool-2",
      toolName: "apply_patch",
      status: "awaiting_approval",
      message: "write src/example.ts",
    }, 20);

    expect(waiting[0]!.text).toContain("Waiting for approval apply_patch - write src/example.ts");
  });

  it("moves a tool out of waiting once execution resumes after approval", () => {
    const waiting = applyChatEventToMessages([], {
      type: "tool_update",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      toolCallId: "tool-1",
      toolName: "apply_patch",
      status: "awaiting_approval",
      message: "write src/example.ts",
    }, 20);

    const running = applyChatEventToMessages(waiting, {
      type: "tool_update",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      toolCallId: "tool-1",
      toolName: "apply_patch",
      status: "running",
      message: "running",
    }, 20);

    expect(running[0]!.text).not.toContain("Waiting for approval apply_patch");
    expect(running[0]!.text).toContain("Editing apply_patch - write src/example.ts");
  });
});
