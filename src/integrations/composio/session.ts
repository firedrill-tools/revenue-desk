import { format } from "node:util";
import { Composio, type ComposioLogger, type ToolRouterCreateSessionConfig } from "@composio/core";
import { checkVendorUrl } from "../shared/url.js";
import { COMPOSIO_API_ORIGIN } from "../shared/vendors.js";

// ---------------------------------------------------------------------------
// Composio session for Gmail, Google Calendar, QuickBooks and Slack.
//
// This module is the only place Revenue Desk talks to Composio. It creates a
// Composio session for one configured user with:
//   - toolkits restricted to gmail, googlecalendar, quickbooks and slack,
//   - per-toolkit tool allowlists (below) so only the named operations exist,
//   - sessionPreset 'direct_tools', so the session's hosted MCP server lists
//     the real operations (GMAIL_FETCH_EMAILS, QUICKBOOKS_CREATE_INVOICE, ...)
//     instead of router meta-tools,
//   - no Composio code sandbox or workbench, no in-chat connection management,
//   - mcp: true, so the session carries its hosted MCP endpoint.
// It also reports per-toolkit connection state and can produce a Connect link.
//
// It never executes a Composio tool. Tool calls travel over the session's MCP
// endpoint through the gateway, where the approval policy applies.
//
// The Composio API host is pinned (COMPOSIO_API_ORIGIN): the client is
// always given it, so neither the SDK's own base-URL environment variable
// nor the Composio CLI's user config file can redirect it (the variable is
// named in docs/ARCHITECTURE.md §3). As defence in depth,
// the session MCP endpoint and every Connect sign-in link Composio returns
// must be HTTPS on a public host: one on this machine (loopback,
// *.localhost) or a private network is refused before anything connects to
// it or shows it.
//
// Secrets: the API key and the session MCP headers (which carry the key) are
// never logged. Use describeEndpoint() for anything that is printed or stored.
// ---------------------------------------------------------------------------

export const COMPOSIO_TOOLKITS = ["gmail", "googlecalendar", "quickbooks", "slack"] as const;
export type ComposioToolkit = (typeof COMPOSIO_TOOLKITS)[number];

/**
 * How far a tool reaches beyond the signed-in user's own account.
 * - read: no side effects.
 * - draft: internal writes (the user's own mailbox: drafts and labels; a
 *   QuickBooks customer; a Slack reaction).
 * - outbound: can reach other people or move money (sending mail, calendar
 *   events that can carry attendees, Slack posts, QuickBooks invoices and
 *   payments).
 * This is only the exposure level for a session. The approval policy
 * classifies each call separately (for example by inspecting attendees, the
 * Slack channel or the amount).
 */
export type ComposioToolAccess = "read" | "draft" | "outbound";

const ACCESS_RANK: Record<ComposioToolAccess, number> = { read: 0, draft: 1, outbound: 2 };

export interface ComposioAllowlistEntry {
  readonly slug: string;
  readonly access: ComposioToolAccess;
}

/**
 * Explicit allowlists (docs/ARCHITECTURE.md §2). Every slug was checked against
 * the live Composio catalog (Gmail and Calendar on 2026-09-28, QuickBooks and
 * Slack on 2026-09-29; none deprecated). Exact input schemas are captured in
 * test/fixtures/surfaces/composio-direct.json by
 * scripts/surfaces/capture-composio-direct.ts.
 *
 * QuickBooks: Composio's toolkit (version 20260721_00) has no tool that
 * emails or voids an invoice, so neither is offered; an invoice is sent to
 * its billing contact through Gmail. SLACK_CHAT_POST_MESSAGE is deprecated in
 * favour of SLACK_SEND_MESSAGE.
 */
export const COMPOSIO_ALLOWLISTS: Readonly<
  Record<ComposioToolkit, readonly ComposioAllowlistEntry[]>
