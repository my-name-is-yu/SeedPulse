import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { RuntimeOperationStore } from "../../store/runtime-operation-store.js";
import { RuntimeControlService } from "../runtime-control-service.js";

describe("RuntimeControlService", () => {
  it("executes approved restart operations through the configured executor", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn().mockResolvedValue({
        ok: true,
        state: "acknowledged",
        message: "reload queued",
      });
      const service = new RuntimeControlService({ operationStore, executor });

      const result = await service.request({
        intent: { kind: "restart_gateway", reason: "gateway を再起動して" },
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      expect(result).toMatchObject({
        success: true,
        message: "reload queued",
        state: "acknowledged",
      });
      expect(executor).toHaveBeenCalledOnce();
      expect(await operationStore.listCompleted()).toHaveLength(0);
      const pending = await operationStore.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        kind: "restart_gateway",
        state: "acknowledged",
        expected_health: {
          daemon_ping: true,
          gateway_acceptance: true,
        },
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("rejects unsupported operation kinds before claiming executor support", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-unsupported-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn();
      const service = new RuntimeControlService({ operationStore, executor });

      const result = await service.request({
        intent: { kind: "reload_config", reason: "runtime 設定を再読み込みして" },
        cwd: "/repo",
      });

      expect(result).toMatchObject({
        success: false,
        state: "failed",
        message: expect.stringContaining("not supported"),
      });
      expect(executor).not.toHaveBeenCalled();
      expect(await operationStore.listPending()).toHaveLength(0);
      expect(await operationStore.listCompleted()).toHaveLength(0);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("records cancelled operations when required approval is rejected", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-rejected-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn();
      const service = new RuntimeControlService({ operationStore, executor });

      const result = await service.request({
        intent: { kind: "restart_daemon", reason: "PulSeed を再起動して" },
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(false),
      });

      expect(result).toMatchObject({
        success: false,
        message: "Runtime control operation was not approved.",
        state: "cancelled",
      });
      expect(executor).not.toHaveBeenCalled();
      expect(await operationStore.listPending()).toHaveLength(0);
      const completed = await operationStore.listCompleted();
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({
        kind: "restart_daemon",
        state: "cancelled",
        result: {
          ok: false,
          message: "Runtime control operation was not approved.",
        },
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});
