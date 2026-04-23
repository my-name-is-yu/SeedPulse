import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventSubscriber } from "../event-subscriber.js";
import type { TendNotification, NotificationVerbosity } from "../event-subscriber.js";
import type { ChatEvent } from "../chat-events.js";

// ─── Helpers ───

/**
 * Access private formatNotification via any-cast so we can unit test
 * the formatting logic without spinning up a real SSE connection.
 */
function format(
  subscriber: EventSubscriber,
  eventType: string,
  data: unknown
): TendNotification | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (subscriber as any).formatNotification(eventType, data);
}

function makeSubscriber(
  goalId = "goal-abc",
  verbosity: NotificationVerbosity = "normal"
): EventSubscriber {
  return new EventSubscriber("http://localhost:9000", goalId, verbosity);
}

// ─── Tests ───

describe("EventSubscriber", () => {
  describe("formatNotification — normal verbosity", () => {
    it("formats Observing progress events with gap", () => {
      const sub = makeSubscriber("goal-abc", "normal");
      const n = format(sub, "progress", {
        iteration: 3,
        maxIterations: 10,
        phase: "Observing...",
        gap: 0.72,
      });
      expect(n).not.toBeNull();
      expect(n!.type).toBe("progress");
      expect(n!.message).toContain("[3/10]");
      expect(n!.message).toContain("0.72");
      expect(n!.gap).toBe(0.72);
    });

    it("shows gap diff (0.72→0.55) across consecutive iterations", () => {
      const sub = makeSubscriber("goal-abc", "normal");
      format(sub, "progress", { iteration: 1, maxIterations: 10, phase: "Observing...", gap: 0.72 });
      const n = format(sub, "progress", { iteration: 2, maxIterations: 10, phase: "Observing...", gap: 0.55 });
      expect(n).not.toBeNull();
      expect(n!.message).toContain("0.72→0.55");
      expect(n!.previousGap).toBe(0.72);
      expect(n!.gap).toBe(0.55);
    });

    it("filters out Executing task phase in normal mode", () => {
      const sub = makeSubscriber("goal-abc", "normal");
      const n = format(sub, "progress", {
        iteration: 1,
        maxIterations: 10,
        phase: "Executing task...",
        taskDescription: "Run tests",
      });
      expect(n).toBeNull();
    });

    it("filters out unknown phases in normal mode", () => {
      const sub = makeSubscriber("goal-abc", "normal");
      const n = format(sub, "progress", {
        iteration: 1,
        maxIterations: 10,
        phase: "Planning...",
      });
      expect(n).toBeNull();
    });
  });

  describe("formatNotification — quiet verbosity", () => {
    it("returns null for Observing events (filters iteration events)", () => {
      const sub = makeSubscriber("goal-abc", "quiet");
      const n = format(sub, "progress", {
        iteration: 2,
        maxIterations: 10,
        phase: "Observing...",
        gap: 0.55,
      });
      expect(n).toBeNull();
    });

    it("still tracks previousGap internally when quiet", () => {
      const sub = makeSubscriber("goal-abc", "quiet");
      format(sub, "progress", { iteration: 1, maxIterations: 10, phase: "Observing...", gap: 0.80 });
      // private state updated even when null returned
      expect((sub as any).previousGap).toBe(0.80);
    });
  });

  describe("formatNotification — verbose verbosity", () => {
    it("includes Executing phase with task description", () => {
      const sub = makeSubscriber("goal-abc", "verbose");
      const n = format(sub, "progress", {
        iteration: 2,
        maxIterations: 10,
        phase: "Executing task...",
        taskDescription: "Run the test suite",
      });
      expect(n).not.toBeNull();
      expect(n!.message).toContain("Executing");
      expect(n!.message).toContain("Run the test suite");
    });

    it("includes all unknown phases in verbose mode", () => {
      const sub = makeSubscriber("goal-abc", "verbose");
      const n = format(sub, "progress", {
        iteration: 1,
        maxIterations: 5,
        phase: "Planning...",
        gap: 0.6,
      });
      expect(n).not.toBeNull();
      expect(n!.message).toContain("Planning...");
    });
  });

  describe("formatNotification — stall", () => {
    it("formats stall notification with warning symbol", () => {
      const sub = makeSubscriber("goal-abc", "normal");
      const n = format(sub, "progress", {
        iteration: 5,
        maxIterations: 10,
        phase: "Skipped",
        skipReason: "No state change detected",
      });
      expect(n).not.toBeNull();
      expect(n!.type).toBe("stall");
      expect(n!.message).toContain("⚠️");
      expect(n!.message).toContain("Stalled");
      expect(n!.message).toContain("No state change detected");
    });

    it("formats stall via stall keyword in phase", () => {
      const sub = makeSubscriber("goal-abc", "normal");
      const n = format(sub, "progress", {
        iteration: 3,
        phase: "stall detected",
        skipReason: "agent did not progress",
      });
      expect(n).not.toBeNull();
      expect(n!.type).toBe("stall");
    });
  });

  describe("formatNotification — complete", () => {
    it("formats complete notification with checkmark", () => {
      const sub = makeSubscriber("goal-abc", "normal");
      const n = format(sub, "progress", {
        iteration: 10,
        maxIterations: 10,
        phase: "complete",
        gap: 0.0,
      });
      expect(n).not.toBeNull();
      expect(n!.type).toBe("complete");
      expect(n!.message).toContain("✅");
      expect(n!.message).toContain("Complete!");
    });

    it("formats loop_complete event type", () => {
      const sub = makeSubscriber("goal-abc", "normal");
      const n = format(sub, "loop_complete", { gap: 0.02, iterations: 8 });
      expect(n).not.toBeNull();
      expect(n!.type).toBe("complete");
      expect(n!.message).toContain("✅");
      expect(n!.message).toContain("0.02");
    });

    it("formats goal_complete event type", () => {
      const sub = makeSubscriber("short", "normal");
      const n = format(sub, "goal_complete", { gap: 0.0, iterations: 5 });
      expect(n).not.toBeNull();
      expect(n!.type).toBe("complete");
    });

    it("resets previousGap after complete", () => {
      const sub = makeSubscriber("goal-abc", "normal");
      format(sub, "progress", { phase: "Observing...", gap: 0.3 });
      format(sub, "progress", { phase: "complete", gap: 0.0 });
      expect((sub as any).previousGap).toBeUndefined();
    });
  });

  describe("subscribe / unsubscribe", () => {
    it("bootstraps snapshot then connects to /stream with after cursor", async () => {
      const firstStream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      const retryStream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ approvals: [], last_outbox_seq: 5 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: firstStream,
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: retryStream,
        });

      vi.stubGlobal("fetch", mockFetch);

      const sub = new EventSubscriber("http://localhost:9000", "goal-xyz", "quiet");
      await sub.subscribe();

      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        "http://localhost:9000/snapshot",
        expect.objectContaining({
          headers: expect.objectContaining({ Accept: "application/json" }),
        })
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        "http://localhost:9000/stream?after=5",
        expect.objectContaining({
          headers: expect.objectContaining({ Accept: "text/event-stream" }),
        })
      );

      vi.unstubAllGlobals();
    });

    it("unsubscribe aborts the connection", () => {
      const sub = new EventSubscriber("http://localhost:9000", "goal-xyz", "normal");
      // Inject a mock AbortController
      const abortMock = vi.fn();
      (sub as any).abortController = { abort: abortMock, signal: { aborted: false } };

      sub.unsubscribe();

      expect(abortMock).toHaveBeenCalledOnce();
      expect((sub as any).abortController).toBeNull();
    });

    it("subscribeReady resolves after a retry without waiting for the full stream lifecycle", async () => {
      const stream = new ReadableStream({
        start() {
          // Keep the stream open; subscribeReady should still resolve once connected.
        },
      });

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ approvals: [], last_outbox_seq: 0 }),
        })
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: stream,
        });

      vi.stubGlobal("fetch", mockFetch);
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: any[]) => void) => {
        fn();
        return 0 as any;
      }) as typeof setTimeout);

      try {
        const sub = new EventSubscriber("http://localhost:9000", "goal-xyz", "quiet");
        await expect(sub.subscribeReady()).resolves.toBeUndefined();
      } finally {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
      }
    });

    it("subscribeReady rejects when both initial connect attempts fail", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ approvals: [], last_outbox_seq: 0 }),
        })
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockRejectedValueOnce(new Error("still failing"));

      vi.stubGlobal("fetch", mockFetch);
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: any[]) => void) => {
        fn();
        return 0 as any;
      }) as typeof setTimeout);

      try {
        const sub = new EventSubscriber("http://localhost:9000", "goal-xyz", "quiet");
        await expect(sub.subscribeReady()).rejects.toThrow("still failing");
      } finally {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
      }
    });
  });

  describe("notification events", () => {
    it("emits notification event on valid SSE message", () => {
      const sub = makeSubscriber("goal-abc", "normal");
      const received: TendNotification[] = [];
      sub.on("notification", (n: TendNotification) => received.push(n));

      // Invoke parseSSEMessage directly
      const raw = `event: progress\ndata: {"phase":"Observing...","gap":0.5,"iteration":1,"maxIterations":5}`;
      (sub as any).parseSSEMessage(raw);

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe("progress");
    });

    it("does not emit for malformed JSON data", () => {
      const sub = makeSubscriber("goal-abc", "normal");
      const received: TendNotification[] = [];
      sub.on("notification", (n: TendNotification) => received.push(n));

      (sub as any).parseSSEMessage(`event: progress\ndata: {not-json}`);

      expect(received).toHaveLength(0);
    });

    it("does not emit when verbosity filters out event", () => {
      const sub = makeSubscriber("goal-abc", "quiet");
      const received: TendNotification[] = [];
      sub.on("notification", (n: TendNotification) => received.push(n));

      const raw = `event: progress\ndata: {"phase":"Observing...","gap":0.5,"iteration":1,"maxIterations":5}`;
      (sub as any).parseSSEMessage(raw);

      expect(received).toHaveLength(0);
    });

    it("formats proactive report notifications from SSE", () => {
      const sub = makeSubscriber("goal-abc", "normal");
      const received: TendNotification[] = [];
      sub.on("notification", (n: TendNotification) => received.push(n));

      const raw = `event: notification_report\ndata: {"report_type":"daily_summary","title":"Morning Planning — 2026-04-08"}`;
      (sub as any).parseSSEMessage(raw);

      expect(received).toHaveLength(1);
      expect(received[0].message).toContain("Morning Planning");
      expect(received[0].reportType).toBe("daily_summary");
    });

    it("formats approval_required events as actionable approvals", () => {
      const sub = makeSubscriber("goal-abc", "normal");
      const received: TendNotification[] = [];
      sub.on("notification", (n: TendNotification) => received.push(n));

      const raw = `event: approval_required\ndata: {"requestId":"approval-123","task":{"description":"Approve daily brief dispatch","action":"dispatch_notification"}}`;
      (sub as any).parseSSEMessage(raw);

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe("approval");
      expect(received[0].requestId).toBe("approval-123");
      expect(received[0].message).toContain("Approve daily brief dispatch");
    });

    it("projects loop_error events into notifications and chat events", () => {
      const sub = makeSubscriber("goal-abc", "normal");
      const notifications: TendNotification[] = [];
      const chatEvents: ChatEvent[] = [];
      sub.on("notification", (n: TendNotification) => notifications.push(n));
      sub.on("chat_event", (event: ChatEvent) => chatEvents.push(event));

      const raw = `id: 11\nevent: loop_error\ndata: {"goalId":"goal-abc","message":"boom","status":"error"}`;
      (sub as any).parseSSEMessage(raw);

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        type: "error",
        goalId: "goal-abc",
      });
      expect(notifications[0].message).toContain("boom");
      expect(chatEvents).toHaveLength(1);
      expect(chatEvents[0]).toMatchObject({
        type: "activity",
        kind: "commentary",
      });
      if (chatEvents[0].type === "activity") {
        expect(chatEvents[0].message).toContain("boom");
        expect(chatEvents[0].sourceId).toBe("daemon:goal-abc:loop_error:error");
      }
    });

    it("ignores events for other goals when goalId is present", () => {
      const sub = makeSubscriber("goal-abc", "normal");
      const received: TendNotification[] = [];
      sub.on("notification", (n: TendNotification) => received.push(n));

      const raw = `id: 7\nevent: approval_required\ndata: {"requestId":"approval-123","goalId":"goal-other","task":{"description":"Ignore me","action":"noop"}}`;
      (sub as any).parseSSEMessage(raw);

      expect(received).toHaveLength(0);
      expect((sub as any).lastOutboxSeq).toBe(7);
    });

    it("emits transcript-compatible chat events for durable progress", () => {
      const sub = makeSubscriber("goal-abc", "normal");
      const received: ChatEvent[] = [];
      sub.on("chat_event", (event: ChatEvent) => received.push(event));

      const raw = `id: 9\nevent: progress\ndata: {"phase":"Observing...","gap":0.5,"iteration":1,"maxIterations":5}`;
      (sub as any).parseSSEMessage(raw);

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        type: "activity",
        kind: "commentary",
      });
      if (received[0].type === "activity") {
        expect(received[0].message).toContain("[1/5]");
        expect(received[0].message).toContain("gap: 0.50");
        expect(received[0].message).not.toContain("0.50→0.50");
        expect(received[0].sourceId).toBe("daemon:goal-abc:progress");
      }
    });

    it("emits assistant_final chat events for chat_response", () => {
      const sub = makeSubscriber("goal-abc", "normal");
      const received: ChatEvent[] = [];
      sub.on("chat_event", (event: ChatEvent) => received.push(event));

      const raw = `id: 10\nevent: chat_response\ndata: {"goalId":"goal-abc","message":"queued","status":"queued"}`;
      (sub as any).parseSSEMessage(raw);

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        type: "assistant_final",
        text: "queued",
        persisted: false,
      });
    });

    it("projects snapshot approvals into chat events during bootstrap", async () => {
      const firstStream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      const retryStream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            approvals: [{
              goalId: "goal-xyz",
              requestId: "approval-123",
              task: { description: "Approve daily brief dispatch" },
            }],
            last_outbox_seq: 5,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: firstStream,
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: retryStream,
        });

      vi.stubGlobal("fetch", mockFetch);

      const sub = new EventSubscriber("http://localhost:9000", "goal-xyz", "normal");
      const received: ChatEvent[] = [];
      sub.on("chat_event", (event: ChatEvent) => received.push(event));

      await sub.subscribe();

      expect(received.some((event) => (
        event.type === "activity"
        && event.message.includes("Approve daily brief dispatch")
        && event.sourceId === "daemon:goal-xyz:approval_required:approval-123"
      ))).toBe(true);

      vi.unstubAllGlobals();
    });
  });

  describe("goalId truncation", () => {
    it("truncates long goalId to 12 characters in messages", () => {
      const longId = "goal-very-long-identifier-xyz";
      const sub = makeSubscriber(longId, "normal");
      const n = format(sub, "loop_complete", { gap: 0.0, iterations: 3 });
      expect(n).not.toBeNull();
      const shortId = longId.slice(0, 12);
      expect(n!.message).toContain(shortId);
      expect(n!.message).not.toContain(longId);
    });

    it("does not truncate short goalId", () => {
      const sub = makeSubscriber("short", "normal");
      const n = format(sub, "loop_complete", { gap: 0.0, iterations: 3 });
      expect(n).not.toBeNull();
      expect(n!.message).toContain("short");
    });
  });
});