> = {
  gmail: [
    { slug: "GMAIL_FETCH_EMAILS", access: "read" },
    { slug: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", access: "read" },
    { slug: "GMAIL_LIST_THREADS", access: "read" },
    { slug: "GMAIL_LIST_LABELS", access: "read" },
    { slug: "GMAIL_CREATE_EMAIL_DRAFT", access: "draft" },
    { slug: "GMAIL_ADD_LABEL_TO_EMAIL", access: "draft" },
    { slug: "GMAIL_SEND_DRAFT", access: "outbound" },
    { slug: "GMAIL_REPLY_TO_THREAD", access: "outbound" },
  ],
  googlecalendar: [
    { slug: "GOOGLECALENDAR_EVENTS_LIST", access: "read" },
    { slug: "GOOGLECALENDAR_FIND_FREE_SLOTS", access: "read" },
    { slug: "GOOGLECALENDAR_FIND_EVENT", access: "read" },
    { slug: "GOOGLECALENDAR_CREATE_EVENT", access: "outbound" },
    { slug: "GOOGLECALENDAR_UPDATE_EVENT", access: "outbound" },
  ],
  quickbooks: [
    { slug: "QUICKBOOKS_GET_COMPANY_INFO", access: "read" },
    { slug: "QUICKBOOKS_QUERY_CUSTOMERS", access: "read" },
    { slug: "QUICKBOOKS_READ_CUSTOMER", access: "read" },
    { slug: "QUICKBOOKS_QUERY_INVOICES", access: "read" },
    { slug: "QUICKBOOKS_READ_INVOICE", access: "read" },
    { slug: "QUICKBOOKS_QUERY_PAYMENTS", access: "read" },
    { slug: "QUICKBOOKS_QUERY_ITEMS", access: "read" },
    { slug: "QUICKBOOKS_GET_AGED_RECEIVABLES_REPORT", access: "read" },
    { slug: "QUICKBOOKS_CREATE_CUSTOMER", access: "draft" },
    { slug: "QUICKBOOKS_CREATE_INVOICE", access: "outbound" },
    { slug: "QUICKBOOKS_CREATE_PAYMENT", access: "outbound" },
  ],
  slack: [
    { slug: "SLACK_FIND_CHANNELS", access: "read" },
    { slug: "SLACK_LIST_ALL_CHANNELS", access: "read" },
    { slug: "SLACK_FETCH_CONVERSATION_HISTORY", access: "read" },
    { slug: "SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION", access: "read" },
    { slug: "SLACK_FIND_USERS", access: "read" },
    { slug: "SLACK_ADD_REACTION_TO_AN_ITEM", access: "draft" },
    { slug: "SLACK_SEND_MESSAGE", access: "outbound" },
  ],
};

/**
 * Default exposure: reads plus drafts. Tools that reach other people are only
 * offered when the caller asks for access 'outbound' explicitly.
 */
export const DEFAULT_COMPOSIO_ACCESS: ComposioToolAccess = "draft";

/** Sessions are cached per (userId, toolkits, access) for this long. */
export const COMPOSIO_SESSION_TTL_MS = 30 * 60 * 1000;

export function isComposioToolkit(value: string): value is ComposioToolkit {
  return (COMPOSIO_TOOLKITS as readonly string[]).includes(value);
}

/** The allowlisted slugs for one toolkit, up to and including `access`. */
export function allowedTools(
  toolkit: ComposioToolkit,
  access: ComposioToolAccess = DEFAULT_COMPOSIO_ACCESS,
): string[] {
  const limit = ACCESS_RANK[access];
  return COMPOSIO_ALLOWLISTS[toolkit]
    .filter((entry) => ACCESS_RANK[entry.access] <= limit)
    .map((entry) => entry.slug);
}

export interface SessionSelection {
  /** Defaults to every Composio toolkit (gmail, googlecalendar, quickbooks and slack). */
  toolkits?: readonly ComposioToolkit[];
  /** Defaults to DEFAULT_COMPOSIO_ACCESS ('draft'). */
  access?: ComposioToolAccess;
}

interface ResolvedSelection {
  toolkits: ComposioToolkit[];
  access: ComposioToolAccess;
}

function resolveSelection(selection: SessionSelection = {}): ResolvedSelection {
  const requested = selection.toolkits ?? COMPOSIO_TOOLKITS;
  if (requested.length === 0) {
    throw new ComposioSessionError("config", "No Composio toolkits requested");
  }
  for (const toolkit of requested) {
    if (!isComposioToolkit(toolkit)) {
      throw new ComposioSessionError("config", `Unsupported Composio toolkit: ${String(toolkit)}`);
    }
  }
  const access = selection.access ?? DEFAULT_COMPOSIO_ACCESS;
  if (!Object.hasOwn(ACCESS_RANK, access)) {
    throw new ComposioSessionError(
      "config",
      `Unsupported Composio access level: ${String(access)}`,
    );
  }
  // Canonical order, no duplicates, so the cache key is stable.
  const toolkits = COMPOSIO_TOOLKITS.filter((toolkit) => requested.includes(toolkit));
  return { toolkits, access };
}

export type RevenueDeskSessionConfig = ToolRouterCreateSessionConfig & { mcp: true };

/** The exact configuration passed to composio.sessions.create. */
export function buildSessionConfig(selection: SessionSelection = {}): RevenueDeskSessionConfig {
  const { toolkits, access } = resolveSelection(selection);
  const tools: Record<string, { enable: string[] }> = {};
  for (const toolkit of toolkits) tools[toolkit] = { enable: allowedTools(toolkit, access) };
  return {
    toolkits: [...toolkits],
    tools,
    sessionPreset: "direct_tools",
    manageConnections: false,
    sandbox: { enable: false },
    mcp: true,
  };
}

// --- The slice of the Composio SDK this module uses -------------------------

export interface ComposioMcpConfig {
  url: string;
  type: "http" | "sse";
  headers?: Record<string, string>;
}

export interface ComposioToolkitState {
  slug: string;
  isNoAuth: boolean;
  connection?: {
    isActive: boolean;
    connectedAccount?: { id: string; status: string };
  };
}

export interface ComposioSessionLike {
  readonly sessionId: string;
  readonly mcp: ComposioMcpConfig;
  toolkits(options?: {
    toolkits?: string[];
    cursor?: string;
    limit?: number;
  }): Promise<{ items: ComposioToolkitState[]; cursor?: string | undefined }>;
  authorize(
    toolkit: string,
    options?: { callbackUrl?: string },
  ): Promise<{ id: string; redirectUrl?: string | null }>;
}

export interface ComposioClientLike {
  createSession(userId: string, config: RevenueDeskSessionConfig): Promise<ComposioSessionLike>;
}

/** Composio logger sink that writes to stderr, keeping stdout clean. */
export const stderrComposioLogger: ComposioLogger = {
  error: (...args) => writeStderr(args),
  warn: (...args) => writeStderr(args),
  info: (...args) => writeStderr(args),
  debug: (...args) => writeStderr(args),
};

function writeStderr(args: unknown[]): void {
  process.stderr.write(`${format(...args)}\n`);
}

export interface ComposioClientOptions {
  apiKey: string;
  /**
   * SDK log sink. The Composio logger is process-wide: the last configured
   * instance wins. Defaults to stderr so a headless run's stdout stays clean.
   */
  logger?: ComposioLogger;
}

/**
 * The real Composio client, always at COMPOSIO_API_ORIGIN: the SDK would
 * otherwise read a base URL from its own environment variable or from its
 * user config file. The npm version check is disabled (it would fetch
 * the registry and could print an upgrade banner through the logger) and
 * anonymous usage analytics are off.
 */
export function createComposioClient(options: ComposioClientOptions): ComposioClientLike {
  if (!options.apiKey) throw new ComposioSessionError("config", "COMPOSIO_API_KEY is not set");
  const composio = new Composio({
    apiKey: options.apiKey,
    baseURL: COMPOSIO_API_ORIGIN,
    disableVersionCheck: true,
    allowTracking: false,
    logger: options.logger ?? stderrComposioLogger,
  });
  return {
    createSession: (userId, config) => composio.sessions.create(userId, config),
  };
}

// --- Errors ------------------------------------------------------------------

export type ComposioSessionErrorCode = "config" | "destination" | "upstream" | "no_redirect";

export class ComposioSessionError extends Error {
  override readonly name = "ComposioSessionError";
  /** Composio's HTTP status, when it answered with one. */
  readonly status: number | null;
  /** Composio's own words (redacted), or this error's message when there are none. */
  readonly said: string;
  constructor(
    readonly code: ComposioSessionErrorCode,
    message: string,
    options?: { cause?: unknown; status?: number | null; said?: string },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.status = options?.status ?? null;
    this.said = options?.said ?? message;
  }
}

/**
 * The HTTP status and Composio's own words in an error of the Composio SDK,
 * whose message reads `401 {"error":{"message":"Invalid API key: …",…}}`.
 */
export function composioErrorParts(error: unknown): {
  readonly status: number | null;
  readonly message: string;
} {
  const raw = error instanceof Error ? error.message : String(error);
  const field = typeof error === "object" && error !== null ? Reflect.get(error, "status") : null;
  let status = typeof field === "number" && Number.isInteger(field) ? field : null;
  let message = raw.trim();
  const match = /^(\d{3})\s+(\{[\s\S]*\})\s*$/.exec(message);
  if (match !== null) {
    status ??= Number(match[1]);
    try {
      const body: unknown = JSON.parse(match[2] ?? "");
      const words = wordsOf(body);
      if (words !== null) message = words;
    } catch {
      // Not JSON after all: keep the message as it was.
    }
  }
  return { status, message };
}

function wordsOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const inner = Reflect.get(body, "error");
  const holder = typeof inner === "object" && inner !== null ? inner : body;
  const message = Reflect.get(holder, "message");
  return typeof message === "string" && message.trim() !== "" ? message.trim() : null;
}

