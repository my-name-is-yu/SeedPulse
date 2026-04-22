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

  it("does not add separate chat rows for raw tool events", () => {
    const messages = applyChatEventToMessages([], {
      type: "tool_start",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      toolCallId: "tool-1",
      toolName: "grep",
      args: { pattern: "ChatEvent" },
    }, 20);

    expect(messages).toEqual([]);
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
});
