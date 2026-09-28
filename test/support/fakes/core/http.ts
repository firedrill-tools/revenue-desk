/**
 * The loopback HTTP server under every REST fake: routing, request
 * recording and fault injection.
 *
 * - Listens on 127.0.0.1 on an ephemeral port, never on another interface.
 * - An optional path prefix (for example "/stripe") is required on every
 *   request, so tests can prove that clients keep a base URL's prefix.
 * - Every request is recorded (credentials redacted) with the response it
 *   got, so a test can assert exactly what a client did.
 * - Faults answer matching requests before any handler runs: they never
 *   change state, as a provider-side failure would not.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { JsonValue } from "../../../../src/contracts/json.js";
import type { FakeClock } from "./clock.js";

/** A response a route or a fault gives. A string body is sent as is. */
export interface FakeResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: JsonValue | string;
}

/**
 * A route that writes the Node response itself (MCP transports). The request
 * stream was already read: `body` is its text.
 */
export interface RawResponse {
  readonly raw: (request: IncomingMessage, response: ServerResponse, body: string) => Promise<void>;
}

export interface FakeRequest {
  readonly method: string;
  /** The path after the prefix, without the query. */
  readonly path: string;
  readonly query: URLSearchParams;
  /** Lower-case header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string;
  /** Route parameters (`:id` segments), URI-decoded. */
  readonly params: Readonly<Record<string, string>>;
  /** Extra facts a handler adds to this request's record (never secrets). */
  readonly note: (facts: Readonly<Record<string, JsonValue>>) => void;
}

export type RouteHandler = (
  request: FakeRequest,
) => FakeResponse | RawResponse | Promise<FakeResponse | RawResponse>;

/** One request as a fake saw it, and what it answered. */
export interface RecordedHttpRequest {
  readonly seq: number;
  /** The fake clock's time when the request arrived. */
  readonly at: string;
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, readonly string[]>>;
  /** Lower-case names; credentials are replaced by "<scheme> [redacted]". */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly status: number;
  /** The JSON response body, when there was one. */
  readonly response: JsonValue | null;
  /** The fault that answered, or null when a route did. */
  readonly fault: string | null;
  readonly notes: Readonly<Record<string, JsonValue>>;
}

/** A provider failure injected for matching requests. */
export interface FaultRule {
  /** Upper-case HTTP method; any method when omitted. */
  readonly method?: string;
  /** Matched against the path after the prefix. */
  readonly path: string | RegExp;
  /** How many requests it answers; default 1. Use Infinity for "always". */
  readonly times?: number;
  /** A label for the record, e.g. "stripe-402". */
  readonly name?: string;
  /** Wait before answering (a slow provider). */
  readonly delayMs?: number;
  /**
   * The response, "drop" to destroy the connection without a reply, or
   * "pass" to answer normally after `delayMs` (a slow provider that still
   * applies the request).
   */
  readonly respond:
    | FakeResponse
    | "drop"
    | "pass"
    | ((request: FakeRequest) => FakeResponse | "drop");
}

export interface FaultHandle {
  readonly name: string;
  /** Requests it answered so far. */
  readonly hits: number;
  readonly remaining: number;
  remove(): void;
}

interface ActiveFault {
  readonly rule: FaultRule;
  readonly name: string;
  hits: number;
  remaining: number;
}

const MAX_BODY_BYTES = 1_048_576;
const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key", "proxy-authorization", "cookie"]);

interface Route {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: RouteHandler;
}

/** Method + path-pattern routing; `:name` segments become params. */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({ method: method.toUpperCase(), segments: split(pattern), handler });
    return this;
  }

  /** The handler for a request, or which methods the path allows. */
  match(
    method: string,
    path: string,
  ):
    | { readonly handler: RouteHandler; readonly params: Record<string, string> }
    | { readonly allowed: readonly string[] }
    | null {
    const segments = split(path);
    const allowed: string[] = [];
    for (const route of this.routes) {
      const params = matchSegments(route.segments, segments);
      if (params === null) continue;
      if (route.method === method) return { handler: route.handler, params };
      allowed.push(route.method);
    }
    return allowed.length > 0 ? { allowed } : null;
  }
}

