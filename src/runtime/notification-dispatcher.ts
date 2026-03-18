import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";
import nodemailer from "nodemailer";
import type { Report } from "../types/report.js";
import type {
  NotificationChannel,
  NotificationConfig,
  NotificationResult,
  SlackChannel,
  EmailChannel,
  WebhookChannel,
} from "../types/notification.js";
import { NotificationConfigSchema } from "../types/notification.js";
import type { NotificationEvent, NotificationEventType } from "../types/plugin.js";
import type { NotifierRegistry } from "./notifier-registry.js";

// ─── Interface ───

export interface INotificationDispatcher {
  dispatch(report: Report): Promise<NotificationResult[]>;
}

// ─── Helpers ───

/** Perform an HTTP/HTTPS POST with a JSON body. Returns the response status code. */
function httpPost(
  urlStr: string,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch (err) {
      reject(new Error(`Invalid URL: ${urlStr}`));
      return;
    }

    const payload = JSON.stringify(body);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port
        ? parseInt(parsed.port, 10)
        : isHttps
          ? 443
          : 80,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...extraHeaders,
      },
    };

    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer | string) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode ?? 0, body: data });
      });
    });

    req.on("error", (err: Error) => reject(err));
    req.setTimeout(10_000, () => {
      req.destroy(new Error("HTTP request timeout"));
    });

    req.write(payload);
    req.end();
  });
}

/** Truncate long strings for Slack blocks. */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

/** Escape user-controlled strings before embedding in HTML to prevent XSS. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Slack formatting ───

type SlackBlock =
  | { type: "header"; text: { type: "plain_text"; text: string; emoji: boolean } }
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | { type: "divider" };

function formatReportForSlack(
  report: Report,
  format: "compact" | "full"
): { blocks: SlackBlock[]; text: string } {
  const goalLabel = report.goal_id ? `Goal: ${report.goal_id}` : "(no goal)";
  const fallbackText = `[${report.report_type}] ${report.title}`;

  if (format === "compact") {
    const blocks: SlackBlock[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${truncate(report.title, 150)}*\n${goalLabel} | _${report.report_type}_`,
        },
      },
    ];
    return { blocks, text: fallbackText };
  }

  // full format
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: truncate(report.title, 150),
        emoji: false,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Type*: ${report.report_type} | *${goalLabel}*`,
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        // Slack mrkdwn max text block is 3000 chars
        text: truncate(report.content, 2900),
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `_Generated at ${report.generated_at}_`,
      },
    },
  ];

  return { blocks, text: fallbackText };
}

// ─── Webhook formatting ───

function formatReportForWebhook(report: Report): Record<string, unknown> {
  return {
    id: report.id,
    report_type: report.report_type,
    goal_id: report.goal_id,
    title: report.title,
    content: report.content,
    verbosity: report.verbosity,
    generated_at: report.generated_at,
  };
}

// ─── Individual notifiers ───

async function sendSlack(
  channel: SlackChannel,
  report: Report
): Promise<NotificationResult> {
  const payload = formatReportForSlack(report, channel.format);
  try {
    const response = await httpPost(channel.webhook_url, payload as unknown as Record<string, unknown>);
    if (response.statusCode === 200) {
      return {
        channel_type: "slack",
        success: true,
        delivered_at: new Date().toISOString(),
        suppressed: false,
      };
    }
    return {
      channel_type: "slack",
      success: false,
      error: `Slack webhook returned HTTP ${response.statusCode}: ${truncate(response.body, 200)}`,
      suppressed: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      channel_type: "slack",
      success: false,
      error: `Slack webhook error: ${message}`,
      suppressed: false,
    };
  }
}

/** Build a simple HTML body for a report. */
function buildEmailHtml(report: Report): string {
  const rows = [
    ["ID", escapeHtml(report.id)],
    ["Type", escapeHtml(report.report_type)],
    ["Goal", escapeHtml(report.goal_id ?? "(none)")],
    ["Generated", escapeHtml(report.generated_at)],
  ]
    .map(
      ([k, v]) =>
        `<tr><th style="text-align:left;padding:4px 8px;background:#f5f5f5">${k}</th>` +
        `<td style="padding:4px 8px">${v}</td></tr>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;color:#333">
<h2>${escapeHtml(report.title)}</h2>
<table border="0" cellpadding="0" cellspacing="4" style="border-collapse:collapse">
${rows}
</table>
<hr>
<pre style="white-space:pre-wrap;background:#fafafa;padding:12px;border-radius:4px">${escapeHtml(report.content)}</pre>
</body>
</html>`;
}

async function sendEmail(
  channel: EmailChannel,
  report: Report
): Promise<NotificationResult> {
  try {
    const transport = nodemailer.createTransport({
      host: channel.smtp.host,
      port: channel.smtp.port,
      secure: channel.smtp.secure,
      auth: {
        user: channel.smtp.auth.user,
        pass: channel.smtp.auth.pass,
      },
    });

    await transport.sendMail({
      from: channel.smtp.auth.user,
      to: channel.address,
      subject: report.title,
      text: `${report.title}\n\n${report.content}`,
      html: buildEmailHtml(report),
    });

    return {
      channel_type: "email",
      success: true,
      delivered_at: new Date().toISOString(),
      suppressed: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      channel_type: "email",
      success: false,
      error: `Email send error: ${message}`,
      suppressed: false,
    };
  }
}

async function sendWebhook(
  channel: WebhookChannel,
  report: Report
): Promise<NotificationResult> {
  const payload = formatReportForWebhook(report);
  try {
    const response = await httpPost(channel.url, payload, channel.headers);
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return {
        channel_type: "webhook",
        success: true,
        delivered_at: new Date().toISOString(),
        suppressed: false,
      };
    }
    return {
      channel_type: "webhook",
      success: false,
      error: `Webhook returned HTTP ${response.statusCode}: ${truncate(response.body, 200)}`,
      suppressed: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      channel_type: "webhook",
      success: false,
      error: `Webhook error: ${message}`,
      suppressed: false,
    };
  }
}

