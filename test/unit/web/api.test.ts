// The web client's typed API client (web/src/lib/api.ts): paths, queries,
// errors, the CSRF header on mutating requests and the retry after a stale
// per-boot token.

import { describe, expect, it } from "vitest";
import { CSRF_HEADER, type SessionInfo } from "../../../src/contracts/api.js";
import {
  ApiError,
  buildPath,
  buildQuery,
  createApiClient,
  errorMessage,
  parseApiError,
  parseTransportError,
} from "../../../web/src/lib/api.js";

type Recorded = { url: string; method: string; headers: Headers; body: string | null };

function session(token: string): SessionInfo {
  return {
    csrfToken: token,
    version: "0.0.0-test",
    mode: "normal",
    model: "claude-sonnet-5",
    effort: "medium",
    businessDate: "2026-09-28",
    approvalTimeoutMs: 900_000,
    modelConfigured: true,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fake server: GET /api/session hands out tokens in order; `handle` answers the rest. */
function fakeServer(handle: (request: Recorded, token: string) => Response, tokens = ["t1", "t2"]) {
  const requests: Recorded[] = [];
  let sessions = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const recorded: Recorded = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    };
    requests.push(recorded);
    if (url.endsWith("/api/session")) {
      const token = tokens[Math.min(sessions, tokens.length - 1)] ?? "t";
      sessions += 1;
      return json(session(token));
    }
    return handle(recorded, tokens[Math.max(0, sessions - 1)] ?? "t");
  };
  return { fetch, requests, sessionCount: () => sessions };
}

describe("buildPath and buildQuery", () => {
  it("fills and encodes params", () => {
    expect(buildPath("/api/runs/:runId/stop", { runId: "run 1/2" })).toBe(
      "/api/runs/run%201%2F2/stop",
    );
  });

  it("refuses a missing param", () => {
    expect(() => buildPath("/api/runs/:runId", {})).toThrow(/runId/);
  });

  it("skips empty values", () => {
    expect(buildQuery({ q: "acme", limit: 20, cursor: undefined, status: "" })).toBe(
      "?q=acme&limit=20",
    );
    expect(buildQuery({})).toBe("");
    expect(buildQuery(undefined)).toBe("");
  });
});

describe("parseApiError", () => {
  it("keeps the contract code, message and issues", () => {
    const error = parseApiError(400, {
      error: {
        code: "invalid_request",
        message: "Bad body.",
        issues: [{ path: "currency", message: "Three letters." }],
      },
    });
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("invalid_request");
    expect(error.message).toBe("Bad body.");
    expect(error.issues).toEqual([{ path: "currency", message: "Three letters." }]);
  });

  it("falls back for unknown bodies", () => {
    expect(parseApiError(502, "<html>").code).toBe("internal");
    expect(parseApiError(418, { error: { code: "teapot", message: "x" } }).code).toBe(
      "unexpected_response",
    );
  });

  it("reads transport errors, whose message is the raw response text", () => {
    const parsed = parseTransportError(
      new Error(JSON.stringify({ error: { code: "run_active", message: "Busy." } })),
    );
    expect(parsed?.code).toBe("run_active");
    expect(parseTransportError(new Error("Failed to fetch"))).toBeNull();
  });

  it("gives a safe message for any thrown value", () => {
    expect(errorMessage(new ApiError("Shown.", { status: 404, code: "not_found" }))).toBe("Shown.");
    expect(errorMessage(new TypeError("internal detail"), "Fallback.")).toBe("Fallback.");
  });
});

