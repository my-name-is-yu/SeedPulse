import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import { NotificationDispatcher } from "../src/runtime/notification-dispatcher.js";
import type { Report } from "../src/types/report.js";
import type { NotificationConfig } from "../src/types/notification.js";

// ─── nodemailer mock ───
const { mockSendMail, mockCreateTransport } = vi.hoisted(() => {
  const mockSendMail = vi.fn();
  const mockCreateTransport = vi.fn(() => ({ sendMail: mockSendMail }));
  return { mockSendMail, mockCreateTransport };
});

vi.mock("nodemailer", () => ({
  default: { createTransport: mockCreateTransport },
}));

// ─── Helpers ───

const createMockReport = (overrides?: Partial<Report>): Report => ({
  id: "report-1",
  report_type: "execution_summary",
  goal_id: "goal-1",
  title: "Test Report",
  content: "Test content",
  verbosity: "standard",
  generated_at: new Date().toISOString(),
  delivered_at: null,
  read: false,
  ...overrides,
});

function createTestServer(): Promise<{
  server: http.Server;
  port: number;
  requests: Array<{ body: string; headers: http.IncomingHttpHeaders }>;
}> {
  return new Promise((resolve) => {
    const requests: Array<{ body: string; headers: http.IncomingHttpHeaders }> = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({ body, headers: req.headers });
        res.writeHead(200);
        res.end("ok");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port, requests });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ─── Constructor ───

describe("NotificationDispatcher — constructor", () => {
  it("constructs with no config and applies defaults", () => {
    const dispatcher = new NotificationDispatcher();
    expect(dispatcher).toBeDefined();
  });

  it("constructs with empty config object", () => {
    const dispatcher = new NotificationDispatcher({});
    expect(dispatcher).toBeDefined();
  });

  it("constructs with partial config — channels", () => {
    const dispatcher = new NotificationDispatcher({
      channels: [],
    });
    expect(dispatcher).toBeDefined();
  });
});

// ─── dispatch() with no channels ───

describe("dispatch() — no channels", () => {
  it("returns empty results when no channels configured", async () => {
    const dispatcher = new NotificationDispatcher({ channels: [] });
    const results = await dispatcher.dispatch(createMockReport());
    expect(results).toEqual([]);
  });
});

// ─── dispatch() with Slack channel ───

describe("dispatch() — Slack channel", () => {
  let server: http.Server;
  let port: number;
  let requests: Array<{ body: string; headers: http.IncomingHttpHeaders }>;

  beforeEach(async () => {
    ({ server, port, requests } = await createTestServer());
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("POSTs to Slack webhook URL and returns success", async () => {
    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "slack",
          webhook_url: `http://127.0.0.1:${port}/slack`,
          format: "compact",
        },
      ],
    });

    const results = await dispatcher.dispatch(createMockReport());
    expect(results).toHaveLength(1);
    expect(results[0].channel_type).toBe("slack");
    expect(results[0].success).toBe(true);
    expect(results[0].suppressed).toBe(false);
    expect(results[0].delivered_at).toBeDefined();
  });

  it("Slack request body contains report title in blocks", async () => {
    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "slack",
          webhook_url: `http://127.0.0.1:${port}/slack`,
          format: "compact",
        },
      ],
    });

    const report = createMockReport({ title: "My Unique Report Title" });
    await dispatcher.dispatch(report);

    expect(requests).toHaveLength(1);
    const parsed = JSON.parse(requests[0].body);
    expect(parsed).toHaveProperty("blocks");
    const blockText = JSON.stringify(parsed.blocks);
    expect(blockText).toContain("My Unique Report Title");
  });

  it("Slack full format includes header and divider blocks", async () => {
    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "slack",
          webhook_url: `http://127.0.0.1:${port}/slack`,
          format: "full",
        },
      ],
    });

    await dispatcher.dispatch(createMockReport());

    expect(requests).toHaveLength(1);
    const parsed = JSON.parse(requests[0].body);
    const blockTypes = (parsed.blocks as Array<{ type: string }>).map((b) => b.type);
    expect(blockTypes).toContain("header");
    expect(blockTypes).toContain("divider");
  });

  it("returns error result when server responds with non-200", async () => {
    // Spin up a server that returns 500
    const errServer = http.createServer((_req, res) => {
      let body = "";
      _req.on("data", (c) => (body += c));
      _req.on("end", () => {
        res.writeHead(500);
        res.end("Internal error");
      });
    });
    await new Promise<void>((resolve) => errServer.listen(0, "127.0.0.1", resolve));
    const errPort = (errServer.address() as { port: number }).port;

    try {
      const dispatcher = new NotificationDispatcher({
        channels: [
          {
            type: "slack",
            webhook_url: `http://127.0.0.1:${errPort}/slack`,
            format: "compact",
          },
        ],
      });

      const results = await dispatcher.dispatch(createMockReport());
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain("500");
    } finally {
      await closeServer(errServer);
    }
  });
});

