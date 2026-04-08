// ─── DataSourceAdapter ───
//
// Defines the IDataSourceAdapter interface and concrete implementations for
// file-based and HTTP API data sources, plus DataSourceRegistry for managing
// multiple adapter instances.

import * as fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import { ValidationError } from "../../base/utils/errors.js";
import type {
  DataSourceType,
  DataSourceConfig,
  DataSourceQuery,
  DataSourceResult,
} from "../../base/types/data-source.js";

// ─── Helper ───

export function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ─── Interface ───

export interface IDataSourceAdapter {
  readonly sourceId: string;
  readonly sourceType: DataSourceType;
  readonly config: DataSourceConfig;
  connect(): Promise<void>;
  query(params: DataSourceQuery): Promise<DataSourceResult>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<boolean>;
  getSupportedDimensions?(): string[];
}

// ─── FileDataSourceAdapter ───

export class FileDataSourceAdapter implements IDataSourceAdapter {
  readonly sourceId: string;
  readonly sourceType: DataSourceType = "file";
  readonly config: DataSourceConfig;

  constructor(config: DataSourceConfig) {
    this.config = config;
    this.sourceId = config.id;
  }

  async connect(): Promise<void> {
    const path = this.config.connection.path;
    if (!path) {
      throw new ValidationError(`FileDataSourceAdapter [${this.sourceId}]: connection.path is required`);
    }
    try { await fsp.access(path); } catch {
      throw new Error(`FileDataSourceAdapter [${this.sourceId}]: file not found: ${path}`);
    }
  }

  async query(params: DataSourceQuery): Promise<DataSourceResult> {
    const path = this.config.connection.path;
    if (!path) {
      throw new ValidationError(`FileDataSourceAdapter [${this.sourceId}]: connection.path is required`);
    }

    let raw: unknown;
    let value: number | string | boolean | null;

    const content = await fsp.readFile(path, "utf-8");

    if (path.endsWith(".json")) {
      raw = JSON.parse(content);
      if (params.expression) {
        const extracted = getNestedValue(raw, params.expression);
        value = extracted !== undefined ? (extracted as number | string | boolean | null) : null;
      } else {
        value = null;
      }
    } else {
      raw = content;
      value = content;
    }

    return {
      value,
      raw,
      timestamp: new Date().toISOString(),
      source_id: this.sourceId,
    };
  }

  async disconnect(): Promise<void> {
    // no-op
  }

  async healthCheck(): Promise<boolean> {
    const path = this.config.connection.path;
    if (!path) return false;
    try {
      await fsp.access(path);
      return true;
    } catch {
      return false;
    }
  }
}

// ─── HttpApiDataSourceAdapter ───

function buildAuthHeaders(config: DataSourceConfig): Record<string, string> {
  const auth = config.auth;
  if (!auth || auth.type === "none") return {};

  const secret = auth.secret_ref ?? "";

  if (auth.type === "api_key") {
    return { "X-API-Key": secret };
  }
  if (auth.type === "bearer") {
    return { Authorization: `Bearer ${secret}` };
  }
  if (auth.type === "basic") {
    const encoded = Buffer.from(secret).toString("base64");
    return { Authorization: `Basic ${encoded}` };
  }
  return {};
}

export class HttpApiDataSourceAdapter implements IDataSourceAdapter {
  readonly sourceId: string;
  readonly sourceType: DataSourceType = "http_api";
  readonly config: DataSourceConfig;

  constructor(config: DataSourceConfig) {
    this.config = config;
    this.sourceId = config.id;
  }

  async connect(): Promise<void> {
    const healthy = await this.healthCheck();
    if (!healthy) {
      throw new Error(`HttpApiDataSourceAdapter [${this.sourceId}]: health check failed for ${this.config.connection.url}`);
    }
  }

  async query(params: DataSourceQuery): Promise<DataSourceResult> {
    const url = this.config.connection.url;
    if (!url) {
      throw new ValidationError(`HttpApiDataSourceAdapter [${this.sourceId}]: connection.url is required`);
    }

    const timeoutMs = params.timeout_ms ?? 10000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const method = this.config.connection.method ?? "GET";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.config.connection.headers,
      ...buildAuthHeaders(this.config),
    };

    let body: string | undefined;
    if (method === "POST" && this.config.connection.body_template) {
      body = this.config.connection.body_template.replace(
        "{{dimension_name}}",
        params.dimension_name
      );
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(
        `HttpApiDataSourceAdapter [${this.sourceId}]: HTTP ${response.status} from ${url}`
      );
    }

    const raw: unknown = await response.json();
    let value: number | string | boolean | null = null;

    if (params.expression) {
      const extracted = getNestedValue(raw, params.expression);
      value = extracted !== undefined ? (extracted as number | string | boolean | null) : null;
    }

