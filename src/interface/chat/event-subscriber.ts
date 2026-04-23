import { EventEmitter } from "node:events";
import { readDaemonAuthToken } from "../../runtime/daemon/client.js";
import type { ChatEvent } from "./chat-events.js";

export interface TendNotification {
  type: "progress" | "stall" | "complete" | "error" | "approval";
  goalId: string;
  message: string;
  iteration?: number;
  maxIterations?: number;
  gap?: number;
  previousGap?: number;
  requestId?: string;
  reportType?: string;
}

export type NotificationVerbosity = "verbose" | "normal" | "quiet";

interface RawProgressEvent {
  iteration?: number;
  maxIterations?: number;
  phase?: string;
  gap?: number;
  taskDescription?: string;
  skipReason?: string;
}

interface RawNotificationReport {
  report_type?: string;
  title?: string;
  content?: string;
  goal_id?: string | null;
}

interface RawChatResponseEvent {
  goalId?: string;
  goal_id?: string;
  message?: string;
  status?: string;
}

interface RawLoopErrorEvent {
  goalId?: string;
  goal_id?: string;
  error?: string;
  message?: string;
  status?: string;
  crashCount?: number;
  crash_count?: number;
  maxRetries?: number;
  max_retries?: number;
}

export class EventSubscriber extends EventEmitter {
  private abortController: AbortController | null = null;
  private previousGap: number | undefined = undefined;
  private lastOutboxSeq = 0;
  private snapshotBootstrapped = false;
  private streamLoopPromise: Promise<void> | null = null;
  private localProjectionSeq = 0;

  constructor(
    private baseUrl: string,
    private goalId: string,
    private verbosity: NotificationVerbosity = "normal",
    private authToken: string | null = readDaemonAuthToken()
  ) {
    super();
  }

  /** Start listening to SSE stream from daemon EventServer */
  async subscribe(): Promise<void> {
    this.abortController?.abort();
    this.abortController = new AbortController();
    await this.connect(false);
  }

  /**
   * Bootstrap snapshot state, open the SSE stream, then continue consuming it
   * in the background. This is used when callers need the subscription to be
   * live before triggering daemon work.
   */
  async subscribeReady(): Promise<void> {
    this.abortController?.abort();
    this.abortController = new AbortController();
    await this.connect(false, true);
  }