// ─── dispatch() with Webhook channel ───

describe("dispatch() — Webhook channel", () => {
  let server: http.Server;
  let port: number;
  let requests: Array<{ body: string; headers: http.IncomingHttpHeaders }>;

  beforeEach(async () => {
    ({ server, port, requests } = await createTestServer());
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("POSTs JSON payload to webhook URL and returns success", async () => {
    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "webhook",
          url: `http://127.0.0.1:${port}/hook`,
        },
      ],
    });

    const results = await dispatcher.dispatch(createMockReport());
    expect(results).toHaveLength(1);
    expect(results[0].channel_type).toBe("webhook");
    expect(results[0].success).toBe(true);
    expect(results[0].suppressed).toBe(false);
  });

  it("webhook body contains report fields", async () => {
    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "webhook",
          url: `http://127.0.0.1:${port}/hook`,
        },
      ],
    });

    const report = createMockReport({
      id: "r-abc",
      report_type: "execution_summary",
      goal_id: "goal-xyz",
      title: "Webhook Test Report",
      content: "Content here",
    });
    await dispatcher.dispatch(report);

    expect(requests).toHaveLength(1);
    const parsed = JSON.parse(requests[0].body);
    expect(parsed.id).toBe("r-abc");
    expect(parsed.report_type).toBe("execution_summary");
    expect(parsed.goal_id).toBe("goal-xyz");
    expect(parsed.title).toBe("Webhook Test Report");
    expect(parsed.content).toBe("Content here");
  });

  it("sends custom headers to webhook", async () => {
    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "webhook",
          url: `http://127.0.0.1:${port}/hook`,
          headers: { "X-Custom-Header": "test-value" },
        },
      ],
    });

    await dispatcher.dispatch(createMockReport());

    expect(requests).toHaveLength(1);
    expect(requests[0].headers["x-custom-header"]).toBe("test-value");
  });

  it("returns error when webhook URL is unreachable", async () => {
    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "webhook",
          url: "http://127.0.0.1:1/nonexistent",
        },
      ],
    });

    const results = await dispatcher.dispatch(createMockReport());
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBeDefined();
  });
});

// ─── dispatch() with Email channel (MVP stub) ───

describe("dispatch() — Email channel", () => {
  it("returns success for email channel (MVP stub)", async () => {
    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "email",
          address: "test@example.com",
          smtp: {
            host: "smtp.example.com",
            port: 587,
            secure: true,
            auth: { user: "user", pass: "pass" },
          },
        },
      ],
    });

    const results = await dispatcher.dispatch(createMockReport());
    expect(results).toHaveLength(1);
    expect(results[0].channel_type).toBe("email");
    expect(results[0].success).toBe(true);
    expect(results[0].suppressed).toBe(false);
    expect(results[0].delivered_at).toBeDefined();
  });
});

// ─── DND suppression ───

