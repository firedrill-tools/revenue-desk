// HTTP API contract between the server (W3) and the web client (W4)
// (docs/ARCHITECTURE.md §6, §7, §9). Every route lives under /api on
// 127.0.0.1:PORT. Bodies are JSON unless the response is a UI message stream.
//
// Frozen for the parallel workstreams. Change it only through the lead.
//
// Shared by server, CLI and web: no Node-only globals, no implementation imports.

import type { UIMessage } from "ai";
import type { AgentEffort } from "./env.js";
import type {
  AgentMode,
  ApprovalDecider,
  ApprovalDescriptor,
  RunConnection,
  RunError,
  RunSource,
  RunStatus,
  RunUsage,
  SdkTerminalReason,
  StatusData,
  ToolDecision,
} from "./events.js";
import type {
  ActionClass,
  ApprovalMode,
  ConnectionKind,
  ConnectionStatus,
  IntegrationId,
  OperationName,
  ToolFailure,
  WorkspaceSettings,
} from "./integration.js";
import type { JsonObject, JsonValue } from "./json.js";

// ---------------------------------------------------------------------------
// Chat messages (AI SDK v7 UIMessage with Revenue Desk's metadata and data parts)
// ---------------------------------------------------------------------------

/** Message metadata: `start` sets runId/model/effort; `finish` merges status and usage. */
export type ChatMessageMetadata = {
  readonly runId: string;
  readonly model: string;
  readonly effort?: AgentEffort;
  readonly status?: RunStatus;
  readonly usage?: RunUsage;
};

/** Transient data part: a tool's live elapsed time. */
export type ToolProgressData = { readonly toolCallId: string; readonly elapsedMs: number };

/** Persisted data part, e.g. an integration that is unavailable for this run. */
export type NoticeData = {
  readonly level: "info" | "warning";
  readonly code: "connection_unavailable";
  readonly integration: IntegrationId;
  readonly message: string;
};

/**
 * Data parts, written as `data-<key>` chunks. status and progress are
 * transient (never stored in the message); usage and notice are persisted.
 */
export type ChatDataParts = {
  status: StatusData;
  progress: ToolProgressData;
  usage: RunUsage;
  notice: NoticeData;
};

export type ChatUIMessage = UIMessage<ChatMessageMetadata, ChatDataParts>;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const API_PATHS = {
  health: "/api/health",
  session: "/api/session",
  chat: "/api/chat",
  /** useChat({resume:true}) reconnects here: replay from the assistant message start, then live. */
  chatStream: "/api/chat/:conversationId/stream",
  conversations: "/api/conversations",
  conversation: "/api/conversations/:conversationId",
  runs: "/api/runs",
  run: "/api/runs/:runId",
  runStop: "/api/runs/:runId/stop",
  approval: "/api/approvals/:approvalId",
  connections: "/api/connections",
  connectionCheck: "/api/connections/:integration/check",
  connectionConnect: "/api/connections/:integration/connect",
  settings: "/api/settings",
  policies: "/api/policies",
} as const;

/** Mutating routes (POST, PATCH) require all three; see docs/ARCHITECTURE.md §7. */
export const CSRF_HEADER = "x-rd-csrf";
/** Per-boot, HttpOnly, SameSite=Strict, Path=/api. Set by GET /api/session. */
export const SESSION_COOKIE = "rd_session";
/** Header on UI message stream responses (set by createUIMessageStreamResponse). */
export const UI_MESSAGE_STREAM_HEADER = "x-vercel-ai-ui-message-stream";

/** At most this many runs at once; one active run per conversation. */
export const MAX_CONCURRENT_RUNS = 4;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const API_ERROR_STATUS = {
  invalid_request: 400,
  forbidden_origin: 403,
  csrf_failed: 403,
  not_found: 404,
  /** The approval was already decided (or expired, or cancelled). */
  already_decided: 409,
  /** The conversation already has an active run. */
  run_active: 409,
  /** Stop for a run that is not running. */
  run_not_active: 409,
  /** The class is set by AGENT_POLICY and cannot be changed in the app. */
  policy_locked: 409,
  /** Connect on an integration that is not Composio, or not configured. */
  not_supported: 409,
  unsupported_media_type: 415,
  too_many_runs: 429,
  /** An integration answered with an error during Check or Connect. */
  upstream_error: 502,
  internal: 500,
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;

export type ApiIssue = { readonly path: string; readonly message: string };

/** Every non-2xx JSON response. Messages are plain, redacted and safe to show. */
export type ApiErrorBody = {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly issues?: readonly ApiIssue[];
  };
};

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export type Page<T> = { readonly items: readonly T[]; readonly nextCursor: string | null };
export type PageQuery = { readonly cursor?: string; readonly limit?: number };

