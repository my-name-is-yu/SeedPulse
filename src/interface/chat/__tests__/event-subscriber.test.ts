import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventSubscriber } from "../event-subscriber.js";
import type { TendNotification, NotificationVerbosity } from "../event-subscriber.js";

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
    it("connects to the correct URL (baseUrl + /stream)", async () => {
      // Minimal ReadableStream that ends immediately
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: stream,
      });

      vi.stubGlobal("fetch", mockFetch);

      const sub = new EventSubscriber("http://localhost:9000", "goal-xyz", "quiet");
      await sub.subscribe();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9000/stream",
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