    return {
      value,
      raw,
      timestamp: new Date().toISOString(),
      source_id: this.sourceId,
    };
  }

  async disconnect(): Promise<void> {
    // no-op
  }

  async healthCheck(): Promise<boolean> {
    const url = this.config.connection.url;
    if (!url) return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(url, {
        method: "HEAD",
        headers: buildAuthHeaders(this.config),
        signal: controller.signal,
      });
      return response.status >= 200 && response.status < 300;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── PostgresDataSourceAdapter ───

function parseScalarResult(text: string): number | string | boolean | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (!Number.isNaN(num)) return num;
  }
  return trimmed;
}

function buildPsqlArgs(connectionString: string, sql: string): string[] {
  return [
    "-X",
    "-q",
    "-t",
    "-A",
    "-v",
    "ON_ERROR_STOP=1",
    "-d",
    connectionString,
    "-c",
    sql,
  ];
}

function normalizeSqlExpression(expression: string): string {
  const trimmed = expression.trim();
  if (/^(select|with)\b/i.test(trimmed)) {
    return trimmed;
  }
  return `SELECT (${trimmed}) AS value`;
}

function runPsql(connectionString: string, sql: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", buildPsqlArgs(connectionString, sql), {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("PostgresDataSourceAdapter: query timed out"));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `psql exited with code ${code ?? "unknown"}`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

export class PostgresDataSourceAdapter implements IDataSourceAdapter {
  readonly sourceId: string;
  readonly sourceType: DataSourceType = "database";
  readonly config: DataSourceConfig;
  private readonly runner: typeof runPsql;

  constructor(config: DataSourceConfig, runner: typeof runPsql = runPsql) {
    this.config = config;
    this.sourceId = config.id;
    this.runner = runner;
  }

  private resolveConnectionString(): string | undefined {
    const direct = this.config.connection_string?.trim();
    if (direct) return direct;
    const url = this.config.connection.url?.trim();
    if (url) return url;
    return undefined;
  }

  private resolveQueryExpression(params: DataSourceQuery): string | undefined {
    const mapped = this.config.dimension_mapping?.[params.dimension_name];
    const expression = params.expression ?? mapped;
    if (!expression || !expression.trim()) {
      return undefined;
    }
    return expression;
  }

  async connect(): Promise<void> {
    const healthy = await this.healthCheck();
    if (!healthy) {
      throw new Error(`PostgresDataSourceAdapter [${this.sourceId}]: health check failed`);
    }
  }

  async query(params: DataSourceQuery): Promise<DataSourceResult> {
    const connectionString = this.resolveConnectionString();
    if (!connectionString) {
      throw new ValidationError(`PostgresDataSourceAdapter [${this.sourceId}]: connection_string is required`);
    }

    const expression = this.resolveQueryExpression(params);
    if (!expression) {
      return {
        value: null,
        raw: [],
        timestamp: new Date().toISOString(),
        source_id: this.sourceId,
        metadata: {
          error: `No SQL expression configured for dimension "${params.dimension_name}"`,
        },
      };
    }

    const sql = normalizeSqlExpression(expression);
    try {
      const result = await this.runner(connectionString, sql, params.timeout_ms ?? 10_000);
      const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
      const firstRow = lines[0] ?? "";
      const [firstCell = ""] = firstRow.split("\t");

      return {
        value: parseScalarResult(firstCell),
        raw: lines,
        timestamp: new Date().toISOString(),
        source_id: this.sourceId,
        metadata: {
          query: sql,
        },
      };
    } catch (error) {
      return {
        value: null,
        raw: [],
        timestamp: new Date().toISOString(),
        source_id: this.sourceId,
        metadata: {
          query: sql,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async disconnect(): Promise<void> {
    // no-op
  }

  async healthCheck(): Promise<boolean> {
    const connectionString = this.resolveConnectionString();
    if (!connectionString) return false;

    try {
      await this.runner(connectionString, "SELECT 1", 5_000);
      return true;
    } catch {
      return false;
    }
  }
}

// ─── DataSourceRegistry ───

export class DataSourceRegistry {
  private readonly sources: Map<string, IDataSourceAdapter> = new Map();

  register(adapter: IDataSourceAdapter): void {
    if (this.sources.has(adapter.sourceId)) {
      throw new Error(
        `DataSourceRegistry: source "${adapter.sourceId}" is already registered. ` +
          `Remove it first before re-registering.`
      );
    }
    this.sources.set(adapter.sourceId, adapter);
  }

  getSource(id: string): IDataSourceAdapter {
    const source = this.sources.get(id);
    if (!source) {
      throw new Error(
        `DataSourceRegistry: no source registered with id "${id}". ` +
          `Available sources: [${this.listSources().join(", ")}]`
      );
    }
    return source;
  }

  listSources(): string[] {
    return Array.from(this.sources.keys()).sort();
  }

  remove(id: string): void {
    if (!this.sources.has(id)) {
      throw new Error(
        `DataSourceRegistry: cannot remove "${id}" — not registered. ` +
          `Available sources: [${this.listSources().join(", ")}]`
      );
    }
    this.sources.delete(id);
  }

  has(id: string): boolean {
    return this.sources.has(id);
  }

  upsert(adapter: IDataSourceAdapter): void {
    if (this.has(adapter.sourceId)) {
      this.remove(adapter.sourceId);
    }
    this.register(adapter);
  }
}
