// Request guards for /api (docs/ARCHITECTURE.md §7 "Security"). Binding to
// 127.0.0.1 does not stop a page on another site from sending requests to it:
//
// - every request needs a loopback Host (127.0.0.1, localhost or [::1], any
//   port), so a DNS-rebinding page cannot reach the API under its own name;
// - GET /api/session sets the per-boot HttpOnly, SameSite=Strict cookie and
//   returns the matching CSRF token in JSON, which other origins cannot read;
// - every mutating request needs a same-origin Origin when one is sent (and
//   no cross-site Sec-Fetch-Site), Content-Type application/json, the cookie
//   and the token in x-rd-csrf.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { CSRF_HEADER, SESSION_COOKIE } from "../contracts/api.js";
import { apiError } from "./http.js";

export type SessionSecrets = {
  /** The rd_session cookie value. */
  readonly sessionId: string;
  /** Echoed by the client in x-rd-csrf. */
  readonly csrfToken: string;
};

export function createSessionSecrets(): SessionSecrets {
  return {
    sessionId: randomBytes(32).toString("base64url"),
    csrfToken: randomBytes(32).toString("base64url"),
  };
}

const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

/** True for a Host header naming 127.0.0.1, localhost or [::1], with any port. */
export function isLoopbackHostHeader(host: string): boolean {
  return LOOPBACK_HOST.test(host.trim());
}

/** The request's Host: the header, or the URL's host when the header is absent (in-process requests). */
export function requestHost(c: Context): string {
  return c.req.header("host") ?? new URL(c.req.url).host;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const JSON_CONTENT_TYPE = /^application\/json\s*(?:;|$)/i;

function sameValue(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isSameOrigin(origin: string, host: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" && parsed.host.toLowerCase() === host.trim().toLowerCase();
}

/** The /api guard. Mount before every /api route. */
export function apiGuard(secrets: SessionSecrets): MiddlewareHandler {
  return async (c, next) => {
    const host = requestHost(c);
    if (!isLoopbackHostHeader(host)) {
      return apiError(c, "forbidden_origin", "The API answers only on a loopback host name.");
    }
    if (SAFE_METHODS.has(c.req.method)) return next();

    const origin = c.req.header("origin");
    if (origin !== undefined && !isSameOrigin(origin, host)) {
      return apiError(c, "forbidden_origin", "Cross-origin requests are not allowed.");
    }
    const fetchSite = c.req.header("sec-fetch-site");
    if (fetchSite === "cross-site" || fetchSite === "same-site") {
      return apiError(c, "forbidden_origin", "Cross-origin requests are not allowed.");
    }
    if (!JSON_CONTENT_TYPE.test(c.req.header("content-type") ?? "")) {
      return apiError(
        c,
        "unsupported_media_type",
        "Send the request body as application/json (use {} when there is none).",
      );
    }
    if (
      !sameValue(getCookie(c, SESSION_COOKIE), secrets.sessionId) ||
      !sameValue(c.req.header(CSRF_HEADER), secrets.csrfToken)
    ) {
      return apiError(
        c,
        "csrf_failed",
        "The session token is missing or stale; reload the page to get a new one.",
      );
    }
    return next();
  };
}

/** Sets the session cookie (GET /api/session). */
export function setSessionCookie(c: Context, secrets: SessionSecrets): void {
  setCookie(c, SESSION_COOKIE, secrets.sessionId, {
    httpOnly: true,
    sameSite: "Strict",
    path: "/api",
  });
}
