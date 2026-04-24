import { randomUUID } from "node:crypto";
import { RuntimeOperationStore } from "../store/runtime-operation-store.js";
import type {
  RuntimeControlActor,
  RuntimeControlOperation,
  RuntimeControlOperationKind,
  RuntimeControlOperationState,
  RuntimeControlReplyTarget,
} from "../store/runtime-operation-schemas.js";
import type { RuntimeControlIntent } from "./runtime-control-intent.js";

export interface RuntimeControlRequest {
  intent: RuntimeControlIntent;
  cwd: string;
  requestedBy?: RuntimeControlActor;
  replyTarget?: RuntimeControlReplyTarget;
  approvalFn?: (reason: string) => Promise<boolean>;
}

export interface RuntimeControlResult {
  success: boolean;
  message: string;
  operationId?: string;
  state?: RuntimeControlOperationState;
}

export interface RuntimeControlExecutorResult {
  ok: boolean;
  message?: string;
  state?: RuntimeControlOperationState;
}

export type RuntimeControlExecutor = (
  operation: RuntimeControlOperation,
  request: RuntimeControlRequest
) => Promise<RuntimeControlExecutorResult>;

export interface RuntimeControlServiceOptions {
  operationStore?: RuntimeOperationStore;
  runtimeRoot?: string;
  executor?: RuntimeControlExecutor;
  now?: () => Date;
}

type RuntimeControlStep =
  | { ok: true; operation: RuntimeControlOperation }
  | { ok: false; result: RuntimeControlResult };

export class RuntimeControlService {
  private readonly operationStore: RuntimeOperationStore;
  private readonly executor?: RuntimeControlExecutor;
  private readonly now: () => Date;

  constructor(options: RuntimeControlServiceOptions = {}) {
    this.operationStore = options.operationStore ?? new RuntimeOperationStore(options.runtimeRoot);
    this.executor = options.executor;
    this.now = options.now ?? (() => new Date());
  }

  async request(request: RuntimeControlRequest): Promise<RuntimeControlResult> {
    if (!isExecutableRuntimeControlKind(request.intent.kind)) {
      return {
        success: false,
        message: `Runtime control operation ${request.intent.kind} is not supported by the production executor.`,
        state: "failed",
      };
    }

    const initial = await this.createInitialOperation(request);
    const approved = await this.approveIfRequired(initial, request.approvalFn);
    if (!approved.ok) return approved.result;

    const acknowledged = await this.acknowledge(approved.operation);
    return this.executeAcknowledgedOperation(acknowledged, request);
  }

  private async createInitialOperation(request: RuntimeControlRequest): Promise<RuntimeControlOperation> {
    const requestedAt = this.nowIso();
    const operation: RuntimeControlOperation = {
      operation_id: randomUUID(),
      kind: request.intent.kind,
      state: "pending",
      requested_at: requestedAt,
      updated_at: requestedAt,
      requested_by: request.requestedBy ?? { surface: "chat" },
      reply_target: normalizeReplyTarget(request.replyTarget ?? { surface: "chat" }),
      reason: request.intent.reason,
      expected_health: expectedHealthFor(request.intent.kind),
    };

    return this.operationStore.save(operation);
  }

  private async approveIfRequired(
    operation: RuntimeControlOperation,
    approvalFn: RuntimeControlRequest["approvalFn"]
  ): Promise<RuntimeControlStep> {
    if (!requiresApproval(operation.kind)) {
      return { ok: true, operation };
    }

    if (!approvalFn) {
      return this.failStep(
        operation,
        "failed",
        "Runtime control requires approval, but no approval handler is configured."
      );
    }

    let approved: boolean;
    try {
      approved = await approvalFn(approvalReason(operation.kind, operation.reason));
    } catch (err) {
      return this.failStep(
        operation,
        "failed",
        err instanceof Error ? err.message : String(err)
      );
    }

    if (!approved) {
      return this.failStep(operation, "cancelled", "Runtime control operation was not approved.");
    }

    const updated = await this.operationStore.save({
      ...operation,
      state: "approved",
      updated_at: this.nowIso(),
    });
    return { ok: true, operation: updated };
  }

