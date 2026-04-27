import { z } from "zod";
import type { Capability } from "../../../base/types/capability.js";

export interface CapabilityAcquisitionRecommendation {
  pluginName: string;
  installSource: string;
  rationale: string;
  verificationHint: string;
  requiresApproval: boolean;
}

export const DeficiencyResponseSchema = z.union([
  z.object({
    has_deficiency: z.literal(false),
  }),
  z.object({
    has_deficiency: z.literal(true),
    missing_capability: z.object({
      name: z.string(),
      type: z.enum(["tool", "permission", "service"]),
    }),
    reason: z.string(),
    alternatives: z.array(z.string()),
    impact_description: z.string(),
  }),
]);

export const GoalCapabilityGapResponseSchema = z.union([
  z.object({
    has_gap: z.literal(false),
  }),
  z.object({
    has_gap: z.literal(true),
    missing_capability: z.object({
      name: z.string(),
      type: z.enum(["tool", "permission", "service", "data_source"]),
    }),
    reason: z.string(),
    alternatives: z.array(z.string()),
    impact_description: z.string(),
    acquirable: z.boolean(),
  }),
]);

export const VerificationResponseSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  reason: z.string(),
});

export const ACQUISITION_RECOMMENDATION_RULES: Array<{
  pluginName: string;
  installSource: string;
  capabilityTypes: Capability["type"][];
  patterns: RegExp[];
  rationale: string;
  verificationHint: string;
  requiresApproval: boolean;
}> = [
  {
    pluginName: "postgres-datasource",
    installSource: "examples/plugins/postgres-datasource",
    capabilityTypes: ["data_source", "service"],
    patterns: [/\bpostgres\b/i, /\bpostgresql\b/i, /\banalytics_db\b/i, /\bdatabase\b/i, /\bsql\b/i],
    rationale: "Use the first-party Postgres datasource plugin for structured SQL observation.",
    verificationHint: "Load the plugin, configure a DSN, and confirm datasource health checks succeed.",
    requiresApproval: false,
  },
  {
    pluginName: "mysql-datasource",
    installSource: "examples/plugins/mysql-datasource",
    capabilityTypes: ["data_source", "service"],
    patterns: [/\bmysql\b/i],
    rationale: "Use the first-party MySQL datasource plugin when the gap targets MySQL-backed data.",
    verificationHint: "Load the plugin, configure the database, and confirm datasource connectivity.",
    requiresApproval: false,
  },
  {
    pluginName: "jira-datasource",
    installSource: "examples/plugins/jira-datasource",
    capabilityTypes: ["service", "data_source"],
    patterns: [/\bjira\b/i],
    rationale: "Use the first-party Jira datasource plugin instead of bespoke API glue.",
    verificationHint: "Load the plugin, configure Jira credentials, and verify plugin/API health.",
    requiresApproval: false,
  },
  {
    pluginName: "websocket-datasource",
    installSource: "examples/plugins/websocket-datasource",
    capabilityTypes: ["service", "data_source"],
    patterns: [/\bwebsocket\b/i, /\bws\b/i],
    rationale: "Use the first-party WebSocket datasource plugin for realtime observation.",
    verificationHint: "Load the plugin, connect to the event stream, and confirm health checks pass.",
    requiresApproval: false,
  },
];