function split(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function matchSegments(
  pattern: readonly string[],
  actual: readonly string[],
): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index] as string;
    const value = actual[index] as string;
    if (expected.startsWith(":")) {
      try {
        params[expected.slice(1)] = decodeURIComponent(value);
      } catch {
        return null;
      }
    } else if (expected !== value) {
      return null;
    }
  }
  return params;
}

export interface FakeHttpServerOptions {
  /** A label for errors, e.g. "stripe". */
  readonly name: string;
  readonly clock: FakeClock;
  readonly router: Router;
  /** Required path prefix, e.g. "/stripe"; "" for none. */
  readonly prefix?: string;
  /** Answers requests that match no route (the provider's own 404). */
  readonly notFound: (request: FakeRequest, allowed: readonly string[]) => FakeResponse;
  /** Answers a body over 1 MiB. */
  readonly tooLarge?: () => FakeResponse;
}

/** A fake's HTTP server. Call start() before use and close() after. */
export class FakeHttpServer {
  readonly requests: RecordedHttpRequest[] = [];
  private readonly faults: ActiveFault[] = [];
  private readonly server: Server;
  private readonly prefix: string;
  private port = 0;
  private faultCount = 0;

  constructor(private readonly options: FakeHttpServerOptions) {
    this.prefix = normalisePrefix(options.prefix ?? "");
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "text/plain" });
          response.end(`${options.name} fake failed: ${message}`);
        } else {
          response.destroy();
        }
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.port = (this.server.address() as AddressInfo).port;
  }

  /** http://127.0.0.1:<port> */
  get origin(): string {
    if (this.port === 0) throw new Error(`${this.options.name} fake is not started`);
    return `http://127.0.0.1:${this.port}`;
  }

  /** The base URL clients are configured with: origin plus prefix. */
  get baseUrl(): string {
    return `${this.origin}${this.prefix}`;
  }

  /** Answers matching requests with a provider failure instead of the route. */
  injectFault(rule: FaultRule): FaultHandle {
    this.faultCount += 1;
    const active: ActiveFault = {
      rule,
      name: rule.name ?? `${this.options.name}-fault-${this.faultCount}`,
      hits: 0,
      remaining: rule.times ?? 1,
    };
    this.faults.push(active);
    return {
      get name() {
        return active.name;
      },
      get hits() {
        return active.hits;
      },
      get remaining() {
        return active.remaining;
      },
      remove: () => {
        const index = this.faults.indexOf(active);
        if (index >= 0) this.faults.splice(index, 1);
      },
    };
  }

  clearFaults(): void {
    this.faults.length = 0;
  }

  /** Recorded requests for one method and path (after the prefix). */
  requestsTo(method: string, path: string | RegExp): RecordedHttpRequest[] {
    return this.requests.filter(
      (entry) =>
        entry.method === method.toUpperCase() &&
        (typeof path === "string" ? entry.path === path : path.test(entry.path)),
    );
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = (request.method ?? "GET").toUpperCase();
    const headers = lowerHeaders(request);
    const bodyResult = await readBody(request);
    const notes: Record<string, JsonValue> = {};
    const record = (status: number, body: JsonValue | string | undefined, fault: string | null) => {
      this.requests.push({
        seq: this.requests.length + 1,
        at: this.options.clock.now().toISOString(),
        method,
        path: stripPrefix(url.pathname, this.prefix) ?? url.pathname,
        query: queryRecord(url.searchParams),
        headers: redactHeaders(headers),
        body: bodyResult.ok ? bodyResult.text : "",
        status,
        response: typeof body === "string" || body === undefined ? parseJson(body) : body,
        fault,
        notes: { ...notes },
      });
    };

    const path = stripPrefix(url.pathname, this.prefix);
    const fakeRequest: FakeRequest = {
      method,
      path: path ?? url.pathname,
      query: url.searchParams,
      headers,
      rawBody: bodyResult.ok ? bodyResult.text : "",
      params: {},
      note: (facts) => Object.assign(notes, facts),
    };

    if (!bodyResult.ok) {
      const reply = this.options.tooLarge?.() ?? { status: 413, body: "Request body too large" };
      record(reply.status, reply.body, null);
      send(response, reply);
      return;
    }
    if (path === null) {
      const reply = this.options.notFound(fakeRequest, []);
      record(reply.status, reply.body, null);
      send(response, reply);
      return;
    }

    const fault = this.takeFault(method, path);
    let passed: string | null = null;
    if (fault !== null && fault.rule.respond === "pass") {
      if (fault.rule.delayMs !== undefined) await delay(fault.rule.delayMs);
      passed = fault.name;
    } else if (fault !== null) {
      const { rule, name } = fault;
      if (rule.delayMs !== undefined) await delay(rule.delayMs);
      const respond = rule.respond as Exclude<FaultRule["respond"], "pass">;
      const reply = typeof respond === "function" ? respond(fakeRequest) : respond;
      if (reply === "drop") {
        record(0, undefined, name);
        request.socket.destroy();
        return;
      }
      record(reply.status, reply.body, name);
      send(response, reply);
      return;
    }

    const match = this.options.router.match(method, path);
    if (match === null || "allowed" in match) {
      const reply = this.options.notFound(fakeRequest, match === null ? [] : match.allowed);
      record(reply.status, reply.body, null);
      send(response, reply);
      return;
    }
    const result = await match.handler({ ...fakeRequest, params: match.params });
    if ("raw" in result) {
      await result.raw(request, response, bodyResult.text);
      record(response.statusCode, parseJsonRpc(bodyResult.text), passed);
      return;
    }
    record(result.status, result.body, passed);
    send(response, result);
  }

  private takeFault(method: string, path: string): ActiveFault | null {
    for (const fault of this.faults) {
      if (fault.remaining <= 0) continue;
      if (fault.rule.method !== undefined && fault.rule.method.toUpperCase() !== method) continue;
      const matches =
        typeof fault.rule.path === "string" ? fault.rule.path === path : fault.rule.path.test(path);
      if (!matches) continue;
      fault.remaining -= 1;
      fault.hits += 1;
      return fault;
    }
    return null;
  }
}

