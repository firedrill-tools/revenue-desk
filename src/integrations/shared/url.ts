// URL helpers for the integrations: prefix-preserving joins at call time, and
// the check that a URL a vendor hands back (Composio's session MCP endpoint,
// its Connect sign-in link) points at a public HTTPS host, never at this
// machine or a private network.
//
// Service base URLs are not configurable (src/integrations/shared/vendors.ts).

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

/** The four octets of a dotted-quad IPv4 address, or null. */
function ipv4Octets(host: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return octets as [number, number, number, number];
}

/**
 * True for an IPv4 address that is not on the public internet: this network
 * (0/8), private (10/8, 172.16/12, 192.168/16), shared (100.64/10), loopback
 * (127/8), link-local (169.254/16), IETF protocol (192.0.0/24), benchmarking
 * (198.18/15), multicast and reserved (224/3).
 */
function isNonPublicIpv4([a, b]: readonly number[]): boolean {
  if (a === undefined || b === undefined) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** The eight 16-bit groups of an IPv6 address (brackets removed), or null. */
function ipv6Groups(host: string): number[] | null {
  if (!host.includes(":")) return null;
  let text = host;
  const tail: number[] = [];
  const dotted = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted !== null) {
    const octets = ipv4Octets(dotted[1] ?? "");
    if (octets === null) return null;
    tail.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    // Drop the address and its colon, unless that colon ends a "::".
    const before = text.slice(0, dotted.index + 1);
    text = before.endsWith("::") ? before : before.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string | undefined): number[] | null => {
    if (part === undefined || part === "") return [];
    const groups = part
      .split(":")
      .map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN));
    return groups.some(Number.isNaN) ? null : groups;
  };
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (head === null || rest === null) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1 && known !== 8) return null;
  if (halves.length === 2 && known > 7) return null;
  return [...head, ...new Array<number>(8 - known).fill(0), ...rest, ...tail];
}

/**
 * True for an IPv6 address that is not on the public internet: unspecified
 * and loopback, link-local (fe80::/10), site-local (fec0::/10), unique local
 * (fc00::/7), multicast (ff00::/8), local-use NAT64 (64:ff9b:1::/48), and an
 * IPv4 address carried inside IPv6 (mapped ::ffff:0:0/96, translated
 * ::ffff:0:0:0/96, compatible ::/96, NAT64 64:ff9b::/96, 6to4 2002::/16)
 * whose IPv4 address is not public.
 */
function isNonPublicIpv6(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const embedded = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
  const firstFour = [g0, g1, g2, g3].every((group) => group === 0);
  if (firstFour && g4 === 0 && (g5 === 0 || g5 === 0xffff)) {
    // ::, ::1, ::a.b.c.d and ::ffff:a.b.c.d
    return g5 === 0 && g6 === 0 ? true : isNonPublicIpv4(embedded);
  }
  if (firstFour && g4 === 0xffff && g5 === 0) {
    // ::ffff:0:a.b.c.d (IPv4-translated)
    return isNonPublicIpv4(embedded);
  }
  if (g0 === 0x64 && g1 === 0xff9b) {
    // 64:ff9b:1::/48 is NAT64 for a local network (RFC 8215): never public.
    if (g2 === 1) return true;
    if ([g2, g3, g4, g5].every((group) => group === 0)) return isNonPublicIpv4(embedded);
  }
  if (g0 === 0x2002) {
    // 6to4: the IPv4 address sits in the second and third groups.
    return isNonPublicIpv4([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]);
  }
  return (
    (g0 & 0xffc0) === 0xfe80 ||
    (g0 & 0xffc0) === 0xfec0 ||
    (g0 & 0xfe00) === 0xfc00 ||
    (g0 & 0xff00) === 0xff00
  );
}

/**
 * True when a URL's hostname names this machine or a private network: a
 * loopback, private, link-local or otherwise non-public IP address (IPv4 or
 * IPv6), `localhost` and `*.localhost`, the private-use `*.local` and
 * `*.internal` names, or a single-label name that only a local resolver can
 * answer. Pass `URL.hostname`, which the URL parser has already normalised
 * (`0x7f.1` becomes `127.0.0.1`, `[::ffff:127.0.0.1]` becomes
 * `[::ffff:7f00:1]`). It judges the name as written; it does not resolve it.
 */
export function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (host === "") return true;
  const v4 = ipv4Octets(host);
  if (v4 !== null) return isNonPublicIpv4(v4);
  const v6 = ipv6Groups(host);
  if (v6 !== null) return isNonPublicIpv6(v6);
  if (host.includes(":")) return true; // not an address the parser would produce
  return (
    isLoopbackHost(host) ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".")
  );
}

export type VendorUrlCheck =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: string };

/**
 * A URL handed back by a vendor, accepted only when it is HTTPS, carries no
 * credentials and names a public host (isPrivateNetworkHost). The reason is
 * safe to show: it never repeats the URL.
 */
export function checkVendorUrl(raw: string): VendorUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "is not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "is not HTTPS" };
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "contains credentials" };
  }
  if (isPrivateNetworkHost(url.hostname)) {
    return { ok: false, reason: "points at this machine or a private network" };
  }
  return { ok: true, url };
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
