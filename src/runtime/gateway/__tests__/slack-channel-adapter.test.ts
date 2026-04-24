import { createHmac } from "crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dispatchGatewayChatInput } from "../chat-session-dispatch.js";
import {
  SlackChannelAdapter,
  type SlackChannelAdapterConfig,
} from "../slack-channel-adapter.js";

vi.mock("../chat-session-dispatch.js", () => ({
  dispatchGatewayChatInput: vi.fn().mockResolvedValue("ok"),
}));

const SIGNING_SECRET = "test-signing-secret-abc123";

/** Build valid Slack request headers with correct HMAC signature */
function buildHeaders(body: string, timestampSec?: number): Record<string, string> {
  const ts = timestampSec ?? Math.floor(Date.now() / 1000);
  const sigBase = `v0:${ts}:${body}`;
  const mac = createHmac("sha256", SIGNING_SECRET).update(sigBase).digest("hex");
  return {
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature": `v0=${mac}`,
  };
}

function makeAdapter(extra?: Partial<SlackChannelAdapterConfig>): SlackChannelAdapter {
  return new SlackChannelAdapter({
    signingSecret: SIGNING_SECRET,
    ...extra,
  });
}

beforeEach(() => {
  vi.mocked(dispatchGatewayChatInput).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Basic adapter properties
// ---------------------------------------------------------------------------

describe("SlackChannelAdapter — properties", () => {
  it("has name 'slack'", () => {
    expect(makeAdapter().name).toBe("slack");
  });

  it("start() resolves without error", async () => {
    await expect(makeAdapter().start()).resolves.toBeUndefined();
  });

  it("stop() resolves without error", async () => {
    await expect(makeAdapter().stop()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// URL Verification Challenge
// ---------------------------------------------------------------------------

describe("SlackChannelAdapter — URL verification", () => {
  it("returns challenge for url_verification type (valid signature required)", () => {
    const adapter = makeAdapter();
    const body = JSON.stringify({ type: "url_verification", challenge: "abc-xyz-123" });
    const headers = buildHeaders(body);
    const res = adapter.handleRequest(body, headers);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ challenge: "abc-xyz-123" });
  });

  it("returns challenge value as-is", () => {
    const adapter = makeAdapter();
    const body = JSON.stringify({ type: "url_verification", challenge: "random_token_42" });
    const headers = buildHeaders(body);
    const res = adapter.handleRequest(body, headers);
    expect(JSON.parse(res.body).challenge).toBe("random_token_42");
  });

  it("rejects url_verification with missing signature (401)", () => {
    const adapter = makeAdapter();
    const body = JSON.stringify({ type: "url_verification", challenge: "abc-xyz-123" });
    const res = adapter.handleRequest(body, {});
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Signature Verification
// ---------------------------------------------------------------------------

describe("SlackChannelAdapter — signature verification", () => {
  it("accepts a valid signature", () => {
    const adapter = makeAdapter();
    const body = JSON.stringify({ type: "event_callback", event: { type: "message" }, team_id: "T1", event_id: "E1" });
    const headers = buildHeaders(body);
    const res = adapter.handleRequest(body, headers);
    expect(res.status).toBe(200);
  });

  it("rejects missing signature headers (401)", () => {
    const adapter = makeAdapter();
    const body = JSON.stringify({ type: "event_callback", event: { type: "message" } });
    const res = adapter.handleRequest(body, {});
    expect(res.status).toBe(401);
  });

  it("rejects when x-slack-signature is missing", () => {
    const adapter = makeAdapter();
    const body = JSON.stringify({ type: "event_callback", event: { type: "message" } });
    const res = adapter.handleRequest(body, {
      "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
    });
    expect(res.status).toBe(401);
  });

  it("rejects when x-slack-request-timestamp is missing", () => {
    const adapter = makeAdapter();
    const body = JSON.stringify({ type: "event_callback", event: { type: "message" } });
    const res = adapter.handleRequest(body, {
      "x-slack-signature": "v0=invalidsig",
    });
    expect(res.status).toBe(401);
  });

  it("rejects a tampered signature (401)", () => {
    const adapter = makeAdapter();
    const body = JSON.stringify({ type: "event_callback", event: { type: "message" } });
    const headers = buildHeaders(body);
    const res = adapter.handleRequest(body, {
      ...headers,
      "x-slack-signature": "v0=aaabbbccc000111222333",
    });
    expect(res.status).toBe(401);
  });

  it("rejects a valid signature with trailing bytes appended (401)", () => {
    // Security: a signature like `v0=<valid_hex>AAAA` must be rejected.
    // Previously the padding approach would truncate extra bytes and pass.
    const adapter = makeAdapter();
    const body = JSON.stringify({ type: "event_callback", event: { type: "message" }, team_id: "T1", event_id: "E1" });
    const headers = buildHeaders(body);
    const validSig = headers["x-slack-signature"]; // "v0=" + 64 hex chars = 67 bytes
    const tamperedSig = validSig + "AAAA"; // append trailing bytes
    const res = adapter.handleRequest(body, {
      ...headers,
      "x-slack-signature": tamperedSig,
    });
    expect(res.status).toBe(401);
  });

    it("rejects a valid sig for a DIFFERENT body (401)", () => {
    const adapter = makeAdapter();
    const body = JSON.stringify({ type: "event_callback", event: { type: "message" } });
    const differentBody = JSON.stringify({ type: "event_callback", event: { type: "app_mention" } });
    const headers = buildHeaders(differentBody); // sig is for differentBody
    const res = adapter.handleRequest(body, headers);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Replay Attack (stale timestamp)
// ---------------------------------------------------------------------------

describe("SlackChannelAdapter — replay protection", () => {
  it("rejects a timestamp older than 5 minutes (401)", () => {
    const adapter = makeAdapter();
    const body = JSON.stringify({ type: "event_callback", event: { type: "message" } });
    const staleTs = Math.floor(Date.now() / 1000) - 6 * 60; // 6 minutes ago
    const headers = buildHeaders(body, staleTs);
    const res = adapter.handleRequest(body, headers);
    expect(res.status).toBe(401);
    expect(res.body).toContain("stale");
  });

  it("accepts a timestamp just within 5 minutes", () => {
    const adapter = makeAdapter();
    const body = JSON.stringify({ type: "event_callback", event: { type: "message" }, team_id: "T1", event_id: "E1" });
    const recentTs = Math.floor(Date.now() / 1000) - 4 * 60; // 4 minutes ago
    const headers = buildHeaders(body, recentTs);
    const res = adapter.handleRequest(body, headers);
    expect(res.status).toBe(200);
  });

  it("rejects a future timestamp beyond 5 minutes", () => {
    const adapter = makeAdapter();
    const body = JSON.stringify({ type: "event_callback", event: { type: "message" } });
    const futureTs = Math.floor(Date.now() / 1000) + 6 * 60; // 6 minutes in future
    const headers = buildHeaders(body, futureTs);
    const res = adapter.handleRequest(body, headers);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Event callback → Envelope conversion
// ---------------------------------------------------------------------------

describe("SlackChannelAdapter — event_callback to Envelope", () => {
  it("calls the registered handler with an Envelope", () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onEnvelope(handler);

    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T_TEAM1",
      event_id: "Ev_001",
      event: { type: "reaction_added", reaction: "eyes", channel: "C_GENERAL" },
    });
    adapter.handleRequest(body, buildHeaders(body));

    expect(handler).toHaveBeenCalledOnce();
    const envelope = handler.mock.calls[0][0];
    expect(envelope.type).toBe("event");
    expect(envelope.source).toBe("slack");
    expect(envelope.name).toBe("reaction_added");
  });

  it("sets envelope.name from slack event type", () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onEnvelope(handler);

    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "E1",
      event: { type: "reaction_added", channel: "C1" },
    });
    adapter.handleRequest(body, buildHeaders(body));

    const envelope = handler.mock.calls[0][0];
    expect(envelope.name).toBe("reaction_added");
  });

  it("sets payload to the Slack event object", () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onEnvelope(handler);

    const slackEvent = { type: "reaction_added", reaction: "thumbsup", channel: "C_TEST", user: "U123" };
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "E1",
      event: slackEvent,
    });
    adapter.handleRequest(body, buildHeaders(body));

    const envelope = handler.mock.calls[0][0];
    expect(envelope.payload).toEqual(slackEvent);
  });

  it("includes slack_team_id and slack_event_id in metadata", () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onEnvelope(handler);

    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T_META",
      event_id: "Ev_META",
      event: { type: "reaction_added" },
    });
    adapter.handleRequest(body, buildHeaders(body));

    const envelope = handler.mock.calls[0][0] as Record<string, unknown>;
    const meta = envelope["metadata"] as Record<string, unknown>;
    expect(meta["slack_team_id"]).toBe("T_META");
    expect(meta["slack_event_id"]).toBe("Ev_META");
  });

  it("sets dedupe_key from event_id", () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onEnvelope(handler);

    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev_DEDUP",
      event: { type: "reaction_added" },
    });
    adapter.handleRequest(body, buildHeaders(body));

    const envelope = handler.mock.calls[0][0];
    expect(envelope.dedupe_key).toBe("Ev_DEDUP");
  });
});

// ---------------------------------------------------------------------------
// Chat dispatch
// ---------------------------------------------------------------------------

describe("SlackChannelAdapter — chat dispatch", () => {
  it("dispatches Slack message text to the cross-platform chat path", () => {
    const adapter = makeAdapter({
      botToken: "xoxb-test-token",
      channelGoalMap: { C_GENERAL: "goal-001" },
      routing: { identityKey: "shared-slack-user" },
    });
    vi.mocked(dispatchGatewayChatInput).mockResolvedValueOnce(null);
    const handler = vi.fn();
    adapter.onEnvelope(handler);

    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T_TEAM1",
      event_id: "Ev_001",
      event: {
        type: "message",
        text: "  hello from slack  ",
        channel: "C_GENERAL",
        user: "U123",
        ts: "171234.567",
      },
    });
    const res = adapter.handleRequest(body, buildHeaders(body));

    expect(res.status).toBe(200);
    expect(handler).not.toHaveBeenCalled();
    expect(dispatchGatewayChatInput).toHaveBeenCalledWith(expect.objectContaining({
      text: "hello from slack",
      platform: "slack",
      identity_key: "shared-slack-user",
      conversation_id: "C_GENERAL",
      sender_id: "U123",
      message_id: "171234.567",
      goal_id: "goal-001",
      metadata: expect.objectContaining({
        goal_id: "goal-001",
        routed_goal_id: "goal-001",
        slack_team_id: "T_TEAM1",
        slack_event_id: "Ev_001",
      }),
    }));
  });

  it("dispatches app_mention text through the same chat path", () => {
    const adapter = makeAdapter({ botToken: "xoxb-test-token" });
    vi.mocked(dispatchGatewayChatInput).mockResolvedValueOnce(null);
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "E1",
      event: { type: "app_mention", text: "<@BOT> help", channel: "C_HELP", user: "U_HELP" },
    });

    adapter.handleRequest(body, buildHeaders(body));

    expect(dispatchGatewayChatInput).toHaveBeenCalledWith(expect.objectContaining({
      text: "<@BOT> help",
      platform: "slack",
      conversation_id: "C_HELP",
      sender_id: "U_HELP",
      message_id: "E1",
    }));
  });

  it("posts the chat reply back to Slack when a bot token is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(dispatchGatewayChatInput).mockResolvedValueOnce("Slack reply text");
    const adapter = makeAdapter({ botToken: "xoxb-test-token" });
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "E1",
      event: { type: "message", text: "hello", channel: "C_HELP", user: "U_HELP", ts: "123.456" },
    });

    adapter.handleRequest(body, buildHeaders(body));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "https://slack.com/api/chat.postMessage",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer xoxb-test-token",
          }),
          body: JSON.stringify({
            channel: "C_HELP",
            text: "Slack reply text",
            thread_ts: "123.456",
          }),
        })
      );
    });
  });

  it("keeps signing-secret-only Slack text events on the envelope path", () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onEnvelope(handler);
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "E1",
      event: { type: "message", text: "hello", channel: "C_HELP", user: "U_HELP", ts: "123.456" },
    });

    adapter.handleRequest(body, buildHeaders(body));

    expect(dispatchGatewayChatInput).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({
      type: "event",
      source: "slack",
      name: "message",
    });
  });

  it("does not dispatch bot messages back into chat", () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onEnvelope(handler);
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "E1",
      event: {
        type: "message",
        subtype: "bot_message",
        text: "bot echo",
        channel: "C_HELP",
        user: "U_BOT",
        bot_id: "B1",
      },
    });

    adapter.handleRequest(body, buildHeaders(body));

    expect(dispatchGatewayChatInput).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Channel-to-goal mapping
