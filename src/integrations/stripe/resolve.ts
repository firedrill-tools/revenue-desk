// Stripe configuration (docs/ARCHITECTURE.md §3): STRIPE_SECRET_KEY,
// ALLOW_LIVE_STRIPE, STRIPE_API_BASE_URL, STRIPE_API_VERSION.

import type { AgentEnv, ConfigProblem } from "../../contracts/env.js";
import type { ConnectionResolution } from "../../contracts/integration.js";
import { checkUrlVariable, hasSecret, hasValue, secretProblem } from "../shared/resolve.js";

const TEST_KEY = /^(?:sk|rk)_test_/;
const LIVE_KEY = /^(?:sk|rk)_live_/;

export function resolveStripe(env: AgentEnv): ConnectionResolution<"stripe"> {
  const { secretKey, allowLive, apiBaseUrl, apiVersion } = env.stripe;
  if (!hasSecret(secretKey)) return { status: "not_configured", missing: ["STRIPE_SECRET_KEY"] };

  const problems: ConfigProblem[] = [];
  const keyProblem = secretProblem("STRIPE_SECRET_KEY", secretKey);
  if (keyProblem !== null) problems.push(keyProblem);
  const key = secretKey.reveal().trim();
  let keyMode: "test" | "live" = "test";
  if (LIVE_KEY.test(key)) {
    keyMode = "live";
    if (!allowLive) {
      problems.push({
        variable: "STRIPE_SECRET_KEY",
        message:
          "STRIPE_SECRET_KEY is a live key; live keys are refused unless ALLOW_LIVE_STRIPE=1",
      });
    }
  } else if (!TEST_KEY.test(key)) {
    problems.push({
      variable: "STRIPE_SECRET_KEY",
      message: "STRIPE_SECRET_KEY must be a secret or restricted key (sk_test_… or rk_test_…)",
    });
  }

  const url = checkUrlVariable("STRIPE_API_BASE_URL", apiBaseUrl);
  if (!url.ok) problems.push(url.problem);

  const version = hasValue(apiVersion) ? apiVersion.trim() : null;
  if (version !== null && !/^[0-9A-Za-z._-]+$/.test(version)) {
    problems.push({
      variable: "STRIPE_API_VERSION",
      message: "STRIPE_API_VERSION must look like 2025-09-30.clover",
    });
  }

  if (problems.length > 0 || !url.ok) return { status: "invalid", problems };
  return {
    status: "configured",
    connection: {
      integration: "stripe",
      kind: "api",
      profile: "stripe-api",
      endpointLabel: url.value.host,
      api: { baseUrl: url.value.url, secretKey, keyMode, apiVersion: version },
    },
  };
}