describe("createApiClient", () => {
  it("sends GET requests without a body or CSRF header, after the session sets its cookie", async () => {
    const server = fakeServer(() => json({ items: [], nextCursor: null }));
    const client = createApiClient({ fetch: server.fetch });
    const page = await client.request("GET /api/conversations", {
      query: { q: "kestrel", limit: 10 },
    });
    expect(page.items).toEqual([]);
    // Every /api read needs the session cookie, which GET /api/session sets.
    expect(server.requests.map((request) => request.url)).toEqual([
      "/api/session",
      "/api/conversations?q=kestrel&limit=10",
    ]);
    const request = server.requests.at(-1);
    expect(request?.method).toBe("GET");
    expect(request?.body).toBeNull();
    expect(request?.headers.has(CSRF_HEADER)).toBe(false);
    expect(server.sessionCount()).toBe(1);
  });

  it("re-reads the session once when a read finds it stale, and retries the read", async () => {
    let reads = 0;
    const server = fakeServer(() => {
      reads += 1;
      return reads === 1
        ? json({ error: { code: "csrf_failed", message: "Stale." } }, 403)
        : json({ items: [], nextCursor: null });
    });
    const client = createApiClient({ fetch: server.fetch });
    await expect(client.request("GET /api/runs")).resolves.toMatchObject({ items: [] });
    expect(server.sessionCount()).toBe(2);
    expect(reads).toBe(2);
  });

  it("sends JSON and the session's CSRF token on mutating requests, {} when there is no body", async () => {
    const server = fakeServer((request, token) =>
      request.headers.get(CSRF_HEADER) === token
        ? json({ runId: "run_1", status: "stopping" }, 202)
        : json({ error: { code: "csrf_failed", message: "No." } }, 403),
    );
    const client = createApiClient({ fetch: server.fetch });
    const response = await client.request("POST /api/runs/:runId/stop", {
      params: { runId: "run_1" },
    });
    expect(response.status).toBe("stopping");
    const request = server.requests.at(-1);
    expect(request?.url).toBe("/api/runs/run_1/stop");
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(request?.body).toBe("{}");
  });

  it("caches the session across requests", async () => {
    const server = fakeServer(() => json({ status: "accepted", approvalId: "a" }));
    const client = createApiClient({ fetch: server.fetch });
    await client.request("POST /api/approvals/:approvalId", {
      params: { approvalId: "a" },
      body: { approved: true },
    });
    await client.request("POST /api/approvals/:approvalId", {
      params: { approvalId: "b" },
      body: { approved: false },
    });
    expect(server.sessionCount()).toBe(1);
  });

  it("re-reads the session once after a stale token (server restart) and retries", async () => {
    const server = fakeServer((request) =>
      request.headers.get(CSRF_HEADER) === "t2"
        ? json({ settings: { companyName: "Kestrel" } })
        : json({ error: { code: "csrf_failed", message: "Stale." } }, 403),
    );
    const client = createApiClient({ fetch: server.fetch });
    const response = await client.request("PATCH /api/settings", {
      body: { companyName: "Kestrel" },
    });
    expect(response.settings.companyName).toBe("Kestrel");
    expect(server.sessionCount()).toBe(2);
    const mutations = server.requests.filter((request) => request.method === "PATCH");
    expect(mutations.map((request) => request.headers.get(CSRF_HEADER))).toEqual(["t1", "t2"]);
  });

  it("does not retry other 403s", async () => {
    const server = fakeServer(() =>
      json({ error: { code: "forbidden_origin", message: "Cross-origin." } }, 403),
    );
    const client = createApiClient({ fetch: server.fetch });
    await expect(client.request("POST /api/conversations", { body: {} })).rejects.toMatchObject({
      code: "forbidden_origin",
      status: 403,
    });
    expect(server.sessionCount()).toBe(1);
  });

  it("maps error bodies and network failures to ApiError", async () => {
    const notFound = createApiClient({
      fetch: fakeServer(() => json({ error: { code: "not_found", message: "No such run." } }, 404))
        .fetch,
    });
    await expect(
      notFound.request("GET /api/runs/:runId", { params: { runId: "x" } }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: "No such run.",
    });

    const offline = createApiClient({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(offline.request("GET /api/connections")).rejects.toMatchObject({
      code: "network_error",
      status: 0,
    });
    await expect(offline.session()).rejects.toMatchObject({ code: "network_error" });
  });

  it("does not cache a failed session read", async () => {
    let calls = 0;
    const client = createApiClient({
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? json({ error: { code: "internal", message: "Boot." } }, 500)
          : json(session("ok"));
      },
    });
    await expect(client.session()).rejects.toBeInstanceOf(ApiError);
    await expect(client.session()).resolves.toMatchObject({ csrfToken: "ok" });
  });
});
