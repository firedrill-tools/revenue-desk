// URL checks for links the UI opens on the user's behalf.
//
// Alias-free and DOM-free so the Node test suite can import it.

import { INTEGRATION_IDS, type IntegrationId } from "../../../src/contracts/integration.js";

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

/**
 * The integration a Composio sign-in returned for: the server's Connect
 * callback is `/connections?connected=<integration>`. Anything else is null.
 */
export function signInReturn(search: string): IntegrationId | null {
  const value = new URLSearchParams(search).get("connected");
  return INTEGRATION_IDS.find((id) => id === value) ?? null;
}
