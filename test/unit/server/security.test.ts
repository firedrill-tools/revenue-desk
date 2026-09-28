// The /api guard (docs/ARCHITECTURE.md §7 "Security"): loopback Host,
// same-origin Origin, JSON bodies, and the per-boot cookie plus CSRF token.

import { afterEach, describe, expect, it } from "vitest";
import { CSRF_HEADER, SESSION_COOKIE, type SessionInfo } from "../../../src/contracts/api.js";
import { isLoopbackHostHeader } from "../../../src/server/security.js";
import { cleanupAll, createTestServer, HOST, ORIGIN } from "./harness.js";

afterEach(cleanupAll);

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

describe("loopback Host (DNS rebinding guard)", () => {
  it.each([
    ["127.0.0.1", true],
    ["127.0.0.1:4320", true],
    ["localhost:4321", true],
    ["LOCALHOST", true],
    ["[::1]:4320", true],
    ["[::1]", true],
    ["evil.test", false],
    ["evil.test:4320", false],
    ["127.0.0.2:4320", false],
    ["localhost.evil.test", false],
    ["127.0.0.1.nip.io", false],
    ["0.0.0.0:4320", false],
    ["", false],
  ])("%s -> %s", (host, expected) => {
    expect(isLoopbackHostHeader(host)).toBe(expected);
  });

  it("refuses reads and writes under a foreign host name", async () => {
    const server = createTestServer();
    for (const [method, path] of [
      ["GET", "/api/health"],
      ["GET", "/api/session"],
      ["GET", "/api/conversations"],
      ["POST", "/api/conversations"],
    ] as const) {
      const response = await server.request(method, path, undefined, {
        host: "rebound.evil.test:4320",
      });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await errorCode(response)).toBe("forbidden_origin");
    }
  });
});