export type ConversationStatus = "idle" | "running" | "awaiting_approval" | "error";

export type ConversationSummary = {
  readonly id: string;
  readonly title: string;
  readonly source: RunSource;
  readonly status: ConversationStatus;
  readonly activeRunId: string | null;
  readonly pendingApprovals: number;
  readonly totalCostUsd: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
};

export type ToolCallStatus =
  | "awaiting_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "denied"
  /** The run ended (stop or restart) while the call was in flight. */
  | "interrupted";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export type ApprovalView = {
  readonly id: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly toolCallId: string;
  readonly integration: IntegrationId;
  readonly actionClass: ActionClass;
  readonly operation: OperationName;
  readonly consequence: string;
  readonly descriptor: ApprovalDescriptor;
  readonly status: ApprovalStatus;
  /** null while pending; "restart" when boot recovery expired it. */
  readonly decidedBy: ApprovalDecider | "restart" | null;
  readonly reason: string | null;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly expiresAt: string;
};

export type ToolCallView = {
  readonly id: string;
  /** The model's tool_use id. */
  readonly toolCallId: string;
  readonly runId: string;
  /** Null only for a rejected unknown tool. */
  readonly integration: IntegrationId | null;
  readonly connectionKind: ConnectionKind | null;
  /** As the model saw it. */
  readonly toolName: string;
  readonly upstreamTool: string | null;
  readonly operation: OperationName | null;
  readonly actionClass: ActionClass | null;
  readonly title: string;
  readonly status: ToolCallStatus;
  readonly decision: ToolDecision;
  /** Redacted. */
  readonly input: JsonObject;
  /** Compacted; null until the call finishes. */
  readonly output: JsonValue | null;
  readonly isError: boolean;
  readonly error: ToolFailure | null;
  readonly httpStatus: number | null;
  readonly idempotencyKey: string | null;
  readonly approvalId: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
};

export type RunSummaryView = {
  readonly id: string;
  readonly conversationId: string;
  readonly source: RunSource;
  readonly mode: AgentMode;
  readonly status: RunStatus;
  readonly model: string;
  readonly effort: AgentEffort;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly usage: RunUsage | null;
  readonly toolCallsByKind: { readonly [K in ConnectionKind]: number };
  readonly approvals: {
    readonly pending: number;
    readonly approved: number;
    readonly denied: number;
  };
  readonly error: RunError | null;
};

export type RunDetailView = RunSummaryView & {
  readonly stopReason: string | null;
  readonly terminalReason: SdkTerminalReason | null;
  /** The effective policy the run used. */
  readonly policy: { readonly [C in ActionClass]: ApprovalMode };
  readonly connections: readonly RunConnection[];
  readonly toolCalls: readonly ToolCallView[];
  readonly approvals: readonly ApprovalView[];
};

export type ConnectionView = ConnectionStatus & {
  readonly label: string;
  /** True for Composio integrations that are configured but not connected. */
  readonly canConnect: boolean;
};

export type PolicyView = {
  readonly actionClass: ActionClass;
  readonly mode: ApprovalMode;
  readonly source: "default" | "saved" | "environment";
  /** Set by AGENT_POLICY; the app cannot change it. */
  readonly locked: boolean;
};

export type SessionInfo = {
  /** Echo in CSRF_HEADER on every mutating request. Never readable cross-origin. */
  readonly csrfToken: string;
  readonly version: string;
  /** "sandbox" only when started by pnpm dev:sandbox; the UI shows "Local sandbox". */
  readonly mode: "normal" | "sandbox";
  readonly model: string;
  readonly effort: AgentEffort;
  readonly businessDate: string;
  readonly approvalTimeoutMs: number;
};

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

/** POST /api/chat. The server owns history, so only the new user message is sent. */
export type ChatRequest = {
  readonly conversationId: string;
  readonly message: ChatUIMessage & { readonly role: "user" };
};

export type ApprovalDecisionRequest = {
  readonly approved: boolean;
  /** Up to 500 characters; shown to the model when denying. */
  readonly reason?: string;
};

export type ApprovalDecisionResponse = {
  readonly status: "accepted";
  readonly approvalId: string;
};

export type CreateConversationRequest = { readonly title?: string };
export type UpdateConversationRequest = { readonly title?: string; readonly archived?: boolean };
export type ConversationListQuery = PageQuery & {
  /** Matches title and message text. */
  readonly q?: string;
  readonly archived?: boolean;
};

export type ConversationDetail = {
  readonly conversation: ConversationSummary;
  readonly messages: readonly ChatUIMessage[];
  /** Pending approvals of the active run, so a reloaded page can still decide them. */
  readonly pendingApprovals: readonly ApprovalView[];
};

