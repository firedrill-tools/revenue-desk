import { format } from "node:util";
import { Composio, type ComposioLogger, type ToolRouterCreateSessionConfig } from "@composio/core";
import { isLoopbackHost } from "../shared/url.js";

// ---------------------------------------------------------------------------
// Composio session for Gmail and Google Calendar.
//
// This module is the only place Revenue Desk talks to Composio. It creates a
// Composio session for one configured user with:
//   - toolkits restricted to gmail and googlecalendar,
//   - per-toolkit tool allowlists (below) so only the named operations exist,
//   - sessionPreset 'direct_tools', so the session's hosted MCP server lists
//     the real operations (GMAIL_FETCH_EMAILS, ...) instead of router meta-tools,
//   - no sandbox or workbench, no in-chat connection management,
//   - mcp: true, so the session carries its hosted MCP endpoint.
// It also reports per-toolkit connection state and can produce a Connect link.
//
// It never executes a Composio tool. Tool calls travel over the session's MCP
// endpoint through the gateway, where the approval policy applies.
//
// The session MCP endpoint must be HTTPS. Plain HTTP is accepted only when
// COMPOSIO_BASE_URL itself is a loopback URL (local fakes and the sandbox
// demo) and the endpoint is on a loopback host too.
//
// Secrets: the API key and the session MCP headers (which carry the key) are
// never logged. Use describeEndpoint() for anything that is printed or stored.
// ---------------------------------------------------------------------------

export const COMPOSIO_TOOLKITS = ["gmail", "googlecalendar"] as const;
export type ComposioToolkit = (typeof COMPOSIO_TOOLKITS)[number];

/**
 * How far a tool reaches beyond the signed-in user's own account.
 * - read: no side effects.
 * - draft: changes only the user's own mailbox (drafts, labels).
 * - outbound: can reach other people (sending mail, calendar events that can
 *   carry attendees).
 * This is only the exposure level for a session. The approval policy
 * classifies each call separately (for example by inspecting attendees).
 */
export type ComposioToolAccess = "read" | "draft" | "outbound";

const ACCESS_RANK: Record<ComposioToolAccess, number> = { read: 0, draft: 1, outbound: 2 };

export interface ComposioAllowlistEntry {
  readonly slug: string;
  readonly access: ComposioToolAccess;
}

/**
 * Explicit allowlists (docs/ARCHITECTURE.md §2). Every slug was checked against
 * the live Composio catalog on 2026-09-28 (none deprecated). Exact input
 * schemas are captured in test/fixtures/surfaces/composio-direct.json by
 * scripts/surfaces/capture-composio-direct.ts.
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
  /** Defaults to every Composio toolkit (gmail and googlecalendar). */
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
  /** Optional API base URL; the SDK default is https://backend.composio.dev. */
  baseURL?: string;
  /**
   * SDK log sink. The Composio logger is process-wide: the last configured
   * instance wins. Defaults to stderr so a headless run's stdout stays clean.
   */
  logger?: ComposioLogger;
}

/**
 * The real Composio client. The npm version check is disabled (it would fetch
 * the registry and could print an upgrade banner through the logger) and
 * anonymous usage analytics are off.
 */
export function createComposioClient(options: ComposioClientOptions): ComposioClientLike {
  if (!options.apiKey) throw new ComposioSessionError("config", "COMPOSIO_API_KEY is not set");
  const composio = new Composio({
    apiKey: options.apiKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
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
  constructor(
    readonly code: ComposioSessionErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
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
      detail: `${label}'s Google sign-in expired. Click Connect in Connections to sign in again.`,
    };
  }
  return {
    toolkit,
    state: "needs_auth",
    accountStatus,
    accountHint,
    detail: `${label}'s Google sign-in is ${accountStatus}. Click Connect in Connections to finish it.`,
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

/** True for an http(s) URL on a loopback host. */
export function isLoopbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

export interface ComposioSessionManagerOptions {
  apiKey: string;
  /** COMPOSIO_USER_ID. Required; there is no default. */
  userId: string;
  /** COMPOSIO_BASE_URL. When it is loopback, loopback http session endpoints are accepted. */
  baseURL?: string;
  logger?: ComposioLogger;
  /**
   * The toolkits and access level the app uses. Methods use it unless a call
   * passes its own selection. Defaults to both toolkits at access 'draft'.
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
  private readonly loopbackBase: boolean;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: ComposioSessionManagerOptions) {
    if (!options.apiKey) throw new ComposioSessionError("config", "COMPOSIO_API_KEY is not set");
    if (!options.userId) throw new ComposioSessionError("config", "COMPOSIO_USER_ID is not set");
    this.apiKey = options.apiKey;
    this.userId = options.userId;
    this.ttlMs = options.ttlMs ?? COMPOSIO_SESSION_TTL_MS;
    this.now = options.now ?? Date.now;
    this.selection = resolveSelection(options.selection);
    this.loopbackBase = options.baseURL !== undefined && isLoopbackUrl(options.baseURL);
    this.client =
      options.client ??
      createComposioClient({
        apiKey: options.apiKey,
        ...(options.baseURL ? { baseURL: options.baseURL } : {}),
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
      const message = this.redact(error instanceof Error ? error.message : String(error));
      const code = name === "ComposioMCPDestinationError" ? "destination" : "upstream";
      throw new ComposioSessionError(code, `Composio session creation failed: ${message}`, {
        cause: error,
      });
    }
  }

  /** The hosted MCP endpoint of the session. The headers carry the credential. */
  async mcpEndpoint(selection: SessionSelection = this.selection): Promise<ComposioMcpEndpoint> {
    const session = await this.getSession(selection);
    const { url, type, headers } = session.mcp;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ComposioSessionError("destination", "Composio returned an invalid MCP URL");
    }
    const loopbackHttp =
      parsed.protocol === "http:" && this.loopbackBase && isLoopbackHost(parsed.hostname);
    if (parsed.protocol !== "https:" && !loopbackHttp) {
      throw new ComposioSessionError("destination", "Composio returned a non-HTTPS MCP URL");
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
      const result = await session.toolkits({
        toolkits: [...toolkits],
        ...(cursor ? { cursor } : {}),
      });
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
   * Uses the configured session, which must include the toolkit.
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