  private acknowledge(operation: RuntimeControlOperation): Promise<RuntimeControlOperation> {
    return this.update(operation, "acknowledged", {
      ok: true,
      message: ackMessage(operation.kind),
    });
  }

  private async executeAcknowledgedOperation(
    operation: RuntimeControlOperation,
    request: RuntimeControlRequest
  ): Promise<RuntimeControlResult> {
    if (!this.executor) {
      const failed = await this.update(operation, "failed", {
        ok: false,
        message: "Runtime control executor is not configured; operation was recorded but not started.",
      });
      return this.toResult(failed);
    }

    let executed: RuntimeControlExecutorResult;
    try {
      executed = await this.executor(operation, request);
    } catch (err) {
      const failed = await this.update(operation, "failed", {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
      return this.toResult(failed);
    }

    const nextState = executed.state ?? (executed.ok ? "acknowledged" : "failed");
    const saved = await this.update(operation, nextState, {
      ok: executed.ok,
      message: executed.message ?? ackMessage(operation.kind),
    });
    return this.toResult(saved);
  }

  private async failStep(
    operation: RuntimeControlOperation,
    state: Extract<RuntimeControlOperationState, "failed" | "cancelled">,
    message: string
  ): Promise<RuntimeControlStep> {
    const saved = await this.update(operation, state, {
      ok: false,
      message,
    });
    return { ok: false, result: this.toResult(saved) };
  }

  private toResult(operation: RuntimeControlOperation): RuntimeControlResult {
    return {
      success: operation.result?.ok ?? false,
      message: operation.result?.message ?? ackMessage(operation.kind),
      operationId: operation.operation_id,
      state: operation.state,
    };
  }

  private async update(
    operation: RuntimeControlOperation,
    state: RuntimeControlOperationState,
    result: { ok: boolean; message: string }
  ): Promise<RuntimeControlOperation> {
    const updated: RuntimeControlOperation = {
      ...operation,
      state,
      updated_at: this.nowIso(),
      result,
    };
    return this.operationStore.save(updated);
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

export function isExecutableRuntimeControlKind(
  kind: RuntimeControlOperationKind
): kind is Extract<RuntimeControlOperationKind, "restart_daemon" | "restart_gateway"> {
  return kind === "restart_daemon" || kind === "restart_gateway";
}

function requiresApproval(kind: RuntimeControlOperationKind): boolean {
  return isExecutableRuntimeControlKind(kind);
}

function normalizeReplyTarget(target: RuntimeControlReplyTarget): RuntimeControlReplyTarget {
  return {
    ...target,
    channel: target.channel ?? defaultChannelForSurface(target.surface),
  };
}

function defaultChannelForSurface(
  surface: RuntimeControlReplyTarget["surface"]
): RuntimeControlReplyTarget["channel"] {
  switch (surface) {
    case "gateway":
      return "plugin_gateway";
    case "cli":
    case "tui":
      return surface;
    case "chat":
    case undefined:
      return undefined;
  }
}

function expectedHealthFor(kind: RuntimeControlOperationKind): { daemon_ping: boolean; gateway_acceptance: boolean } {
  return {
    daemon_ping: isExecutableRuntimeControlKind(kind),
    gateway_acceptance: isExecutableRuntimeControlKind(kind),
  };
}

function approvalReason(kind: RuntimeControlOperationKind, reason: string): string {
  return `Runtime control ${kind}: ${reason}`;
}

function ackMessage(kind: RuntimeControlOperationKind): string {
  switch (kind) {
    case "restart_gateway":
      return "gateway の再起動を開始します。復帰後にこの会話へ結果を返します。";
    case "restart_daemon":
      return "PulSeed daemon の再起動を開始します。復帰後にこの会話へ結果を返します。";
    case "reload_config":
      return "runtime 設定の再読み込みを開始します。";
    case "self_update":
      return "PulSeed 自身の更新準備を開始します。実行前に内容を確認します。";
  }
}