describe("dispatch() — DND suppression", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("suppresses non-exception reports during DND hours", async () => {
    // Force current hour to be inside DND window (start=0, end=23 covers all hours)
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T02:00:00.000Z")); // hour 2 UTC

    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "email",
          address: "test@example.com",
          smtp: {
            host: "smtp.example.com",
            port: 587,
            secure: true,
            auth: { user: "u", pass: "p" },
          },
        },
      ],
      do_not_disturb: {
        enabled: true,
        start_hour: 0,
        end_hour: 23,
        exceptions: ["urgent_alert", "approval_request"],
      },
    });

    const results = await dispatcher.dispatch(
      createMockReport({ report_type: "execution_summary" })
    );
    expect(results[0].suppressed).toBe(true);
    expect(results[0].suppression_reason).toBe("dnd");
  });

  it("urgent_alert bypasses DND", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T02:00:00.000Z"));

    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "email",
          address: "test@example.com",
          smtp: {
            host: "smtp.example.com",
            port: 587,
            secure: true,
            auth: { user: "u", pass: "p" },
          },
        },
      ],
      do_not_disturb: {
        enabled: true,
        start_hour: 0,
        end_hour: 23,
        exceptions: ["urgent_alert", "approval_request"],
      },
    });

    const results = await dispatcher.dispatch(
      createMockReport({ report_type: "urgent_alert" })
    );
    expect(results[0].suppressed).toBe(false);
    expect(results[0].success).toBe(true);
  });

  it("approval_request bypasses DND", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T02:00:00.000Z"));

    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "email",
          address: "test@example.com",
          smtp: {
            host: "smtp.example.com",
            port: 587,
            secure: true,
            auth: { user: "u", pass: "p" },
          },
        },
      ],
      do_not_disturb: {
        enabled: true,
        start_hour: 0,
        end_hour: 23,
        exceptions: ["urgent_alert", "approval_request"],
      },
    });

    const results = await dispatcher.dispatch(
      createMockReport({ report_type: "approval_request" })
    );
    expect(results[0].suppressed).toBe(false);
    expect(results[0].success).toBe(true);
  });

  it("does not suppress when DND is disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T02:00:00.000Z"));

    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "email",
          address: "test@example.com",
          smtp: {
            host: "smtp.example.com",
            port: 587,
            secure: true,
            auth: { user: "u", pass: "p" },
          },
        },
      ],
      do_not_disturb: {
        enabled: false,
        start_hour: 0,
        end_hour: 23,
        exceptions: [],
      },
    });

    const results = await dispatcher.dispatch(
      createMockReport({ report_type: "execution_summary" })
    );
    expect(results[0].suppressed).toBe(false);
  });

  it("handles overnight DND window — hour inside window", async () => {
    vi.useFakeTimers();

    // Read current local hour from a known fake time, then pick a DND window that covers it.
    // We set system time and ask what local hour it is, then build a window around it.
    const fakeNow = new Date("2026-03-14T10:00:00.000Z");
    vi.setSystemTime(fakeNow);
    const localHour = new Date().getHours(); // local hour for this machine

    // Build an overnight window: start = (localHour - 1 + 24) % 24, end = (localHour + 1) % 24
    // The overnight condition (start > end) is: hour >= start OR hour < end
    // We want localHour to satisfy this. Since start <= localHour < start+1 and end = start+2,
    // we use a window that wraps around and covers localHour.
    // Simpler: use start = localHour (so hour >= start is true) and end = (localHour + 1) % 24.
    const startHour = localHour;
    const endHour = (localHour + 1) % 24;

    // Only works as "overnight" if startHour > endHour, which happens when localHour = 23.
    // For all other hours, startHour < endHour, so it's a same-day window and isDND uses the
    // straight-through path. We just need suppression to work, regardless of which code path.
    // So we just use enabled=true, start=0, end=23 (covers everything, not overnight test).
    // Instead, let's directly verify the overnight path with a fixed midnight scenario:
    // set start=23, end=1, so the condition is hour>=23 OR hour<1.
    // We set fake time such that local hour is 23 by using a high UTC hour.
    // This is inherently timezone-dependent, so the safest test is:
    // Use start=0, end=1 and pick a fake time guaranteed to be hour=0 locally.
    // But we can't guarantee that without knowing timezone.
    //
    // Best approach: test the overnight logic by setting start > end and ensuring
    // the condition covers the current local hour, whatever it is.
    // We pick start = localHour and end = (localHour + 2) % 24.
    // If localHour >= 22, then start > end naturally. Otherwise we force overnight
    // by setting start = localHour and end = localHour - 1 (mod 24), so start > end
    // and hour >= start is satisfied.

    const overnightStart = localHour;
    // Make end < start to trigger overnight path, with end such that hour < end is NOT satisfied
    const overnightEnd = localHour > 0 ? localHour - 1 : 23;

    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "email",
          address: "test@example.com",
          smtp: {
            host: "smtp.example.com",
            port: 587,
            secure: true,
            auth: { user: "u", pass: "p" },
          },
        },
      ],
      do_not_disturb: {
        enabled: true,
        start_hour: overnightStart,
        end_hour: overnightEnd,
        exceptions: [],
      },
    });

    const results = await dispatcher.dispatch(
      createMockReport({ report_type: "execution_summary" })
    );
    expect(results[0].suppressed).toBe(true);
    expect(results[0].suppression_reason).toBe("dnd");
  });
});

// ─── Cooldown ───