// --- Connection status -------------------------------------------------------

export type ComposioConnectionState = "connected" | "needs_auth" | "expired";

export interface ToolkitConnectionStatus {
  toolkit: ComposioToolkit;
  state: ComposioConnectionState;
  /** The connected account's status in lower case, or null when there is none. */
  accountStatus: string | null;
  /** A masked account id for display, e.g. "ca_…c6M". Never the full id. */
  accountHint: string | null;
  /** One plain sentence for the Connections screen. */
  detail: string;
}

const TOOLKIT_LABEL: Record<ComposioToolkit, string> = {
  gmail: "Gmail",
  googlecalendar: "Google Calendar",
  quickbooks: "QuickBooks Online",
  slack: "Slack",
};

/** Whose sign-in Composio holds for a toolkit, for the Connections screen. */
const SIGN_IN: Record<ComposioToolkit, string> = {
  gmail: "Google",
  googlecalendar: "Google",
  quickbooks: "Intuit",
  slack: "Slack",
};

export function maskAccountId(id: string): string {
  if (id.length <= 8) return "…";
  return `${id.slice(0, 3)}…${id.slice(-3)}`;
}

/** Maps Composio's toolkit state onto connected / needs_auth / expired. */
export function toConnectionStatus(
  toolkit: ComposioToolkit,
  state: ComposioToolkitState | undefined,
): ToolkitConnectionStatus {
  const label = TOOLKIT_LABEL[toolkit];
  if (!state) {
    return {
      toolkit,
      state: "needs_auth",
      accountStatus: null,
      accountHint: null,
      detail: `${label} was not reported by Composio for this session`,
    };
  }
  if (state.isNoAuth) {
    return {
      toolkit,
      state: "connected",
      accountStatus: null,
      accountHint: null,
      detail: `${label} needs no sign-in`,
    };
  }
  const account = state.connection?.connectedAccount;
  if (!account) {
    return {
      toolkit,
      state: "needs_auth",
      accountStatus: null,
      accountHint: null,
      detail: `${label} is not connected. Click Connect in Connections to sign in.`,
    };
  }
  const accountStatus = account.status.toLowerCase();
  const accountHint = maskAccountId(account.id);
  if (state.connection?.isActive && accountStatus === "active") {
    return {
      toolkit,
      state: "connected",
      accountStatus,
      accountHint,
      detail: `${label} connected`,
    };
  }
  if (accountStatus === "expired") {
    return {
      toolkit,
      state: "expired",
      accountStatus,
      accountHint,
      detail: `${label}'s ${SIGN_IN[toolkit]} sign-in expired. Click Connect in Connections to sign in again.`,
    };
  }
  return {
    toolkit,
    state: "needs_auth",
    accountStatus,
    accountHint,
    detail: `${label}'s ${SIGN_IN[toolkit]} sign-in is ${accountStatus}. Click Connect in Connections to finish it.`,
  };
}

