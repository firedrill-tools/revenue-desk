// Request guards for /api (docs/ARCHITECTURE.md §7 "Security"). Binding to
// 127.0.0.1 does not stop a page on another site from sending requests to it:
//
// - every request needs a loopback Host (127.0.0.1, localhost or [::1], any
//   port), so a DNS-rebinding page cannot reach the API under its own name;
// - GET /api/session sets the per-boot HttpOnly, SameSite=Strict cookie and
//   returns the matching CSRF token in JSON, which other origins cannot read;
// - every other request, reads included, needs that cookie: conversations
//   and runs hold email bodies, invoices and charges, and a page on another
//   localhost port is same-site, so the cookie is the proof of this app;
// - every mutating request also needs a same-origin Origin when one is sent
//   (and no cross-site Sec-Fetch-Site), Content-Type application/json and the
//   token in x-rd-csrf.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { API_PATHS, CSRF_HEADER, SESSION_COOKIE } from "../contracts/api.js";
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
/** The only /api routes that answer without the session cookie: they hold no data. */
const OPEN_PATHS = new Set<string>([API_PATHS.health, API_PATHS.session]);
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
    if (OPEN_PATHS.has(c.req.path)) return next();
    if (!sameValue(getCookie(c, SESSION_COOKIE), secrets.sessionId)) {
      return apiError(
        c,
        "csrf_failed",
        "The session is missing or stale; reload the page to get a new one.",
      );
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
    if (!sameValue(c.req.header(CSRF_HEADER), secrets.csrfToken)) {
      return apiError(
        c,
        "csrf_failed",
        "The session token is missing or stale; reload the page to get a new one.",
      );
    }
    return next();
  };
}

/**
 * The page's Content-Security-Policy. Model text is rendered without images
 * (web/src/lib/markdown.ts); this is the second barrier: the browser loads
 * scripts, styles, fonts and images only from this origin (images also from
 * data: URLs the app itself makes), connects only to it, and is never framed.
 * Inline styles stay allowed for the component library.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Security headers on every response (the SPA and /api). */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const headers = c.res.headers;
    try {
      headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
      headers.set("x-content-type-options", "nosniff");
      headers.set("referrer-policy", "no-referrer");
      headers.set("x-frame-options", "DENY");
    } catch {
      // An immutable Response (none of the app's own) keeps its headers.
    }
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
