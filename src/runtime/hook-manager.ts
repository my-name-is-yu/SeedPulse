import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { Logger } from "./logger.js";
import {
  HooksConfigSchema,
  type HookConfig,
  type HookEventType,
  type HookPayload,
} from "../base/types/hook.js";
import { DreamLogCollector } from "../platform/dream/dream-log-collector.js";
import type { DreamCollectorConfig } from "../platform/dream/dream-log-collector.js";
import { DreamLogConfigSchema } from "../platform/dream/dream-types.js";

// ─── HookManager ───

/**
 * HookManager loads hook definitions from {baseDir}/hooks.json and fires them
 * asynchronously when events are emitted. Hooks never block the caller —
 * all firing is fire-and-forget via Promise.allSettled.
 */
export class HookManager {
  private hooks: HookConfig[] = [];
  private readonly logger?: Logger;
  private readonly dreamCollector: DreamLogCollector;

  constructor(private readonly baseDir: string, logger?: Logger) {
    this.logger = logger;
    this.dreamCollector = new DreamLogCollector(baseDir, logger, this.loadDreamCollectorConfig());
  }

  getDreamCollector(): DreamLogCollector {
    return this.dreamCollector;
  }

  private loadDreamCollectorConfig(): DreamCollectorConfig {
    const configPath = path.join(this.baseDir, "dream", "config.json");
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
      return DreamLogConfigSchema.parse(raw).logCollection;
    } catch {
      return {};
    }
  }

  /**
   * Load hook definitions from {baseDir}/hooks.json.
   * If the file does not exist, hooks = [] (no error).
   * If the file is malformed, logs a warning and continues with no hooks.
   */
  async loadHooks(): Promise<void> {
    const configPath = path.join(this.baseDir, "hooks.json");
    try {
      const raw = await fsp.readFile(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      const config = HooksConfigSchema.parse(parsed);
      this.hooks = config.hooks;
      this.logger?.info(`[HookManager] Loaded ${this.hooks.length} hook(s) from ${configPath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // File doesn't exist — that's fine
        this.hooks = [];
      } else {
        this.logger?.warn(
          `[HookManager] Failed to load hooks.json: ${err instanceof Error ? err.message : String(err)}. Continuing with no hooks.`
        );
        this.hooks = [];
      }
    }
  }

  /**
   * Emit an event. Finds matching hooks and fires them asynchronously.
   * Never throws — errors are logged only.
   */
  async emit(event: HookEventType, partial: Partial<HookPayload>): Promise<void> {
    const goalId = partial.goal_id ?? "global";
    const taskId = typeof partial.data?.["task_id"] === "string"
      ? String(partial.data["task_id"])
      : typeof partial.data?.["taskId"] === "string"
        ? String(partial.data["taskId"])
        : undefined;

    void this.dreamCollector.appendEventLog({
      timestamp: new Date().toISOString(),
      eventType: event,
      goalId,
      ...(taskId ? { taskId } : {}),
      data: partial.data ?? {},
    }).catch((err) => {
      this.logger?.warn(`[HookManager] Failed to persist dream event ${event}: ${err instanceof Error ? err.message : String(err)}`);
    });

    const matching = this.hooks.filter((h) => {
      if (!h.enabled) return false;
      if (h.event !== event) return false;
      if (h.filter?.goal_id && partial.goal_id !== h.filter.goal_id) return false;
      if (h.filter?.dimension && partial.dimension !== h.filter.dimension) return false;
      return true;
    });

    if (matching.length === 0) return;

    const payload: HookPayload = {
      event,
      timestamp: new Date().toISOString(),
      goal_id: partial.goal_id,
      dimension: partial.dimension,
      data: partial.data ?? {},
    };

    // Fire-and-forget: do not await, do not block
    void Promise.allSettled(
      matching.map((hook) => this.fireHook(hook, payload))
    ).then((results) => {
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        if (r.status === "rejected") {
          const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
          this.logger?.error(`[HookManager] Hook "${matching[i]!.event}" (${matching[i]!.type}) failed: ${reason}`);
        }
      }
    });
  }

  private async fireHook(hook: HookConfig, payload: HookPayload): Promise<void> {
    if (hook.type === "shell") {
      return this.fireShellHook(hook, payload);
    } else {
      return this.fireWebhookHook(hook, payload);
    }
  }

  /**
   * Spawn a shell command and pass the JSON payload via stdin.
   * Kill after timeout_ms.
   */
  private async fireShellHook(hook: HookConfig, payload: HookPayload): Promise<void> {
    if (!hook.command) {
      this.logger?.warn("[HookManager] Shell hook has no command defined, skipping.");
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const child = spawn(hook.command!, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
      const payloadJson = JSON.stringify(payload);
      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Shell hook timed out after ${hook.timeout_ms}ms`));
      }, hook.timeout_ms);

      child.on("close", (code) => {
        clearTimeout(timer);
        if (stdout) this.logger?.info(`[HookManager] Shell hook stdout: ${stdout.trim()}`);
        if (stderr) this.logger?.warn(`[HookManager] Shell hook stderr: ${stderr.trim()}`);
        if (code !== 0) {
          reject(new Error(`Shell hook exited with code ${code}`));
        } else {
          resolve();
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "EPIPE") {
          clearTimeout(timer);
          reject(err);
        }
        // EPIPE is expected when process exits before stdin is consumed; ignore
      });

      child.stdin?.write(payloadJson);
      child.stdin?.end();
    });
  }

  /**
   * HTTP POST to hook.url with JSON body.
   * Includes hook.headers if present.
   * Timeout after timeout_ms.
   */
  private async fireWebhookHook(hook: HookConfig, payload: HookPayload): Promise<void> {
    if (!hook.url) {
      this.logger?.warn("[HookManager] Webhook hook has no url defined, skipping.");
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), hook.timeout_ms);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(hook.headers ?? {}),
      };

      const response = await fetch(hook.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      this.logger?.info(`[HookManager] Webhook hook responded with status ${response.status}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Return the total number of loaded hooks. */
  getHookCount(): number {
    return this.hooks.length;
  }

  /** Return all hooks registered for a given event type. */
  getHooksForEvent(event: HookEventType): HookConfig[] {
    return this.hooks.filter((h) => h.event === event);
  }
}
