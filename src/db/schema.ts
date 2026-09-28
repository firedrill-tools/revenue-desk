// SQLite schema (docs/ARCHITECTURE.md §8). One database per state directory:
// <AGENT_STATE_DIR>/revenue-desk.sqlite, shared by the server and the CLI.
//
// Conventions: ids are randomUUID() except messages (UIMessage ids); times are
// ISO-8601 UTC text; business money is integer minor units plus currency;
// model cost is USD as REAL; JSON columns hold JSON text. No secret is ever
// stored: inputs are redacted and outputs compacted before they are written.
//
// Migrations are generated from this file by `pnpm db:generate` into
// src/db/migrations and committed. Never edit a generated migration.

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { ChatMessageMetadata, ChatUIMessage } from "../contracts/api.js";
import type { AgentEffort, EnvVarName } from "../contracts/env.js";
import type {
  ApprovalDescriptor,
  RunConnection,
  RunErrorCode,
  SdkTerminalReason,
} from "../contracts/events.js";
import type {
  ActionClass,
  ApprovalMode,
  ConnectionKind,
  ConnectionState,
  IntegrationId,
  OperationName,
  PolicyModes,
  ProfileId,
} from "../contracts/integration.js";
import type { JsonObject, JsonValue } from "../contracts/json.js";

// Enum values, repeated here as literals so drizzle-kit can load this file
// without resolving TypeScript imports. test/unit/db-schema.test.ts checks
// that each list equals its contract.
const INTEGRATION = [
  "gmail",
  "google_calendar",
  "hubspot",
  "stripe",
  "quickbooks",
  "slack",
] as const satisfies readonly IntegrationId[];
const CONNECTION_KIND = ["composio", "mcp", "api"] as const satisfies readonly ConnectionKind[];
const PROFILE = [
  "composio",
  "hubspot-mcp-0.4",
  "stripe-api",
  "quickbooks-api",
  "slack-api",
] as const satisfies readonly ProfileId[];
const ACTION_CLASS = [
  "read",
  "internal_write",
  "outbound",
  "financial",
  "destructive",
] as const satisfies readonly ActionClass[];
const APPROVAL_MODE = ["auto", "ask", "deny"] as const satisfies readonly ApprovalMode[];
const CONNECTION_STATE = [
  "connected",
  "needs_auth",
  "expired",
  "not_configured",
  "invalid",
  "error",
  "unknown",
] as const satisfies readonly ConnectionState[];
const EFFORT = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly AgentEffort[];
export const DB_ENUMS = {
  integration: INTEGRATION,
  connectionKind: CONNECTION_KIND,
  profile: PROFILE,
  actionClass: ACTION_CLASS,
  approvalMode: APPROVAL_MODE,
  connectionState: CONNECTION_STATE,
  effort: EFFORT,
  source: ["ui", "cli"],
  mode: ["interactive", "headless"],
  conversationStatus: ["idle", "running", "awaiting_approval", "error"],
  runStatus: ["running", "completed", "failed", "cancelled", "timed_out"],
  runErrorCode: [
    "config_missing",
    "model_error",
    "max_turns",
    "budget_exceeded",
    "timeout",
    "cancelled",
    "server_restart",
    "internal",
  ],
  messageRole: ["user", "assistant"],
  toolCallStatus: ["awaiting_approval", "running", "succeeded", "failed", "denied", "interrupted"],
  toolDecision: [
    "pending",
    "auto",
    "approved",
    "denied",
    "policy_denied",
    "timed_out",
    "stopped",
    "rejected",
  ],
  approvalStatus: ["pending", "approved", "denied", "expired", "cancelled"],
  approvalDecidedBy: ["user", "timeout", "stop", "restart"],
} as const satisfies { readonly [key: string]: readonly string[] };

/** `col IN ('a','b')` for a CHECK constraint. Values are fixed literals, never input. */
function oneOf(column: string, values: readonly string[]) {
  return sql.raw(`${column} IN (${values.map((value) => `'${value}'`).join(", ")})`);
}

