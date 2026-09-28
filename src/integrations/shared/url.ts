// Base URLs for integrations: validation at resolve time and prefix-preserving
// joins at call time (docs/ARCHITECTURE.md §3: "Base URLs may contain a path
// prefix; clients join paths without dropping it").

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** True for localhost, *.localhost, 127.0.0.0/8 and ::1 (with or without brackets). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    LOOPBACK_V4.test(host) ||
    /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

export type BaseUrlCheck =
  | {
      readonly ok: true;
      /** Normalised: origin plus path, without a trailing slash. */
      readonly url: string;
      /** Host (and port) only; safe to show, log and store. */
      readonly host: string;
      readonly loopback: boolean;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Validates a configured base URL. HTTPS is required, except that plain HTTP
 * is accepted for loopback hosts (local fakes and the sandbox demo). A base
 * URL never carries credentials, a query or a fragment.
 */
export function checkBaseUrl(raw: string): BaseUrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, message: "is not a valid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: "must use https" };
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    return {
      ok: false,
      message: "must use https (plain http is accepted only for loopback hosts)",
    };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, message: "must not contain credentials" };
  }
  if (url.search !== "" || url.hash !== "") {
    return { ok: false, message: "must not contain a query or a fragment" };
  }
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${url.origin}${path}`, host: url.host, loopback };
}

/** The host of a URL for labels; the raw string when it cannot be parsed. */
export function hostOf(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
}

export type QueryValue = string | number | boolean | null | undefined;

/**
 * Joins a base URL (which may end in a path prefix) and a path, keeping the
 * prefix, then appends query parameters. Null and undefined values are skipped.
 */
export function joinUrl(
  base: string,
  path: string,
  query: Readonly<Record<string, QueryValue>> | URLSearchParams = {},
): string {
  const joined = `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  const params =
    query instanceof URLSearchParams
      ? query
      : new URLSearchParams(
          Object.entries(query).flatMap(([key, value]): [string, string][] =>
            value === null || value === undefined ? [] : [[key, String(value)]],
          ),
        );
  const search = params.toString();
  return search === "" ? joined : `${joined}?${search}`;
}
