import { OutboxStore } from "../store/outbox-store.js";
import type { RuntimeControlOperation } from "../store/runtime-operation-schemas.js";

export interface RuntimeControlResultEventPublisher {
  broadcast(eventType: string, data: unknown): Promise<void> | void;
}

export interface PublishRuntimeControlResultOptions {
  operation: RuntimeControlOperation;
  publisher?: RuntimeControlResultEventPublisher;
  outboxStore?: OutboxStore;
  runtimeRoot?: string | null;
  now?: () => number;
}

export interface RuntimeControlResultPayload {
  operationId: string;
  operation_id: string;
  kind: RuntimeControlOperation["kind"];
  state: RuntimeControlOperation["state"];
  ok: boolean;
  message: string;
  daemon_status?: string;
  health_error?: string;
  requested_by: RuntimeControlOperation["requested_by"];
  reply_target: RuntimeControlOperation["reply_target"];
  completed_at?: string;
}

export async function publishRuntimeControlResult(
  options: PublishRuntimeControlResultOptions
): Promise<void> {
  const payload = toRuntimeControlResultPayload(options.operation);
  const chatResponse = {
    goalId: `runtime_control:${payload.operation_id}`,
    goal_id: `runtime_control:${payload.operation_id}`,
    message: payload.message,
    status: payload.ok ? "verified" : "failed",
    reply_target: payload.reply_target,
    runtime_control: payload,
  };

  if (options.publisher) {
    await options.publisher.broadcast("runtime_control_result", payload);
    await options.publisher.broadcast("chat_response", chatResponse);
    return;
  }

  const outboxStore = options.outboxStore ?? new OutboxStore(options.runtimeRoot ?? undefined);
  const createdAt = options.now?.() ?? Date.now();
  await outboxStore.append({
    event_type: "runtime_control_result",
    correlation_id: payload.operation_id,
    created_at: createdAt,
    payload,
  });
  await outboxStore.append({
    event_type: "chat_response",
    correlation_id: payload.operation_id,
    created_at: options.now?.() ?? Date.now(),
    payload: chatResponse,
  });
}

export function toRuntimeControlResultPayload(
  operation: RuntimeControlOperation
): RuntimeControlResultPayload {
  return {
    operationId: operation.operation_id,
    operation_id: operation.operation_id,
    kind: operation.kind,
    state: operation.state,
    ok: operation.result?.ok ?? false,
    message: operation.result?.message ?? "Runtime control operation completed.",
    daemon_status: operation.result?.daemon_status,
    health_error: operation.result?.health_error,
    requested_by: operation.requested_by,
    reply_target: operation.reply_target,
    completed_at: operation.completed_at,
  };
}
