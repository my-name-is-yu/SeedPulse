import { describe, expect, it } from "vitest";
import { IngressRouter, buildStandaloneIngressMessage } from "../ingress-router.js";

describe("IngressRouter", () => {
  const router = new IngressRouter();

  it("selects direct answers for simple questions regardless of ingress channel", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "What is a lightweight direct-answer route?",
        channel: "plugin_gateway",
        platform: "discord",
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
        },
      }),
      {
        hasLightweightLlm: true,
        hasAgentLoop: false,
        hasToolLoop: true,
      }
    );

    expect(route.kind).toBe("direct_answer");
    expect(route.lane).toBe("fast");
    expect(route.replyTargetPolicy).toBe("turn_reply_target");
    expect(route.daemonChatPolicy).toBe("compatibility_only");
  });

  it("keeps repository-inspection questions off the direct-answer route", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "What files changed?",
      }),
      {
        hasLightweightLlm: true,
        hasAgentLoop: false,
        hasToolLoop: true,
      }
    );

    expect(route.kind).toBe("tool_loop");
  });

  it("routes explicit runtime-control requests to the durable lane when allowed", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "PulSeed を再起動して",
        channel: "plugin_gateway",
        platform: "telegram",
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
        },
      }),
      {
        hasLightweightLlm: true,
        hasAgentLoop: true,
        hasToolLoop: true,
      }
    );

    expect(route.kind).toBe("runtime_control");
    expect(route.lane).toBe("durable");
    expect(route.eventProjectionPolicy).toBe("latest_active_reply_target");
  });

  it("does not route runtime-control text to the durable lane when ingress policy disallows it", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "PulSeed を再起動して",
        channel: "plugin_gateway",
        platform: "telegram",
        runtimeControl: {
          allowed: false,
          approvalMode: "disallowed",
        },
      }),
      {
        hasLightweightLlm: true,
        hasAgentLoop: true,
        hasToolLoop: true,
      }
    );

    expect(route.kind).toBe("agent_loop");
    expect(route.lane).toBe("fast");
  });
});
