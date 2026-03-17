import * as http from "node:http";
import type { DriveSystem } from "../drive/drive-system.js";
import { MotivaEventSchema } from "../types/drive.js";

export interface EventServerConfig {
  host?: string; // default: "127.0.0.1" (localhost only!)
  port?: number; // default: 41700
}

export class EventServer {
  private server: http.Server | null = null;
  private driveSystem: DriveSystem;
  private host: string;
  private port: number;

  constructor(driveSystem: DriveSystem, config?: EventServerConfig) {
    this.driveSystem = driveSystem;
    this.host = config?.host ?? "127.0.0.1";
    this.port = config?.port ?? 41700;
  }

  /** Start HTTP server */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.port, this.host, () => resolve());
      this.server.on("error", reject);
    });
  }

  /** Stop HTTP server */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  /** Handle incoming HTTP request */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Only accept POST /events
    if (req.method !== "POST" || req.url !== "/events") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const data = JSON.parse(body) as unknown;
        const event = MotivaEventSchema.parse(data);
        // Write event to file queue (DriveSystem will pick it up)
        this.driveSystem.writeEvent(event);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "accepted", event_type: event.type }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid event", details: String(err) }));
      }
    });
  }

  /** Check if server is running */
  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  getPort(): number {
    return this.port;
  }

  getHost(): string {
    return this.host;
  }
}