export type RunListQuery = PageQuery & {
  readonly conversationId?: string;
  readonly status?: RunStatus;
  readonly source?: RunSource;
};

export type StopRunResponse = { readonly runId: string; readonly status: "stopping" };

export type ConnectResponse = {
  /** Composio's hosted sign-in; the UI opens it in a new tab. */
  readonly redirectUrl: string;
};

export type SettingsUpdate = Partial<Omit<WorkspaceSettings, "updatedAt">>;
export type PoliciesUpdate = { readonly modes: { readonly [C in ActionClass]?: ApprovalMode } };

export type HealthResponse = {
  readonly status: "ok";
  readonly service: "revenue-desk";
  readonly version: string;
};

// ---------------------------------------------------------------------------
// Endpoint map
// ---------------------------------------------------------------------------

type None = Record<never, never>;

/** A UI message stream (SSE, UI_MESSAGE_STREAM_HEADER: v1, ends with [DONE]). */
export type UIMessageStreamBody = { readonly kind: "ui-message-stream" };

export type Endpoint<Params, Query, Body, Response> = {
  readonly params: Params;
  readonly query: Query;
  readonly body: Body;
  readonly response: Response;
};

/**
 * Every route, keyed "METHOD path". Status codes: 200 unless noted; errors
 * use ApiErrorBody with API_ERROR_STATUS.
 */
export type ApiEndpoints = {
  "GET /api/health": Endpoint<None, None, null, HealthResponse>;
  /** Sets SESSION_COOKIE; returns the matching csrfToken. */
  "GET /api/session": Endpoint<None, None, null, SessionInfo>;
  /** 404 unknown conversation; 409 run_active; 429 too_many_runs. */
  "POST /api/chat": Endpoint<None, None, ChatRequest, UIMessageStreamBody>;
  /** 204 with no body when the conversation has no active run. */
  "GET /api/chat/:conversationId/stream": Endpoint<
    { readonly conversationId: string },
    None,
    null,
    UIMessageStreamBody | null
  >;
  "GET /api/conversations": Endpoint<None, ConversationListQuery, null, Page<ConversationSummary>>;
  /** 201. */
  "POST /api/conversations": Endpoint<
    None,
    None,
    CreateConversationRequest,
    { readonly conversation: ConversationSummary }
  >;
  "GET /api/conversations/:conversationId": Endpoint<
    { readonly conversationId: string },
    None,
    null,
    ConversationDetail
  >;
  "PATCH /api/conversations/:conversationId": Endpoint<
    { readonly conversationId: string },
    None,
    UpdateConversationRequest,
    { readonly conversation: ConversationSummary }
  >;
  "GET /api/runs": Endpoint<None, RunListQuery, null, Page<RunSummaryView>>;
  "GET /api/runs/:runId": Endpoint<{ readonly runId: string }, None, null, RunDetailView>;
  /** 202. Interrupts the run and cancels its pending approvals; 409 run_not_active. */
  "POST /api/runs/:runId/stop": Endpoint<{ readonly runId: string }, None, None, StopRunResponse>;
  /** 404 unknown; 409 already_decided. */
  "POST /api/approvals/:approvalId": Endpoint<
    { readonly approvalId: string },
    None,
    ApprovalDecisionRequest,
    ApprovalDecisionResponse
  >;
  "GET /api/connections": Endpoint<None, None, null, { readonly items: readonly ConnectionView[] }>;
  /** Runs the read-only probe. */
  "POST /api/connections/:integration/check": Endpoint<
    { readonly integration: IntegrationId },
    None,
    None,
    { readonly connection: ConnectionView }
  >;
  /**
   * Composio only, on the user's click. The callback URL is derived by the
   * server from its own origin, never taken from the request.
   */
  "POST /api/connections/:integration/connect": Endpoint<
    { readonly integration: IntegrationId },
    None,
    None,
    ConnectResponse
  >;
  "GET /api/settings": Endpoint<None, None, null, { readonly settings: WorkspaceSettings }>;
  "PATCH /api/settings": Endpoint<
    None,
    None,
    SettingsUpdate,
    { readonly settings: WorkspaceSettings }
  >;
  "GET /api/policies": Endpoint<None, None, null, { readonly policies: readonly PolicyView[] }>;
  /** 409 policy_locked when a class is set by AGENT_POLICY. */
  "PATCH /api/policies": Endpoint<
    None,
    None,
    PoliciesUpdate,
    { readonly policies: readonly PolicyView[] }
  >;
};

export type ApiRoute = keyof ApiEndpoints;