describe("mutating requests", () => {
  it("accepts a same-origin JSON request with the cookie and token", async () => {
    const server = createTestServer();
    const response = await server.request("POST", "/api/conversations", { title: "Hello" });
    expect(response.status).toBe(201);
  });

  it("accepts a request without Origin (non-browser clients) when the token is valid", async () => {
    const server = createTestServer();
    const headers = new Headers({
      host: HOST,
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${server.services.secrets.sessionId}`,
      [CSRF_HEADER]: server.services.secrets.csrfToken,
    });
    const noOrigin = await server.app.request(`${ORIGIN}/api/conversations`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(noOrigin.status).toBe(201);
  });

  it.each([
    ["https://attacker.example", "a foreign site"],
    ["http://127.0.0.1:9999", "another loopback port"],
    ["https://127.0.0.1:4320", "another scheme"],
    ["null", "an opaque origin"],
  ])("refuses Origin %s (%s)", async (origin) => {
    const server = createTestServer();
    const response = await server.request("POST", "/api/conversations", {}, { origin });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden_origin");
  });

  it("refuses a cross-site fetch even without an Origin header", async () => {
    const server = createTestServer();
    const response = await server.request(
      "POST",
      "/api/conversations",
      {},
      {
        "sec-fetch-site": "cross-site",
      },
    );
    expect(response.status).toBe(403);
  });

  it.each([
    ["text/plain"],
    ["application/x-www-form-urlencoded"],
    ["multipart/form-data; boundary=x"],
    ["application/jsonp"],
  ])("refuses Content-Type %s with 415", async (contentType) => {
    const server = createTestServer();
    const response = await server.request(
      "POST",
      "/api/conversations",
      {},
      {
        "content-type": contentType,
      },
    );
    expect(response.status).toBe(415);
    expect(await errorCode(response)).toBe("unsupported_media_type");
  });

  it("accepts application/json with a charset", async () => {
    const server = createTestServer();
    const response = await server.request(
      "POST",
      "/api/conversations",
      {},
      {
        "content-type": "application/json; charset=utf-8",
      },
    );
    expect(response.status).toBe(201);
  });

  it.each([
    ["no token", { [CSRF_HEADER]: "" }],
    ["a wrong token", { [CSRF_HEADER]: "forged" }],
    ["no cookie", { cookie: "" }],
    ["a wrong cookie", { cookie: `${SESSION_COOKIE}=forged` }],
  ])("refuses a request with %s (403 csrf_failed)", async (_label, headers) => {
    const server = createTestServer();
    const response = await server.request("POST", "/api/conversations", {}, headers);
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("csrf_failed");
  });

  it("guards every mutating route, including PATCH and the approval decision", async () => {
    const server = createTestServer();
    for (const [method, path] of [
      ["POST", "/api/chat"],
      ["PATCH", "/api/conversations/x"],
      ["POST", "/api/runs/x/stop"],
      ["POST", "/api/approvals/x"],
      ["POST", "/api/connections/gmail/check"],
      ["POST", "/api/connections/gmail/connect"],
      ["PATCH", "/api/settings"],
      ["PATCH", "/api/policies"],
    ] as const) {
      const response = await server.request(method, path, {}, { [CSRF_HEADER]: "" });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });
});

describe("reads", () => {
  it("need the session cookie: conversations and runs hold email bodies and invoices", async () => {
    const server = createTestServer();
    const conversation = { id: await server.createConversation("Private") };
    for (const path of [
      "/api/conversations",
      `/api/conversations/${conversation.id}`,
      "/api/runs",
      "/api/runs/r_unknown",
      `/api/chat/${conversation.id}/stream`,
      "/api/connections",
      "/api/settings",
      "/api/policies",
    ]) {
      for (const cookie of ["", `${SESSION_COOKIE}=forged`]) {
        const response = await server.request("GET", path, undefined, { cookie });
        expect(response.status, `${path} ${cookie}`).toBe(403);
        expect(await errorCode(response)).toBe("csrf_failed");
      }
    }
    const allowed = await server.request("GET", `/api/conversations/${conversation.id}`);
    expect(allowed.status).toBe(200);
  });

  it("of health and the session itself need no cookie", async () => {
    const server = createTestServer();
    for (const path of ["/api/health", "/api/session"]) {
      const response = await server.request("GET", path, undefined, { cookie: "" });
      expect(response.status, path).toBe(200);
    }
  });
});

describe("GET /api/session", () => {
  it("sets the HttpOnly SameSite=Strict cookie and returns the matching token", async () => {
    const server = createTestServer({ runtime: { sandbox: true } });
    const response = await server.request("GET", "/api/session");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=${server.services.secrets.sessionId}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api/i);
    const info = (await response.json()) as SessionInfo;
    expect(info).toEqual({
      csrfToken: server.services.secrets.csrfToken,
      version: "0.0.0-test",
      mode: "sandbox",
      model: "claude-sonnet-5",
      effort: "medium",
      businessDate: "2026-09-28",
      approvalTimeoutMs: 900_000,
    });

    // The cookie and token from the session authorise a mutation.
    const created = await server.app.request(`${ORIGIN}/api/conversations`, {
      method: "POST",
      headers: {
        host: HOST,
        origin: ORIGIN,
        "content-type": "application/json",
        cookie: cookie.split(";")[0] ?? "",
        [CSRF_HEADER]: info.csrfToken,
      },
      body: "{}",
    });
    expect(created.status).toBe(201);
  });

  it("reports Settings' model and effort over the environment's", async () => {
    const server = createTestServer({ runtime: { businessDate: null } });
    await server.request("PATCH", "/api/settings", {
      defaultModel: "claude-opus-5",
      defaultEffort: "high",
      timezone: "Pacific/Kiritimati",
    });
    const info = (await (await server.request("GET", "/api/session")).json()) as SessionInfo;
    expect(info).toMatchObject({ mode: "normal", model: "claude-opus-5", effort: "high" });
    expect(info.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("the rest of /api", () => {
  it("answers health and a JSON 404 for unknown routes", async () => {
    const server = createTestServer();
    const health = await server.request("GET", "/api/health");
    expect(await health.json()).toEqual({
      status: "ok",
      service: "revenue-desk",
      version: "0.0.0-test",
    });
    const unknown = await server.request("GET", "/api/nope");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: { code: "not_found", message: "Unknown API route" },
    });
  });

  it("returns 400 for a body that is not JSON", async () => {
    const server = createTestServer();
    const response = await server.app.request(`${ORIGIN}/api/conversations`, {
      method: "POST",
      headers: {
        host: HOST,
        origin: ORIGIN,
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE}=${server.services.secrets.sessionId}`,
        [CSRF_HEADER]: server.services.secrets.csrfToken,
      },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_request");
  });
});
