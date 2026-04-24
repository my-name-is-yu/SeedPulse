import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../tests/helpers/temp-dir.js";
import { reconcileRuntimeControlOperationsAfterStartup } from "../daemon/runner-startup.js";
import { OutboxStore } from "../store/outbox-store.js";
import { RuntimeOperationStore } from "../store/runtime-operation-store.js";
import type { RuntimeControlOperation } from "../store/runtime-operation-schemas.js";

function makeRestartingOperation(
  overrides: Partial<RuntimeControlOperation> = {}
): RuntimeControlOperation {
  return {
    operation_id: "op-restart-1",
    kind: "restart_daemon",
    state: "restarting",
    requested_at: "2026-04-13T00:00:00.000Z",
    updated_at: "2026-04-13T00:00:00.000Z",
    requested_by: {
      surface: "gateway",
      platform: "slack",
      conversation_id: "thread-1",
      identity_key: "owner",
      user_id: "owner-user",
    },
    reply_target: {
      surface: "gateway",
      channel: "plugin_gateway",
      platform: "slack",
      conversation_id: "thread-1",
      message_id: "msg-1",
      identity_key: "owner",
      user_id: "owner-user",
      deliveryMode: "thread_reply",
      metadata: {
        response_url: "https://example.test/response",
      },
    },
    reason: "PulSeed を再起動して",
    started_at: "2026-04-13T00:00:01.000Z",
    expected_health: {
      daemon_ping: true,
      gateway_acceptance: true,
    },
    result: {
      ok: true,
      message: "daemon restart was accepted by the runtime command dispatcher.",
    },
    ...overrides,
  };
}

describe("runtime-control restart result routing", () => {
  it("publishes verified restart results to the durable reply target events", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-result-routing-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const operationStore = new RuntimeOperationStore(runtimeRoot);
      await operationStore.save(makeRestartingOperation());

      await reconcileRuntimeControlOperationsAfterStartup(
        runtimeRoot,
        { status: "idle" },
        { info: vi.fn() },
      );

      expect(await operationStore.listPending()).toHaveLength(0);
      const completed = await operationStore.listCompleted();
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({
        operation_id: "op-restart-1",
        state: "verified",
        reply_target: {
          channel: "plugin_gateway",
          message_id: "msg-1",
          deliveryMode: "thread_reply",
          metadata: {
            response_url: "https://example.test/response",
          },
        },
      });

      const outbox = await new OutboxStore(runtimeRoot).list();
      expect(outbox).toHaveLength(2);
      expect(outbox[0]).toMatchObject({
        event_type: "runtime_control_result",
        correlation_id: "op-restart-1",
        payload: {
          operation_id: "op-restart-1",
          state: "verified",
          ok: true,
          reply_target: {
            conversation_id: "thread-1",
            message_id: "msg-1",
          },
        },
      });
      expect(outbox[1]).toMatchObject({
        event_type: "chat_response",
        correlation_id: "op-restart-1",
        payload: {
          goalId: "runtime_control:op-restart-1",
          goal_id: "runtime_control:op-restart-1",
          status: "verified",
          reply_target: {
            conversation_id: "thread-1",
            message_id: "msg-1",
          },
          runtime_control: {
            operation_id: "op-restart-1",
          },
        },
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("uses the live event publisher when startup has an event server", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-result-publisher-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const operationStore = new RuntimeOperationStore(runtimeRoot);
      await operationStore.save(makeRestartingOperation({ operation_id: "op-restart-2" }));
      const published: Array<{ eventType: string; data: unknown }> = [];

      await reconcileRuntimeControlOperationsAfterStartup(
        runtimeRoot,
        { status: "running" },
        { info: vi.fn() },
        {
          broadcast: (eventType, data) => {
            published.push({ eventType, data });
          },
        },
      );

      expect(published.map((entry) => entry.eventType)).toEqual([
        "runtime_control_result",
        "chat_response",
      ]);
      expect(published[1]?.data).toMatchObject({
        goalId: "runtime_control:op-restart-2",
        message: "PulSeed daemon の再起動を確認しました。",
        reply_target: {
          channel: "plugin_gateway",
          message_id: "msg-1",
        },
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});