  private async connect(isRetry: boolean, background = false): Promise<void> {
    if (this.abortController?.signal.aborted) return;

    try {
      if (!this.snapshotBootstrapped) {
        await this.bootstrapSnapshot();
      }

      const res = await fetch(`${this.baseUrl}/stream?after=${this.lastOutboxSeq}`, {
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          ...this.authHeaders(),
        },
        signal: this.abortController!.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`SSE connect failed: HTTP ${res.status}`);
      }

      const loopPromise = this.consumeStream(res.body.getReader(), isRetry);
      this.streamLoopPromise = loopPromise;
      if (background) {
        void loopPromise.catch(() => undefined);
        return;
      }
      await loopPromise;
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      const notification: TendNotification = {
        type: "error",
        goalId: this.goalId,
        message: `⚠️ [tend] ${this.goalId}: Connection error — ${String(err)}`,
      };
      this.emitProjectedEvent("connection_error", null, notification);
      // Retry once on error
      if (!isRetry && !this.abortController?.signal.aborted) {
        await new Promise((r) => setTimeout(r, 2000));
        return this.connect(true, background);
      }
      throw err;
    }
  }

  /** Stop listening */
  unsubscribe(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  private async consumeStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    isRetry: boolean
  ): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        this.parseSSEMessage(part);
      }
    }

    if (!this.abortController?.signal.aborted && !isRetry) {
      await this.connect(true, true);
    }
  }

  private parseSSEMessage(raw: string): void {
    let id = "";
    let eventType = "message";
    let data = "";

    for (const line of raw.split("\n")) {
      if (line.startsWith("id: ")) {
        id = line.slice(4).trim();
      } else if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        data += (data ? "\n" : "") + line.slice(6);
      }
    }

    if (!data) return;
    const seq = Number.parseInt(id, 10);
    if (Number.isFinite(seq) && seq > this.lastOutboxSeq) {
      this.lastOutboxSeq = seq;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    if (!this.matchesGoal(parsed)) {
      return;
    }

    this.emitProjectedEvent(eventType, parsed);
  }

  /** Format a raw SSE event into a TendNotification (returns null if verbosity filters it out) */
  private formatNotification(eventType: string, data: unknown): TendNotification | null {
    const shortId = this.goalId.length > 12 ? this.goalId.slice(0, 12) : this.goalId;

    if (eventType === "progress") {
      const ev = data as RawProgressEvent;
      const iter = ev.iteration;
      const max = ev.maxIterations;
      const gap = ev.gap;
      const phase = ev.phase ?? "";

      // Complete phase
      if (phase === "complete" || phase.toLowerCase().includes("complete")) {
        const msg = `✅ [tend] ${shortId}: Complete! gap: ${gap?.toFixed(2) ?? "?"}, ${iter ?? "?"} iterations`;
        const n: TendNotification = { type: "complete", goalId: this.goalId, message: msg, iteration: iter, maxIterations: max, gap };
        this.previousGap = undefined;
        return n;
      }

      // Stall / skip
      if (phase === "Skipped" || phase === "Skipped (no state change)" || phase.toLowerCase().includes("stall")) {
        const reason = ev.skipReason ?? phase;
        const msg = `⚠️ [tend] ${shortId}: Stalled — "${reason}"`;
        return { type: "stall", goalId: this.goalId, message: msg, iteration: iter, maxIterations: max, gap };
      }

      // Iteration summary — gap update on Observing/Verifying
      if (gap !== undefined && (phase === "Observing..." || phase === "Verifying result...")) {
        if (this.verbosity === "normal" || this.verbosity === "verbose") {
          const prev = this.previousGap;
          const prevStr = prev !== undefined ? `${prev.toFixed(2)}→` : "";
          const msg = `🌱 [tend] ${shortId}: [${iter ?? "?"}/${max ?? "?"}] gap: ${prevStr}${gap.toFixed(2)}`;
          this.previousGap = gap;
          return { type: "progress", goalId: this.goalId, message: msg, iteration: iter, maxIterations: max, gap, previousGap: prev };
        }
        this.previousGap = gap;
        return null;
      }

      // Executing phase
      if (phase === "Executing task...") {
        if (this.verbosity === "verbose") {
          const task = ev.taskDescription ?? "...";
          const msg = `🌱 [tend] ${shortId}: [${iter ?? "?"}/${max ?? "?"}] Executing: "${task}"`;
          return { type: "progress", goalId: this.goalId, message: msg, iteration: iter, maxIterations: max };
        }
        return null;
      }

      // All other phases — verbose only
      if (this.verbosity === "verbose") {
        const msg = `🌱 [tend] ${shortId}: [${iter ?? "?"}/${max ?? "?"}] ${phase}`;
        return { type: "progress", goalId: this.goalId, message: msg, iteration: iter, maxIterations: max, gap };
      }

      return null;
    }

    if (eventType === "notification_report") {
      const report = data as RawNotificationReport;
      if (report.report_type === "approval_request") {
        return null;
      }
      const title = report.title ?? report.report_type ?? "Notification";
      const prefix = report.report_type === "weekly_report"
        ? "🗓"
        : report.report_type === "daily_summary"
          ? "📰"
          : report.report_type === "urgent_alert"
            ? "⚠️"
            : "🔔";
      return {
        type: "progress",
        goalId: this.goalId,
        reportType: report.report_type,
        message: `${prefix} [tend] ${shortId}: ${title}`,
      };
    }

    if (eventType === "approval_required") {
      const ev = data as {
        requestId?: string;
        goalId?: string;
        task?: { description?: string; action?: string };
      };
      const description = ev.task?.description ?? ev.task?.action ?? "A task requires approval";
      return {
        type: "approval",
        goalId: this.goalId,
        requestId: ev.requestId,
        message: `🛂 [tend] ${shortId}: Approval required — ${description}`,
      };
    }

    if (eventType === "approval_resolved") {
      const ev = data as { approved?: boolean };
      const decision = ev.approved ? "approved" : "rejected";
      return {
        type: "progress",
        goalId: this.goalId,
        message: `🧾 [tend] ${shortId}: Approval ${decision}`,
      };
    }

    // CoreLoop completion broadcast
    if (eventType === "loop_complete" || eventType === "goal_complete") {
      const ev = data as Record<string, unknown>;
      const gap = typeof ev["gap"] === "number" ? ev["gap"] : undefined;
      const iterations = typeof ev["iterations"] === "number" ? ev["iterations"] : undefined;
      const msg = `✅ [tend] ${shortId}: Complete! gap: ${gap?.toFixed(2) ?? "?"}, ${iterations ?? "?"} iterations`;
      this.previousGap = undefined;
      return { type: "complete", goalId: this.goalId, message: msg, gap };
    }

    if (eventType === "loop_error") {
      const ev = data as RawLoopErrorEvent;
      const message = ev.error ?? ev.message ?? "Unknown daemon loop error";
      const crashCount = typeof ev.crashCount === "number"
        ? ev.crashCount
        : typeof ev.crash_count === "number"
          ? ev.crash_count
          : undefined;
      const maxRetries = typeof ev.maxRetries === "number"
        ? ev.maxRetries
        : typeof ev.max_retries === "number"
          ? ev.max_retries
          : undefined;
      const retryNote = crashCount !== undefined && maxRetries !== undefined
        ? ` (${crashCount}/${maxRetries})`
        : "";
      return {
        type: "error",
        goalId: this.goalId,
        message: `⚠️ [tend] ${shortId}: Loop error${retryNote} — ${message}`,
      };
    }

    return null;
  }

  private formatChatEvent(
    eventType: string,
    data: unknown,
    notification: TendNotification | null
  ): ChatEvent | null {
    if (eventType === "chat_response") {
      const response = data as RawChatResponseEvent;
      const text = typeof response.message === "string" ? response.message.trim() : "";
      if (!text) return null;
      return {
        type: "assistant_final",
        text,
        persisted: false,
        ...this.createChatEventBase(eventType, data),
      };
    }

    if (!notification) {
      return null;
    }

    return {
      type: "activity",
      kind: "commentary",
      message: notification.message,
      sourceId: this.createChatSourceId(eventType, data, notification),
      transient: false,
      ...this.createChatEventBase(eventType, data),
    };
  }

  private matchesGoal(data: unknown): boolean {
    if (typeof data !== "object" || data === null) return true;
    const goalId = (data as Record<string, unknown>)["goalId"] ?? (data as Record<string, unknown>)["goal_id"];
    return typeof goalId === "string" ? goalId === this.goalId : true;
  }

  private async bootstrapSnapshot(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/snapshot`, {
        headers: { Accept: "application/json", ...this.authHeaders() },
        signal: this.abortController!.signal,
      });
      if (!res.ok) {
        throw new Error(`snapshot failed: HTTP ${res.status}`);
      }
      const snapshot = await res.json() as {
        approvals?: unknown[];
        last_outbox_seq?: number;
      };
      this.snapshotBootstrapped = true;
      this.lastOutboxSeq = Math.max(this.lastOutboxSeq, snapshot.last_outbox_seq ?? 0);
      for (const approval of snapshot.approvals ?? []) {
        if (!this.matchesGoal(approval)) continue;
        this.emitProjectedEvent("approval_required", approval);
      }
    } catch {
      // Snapshot bootstrap is best-effort.
    }
  }

  private emitProjectedEvent(
    eventType: string,
    data: unknown,
    notificationOverride: TendNotification | null = null
  ): void {
    const notification = notificationOverride ?? this.formatNotification(eventType, data);
    if (notification) {
      this.emit("notification", notification);
    }

    const chatEvent = this.formatChatEvent(eventType, data, notification);
    if (chatEvent) {
      this.emit("chat_event", chatEvent);
    }
  }

  private createChatEventBase(eventType: string, data: unknown): {
    runId: string;
    turnId: string;
    createdAt: string;
  } {
    const projectionId = this.createProjectionId(eventType, data);
    return {
      runId: `daemon:${this.goalId}`,
      turnId: `daemon:${this.goalId}:${projectionId}`,
      createdAt: new Date().toISOString(),
    };
  }

  private createProjectionId(eventType: string, data: unknown): string {
    const record = typeof data === "object" && data !== null
      ? data as Record<string, unknown>
      : null;
    const requestId = record?.["requestId"];
    if (typeof requestId === "string" && requestId) {
      return `${eventType}:${requestId}`;
    }

    if (this.lastOutboxSeq > 0) {
      return `${eventType}:${this.lastOutboxSeq}`;
    }

    this.localProjectionSeq += 1;
    return `${eventType}:local:${this.localProjectionSeq}`;
  }

  private createChatSourceId(
    eventType: string,
    data: unknown,
    notification: TendNotification
  ): string {
    const requestId = notification.requestId;
    if (requestId) {
      return `daemon:${this.goalId}:${eventType}:${requestId}`;
    }

    if (notification.reportType) {
      return `daemon:${this.goalId}:${eventType}:${notification.reportType}`;
    }

    const record = typeof data === "object" && data !== null
      ? data as Record<string, unknown>
      : null;
    const status = record?.["status"];
    if (typeof status === "string" && status) {
      return `daemon:${this.goalId}:${eventType}:${status}`;
    }

    return `daemon:${this.goalId}:${eventType}`;
  }

  private authHeaders(): Record<string, string> {
    return this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {};
  }
}
