// URL checks for links the UI opens on the user's behalf.
//
// Alias-free and DOM-free so the Node test suite can import it.

import { INTEGRATION_IDS, type IntegrationId } from "../../../src/contracts/integration.js";

/**
 * A Composio sign-in URL is opened only if it is https. Anything else
 * (javascript:, data:, plain http) is refused.
 */
export function safeRedirectUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  return url.protocol === "https:" ? url.toString() : null;
}

/**
 * The integration a Composio sign-in returned for: the server's Connect
 * callback is `/connections?connected=<integration>`. Anything else is null.
 */
export function signInReturn(search: string): IntegrationId | null {
  const value = new URLSearchParams(search).get("connected");
  return INTEGRATION_IDS.find((id) => id === value) ?? null;
}