// --- Session manager ---------------------------------------------------------

export interface ComposioMcpEndpoint {
  type: "http" | "sse";
  url: string;
  /** Carries the Composio credential. Never log or persist. */
  headers: Record<string, string>;
}

/** A description of an endpoint that is safe to log or store. */
export function describeEndpoint(endpoint: Pick<ComposioMcpEndpoint, "type" | "url">): {
  type: "http" | "sse";
  host: string;
} {
  return { type: endpoint.type, host: new URL(endpoint.url).host };
}

export interface ComposioSessionManagerOptions {
  apiKey: string;
  /** COMPOSIO_USER_ID. Required; there is no default. */
  userId: string;
  logger?: ComposioLogger;
  /**
   * The toolkits and access level the app uses. Methods use it unless a call
   * passes its own selection. Defaults to every toolkit at access 'draft'.
   */
  selection?: SessionSelection;
  /** Injected client (tests). Defaults to createComposioClient(). */
  client?: ComposioClientLike;
  ttlMs?: number;
  now?: () => number;
}

interface CacheEntry {
  createdAt: number;
  promise: Promise<ComposioSessionLike>;
}

export class ComposioSessionManager {
  private readonly client: ComposioClientLike;
  private readonly apiKey: string;
  private readonly userId: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly selection: SessionSelection;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: ComposioSessionManagerOptions) {
    if (!options.apiKey) throw new ComposioSessionError("config", "COMPOSIO_API_KEY is not set");
    if (!options.userId) throw new ComposioSessionError("config", "COMPOSIO_USER_ID is not set");
    this.apiKey = options.apiKey;
    this.userId = options.userId;
    this.ttlMs = options.ttlMs ?? COMPOSIO_SESSION_TTL_MS;
    this.now = options.now ?? Date.now;
    this.selection = resolveSelection(options.selection);
    this.client =
      options.client ??
      createComposioClient({
        apiKey: options.apiKey,
        ...(options.logger ? { logger: options.logger } : {}),
      });
  }

  /**
   * The Composio session for this selection, created lazily and reused for
   * the TTL. Concurrent callers share one creation. A failed creation is not
   * cached. `fresh` forces a new session.
   */
  getSession(
    selection: SessionSelection = this.selection,
    fresh = false,
  ): Promise<ComposioSessionLike> {
    const resolved = resolveSelection(selection);
    const key = `${resolved.toolkits.join(",")}|${resolved.access}`;
    const existing = this.cache.get(key);
    if (existing && !fresh && this.now() - existing.createdAt < this.ttlMs) return existing.promise;

    const entry: CacheEntry = {
      createdAt: this.now(),
      promise: this.createSession(resolved),
    };
    this.cache.set(key, entry);
    entry.promise.catch(() => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
    });
    return entry.promise;
  }

  private async createSession(selection: ResolvedSelection): Promise<ComposioSessionLike> {
    const config = buildSessionConfig(selection);
    try {
      return await this.client.createSession(this.userId, config);
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const code = name === "ComposioMCPDestinationError" ? "destination" : "upstream";
      throw this.failure(code, "Composio session creation failed", error);
    }
  }

  /** A ComposioSessionError for an SDK failure: its status, Composio's words, never the key. */
  private failure(
    code: ComposioSessionErrorCode,
    what: string,
    error: unknown,
  ): ComposioSessionError {
    const { status, message } = composioErrorParts(error);
    const said = this.redact(message);
    const http = status === null ? "" : ` (HTTP ${status})`;
    return new ComposioSessionError(code, `${what}${http}: ${said}`, {
      cause: error,
      status,
      said,
    });
  }

  /**
   * The hosted MCP endpoint of the session. The headers carry the credential.
   * Refused unless it is HTTPS on a public host (checkVendorUrl).
   */
  async mcpEndpoint(selection: SessionSelection = this.selection): Promise<ComposioMcpEndpoint> {
    const session = await this.getSession(selection);
    const { url, type, headers } = session.mcp;
    const checked = checkVendorUrl(url);
    if (!checked.ok) {
      throw new ComposioSessionError(
        "destination",
        `Composio returned a session MCP URL that ${checked.reason}; Revenue Desk does not connect to it`,
      );
    }
    if (type !== "http" && type !== "sse") {
      throw new ComposioSessionError(
        "upstream",
        `Unsupported Composio MCP transport: ${String(type)}`,
      );
    }
    return { type, url, headers: { ...(headers ?? {}) } };
  }

  /** Connection state per toolkit of the selection. Read-only. */
  async connectionStatus(
    selection: SessionSelection = this.selection,
  ): Promise<Record<ComposioToolkit, ToolkitConnectionStatus>> {
    const { toolkits } = resolveSelection(selection);
    const session = await this.getSession(selection);
    const states = new Map<string, ComposioToolkitState>();
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      let result: Awaited<ReturnType<ComposioSessionLike["toolkits"]>>;
      try {
        result = await session.toolkits({
          toolkits: [...toolkits],
          ...(cursor ? { cursor } : {}),
        });
      } catch (error) {
        throw this.failure("upstream", "Composio did not list the connections", error);
      }
      for (const item of result.items) states.set(item.slug, item);
      cursor = result.cursor || undefined;
      if (!cursor) break;
    }
    const out: Partial<Record<ComposioToolkit, ToolkitConnectionStatus>> = {};
    for (const toolkit of toolkits) out[toolkit] = toConnectionStatus(toolkit, states.get(toolkit));
    return out as Record<ComposioToolkit, ToolkitConnectionStatus>;
  }

  /**
   * Starts Composio's hosted sign-in for a toolkit and returns the URL the
   * user opens. Every call starts a new link flow, so call it only when the
   * user presses Connect. Composio sends the user back to `callbackUrl`.
   * Uses the configured session, which must include the toolkit. The link is
   * refused unless it is HTTPS on a public host (checkVendorUrl).
   */
  async authorize(
    toolkit: ComposioToolkit,
    callbackUrl: string,
  ): Promise<{ redirectUrl: string; connectionRequestId: string }> {
    if (!isComposioToolkit(toolkit)) {
      throw new ComposioSessionError("config", `Unsupported Composio toolkit: ${String(toolkit)}`);
    }
    let callback: URL;
    try {
      callback = new URL(callbackUrl);
    } catch {
      throw new ComposioSessionError("config", "The Connect callback URL is not a valid URL");
    }
    if (callback.protocol !== "http:" && callback.protocol !== "https:") {
      throw new ComposioSessionError("config", "The Connect callback URL must be http or https");
    }
    if (!resolveSelection(this.selection).toolkits.includes(toolkit)) {
      throw new ComposioSessionError("config", `${TOOLKIT_LABEL[toolkit]} is not in this session`);
    }
    const session = await this.getSession();
    const request = await session.authorize(toolkit, { callbackUrl: callback.toString() });
    if (!request.redirectUrl) {
      throw new ComposioSessionError(
        "no_redirect",
        `Composio did not return a sign-in link for ${TOOLKIT_LABEL[toolkit]}`,
      );
    }
    const link = checkVendorUrl(request.redirectUrl);
    if (!link.ok) {
      throw new ComposioSessionError(
        "destination",
        `Composio returned a sign-in link for ${TOOLKIT_LABEL[toolkit]} that ${link.reason}; Revenue Desk does not open it`,
      );
    }
    return { redirectUrl: request.redirectUrl, connectionRequestId: request.id };
  }

  /** Forget cached sessions so the next call sees fresh state. */
  reset(): void {
    this.cache.clear();
  }

  private redact(text: string): string {
    return text.split(this.apiKey).join("[REDACTED]");
  }
}
