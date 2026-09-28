// Loopback detection for URLs and host names: the sandbox demo refuses any
// other endpoint (docs/ARCHITECTURE.md §11).

const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** True for localhost, *.localhost, 127.0.0.0/8 and ::1 (with or without brackets). */
export function isLoopbackHost(host: string): boolean {
  const value = host
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value === "::1" ||
    value === "0:0:0:0:0:0:0:1" ||
    IPV4_LOOPBACK.test(value) ||
    /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)
  );
}

/** True when `url` parses as http(s) and names a loopback host. */
export function isLoopbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return isLoopbackHost(parsed.hostname);
}