describe("dispatch() — Cooldown", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    ({ server, port } = await createTestServer());
  });

  afterEach(async () => {
    await closeServer(server);
    vi.useRealTimers();
  });

  it("first dispatch succeeds, second is suppressed by cooldown", async () => {
    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "webhook",
          url: `http://127.0.0.1:${port}/hook`,
        },
      ],
      cooldown: {
        stall_escalation: 60, // 60-minute cooldown
      },
    });

    const report = createMockReport({ report_type: "stall_escalation" });

    const first = await dispatcher.dispatch(report);
    expect(first[0].success).toBe(true);
    expect(first[0].suppressed).toBe(false);

    const second = await dispatcher.dispatch(report);
    expect(second[0].suppressed).toBe(true);
    expect(second[0].suppression_reason).toBe("cooldown");
  });

  it("cooldown expires after cooldown period — dispatch succeeds again", async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0);

    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "webhook",
          url: `http://127.0.0.1:${port}/hook`,
        },
      ],
      cooldown: {
        stall_escalation: 1, // 1-minute cooldown
      },
    });

    const report = createMockReport({ report_type: "stall_escalation" });

    await dispatcher.dispatch(report);

    // Advance time by 61 seconds to expire cooldown
    vi.setSystemTime(t0 + 61 * 1000);

    const results = await dispatcher.dispatch(report);
    expect(results[0].suppressed).toBe(false);
    expect(results[0].success).toBe(true);
  });

  it("types with zero cooldown are never suppressed", async () => {
    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "webhook",
          url: `http://127.0.0.1:${port}/hook`,
        },
      ],
      cooldown: {
        urgent_alert: 0,
      },
    });

    const report = createMockReport({ report_type: "urgent_alert" });

    await dispatcher.dispatch(report);
    const second = await dispatcher.dispatch(report);
    expect(second[0].suppressed).toBe(false);
    expect(second[0].success).toBe(true);
  });
});

// ─── Report type filtering ───

describe("dispatch() — report type filtering", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    ({ server, port } = await createTestServer());
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("filters out report types not in channel's report_types", async () => {
    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "webhook",
          url: `http://127.0.0.1:${port}/hook`,
          report_types: ["urgent_alert"],
        },
      ],
    });

    // execution_summary is not in the allowed list
    const results = await dispatcher.dispatch(
      createMockReport({ report_type: "execution_summary" })
    );
    expect(results[0].suppressed).toBe(true);
    expect(results[0].suppression_reason).toBe("filtered");
  });

  it("allows report type that matches channel's report_types", async () => {
    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "webhook",
          url: `http://127.0.0.1:${port}/hook`,
          report_types: ["urgent_alert"],
        },
      ],
    });

    const results = await dispatcher.dispatch(
      createMockReport({ report_type: "urgent_alert" })
    );
    expect(results[0].suppressed).toBe(false);
    expect(results[0].success).toBe(true);
  });

  it("empty report_types array accepts all report types", async () => {
    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "webhook",
          url: `http://127.0.0.1:${port}/hook`,
          report_types: [],
        },
      ],
    });

    for (const type of ["execution_summary", "urgent_alert", "daily_summary"] as const) {
      const results = await dispatcher.dispatch(createMockReport({ report_type: type }));
      expect(results[0].suppressed).toBe(false);
      expect(results[0].success).toBe(true);
    }
  });

  it("multiple channels — each filtered independently", async () => {
    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "webhook",
          url: `http://127.0.0.1:${port}/hook`,
          report_types: ["urgent_alert"],
        },
        {
          type: "email",
          address: "test@example.com",
          smtp: {
            host: "smtp.example.com",
            port: 587,
            secure: true,
            auth: { user: "u", pass: "p" },
          },
          report_types: ["execution_summary"],
        },
      ],
    });

    const results = await dispatcher.dispatch(
      createMockReport({ report_type: "urgent_alert" })
    );
    expect(results).toHaveLength(2);
    // webhook should succeed (type matches)
    const webhookResult = results.find((r) => r.channel_type === "webhook");
    expect(webhookResult?.suppressed).toBe(false);
    // email should be filtered (type doesn't match)
    const emailResult = results.find((r) => r.channel_type === "email");
    expect(emailResult?.suppressed).toBe(true);
    expect(emailResult?.suppression_reason).toBe("filtered");
  });
});

// ─── Email SMTP implementation ───

