import { describe, expect, it } from "vitest";
import { recognizeRuntimeControlIntent } from "../runtime-control-intent.js";

describe("recognizeRuntimeControlIntent", () => {
  it("recognizes only runtime operations supported by the production executor", () => {
    expect(recognizeRuntimeControlIntent("gateway を再起動して")).toMatchObject({
      kind: "restart_gateway",
    });
    expect(recognizeRuntimeControlIntent("PulSeed を再起動して")).toMatchObject({
      kind: "restart_daemon",
    });

    expect(recognizeRuntimeControlIntent("runtime 設定を再読み込みして")).toBeNull();
    expect(recognizeRuntimeControlIntent("PulSeed 自身を更新して")).toBeNull();
  });
});