// ─── Report type → NotificationEventType mapping ───

/**
 * Map an internal report_type string to the closest NotificationEventType
 * for routing to INotifier plugins. Returns null when no mapping applies.
 */
function reportTypeToEventType(reportType: string): NotificationEventType | null {
  switch (reportType) {
    case "goal_completion":
      return "goal_complete";
    case "urgent_alert":
      return "approval_needed";
    case "stall_escalation":
      return "stall_detected";
    case "strategy_change":
      return "goal_progress";
    case "capability_escalation":
      return "task_blocked";
    case "progress_update":
      return "goal_progress";
    default:
      return null;
  }
}

// ─── NotificationDispatcher ───

export class NotificationDispatcher implements INotificationDispatcher {
  private config: NotificationConfig;
  /** reportType -> timestamp of last successful send */
  private lastSent: Map<string, number> = new Map();
  private notifierRegistry?: NotifierRegistry;

  constructor(config?: Partial<NotificationConfig>, notifierRegistry?: NotifierRegistry) {
    this.config = NotificationConfigSchema.parse(config ?? {});
    this.notifierRegistry = notifierRegistry;
  }

  /** Replace or set the NotifierRegistry after construction. */
  setNotifierRegistry(registry: NotifierRegistry): void {
    this.notifierRegistry = registry;
  }

  /** Dispatch report to all configured channels */
  async dispatch(report: Report): Promise<NotificationResult[]> {
    const results: NotificationResult[] = [];

    const channels = this.getChannelsForReport(report);

    for (const channel of channels) {
      // Check DND
      if (this.isDND(report.report_type)) {
        results.push({
          channel_type: channel.type,
          success: false,
          suppressed: true,
          suppression_reason: "dnd",
        });
        continue;
      }

      // Check cooldown
      if (this.isCooldown(report.report_type)) {
        results.push({
          channel_type: channel.type,
          success: false,
          suppressed: true,
          suppression_reason: "cooldown",
        });
        continue;
      }

      // Check if this channel accepts this report type
      if (!this.channelAcceptsReportType(channel, report.report_type)) {
        results.push({
          channel_type: channel.type,
          success: false,
          suppressed: true,
          suppression_reason: "filtered",
        });
        continue;
      }

      // Send
      const result = await this.sendToChannel(channel, report);
      results.push(result);

      if (result.success) {
        this.lastSent.set(report.report_type, Date.now());
      }
    }

    // Route to NotifierRegistry plugins (additive, failures don't affect core dispatch)
    await this.dispatchToPluginNotifiers(report);

    return results;
  }