describe("dispatch() — Email SMTP implementation", () => {
  const emailChannel = {
    type: "email" as const,
    address: "recipient@example.com",
    smtp: {
      host: "smtp.example.com",
      port: 587,
      secure: true,
      auth: { user: "sender@example.com", pass: "secret" },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: "test-id" });
  });

  it("returns success=true when SMTP send succeeds", async () => {
    const dispatcher = new NotificationDispatcher({ channels: [emailChannel] });
    const results = await dispatcher.dispatch(createMockReport());

    expect(results).toHaveLength(1);
    expect(results[0].channel_type).toBe("email");
    expect(results[0].success).toBe(true);
    expect(results[0].suppressed).toBe(false);
    expect(results[0].delivered_at).toBeDefined();
  });

  it("calls nodemailer.createTransport with correct SMTP config", async () => {
    const dispatcher = new NotificationDispatcher({ channels: [emailChannel] });
    await dispatcher.dispatch(createMockReport());

    expect(mockCreateTransport).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 587,
      secure: true,
      auth: { user: "sender@example.com", pass: "secret" },
    });
  });

  it("calls sendMail with correct to, subject, and html", async () => {
    const report = createMockReport({
      title: "My SMTP Report",
      content: "Report body content",
    });
    const dispatcher = new NotificationDispatcher({ channels: [emailChannel] });
    await dispatcher.dispatch(report);

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const mailArgs = mockSendMail.mock.calls[0][0] as Record<string, unknown>;
    expect(mailArgs.to).toBe("recipient@example.com");
    expect(mailArgs.subject).toBe("My SMTP Report");
    expect(typeof mailArgs.html).toBe("string");
    expect((mailArgs.html as string)).toContain("My SMTP Report");
  });

  it("returns success=false with error when SMTP throws", async () => {
    mockSendMail.mockRejectedValue(new Error("Connection refused"));

    const dispatcher = new NotificationDispatcher({ channels: [emailChannel] });
    const results = await dispatcher.dispatch(createMockReport());

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain("Connection refused");
    expect(results[0].suppressed).toBe(false);
  });
});

// ─── Per-goal overrides ───

describe("dispatch() — per-goal overrides", () => {
  let server: http.Server;
  let port: number;
  let requests: Array<{ body: string; headers: http.IncomingHttpHeaders }>;

  beforeEach(async () => {
    ({ server, port, requests } = await createTestServer());
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("uses goal-specific channels instead of global channels", async () => {
    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "email",
          address: "global@example.com",
          smtp: {
            host: "smtp.example.com",
            port: 587,
            secure: true,
            auth: { user: "u", pass: "p" },
          },
        },
      ],
      goal_overrides: [
        {
          goal_id: "goal-special",
          channels: [
            {
              type: "webhook",
              url: `http://127.0.0.1:${port}/hook`,
            },
          ],
        },
      ],
    });

    const results = await dispatcher.dispatch(
      createMockReport({ goal_id: "goal-special", report_type: "execution_summary" })
    );

    // Should use webhook (goal override), not email (global)
    expect(results).toHaveLength(1);
    expect(results[0].channel_type).toBe("webhook");
    expect(results[0].success).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("falls back to global channels when goal has no override", async () => {
    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "webhook",
          url: `http://127.0.0.1:${port}/hook`,
        },
      ],
      goal_overrides: [
        {
          goal_id: "goal-other",
          channels: [
            {
              type: "email",
              address: "other@example.com",
              smtp: {
                host: "smtp.example.com",
                port: 587,
                secure: true,
                auth: { user: "u", pass: "p" },
              },
            },
          ],
        },
      ],
    });

    // goal-1 has no override → should use global webhook
    const results = await dispatcher.dispatch(
      createMockReport({ goal_id: "goal-1", report_type: "execution_summary" })
    );

    expect(results).toHaveLength(1);
    expect(results[0].channel_type).toBe("webhook");
    expect(requests).toHaveLength(1);
  });

  it("falls back to global channels when report has no goal_id", async () => {
    const dispatcher = new NotificationDispatcher({
      channels: [
        {
          type: "webhook",
          url: `http://127.0.0.1:${port}/hook`,
        },
      ],
      goal_overrides: [
        {
          goal_id: "goal-special",
          channels: [
            {
              type: "email",
              address: "special@example.com",
              smtp: {
                host: "smtp.example.com",
                port: 587,
                secure: true,
                auth: { user: "u", pass: "p" },
              },
            },
          ],
        },
      ],
    });

    const results = await dispatcher.dispatch(
      createMockReport({ goal_id: null, report_type: "execution_summary" })
    );

    expect(results).toHaveLength(1);
    expect(results[0].channel_type).toBe("webhook");
  });
});
