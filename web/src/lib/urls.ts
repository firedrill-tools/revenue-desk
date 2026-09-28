// URL checks for links the UI opens on the user's behalf.
//
// Alias-free and DOM-free so the Node test suite can import it.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * A Composio sign-in URL is opened only if it is https, or http on a loopback
 * host (the sandbox demo's local fake). Anything else (javascript:, data:,
 * plain http to a remote host) is refused.
 */
export function safeRedirectUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url.toString();
  return null;
}
