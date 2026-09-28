// Typed client for the Revenue Desk HTTP API (src/contracts/api.ts).
//
// - Routes are the contract's "METHOD /path" keys, so a call's params, query,
//   body and response are all checked against ApiEndpoints.
// - Every request waits for GET /api/session first: it sets the per-boot
//   session cookie that every other /api route, reads included, requires.
//   Mutating requests (POST, PATCH) also send JSON (`{}` when there is no
//   body) and the session's CSRF token. If the server restarted, the cookie
//   and token are stale: the client re-reads the session once and retries
//   (docs/ARCHITECTURE.md §7).
// - Errors become ApiError with the contract's code and a plain message.
//
// Alias-free and DOM-free so the Node test suite can import it.

import {
  API_ERROR_STATUS,
  API_PATHS,
  type ApiEndpoints,
  type ApiErrorCode,
  type ApiIssue,
  type ApiRoute,
  CSRF_HEADER,
  type SessionInfo,
} from "../../../src/contracts/api.js";

type Endpoint<R extends ApiRoute> = ApiEndpoints[R];
type HasKeys<T> = [keyof T] extends [never] ? false : true;

/** The arguments of one call, derived from the endpoint's contract. */
export type RequestArgs<R extends ApiRoute> = (HasKeys<Endpoint<R>["params"]> extends true
  ? { readonly params: Endpoint<R>["params"] }
  : { readonly params?: undefined }) &
  (HasKeys<Endpoint<R>["query"]> extends true
    ? { readonly query?: Endpoint<R>["query"] }
    : { readonly query?: undefined }) &
  (Endpoint<R>["body"] extends null
    ? { readonly body?: undefined }
    : HasKeys<Endpoint<R>["body"]> extends true
      ? { readonly body: Endpoint<R>["body"] }
      : { readonly body?: undefined }) & { readonly signal?: AbortSignal };

export type ResponseOf<R extends ApiRoute> = Endpoint<R>["response"];

type NeedsArgs<R extends ApiRoute> =
  HasKeys<Endpoint<R>["params"]> extends true
    ? true
    : Endpoint<R>["body"] extends null
      ? false
      : HasKeys<Endpoint<R>["body"]>;

/** Arguments are required exactly when the route has params or a body. */
export type RequestArgsTuple<R extends ApiRoute> =
  NeedsArgs<R> extends true ? [args: RequestArgs<R>] : [args?: RequestArgs<R>];

/** Client-side failures that have no server error code. */
export type ClientErrorCode = "network_error" | "unexpected_response";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | ClientErrorCode;
  readonly issues: readonly ApiIssue[];

  constructor(
    message: string,
    options: {
      status: number;
      code: ApiErrorCode | ClientErrorCode;
      issues?: readonly ApiIssue[];
    },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
    this.issues = options.issues ?? [];
  }
}

const API_ERROR_CODES = new Set<string>(Object.keys(API_ERROR_STATUS));

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && API_ERROR_CODES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readIssues(value: unknown): ApiIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((issue: unknown) =>
    isRecord(issue) && typeof issue.path === "string" && typeof issue.message === "string"
      ? [{ path: issue.path, message: issue.message }]
      : [],
  );
}

/** Reads an ApiErrorBody; anything else becomes a generic error for the status. */
export function parseApiError(status: number, body: unknown): ApiError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  if (error && isApiErrorCode(error.code) && typeof error.message === "string") {
    return new ApiError(error.message, {
      status,
      code: error.code,
      issues: readIssues(error.issues),
    });
  }
  if (status >= 500) {
    return new ApiError("The server hit an error. Try again.", { status, code: "internal" });
  }
  return new ApiError(`The server answered ${status}.`, { status, code: "unexpected_response" });
}

/** Parses an error message produced by the AI SDK chat transport (the raw response text). */
export function parseTransportError(error: Error): ApiError | null {
  try {
    const body: unknown = JSON.parse(error.message);
    const parsed = parseApiError(0, body);
    return parsed.code === "unexpected_response" ? null : parsed;
  } catch {
    return null;
  }
}

/** Replaces `:name` segments with encoded params; a missing param is a programming error. */
export function buildPath(template: string, params: Readonly<Record<string, string>> = {}): string {
  return template.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined || value === "") {
      throw new Error(`Missing path parameter "${name}" for ${template}`);
    }
    return encodeURIComponent(value);
  });
}

type QueryValue = string | number | boolean | null | undefined;

