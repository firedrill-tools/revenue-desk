// QuickBooks configuration (docs/ARCHITECTURE.md §3): QBO_ACCESS_TOKEN,
// QBO_REALM_ID, QBO_API_BASE_URL, QBO_MINOR_VERSION.

import type { AgentEnv, ConfigProblem, EnvVarName } from "../../contracts/env.js";
import type { ConnectionResolution } from "../../contracts/integration.js";
import { checkUrlVariable, hasSecret, hasValue, secretProblem } from "../shared/resolve.js";

export function resolveQuickBooks(env: AgentEnv): ConnectionResolution<"quickbooks"> {
  const { accessToken, realmId, apiBaseUrl, minorVersion } = env.quickbooks;
  const missing: EnvVarName[] = [];
  if (!hasSecret(accessToken)) missing.push("QBO_ACCESS_TOKEN");
  if (!hasValue(realmId)) missing.push("QBO_REALM_ID");
  if (!hasSecret(accessToken) || !hasValue(realmId)) return { status: "not_configured", missing };

  const problems: ConfigProblem[] = [];
  const tokenProblem = secretProblem("QBO_ACCESS_TOKEN", accessToken);
  if (tokenProblem !== null) problems.push(tokenProblem);
  const realm = realmId.trim();
  if (!/^[A-Za-z0-9]{1,64}$/.test(realm)) {
    problems.push({
      variable: "QBO_REALM_ID",
      message: "QBO_REALM_ID must be the company's id (digits)",
    });
  }
  const version = hasValue(minorVersion) ? minorVersion.trim() : null;
  if (version !== null && !/^\d{1,4}$/.test(version)) {
    problems.push({
      variable: "QBO_MINOR_VERSION",
      message: "QBO_MINOR_VERSION must be a number, e.g. 75",
    });
  }
  const url = checkUrlVariable("QBO_API_BASE_URL", apiBaseUrl);
  if (!url.ok) problems.push(url.problem);

  if (problems.length > 0 || !url.ok) return { status: "invalid", problems };
  return {
    status: "configured",
    connection: {
      integration: "quickbooks",
      kind: "api",
      profile: "quickbooks-api",
      endpointLabel: url.value.host,
      api: { baseUrl: url.value.url, accessToken, realmId: realm, minorVersion: version },
    },
  };
}
