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
    }
  | { readonly ok: false; readonly message: string };

export type BaseUrlOptions = {
  /**
   * Accept plain HTTP on a loopback host: an MCP server the user runs on
   * this machine (HUBSPOT_MCP_URL). Every service base URL is HTTPS only.
   */
  readonly allowLoopbackHttp?: boolean;
};

/**
 * Validates a configured base URL. HTTPS is required (see BaseUrlOptions for
 * the one exception). A base URL never carries credentials, a query or a
 * fragment.
 */
export function checkBaseUrl(raw: string, options: BaseUrlOptions = {}): BaseUrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, message: "is not a valid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: "must use https" };
  }
  if (url.protocol === "http:" && !(options.allowLoopbackHttp && isLoopbackHost(url.hostname))) {
    return {
      ok: false,
      message: options.allowLoopbackHttp
        ? "must use https (plain http is accepted only for a server on this machine)"
        : "must use https",
    };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, message: "must not contain credentials" };
  }
  if (url.search !== "" || url.hash !== "") {
    return { ok: false, message: "must not contain a query or a fragment" };
  }
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${url.origin}${path}`, host: url.host };
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