export function buildQuery(query: Readonly<Record<string, QueryValue>> | undefined): string {
  if (!query) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

function splitRoute(route: ApiRoute): { method: "GET" | "POST" | "PATCH"; path: string } {
  const space = route.indexOf(" ");
  const method = route.slice(0, space);
  if (method !== "GET" && method !== "POST" && method !== "PATCH") {
    throw new Error(`Unsupported method in route ${route}`);
  }
  return { method, path: route.slice(space + 1) };
}

/** fetch's first argument (RequestInfo in the DOM library, which Node's types lack). */
type FetchInput = Parameters<typeof globalThis.fetch>[0];

export type ApiClientOptions = {
  /** Defaults to globalThis.fetch, resolved at call time. */
  readonly fetch?: typeof globalThis.fetch;
  /** Prefix for tests that call an absolute origin; empty in the browser. */
  readonly baseUrl?: string;
};

export type ApiClient = {
  request<R extends ApiRoute>(route: R, ...args: RequestArgsTuple<R>): Promise<ResponseOf<R>>;
  /** GET /api/session, cached until a CSRF failure or refreshSession(). */
  session(): Promise<SessionInfo>;
  refreshSession(): Promise<SessionInfo>;
  /**
   * fetch after the session is loaded (its cookie), with the CSRF header on
   * mutating requests and one retry after a stale session. The chat transport
   * uses it for POST /api/chat and the stream resume.
   */
  fetchWithCsrf(input: FetchInput, init?: RequestInit): Promise<Response>;
};

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? "";
  const doFetch: typeof globalThis.fetch = (input, init) =>
    (options.fetch ?? globalThis.fetch)(input, init);
  let sessionPromise: Promise<SessionInfo> | null = null;

  async function loadSession(): Promise<SessionInfo> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${API_PATHS.session}`, {
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
    } catch {
      throw new ApiError("Revenue Desk's server is not reachable.", {
        status: 0,
        code: "network_error",
      });
    }
    const body = await readJson(response);
    if (!response.ok) throw parseApiError(response.status, body);
    if (!isRecord(body) || typeof body.csrfToken !== "string") {
      throw new ApiError("The session response was not understood.", {
        status: response.status,
        code: "unexpected_response",
      });
    }
    return body as SessionInfo;
  }

  function session(): Promise<SessionInfo> {
    if (sessionPromise === null) {
      const pending = loadSession();
      sessionPromise = pending;
      // A failed read is not cached: the next caller tries again.
      pending.catch(() => {
        if (sessionPromise === pending) sessionPromise = null;
      });
    }
    return sessionPromise;
  }

  function refreshSession(): Promise<SessionInfo> {
    sessionPromise = null;
    return session();
  }

  /** The request with the session loaded (so its cookie is set) and, for a mutation, its token. */
  async function withSession(
    init: RequestInit | undefined,
    mutating: boolean,
  ): Promise<RequestInit> {
    const { csrfToken } = await session();
    const headers = new Headers(init?.headers);
    if (mutating) headers.set(CSRF_HEADER, csrfToken);
    return { ...init, headers, credentials: init?.credentials ?? "same-origin" };
  }

  async function isStaleCsrf(response: Response): Promise<boolean> {
    if (response.status !== API_ERROR_STATUS.csrf_failed) return false;
    const body = await readJson(response.clone());
    return isRecord(body) && isRecord(body.error) && body.error.code === "csrf_failed";
  }

  async function fetchWithCsrf(input: FetchInput, init?: RequestInit): Promise<Response> {
    const mutating = MUTATING.has((init?.method ?? "GET").toUpperCase());
    const first = await doFetch(input, await withSession(init, mutating));
    if (!(await isStaleCsrf(first))) return first;
    await refreshSession();
    return doFetch(input, await withSession(init, mutating));
  }

  async function request<R extends ApiRoute>(
    route: R,
    ...rest: RequestArgsTuple<R>
  ): Promise<ResponseOf<R>> {
    const args: RequestArgs<R> | undefined = rest[0];
    const { method, path } = splitRoute(route);
    const params = args?.params as Readonly<Record<string, string>> | undefined;
    const query = args?.query as Readonly<Record<string, QueryValue>> | undefined;
    const url = `${baseUrl}${buildPath(path, params)}${buildQuery(query)}`;
    const init: RequestInit = {
      method,
      headers:
        method === "GET"
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      credentials: "same-origin",
      ...(method === "GET" ? {} : { body: JSON.stringify(args?.body ?? {}) }),
      ...(args?.signal ? { signal: args.signal } : {}),
    };

    let response: Response;
    try {
      response = await fetchWithCsrf(url, init);
    } catch (error) {
      if (args?.signal?.aborted) throw error;
      throw new ApiError("Revenue Desk's server is not reachable.", {
        status: 0,
        code: "network_error",
      });
    }
    const body = await readJson(response);
    if (!response.ok) throw parseApiError(response.status, body);
    if (body === undefined) {
      throw new ApiError("The server's response was not understood.", {
        status: response.status,
        code: "unexpected_response",
      });
    }
    return body as ResponseOf<R>;
  }

  return { request, session, refreshSession, fetchWithCsrf };
}

/** The app's client (same origin). */
export const api: ApiClient = createApiClient();

/** A message for any thrown value, safe to show. */
export function errorMessage(
  error: unknown,
  fallback = "Something went wrong. Try again.",
): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}