// ---------------------------------------------------------------------------

describe("SlackChannelAdapter — channel-to-goal mapping", () => {
  it("maps Slack channel ID to goalId", () => {
    const adapter = makeAdapter({
      channelGoalMap: { C_GENERAL: "goal-001" },
    });
    const handler = vi.fn();
    adapter.onEnvelope(handler);

    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "E1",
      event: { type: "message", channel: "C_GENERAL" },
    });
    adapter.handleRequest(body, buildHeaders(body));

    const envelope = handler.mock.calls[0][0];
    expect(envelope.goal_id).toBe("goal-001");
  });

  it("leaves goal_id undefined for unmapped channels", () => {
    const adapter = makeAdapter({
      channelGoalMap: { C_OTHER: "goal-002" },
    });
    const handler = vi.fn();
    adapter.onEnvelope(handler);

    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "E1",
      event: { type: "message", channel: "C_UNMAPPED" },
    });
    adapter.handleRequest(body, buildHeaders(body));

    const envelope = handler.mock.calls[0][0];
    expect(envelope.goal_id).toBeUndefined();
  });

  it("leaves goal_id undefined when no channelGoalMap configured", () => {
    const adapter = makeAdapter(); // no map
    const handler = vi.fn();
    adapter.onEnvelope(handler);

    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "E1",
      event: { type: "message", channel: "C_ANY" },
    });
    adapter.handleRequest(body, buildHeaders(body));

    const envelope = handler.mock.calls[0][0];
    expect(envelope.goal_id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("SlackChannelAdapter — edge cases", () => {
  it("returns 200 without calling handler when no handler registered", () => {
    const adapter = makeAdapter();
    // no onEnvelope registered
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "E1",
      event: { type: "message" },
    });
    const res = adapter.handleRequest(body, buildHeaders(body));
    expect(res.status).toBe(200);
  });

  it("returns 400 for invalid JSON body", () => {
    const adapter = makeAdapter();
    const res = adapter.handleRequest("not-json", {});
    expect(res.status).toBe(400);
  });

  it("returns 400 for event_callback without event field", () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onEnvelope(handler);

    const body = JSON.stringify({ type: "event_callback" }); // no event field
    const res = adapter.handleRequest(body, buildHeaders(body));
    expect(res.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it("handles app_mention event type", () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onEnvelope(handler);

    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "E1",
      event: { type: "app_mention", text: "<@BOT> help", channel: "C_HELP" },
    });
    adapter.handleRequest(body, buildHeaders(body));

    expect(handler).toHaveBeenCalledOnce();
    const envelope = handler.mock.calls[0][0];
    expect(envelope.name).toBe("app_mention");
  });

  it("handles reaction_added event type", () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onEnvelope(handler);

    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "E1",
      event: { type: "reaction_added", reaction: "thumbsup" },
    });
    adapter.handleRequest(body, buildHeaders(body));

    expect(handler).toHaveBeenCalledOnce();
    const envelope = handler.mock.calls[0][0];
    expect(envelope.name).toBe("reaction_added");
  });

  it("returns 200 for unknown event type (pass-through)", () => {
    const adapter = makeAdapter();
    const body = JSON.stringify({ type: "some_other_type" });
    const headers = buildHeaders(body);
    const res = adapter.handleRequest(body, headers);
    expect(res.status).toBe(200);
  });
});