function normalisePrefix(prefix: string): string {
  if (prefix === "" || prefix === "/") return "";
  const trimmed = prefix.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** The path after the prefix, or null when the request lacks the prefix. */
function stripPrefix(pathname: string, prefix: string): string | null {
  if (prefix === "") return pathname;
  if (pathname === prefix) return "/";
  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : null;
}

function lowerHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.has(name)) {
      out[name] = value;
      continue;
    }
    const scheme = /^(\S+)\s+\S/.exec(value)?.[1];
    out[name] = name === "authorization" && scheme ? `${scheme} [redacted]` : "[redacted]";
  }
  return out;
}

function queryRecord(params: URLSearchParams): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of params) out[key] = [...(out[key] ?? []), value];
  return out;
}

async function readBody(
  request: IncomingMessage,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) tooLarge = true;
    else chunks.push(buffer);
  }
  return tooLarge ? { ok: false } : { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

function parseJson(text: string | undefined): JsonValue | null {
  if (text === undefined || text === "") return null;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
}

/** For raw (MCP) routes the record keeps the JSON-RPC request, not the stream. */
function parseJsonRpc(text: string): JsonValue | undefined {
  return parseJson(text) ?? undefined;
}

function send(response: ServerResponse, reply: FakeResponse): void {
  const headers: Record<string, string> = { ...reply.headers };
  let payload = "";
  if (typeof reply.body === "string") {
    payload = reply.body;
    headers["content-type"] ??= "text/plain; charset=utf-8";
  } else if (reply.body !== undefined) {
    payload = JSON.stringify(reply.body);
    headers["content-type"] ??= "application/json";
  }
  response.writeHead(reply.status, headers);
  response.end(payload);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A header value, or undefined. Names are lower case. */
export function header(request: FakeRequest, name: string): string | undefined {
  return request.headers[name.toLowerCase()];
}

/** The bearer token of a request, or null when there is none. */
export function bearerToken(request: FakeRequest): string | null {
  const value = header(request, "authorization");
  if (value === undefined) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return match?.[1] ?? null;
}

/** The media type of a request body without parameters, lower case ("" when absent). */
export function mediaType(request: FakeRequest): string {
  return (header(request, "content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}
