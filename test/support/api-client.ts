/**
 * A test client for Revenue Desk's HTTP API (src/contracts/api.ts), as a
 * browser tab uses it: GET /api/session for the per-boot cookie and CSRF
 * token (read first, as the app does, since every other route needs the
 * cookie), then mutating requests with a same-origin Origin, JSON, the
 * cookie and x-rd-csrf. Chat responses are read as the UI message stream (SSE,
 * terminated by [DONE]); a caller can decide approvals while the stream is
 * open, as the approval card does.
 */
import {
  API_PATHS,
  type ApiEndpoints,
  type ApiErrorBody,
  type ApiRoute,
  CSRF_HEADER,
  type SessionInfo,
} from "../../src/contracts/api.js";
import type { JsonObject } from "../../src/contracts/json.js";

type RouteParams<R extends ApiRoute> = ApiEndpoints[R]["params"];
type RouteQuery<R extends ApiRoute> = ApiEndpoints[R]["query"];
type RouteBody<R extends ApiRoute> = ApiEndpoints[R]["body"];
type RouteResponse<R extends ApiRoute> = ApiEndpoints[R]["response"];

export type ApiReply<R extends ApiRoute> =
  | { readonly ok: true; readonly status: number; readonly body: RouteResponse<R> }
  | { readonly ok: false; readonly status: number; readonly body: ApiErrorBody | null };

/** One UI message stream chunk (`data: {...}`), as JSON. */
export type StreamChunk = JsonObject & { readonly type: string };

export interface ChatOptions {
  /** Called for every chunk while the stream is open (e.g. to decide an approval). */
  readonly onChunk?: (chunk: StreamChunk) => void | Promise<void>;
}

export class ApiClient {
  private cookie: string | null = null;
  private csrf: string | null = null;

  constructor(readonly baseUrl: string) {}

  /** GET /api/session: stores the cookie and CSRF token for later mutating calls. */
  async session(): Promise<SessionInfo> {
    const response = await fetch(`${this.baseUrl}${API_PATHS.session}`);
    if (!response.ok) throw new Error(`GET /api/session answered ${response.status}`);
    const cookie = response.headers.get("set-cookie");
    this.cookie = cookie === null ? null : (cookie.split(";")[0] ?? null);
    const info = (await response.json()) as SessionInfo;
    this.csrf = info.csrfToken;
    return info;
  }

  /** Any contract route, e.g. call("GET /api/runs/:runId", { params: { runId } }). */
  async call<R extends ApiRoute>(
    route: R,
    options: {
      readonly params?: RouteParams<R>;
      readonly query?: RouteQuery<R>;
      readonly body?: RouteBody<R>;
    } = {},
  ): Promise<ApiReply<R>> {
    const response = await this.send(route, options);
    const text = await response.text();
    const parsed: unknown = text === "" ? null : JSON.parse(text);
    return response.ok
      ? { ok: true, status: response.status, body: parsed as RouteResponse<R> }
      : { ok: false, status: response.status, body: parsed as ApiErrorBody | null };
  }

  /** Like call(), but throws unless the route answered 2xx. */
  async expect<R extends ApiRoute>(
    route: R,
    options: {
      readonly params?: RouteParams<R>;
      readonly query?: RouteQuery<R>;
      readonly body?: RouteBody<R>;
    } = {},
  ): Promise<RouteResponse<R>> {
    const reply = await this.call(route, options);
    if (!reply.ok)
      throw new Error(`${route} answered ${reply.status}: ${JSON.stringify(reply.body)}`);
    return reply.body;
  }

  /** POST /api/chat with one user message; resolves with every chunk once the stream ends. */
  async chat(
    conversationId: string,
    text: string,
    options: ChatOptions = {},
  ): Promise<StreamChunk[]> {
    const response = await this.send("POST /api/chat", {
      body: {
        conversationId,
        message: {
          id: `msg_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          role: "user",
          parts: [{ type: "text", text }],
        },
      },
    });
    if (!response.ok)
      throw new Error(`POST /api/chat answered ${response.status}: ${await response.text()}`);
    return readStream(response, options);
  }

  /** POST /api/approvals/:approvalId. */
  decide(
    approvalId: string,
    approved: boolean,
    reason?: string,
  ): Promise<ApiReply<"POST /api/approvals/:approvalId">> {
    return this.call("POST /api/approvals/:approvalId", {
      params: { approvalId },
      body: reason === undefined ? { approved } : { approved, reason },
    });
  }

  private async send<R extends ApiRoute>(
    route: R,
    options: {
      readonly params?: RouteParams<R>;
      readonly query?: RouteQuery<R>;
      readonly body?: RouteBody<R>;
    },
  ): Promise<Response> {
    const [method, template] = route.split(" ") as [string, string];
    // Reads need the session cookie too; the session and health routes do not.
    if (this.cookie === null && template !== API_PATHS.session && template !== API_PATHS.health) {
      await this.session();
    }
    let path = template;
    for (const [name, value] of Object.entries((options.params ?? {}) as Record<string, string>)) {
      path = path.replace(`:${name}`, encodeURIComponent(value));
    }
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries((options.query ?? {}) as Record<string, unknown>)) {
      if (value !== undefined && value !== null) query.set(name, String(value));
    }
    const url = `${this.baseUrl}${path}${query.size > 0 ? `?${query.toString()}` : ""}`;
    const headers: Record<string, string> = {};
    const mutating = method !== "GET";
    if (mutating) {
      if (this.csrf === null) throw new Error("Call session() before a mutating request");
      headers.origin = this.baseUrl;
      headers["content-type"] = "application/json";
      headers[CSRF_HEADER] = this.csrf;
    }
    if (this.cookie !== null) headers.cookie = this.cookie;
    return fetch(url, {
      method,
      headers,
      ...(mutating ? { body: JSON.stringify(options.body ?? {}) } : {}),
    });
  }
}

/** Reads a UI message stream to [DONE], handing each chunk to onChunk as it arrives. */
export async function readStream(
  response: Response,
  options: ChatOptions = {},
): Promise<StreamChunk[]> {
  if (response.body === null) return [];
  const chunks: StreamChunk[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const piece of response.body) {
    buffer += decoder.decode(piece as Uint8Array, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data === "" || data === "[DONE]") continue;
      const chunk = JSON.parse(data) as StreamChunk;
      chunks.push(chunk);
      await options.onChunk?.(chunk);
    }
  }
  return chunks;
}
