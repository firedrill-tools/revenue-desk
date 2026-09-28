// One HTTP exchange with a provider, with the retry rules of
// docs/ARCHITECTURE.md §5 ("HTTP clients"):
//   - writes are never retried;
//   - reads retry at most twice, only on HTTP 429 (honouring Retry-After) or
//     on a network error raised before the request reached the server.
// Provider clients turn the outcome into data or an ApiToolError.

import type { JsonValue } from "../../contracts/json.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Waits `ms`, rejecting early with the signal's reason when it aborts. */
export type Sleep = (ms: number, signal: AbortSignal | undefined) => Promise<void>;

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export type HttpMethod = "GET" | "POST" | "DELETE";

export type HttpRequest = {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /** True only for side-effect-free calls. Writes are never retried. */
  readonly retryable: boolean;
  readonly signal: AbortSignal | undefined;
};

export type HttpResponse = {
  readonly status: number;
  readonly headers: Headers;
  /** The parsed JSON body, or undefined when the body is empty or not JSON. */
  readonly json: JsonValue | undefined;
  readonly text: string;
};

export type HttpDeps = {
  readonly fetch?: FetchLike;
  readonly sleep?: Sleep;
  /** Retries after the first attempt, for retryable requests. Default 2. */
  readonly maxRetries?: number;
  /** Backoff for a 429 without Retry-After, and for network errors: base * 2^attempt. Default 500. */
  readonly backoffMs?: number;
  /** A Retry-After longer than this is not waited for; the 429 is returned. Default 10000. */
  readonly maxRetryDelayMs?: number;
  /** Per-attempt time limit. Default 60000. */
  readonly timeoutMs?: number;
};

/** A failure to get any HTTP response. */
export class TransportError extends Error {
  override readonly name = "TransportError";
  constructor(
    readonly kind: "network" | "timeout" | "aborted",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Error codes that mean the connection was never established, so the request
 * cannot have reached the server. Anything else (a reset after connecting, a
 * socket error mid-response) might have been processed and is not retried.
 */
const CONNECT_PHASE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    if ("code" in current && typeof current.code === "string") codes.push(current.code);
    if ("errors" in current && Array.isArray(current.errors)) {
      for (const inner of current.errors) {
        if (typeof inner === "object" && inner !== null && "code" in inner) {
          if (typeof inner.code === "string") codes.push(inner.code);
        }
      }
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return codes;
}

/** True when a fetch error happened before any byte of the request was sent. */
export function isPreSendNetworkError(error: unknown): boolean {
  return errorCodes(error).some((code) => CONNECT_PHASE_CODES.has(code));
}

/** Retry-After as milliseconds (delta-seconds or an HTTP date); null when absent or invalid. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

function parseBody(text: string): JsonValue | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return undefined;
  }
}

function describeCause(error: unknown): string {
  const codes = errorCodes(error);
  if (codes.length > 0) return codes[0] ?? "network error";
  return error instanceof Error ? error.message : "network error";
}

async function attempt(
  request: HttpRequest,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<HttpResponse> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal =
    request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      signal,
      redirect: "error",
    });
    text = await response.text();
  } catch (error) {
    if (request.signal?.aborted) {
      throw new TransportError("aborted", "The request was cancelled", { cause: error });
    }
    if (timeout.aborted) {
      throw new TransportError("timeout", `No response within ${timeoutMs} ms`, { cause: error });
    }
    throw new TransportError("network", `Network error: ${describeCause(error)}`, {
      cause: error,
    });
  }
  return { status: response.status, headers: response.headers, json: parseBody(text), text };
}

/**
 * Sends one request. Returns every HTTP response (2xx or not); throws
 * TransportError when no response arrived. Only `retryable` requests are
 * retried, and only on 429 or a pre-send network error.
 */
export async function sendHttp(request: HttpRequest, deps: HttpDeps = {}): Promise<HttpResponse> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const maxRetries = request.retryable ? (deps.maxRetries ?? 2) : 0;
  const backoffMs = deps.backoffMs ?? 500;
  const maxRetryDelayMs = deps.maxRetryDelayMs ?? 10_000;
  const timeoutMs = deps.timeoutMs ?? 60_000;

  for (let retry = 0; ; retry += 1) {
    let response: HttpResponse;
    try {
      response = await attempt(request, fetchImpl, timeoutMs);
    } catch (error) {
      const retryableNetwork =
        error instanceof TransportError &&
        error.kind === "network" &&
        isPreSendNetworkError(error.cause);
      if (!retryableNetwork || retry >= maxRetries) throw error;
      await sleep(backoffMs * 2 ** retry, request.signal);
      continue;
    }
    if (response.status !== 429 || retry >= maxRetries) return response;
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    const delay = retryAfter ?? backoffMs * 2 ** retry;
    if (delay > maxRetryDelayMs) return response;
    await sleep(delay, request.signal);
  }
}
