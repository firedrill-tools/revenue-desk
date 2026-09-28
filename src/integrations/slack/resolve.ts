// Slack configuration (docs/ARCHITECTURE.md §3): SLACK_BOT_TOKEN, SLACK_API_BASE_URL.

import type { AgentEnv, ConfigProblem } from "../../contracts/env.js";
import type { ConnectionResolution } from "../../contracts/integration.js";
import { checkUrlVariable, hasSecret, secretProblem } from "../shared/resolve.js";

export function resolveSlack(env: AgentEnv): ConnectionResolution<"slack"> {
  const { botToken, apiBaseUrl } = env.slack;
  if (!hasSecret(botToken)) return { status: "not_configured", missing: ["SLACK_BOT_TOKEN"] };

  const problems: ConfigProblem[] = [];
  const tokenProblem = secretProblem("SLACK_BOT_TOKEN", botToken);
  if (tokenProblem !== null) problems.push(tokenProblem);
  if (!botToken.reveal().trim().startsWith("xoxb-")) {
    problems.push({
      variable: "SLACK_BOT_TOKEN",
      message: "SLACK_BOT_TOKEN must be a bot token (xoxb-…)",
    });
  }
  const url = checkUrlVariable("SLACK_API_BASE_URL", apiBaseUrl);
  if (!url.ok) problems.push(url.problem);

  if (problems.length > 0 || !url.ok) return { status: "invalid", problems };
  return {
    status: "configured",
    connection: {
      integration: "slack",
      kind: "api",
      profile: "slack-api",
      endpointLabel: url.value.host,
      api: { baseUrl: url.value.url, botToken },
    },
  };
}
