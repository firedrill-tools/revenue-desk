// Composio configuration shared by Gmail, Google Calendar, QuickBooks and
// Slack (docs/ARCHITECTURE.md §3): COMPOSIO_API_KEY and COMPOSIO_USER_ID (no
// default in code). The API host is pinned (src/integrations/shared/vendors.ts).

import type { AgentEnv, ConfigProblem, EnvVarName, SecretValue } from "../../contracts/env.js";
import { hasSecret, hasValue, secretProblem } from "../shared/resolve.js";
import { hostOf } from "../shared/url.js";
import { COMPOSIO_API_ORIGIN } from "../shared/vendors.js";

export type ComposioConfig =
  | {
      readonly status: "configured";
      readonly apiKey: SecretValue;
      readonly userId: string;
      /** backend.composio.dev, for labels. */
      readonly host: string;
    }
  | { readonly status: "not_configured"; readonly missing: readonly EnvVarName[] }
  | { readonly status: "invalid"; readonly problems: readonly ConfigProblem[] };

export function resolveComposioConfig(env: AgentEnv): ComposioConfig {
  const { apiKey, userId } = env.composio;
  const missing: EnvVarName[] = [];
  if (!hasSecret(apiKey)) missing.push("COMPOSIO_API_KEY");
  if (!hasValue(userId)) missing.push("COMPOSIO_USER_ID");
  if (!hasSecret(apiKey) || !hasValue(userId)) return { status: "not_configured", missing };

  const problems: ConfigProblem[] = [];
  const keyProblem = secretProblem("COMPOSIO_API_KEY", apiKey);
  if (keyProblem !== null) problems.push(keyProblem);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects.
  if (userId !== userId.trim() || /[\u0000-\u001f\u007f]/.test(userId)) {
    problems.push({
      variable: "COMPOSIO_USER_ID",
      message: "COMPOSIO_USER_ID contains whitespace or control characters",
    });
  }

  if (problems.length > 0) return { status: "invalid", problems };
  return { status: "configured", apiKey, userId, host: hostOf(COMPOSIO_API_ORIGIN) };
}
