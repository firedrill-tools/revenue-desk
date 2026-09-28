// Connect for Composio integrations (docs/ARCHITECTURE.md §9): Composio's
// hosted sign-in, started only from the user's click. Every call starts a new
// link flow, so nothing else calls this.

import type { ComposioConnection } from "../contracts/integration.js";
import { ComposioSessionManager } from "../integrations/composio/session.js";
import type { ComposioAuthorizer } from "./connections.js";

export function createComposioAuthorizer(): ComposioAuthorizer {
  const managers = new Map<string, ComposioSessionManager>();
  return async (connection: ComposioConnection, callbackUrl: string) => {
    const { apiKey, userId, baseUrl, toolkit } = connection.composio;
    const key = `${baseUrl}\n${userId}`;
    let manager = managers.get(key);
    if (manager === undefined) {
      manager = new ComposioSessionManager({ apiKey: apiKey.reveal(), userId, baseURL: baseUrl });
      managers.set(key, manager);
    }
    const { redirectUrl } = await manager.authorize(toolkit, callbackUrl);
    return { redirectUrl };
  };
}
