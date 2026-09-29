// Composio configuration shared by Gmail, Google Calendar, QuickBooks and
// Slack (docs/ARCHITECTURE.md §3): COMPOSIO_API_KEY, COMPOSIO_USER_ID (no
// default in code), COMPOSIO_BASE_URL.

import type { AgentEnv, ConfigProblem, EnvVarName, SecretValue } from "../../contracts/env.js";
import { checkUrlVariable, hasSecret, hasValue, secretProblem } from "../shared/resolve.js";

export type ComposioConfig =
  | {
      readonly status: "configured";
      readonly apiKey: SecretValue;
      readonly userId: string;
      readonly baseUrl: string;
      readonly host: string;
    }
  | { readonly status: "not_configured"; readonly missing: readonly EnvVarName[] }
  | { readonly status: "invalid"; readonly problems: readonly ConfigProblem[] };

export function resolveComposioConfig(env: AgentEnv): ComposioConfig {
  const { apiKey, userId, baseUrl } = env.composio;
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
  const url = checkUrlVariable("COMPOSIO_BASE_URL", baseUrl);
  if (!url.ok) problems.push(url.problem);

  if (problems.length > 0 || !url.ok) return { status: "invalid", problems };
  return { status: "configured", apiKey, userId, baseUrl: url.value.url, host: url.value.host };
}