const createdAt = () => text("created_at").notNull();
const updatedAt = () => text("updated_at").notNull();

// ---------------------------------------------------------------------------
// Workspace settings (singleton) and policies
// ---------------------------------------------------------------------------

export const workspaceSettings = sqliteTable(
  "workspace_settings",
  {
    id: integer("id").primaryKey().default(1),
    companyName: text("company_name").notNull().default(""),
    agentName: text("agent_name").notNull().default("Revenue Desk"),
    senderName: text("sender_name").notNull().default(""),
    emailSignature: text("email_signature").notNull().default(""),
    internalEmailDomains: text("internal_email_domains", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    notifySlackChannel: text("notify_slack_channel"),
    allowedSlackChannels: text("allowed_slack_channels", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    internalCalendarIds: text("internal_calendar_ids", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    timezone: text("timezone").notNull().default("UTC"),
    currency: text("currency").notNull().default("USD"),
    defaultModel: text("default_model"),
    defaultEffort: text("default_effort", { enum: EFFORT }),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("workspace_settings_singleton", sql`${t.id} = 1`),
    check(
      "workspace_settings_effort",
      sql`${t.defaultEffort} IS NULL OR ${oneOf("default_effort", EFFORT)}`,
    ),
  ],
);

export const policies = sqliteTable(
  "policies",
  {
    actionClass: text("action_class", { enum: ACTION_CLASS }).primaryKey(),
    mode: text("mode", { enum: APPROVAL_MODE }).notNull(),
    updatedAt: updatedAt(),
  },
  () => [
    check("policies_action_class", oneOf("action_class", ACTION_CLASS)),
    check("policies_mode", oneOf("mode", APPROVAL_MODE)),
  ],
);

// ---------------------------------------------------------------------------
// Connections: the last known status of each integration (from probes)
// ---------------------------------------------------------------------------

export const connections = sqliteTable(
  "connections",
  {
    integration: text("integration", { enum: INTEGRATION }).primaryKey(),
    kind: text("kind", { enum: CONNECTION_KIND }).notNull(),
    profile: text("profile", { enum: PROFILE }).notNull(),
    status: text("status", { enum: CONNECTION_STATE }).notNull().default("unknown"),
    statusDetail: text("status_detail").notNull().default(""),
    /** Host only. */
    endpointLabel: text("endpoint_label"),
    /** Masked, e.g. "ca_…c6M". */
    accountHint: text("account_hint"),
    missingVars: text("missing_vars", { mode: "json" })
      .$type<EnvVarName[]>()
      .notNull()
      .default(sql`'[]'`),
    lastCheckedAt: text("last_checked_at"),
    updatedAt: updatedAt(),
  },
  () => [
    check("connections_integration", oneOf("integration", INTEGRATION)),
    check("connections_kind", oneOf("kind", CONNECTION_KIND)),
    check("connections_status", oneOf("status", CONNECTION_STATE)),
  ],
);

// ---------------------------------------------------------------------------
// Conversations, runs and messages
// ---------------------------------------------------------------------------

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull().default(""),
    source: text("source", { enum: DB_ENUMS.source }).notNull(),
    status: text("status", { enum: DB_ENUMS.conversationStatus }).notNull().default("idle"),
    /** The Agent SDK session to resume on the next turn. */
    sdkSessionId: text("sdk_session_id"),
    totalCostUsd: real("total_cost_usd").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    archivedAt: text("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("conversations_list_idx").on(t.archivedAt, t.updatedAt),
    check("conversations_source", oneOf("source", DB_ENUMS.source)),
    check("conversations_status", oneOf("status", DB_ENUMS.conversationStatus)),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    source: text("source", { enum: DB_ENUMS.source }).notNull(),
    mode: text("mode", { enum: DB_ENUMS.mode }).notNull(),
    status: text("status", { enum: DB_ENUMS.runStatus }).notNull().default("running"),
    stopReason: text("stop_reason"),
    terminalReason: text("terminal_reason").$type<SdkTerminalReason>(),
    model: text("model").notNull(),
    effort: text("effort", { enum: EFFORT }).notNull(),
    userMessageId: text("user_message_id"),
    assistantMessageId: text("assistant_message_id"),
    numTurns: integer("num_turns"),
    modelRequests: integer("model_requests"),
    costUsd: real("cost_usd"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheCreationTokens: integer("cache_creation_tokens"),
    durationMs: integer("duration_ms"),
    durationApiMs: integer("duration_api_ms"),
    errorCode: text("error_code", { enum: DB_ENUMS.runErrorCode }).$type<RunErrorCode>(),
    errorMessage: text("error_message"),
    policySnapshot: text("policy_snapshot", { mode: "json" }).$type<PolicyModes>().notNull(),
    /** Integration, kind, profile, availability and endpoint host: never secrets. */
    connectionsSnapshot: text("connections_snapshot", { mode: "json" })
      .$type<RunConnection[]>()
      .notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    /**
     * The process that runs it (the server or a CLI invocation): its pid and
     * when that process started, so a reused pid is not mistaken for it.
     * Null only for rows written before migration 0002. A running run whose
     * owner is gone is recovered (src/db/recover.ts).
     */
    ownerPid: integer("owner_pid"),
    ownerStartedAt: text("owner_started_at"),
    /**
     * The Agent SDK session the run used. A resumed session reports running
     * totals, so a run's usage is the session's totals minus the usage its
     * earlier runs recorded (src/db/usage-baseline.ts).
     */
    sdkSessionId: text("sdk_session_id"),
  },
  (t) => [
    index("runs_conversation_idx").on(t.conversationId, t.startedAt),
    // One active run per conversation, whichever process (server or CLI) starts it.
    uniqueIndex("runs_one_running_per_conversation")
      .on(t.conversationId)
      .where(sql`${t.status} = 'running'`),
    index("runs_status_idx").on(t.status),
    index("runs_started_idx").on(t.startedAt),
    check("runs_source", oneOf("source", DB_ENUMS.source)),
    check("runs_mode", oneOf("mode", DB_ENUMS.mode)),
    check("runs_status", oneOf("status", DB_ENUMS.runStatus)),
    check("runs_effort", oneOf("effort", EFFORT)),
    check(
      "runs_error_code",
      sql`${t.errorCode} IS NULL OR ${oneOf("error_code", DB_ENUMS.runErrorCode)}`,
    ),
    check("runs_finished", sql`(${t.status} = 'running') = (${t.finishedAt} IS NULL)`),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    /** The UIMessage id. */
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    role: text("role", { enum: DB_ENUMS.messageRole }).notNull(),
    /** Exactly the rendered UIMessage parts (transient data parts excluded). */
    partsJson: text("parts_json", { mode: "json" }).$type<ChatUIMessage["parts"]>().notNull(),
    metadataJson: text("metadata_json", { mode: "json" }).$type<ChatMessageMetadata>(),
    /** Plain text of the text parts, for search. */
    text: text("text").notNull().default(""),
    /** Order within the conversation, from 0. */
    seq: integer("seq").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("messages_conversation_seq_idx").on(t.conversationId, t.seq),
    index("messages_run_idx").on(t.runId),
    check("messages_role", oneOf("role", DB_ENUMS.messageRole)),
  ],
);

// ---------------------------------------------------------------------------
// The action log: one row per tool call, and one per approval
// ---------------------------------------------------------------------------

export const toolCalls = sqliteTable(
  "tool_calls",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** The model's tool_use id; unique within its run (the idempotency key is per run too). */
    toolUseId: text("tool_use_id").notNull(),
    /** Null only for a rejected unknown tool. */
    integration: text("integration", { enum: INTEGRATION }),
    connectionKind: text("connection_kind", { enum: CONNECTION_KIND }),
    /** As the model saw it, e.g. mcp__stripe__create_refund. */
    toolName: text("tool_name").notNull(),
    /** A Composio slug, an MCP tool name or "POST /v1/refunds". */
    upstreamTool: text("upstream_tool"),
    operation: text("operation").$type<OperationName>(),
    actionClass: text("action_class", { enum: ACTION_CLASS }),
    title: text("title").notNull(),
    status: text("status", { enum: DB_ENUMS.toolCallStatus }).notNull(),
    decision: text("decision", { enum: DB_ENUMS.toolDecision }).notNull().default("pending"),
    /** Redacted. */
    inputJson: text("input_json", { mode: "json" }).$type<JsonObject>().notNull(),
    /** Compacted; null until the call finishes. */
    outputJson: text("output_json", { mode: "json" }).$type<JsonValue>(),
    truncated: integer("truncated", { mode: "boolean" }).notNull().default(false),
    isError: integer("is_error", { mode: "boolean" }).notNull().default(false),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    httpStatus: integer("http_status"),
    idempotencyKey: text("idempotency_key"),
    /** Set when the call asked for approval (no foreign key: see §8). */
    approvalId: text("approval_id"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    durationMs: integer("duration_ms"),
  },
  (t) => [
    uniqueIndex("tool_calls_run_tool_use_idx").on(t.runId, t.toolUseId),
    index("tool_calls_run_idx").on(t.runId, t.startedAt),
    index("tool_calls_integration_idx").on(t.integration),
    check(
      "tool_calls_integration",
      sql`${t.integration} IS NULL OR ${oneOf("integration", INTEGRATION)}`,
    ),
    check(
      "tool_calls_kind",
      sql`${t.connectionKind} IS NULL OR ${oneOf("connection_kind", CONNECTION_KIND)}`,
    ),
    check(
      "tool_calls_action_class",
      sql`${t.actionClass} IS NULL OR ${oneOf("action_class", ACTION_CLASS)}`,
    ),
    check("tool_calls_status", oneOf("status", DB_ENUMS.toolCallStatus)),
    check("tool_calls_decision", oneOf("decision", DB_ENUMS.toolDecision)),
    check(
      "tool_calls_known_tool",
      sql`${t.decision} = 'rejected' OR ${t.decision} = 'pending' OR ${t.integration} IS NOT NULL`,
    ),
  ],
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** The model's tool_use id. No foreign key: the gate may write this row first. */
    toolUseId: text("tool_use_id").notNull(),
    integration: text("integration", { enum: INTEGRATION }).notNull(),
    actionClass: text("action_class", { enum: ACTION_CLASS }).notNull(),
    operation: text("operation").$type<OperationName>().notNull(),
    consequence: text("consequence").notNull(),
    descriptorJson: text("descriptor_json", { mode: "json" }).$type<ApprovalDescriptor>().notNull(),
    status: text("status", { enum: DB_ENUMS.approvalStatus }).notNull().default("pending"),
    decidedBy: text("decided_by", { enum: DB_ENUMS.approvalDecidedBy }),
    reason: text("reason"),
    requestedAt: text("requested_at").notNull(),
    decidedAt: text("decided_at"),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [
    uniqueIndex("approvals_run_tool_use_idx").on(t.runId, t.toolUseId),
    index("approvals_status_idx").on(t.status, t.expiresAt),
    index("approvals_run_idx").on(t.runId),
    check("approvals_integration", oneOf("integration", INTEGRATION)),
    check("approvals_action_class", oneOf("action_class", ACTION_CLASS)),
    check("approvals_status", oneOf("status", DB_ENUMS.approvalStatus)),
    check(
      "approvals_decided_by",
      sql`${t.decidedBy} IS NULL OR ${oneOf("decided_by", DB_ENUMS.approvalDecidedBy)}`,
    ),
    check(
      "approvals_decided",
      sql`(${t.status} = 'pending') = (${t.decidedAt} IS NULL AND ${t.decidedBy} IS NULL)`,
    ),
  ],
);

export type ChatMessageRow = typeof messages.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type ToolCallRow = typeof toolCalls.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type ConnectionRow = typeof connections.$inferSelect;
export type PolicyRow = typeof policies.$inferSelect;
export type WorkspaceSettingsRow = typeof workspaceSettings.$inferSelect;
