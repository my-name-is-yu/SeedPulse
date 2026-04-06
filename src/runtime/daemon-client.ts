// ─── Daemon Client ───
//
// Client library for connecting to PulSeed daemon's EventServer.
// Receives events via SSE, sends commands via REST.

import http from "node:http";
import { DEFAULT_PORT } from "./port-utils.js";

export interface DaemonClientConfig {
  host: string;
  port: number;
  reconnectInterval?: number; // ms, default 3000
  maxReconnectAttempts?: number; // default 10
}

export interface DaemonEvent {
  id: string;
  type: string;
  data: unknown;
}

type EventHandler = (data: unknown) => void;

export class DaemonClient {
  private config: Required<DaemonClientConfig>;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private sseRequest: http.ClientRequest | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private stopped = false;
  private lastEventId: string | null = null;

  constructor(config: DaemonClientConfig) {
    this.config = {
      host: config.host,
      port: config.port,
      reconnectInterval: config.reconnectInterval ?? 3000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 10,
    };
  }

  // ─── SSE Connection ───

  connect(): void {
    this.stopped = false;
    this.connectSSE();
  }

  private connectSSE(): void {
    if (this.stopped) return;

    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    };
    if (this.lastEventId) {
      headers["Last-Event-ID"] = this.lastEventId;
    }

    const req = http.get(
      {
        hostname: this.config.host,
        port: this.config.port,
        path: "/stream",
        headers,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          this.scheduleReconnect();
          return;
        }

        this.connected = true;
        this.reconnectAttempts = 0;
        this.emit("_connected", { timestamp: new Date().toISOString() });

        let buffer = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            this.parseSSEMessage(part);
          }
        });

        res.on("end", () => {
          this.connected = false;
          this.emit("_disconnected", {});
          this.scheduleReconnect();
        });
      }
    );

    req.on("error", () => {
      this.connected = false;
      this.scheduleReconnect();
    });

    this.sseRequest = req;
  }

  private parseSSEMessage(raw: string): void {
    let id = "";
    let event = "message";
    let data = "";

    for (const line of raw.split("\n")) {
      if (line.startsWith("id: ")) {
        id = line.slice(4);
      } else if (line.startsWith("event: ")) {
        event = line.slice(7);
      } else if (line.startsWith("data: ")) {
        data += line.slice(6);
      } else if (line.startsWith(": ")) {
        // Comment (keepalive), ignore
      }
    }

    if (id) this.lastEventId = id;
    if (!data && event === "message") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = data;
    }

    this.emit(event, parsed);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.emit("_reconnect_failed", { attempts: this.reconnectAttempts });
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.config.reconnectInterval * Math.pow(1.5, this.reconnectAttempts - 1),
      30_000
    );
    this.reconnectTimer = setTimeout(() => this.connectSSE(), delay);
  }

  disconnect(): void {
    this.stopped = true;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sseRequest) {
      this.sseRequest.destroy();
      this.sseRequest = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ─── Event Handling ───

  on(event: string, handler: EventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: EventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  private emit(event: string, data: unknown): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch {
          // Don't let handler errors break the event loop
        }
      }
    }
    // Also emit to wildcard listeners
    const wildcardHandlers = this.handlers.get("*");
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          handler({ type: event, data });
        } catch {
          // ignore
        }
      }
    }
  }

  // ─── REST Commands ───

  async startGoal(goalId: string): Promise<{ ok: boolean }> {
    return this.post(`/goals/${encodeURIComponent(goalId)}/start`, {});
  }

  async stopGoal(goalId: string): Promise<{ ok: boolean }> {
    return this.post(`/goals/${encodeURIComponent(goalId)}/stop`, {});
  }

  async approve(goalId: string, requestId: string, approved: boolean): Promise<{ ok: boolean }> {
    return this.post(`/goals/${encodeURIComponent(goalId)}/approve`, { requestId, approved });
  }

  async chat(goalId: string, message: string): Promise<{ ok: boolean }> {
    return this.post(`/goals/${encodeURIComponent(goalId)}/chat`, { message });
  }

  async getStatus(): Promise<unknown> {
    return this.get("/daemon/status");
  }

  async getGoals(): Promise<unknown[]> {
    return this.get("/goals") as Promise<unknown[]>;
  }

  async getGoal(goalId: string): Promise<unknown> {
    return this.get(`/goals/${encodeURIComponent(goalId)}`);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.get("/health");
      return true;
    } catch {
      return false;
    }
  }

  // ─── HTTP Helpers ───

  private get(path: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        { hostname: this.config.host, port: this.config.port, path },
        (res) => {
          let body = "";
          res.setEncoding("utf-8");
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try { resolve(JSON.parse(body)); } catch { resolve(body); }
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${body}`));
            }
          });
        }
      );
      req.on("error", reject);
    });
  }

  private post(path: string, data: unknown): Promise<{ ok: boolean }> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(data);
      const req = http.request(
        {
          hostname: this.config.host,
          port: this.config.port,
          path,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let responseBody = "";
          res.setEncoding("utf-8");
          res.on("data", (chunk) => { responseBody += chunk; });
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try { resolve(JSON.parse(responseBody)); } catch { resolve({ ok: true }); }
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${responseBody}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }
}

// ─── Convenience: detect running daemon ───

export async function isDaemonRunning(baseDir: string): Promise<{ running: boolean; port: number }> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  // DEFAULT_PORT imported from port-utils

  try {
    const statePath = path.join(baseDir, "daemon-state.json");
    const raw = await fs.readFile(statePath, "utf-8");
    const state = JSON.parse(raw);

    if (state.status !== "running" || !state.pid) {
      return { running: false, port: DEFAULT_PORT };
    }

    // Check if PID is actually alive
    try {
      process.kill(state.pid, 0);
    } catch {
      return { running: false, port: DEFAULT_PORT };
    }

    // Try to read daemon config for port
    let port = DEFAULT_PORT;
    try {
      const configPath = path.join(baseDir, "daemon.json");
      const configRaw = await fs.readFile(configPath, "utf-8");
      const config = JSON.parse(configRaw);
      if (config.event_server_port) port = config.event_server_port;
    } catch {
      // Use default port
    }

    // Verify EventServer is actually responding
    const client = new DaemonClient({ host: "127.0.0.1", port });
    const healthy = await client.healthCheck();
    return { running: healthy, port };
  } catch {
    return { running: false, port: DEFAULT_PORT };
  }
}