  /**
   * Route the report to all matching INotifier plugins registered in the
   * NotifierRegistry. Plugin failures are logged but never propagated.
   */
  private async dispatchToPluginNotifiers(report: Report): Promise<void> {
    if (!this.notifierRegistry) return;

    const eventType = reportTypeToEventType(report.report_type);
    if (eventType === null) return;

    const notifiers = this.notifierRegistry.findForEvent(eventType);
    if (notifiers.length === 0) return;

    const event: NotificationEvent = {
      type: eventType,
      goal_id: report.goal_id ?? "",
      timestamp: report.generated_at,
      summary: report.title,
      details: {
        report_id: report.id,
        report_type: report.report_type,
        content: report.content,
        verbosity: report.verbosity,
      },
      severity: this.resolveSeverity(report.report_type),
    };

    const settlements = await Promise.allSettled(
      notifiers.map((n) => n.notify(event))
    );

    for (let i = 0; i < settlements.length; i++) {
      const result = settlements[i];
      if (result.status === "rejected") {
        const notifierName = notifiers[i].name;
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.error(`[NotificationDispatcher] plugin notifier "${notifierName}" failed: ${reason}`);
      }
    }
  }

  /** Derive a severity level from the report type. */
  private resolveSeverity(reportType: string): "info" | "warning" | "critical" {
    if (reportType === "urgent_alert") return "critical";
    if (reportType === "stall_escalation" || reportType === "capability_escalation") return "warning";
    return "info";
  }

  // ─── Private helpers ───

  /**
   * Return the channels applicable to this report. Per-goal overrides take
   * priority over the global channel list.
   */
  private getChannelsForReport(report: Report): NotificationChannel[] {
    if (report.goal_id) {
      const override = this.config.goal_overrides.find(
        (o) => o.goal_id === report.goal_id
      );
      if (override?.channels && override.channels.length > 0) {
        return override.channels;
      }
    }
    return this.config.channels;
  }

  /**
   * Return the cooldown minutes for a report type, applying per-goal overrides
   * when present (we use global cooldown here since no report context; callers
   * that need per-goal cooldown should subclass or extend).
   */
  private getCooldownMinutes(reportType: string): number {
    const cooldown = this.config.cooldown as Record<string, number>;
    return cooldown[reportType] ?? 0;
  }

  /** Check if currently in DND hours for the given report type. */
  private isDND(reportType: string): boolean {
    const dnd = this.config.do_not_disturb;
    if (!dnd.enabled) return false;

    // Exceptions bypass DND (urgent_alert, approval_request by default)
    if (dnd.exceptions.includes(reportType)) return false;

    const now = new Date();
    const hour = now.getHours();

    // Handle overnight DND (e.g., 22:00–07:00)
    if (dnd.start_hour > dnd.end_hour) {
      return hour >= dnd.start_hour || hour < dnd.end_hour;
    }
    return hour >= dnd.start_hour && hour < dnd.end_hour;
  }

  /** Check cooldown: true if we should suppress due to recent send. */
  private isCooldown(reportType: string): boolean {
    const cooldownMinutes = this.getCooldownMinutes(reportType);
    if (cooldownMinutes <= 0) return false;

    const lastSent = this.lastSent.get(reportType);
    if (lastSent === undefined) return false;

    const elapsedMs = Date.now() - lastSent;
    return elapsedMs < cooldownMinutes * 60 * 1000;
  }

  /**
   * Return true if the channel should receive this report type.
   * An empty report_types array means "accept all."
   */
  private channelAcceptsReportType(
    channel: NotificationChannel,
    reportType: string
  ): boolean {
    if (channel.report_types.length === 0) return true;
    return channel.report_types.includes(reportType);
  }

  /** Dispatch to the correct sender based on channel type. */
  private async sendToChannel(
    channel: NotificationChannel,
    report: Report
  ): Promise<NotificationResult> {
    switch (channel.type) {
      case "slack":
        return sendSlack(channel as SlackChannel, report);
      case "email":
        return sendEmail(channel as EmailChannel, report);
      case "webhook":
        return sendWebhook(channel as WebhookChannel, report);
    }
  }
}
