import type { ChannelAdapter, EnvelopeHandler, ReplyChannel } from "./channel-adapter.js";
import { createEnvelope } from "../types/envelope.js";
import type { EnvelopeType, EnvelopePriority } from "../types/envelope.js";

/** Minimal interface for a WebSocket-like socket */
export interface WsSocketLike {
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  send(data: string): void;
}

/** Minimal interface for a WebSocket-like server */
export interface WsLike {
  on(event: "connection", cb: (socket: WsSocketLike) => void): void;
  on(event: "close", cb: () => void): void;
  close(cb?: () => void): void;
}

/**
 * WsChannelAdapter wraps a WebSocket server (WsLike) and converts
 * incoming messages into Envelopes for the IngressGateway.
 *
 * The ws package (or any compatible WS server) can be injected;
 * no direct dependency on "ws" is required.
 */
export class WsChannelAdapter implements ChannelAdapter {
  readonly name = "websocket";
  private handler: EnvelopeHandler | null = null;
  private wss: WsLike;

  constructor(wss: WsLike) {
    this.wss = wss;
  }

  onEnvelope(handler: EnvelopeHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.wss.on("connection", (socket) => {
      this.handleConnection(socket);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close(() => resolve());
    });
  }

  private handleConnection(socket: WsSocketLike): void {
    socket.on("message", (data) => {
      this.handleMessage(data, socket);
    });

    socket.on("error", (err) => {
      console.warn("WsChannelAdapter: socket error:", err.message);
    });
  }

  private handleMessage(data: unknown, socket: WsSocketLike): void {
    let parsed: Record<string, unknown>;

    try {
      const raw = typeof data === "string" ? data : String(data);
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.warn("WsChannelAdapter: failed to parse message, ignoring");
      return;
    }

    if (!this.handler) {
      console.warn("WsChannelAdapter: no handler registered, dropping message");
      return;
    }

    const envelope = createEnvelope({
      type: (parsed["type"] as EnvelopeType) ?? "event",
      name: String(parsed["name"] ?? "ws_message"),
      source: "websocket",
      goal_id: parsed["goal_id"] as string | undefined,
      priority: (parsed["priority"] as EnvelopePriority) ?? "normal",
      payload: parsed["payload"] ?? parsed,
    });

    const reply: ReplyChannel = {
      send(responseData: unknown): void {
        socket.send(JSON.stringify(responseData));
      },
      close(): void {
        // WebSocket close is handled at socket level; no-op here
      },
    };

    void this.handler(envelope, reply as any);
  }
}
