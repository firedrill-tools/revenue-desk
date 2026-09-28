// The Slack integration: API kind, profile slack-api.

import {
  INTEGRATIONS,
  type ProbeResult,
  type SlackConnection,
} from "../../contracts/integration.js";
import type { ApiIntegration, ApiIntegrationDeps } from "../shared/definition.js";
import { probeFailure } from "../shared/errors.js";
import type { HttpDeps } from "../shared/http.js";
import { str } from "../shared/json.js";
import { maskIdentifier, sentence } from "../shared/text.js";
import { classifySlack } from "./classify.js";
import { SlackClient } from "./client.js";
import { checkSlackInput } from "./input-rules.js";
import { SLACK_PROFILE } from "./profile.js";
import { resolveSlack } from "./resolve.js";
import { createSlackTools } from "./tools.js";

const REJECTED = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked"]);

export function slackClientFor(connection: SlackConnection, http?: HttpDeps): SlackClient {
  return new SlackClient({
    baseUrl: connection.api.baseUrl,
    botToken: connection.api.botToken,
    ...(http === undefined ? {} : { http }),
  });
}

/** Read-only check: auth.test names the workspace and the bot user. */
export async function probeSlack(
  connection: SlackConnection,
  signal: AbortSignal,
  http?: HttpDeps,
): Promise<ProbeResult> {
  try {
    const body = await slackClientFor(connection, http).read("auth.test", {}, signal);
    const team = str(body, "team");
    const user = str(body, "user");
    const teamId = str(body, "team_id");
    const who = [
      team === undefined ? undefined : `Connected to ${team}`,
      user === undefined ? undefined : `as ${user}`,
    ]
      .filter((part) => part !== undefined)
      .join(" ");
    return {
      state: "connected",
      detail: who === "" ? "Slack accepted the bot token." : sentence(who),
      accountHint: teamId === undefined ? null : maskIdentifier(teamId),
    };
  } catch (error) {
    return probeFailure("Slack", error, {
      expired: (failure) => failure.code === "token_expired",
      rejected: (failure) =>
        failure.status === 401 ||
        failure.status === 403 ||
        (failure.code !== null && (REJECTED.has(failure.code) || failure.code === "missing_scope")),
    });
  }
}

export function createSlackIntegration(deps: ApiIntegrationDeps = {}): ApiIntegration<"slack"> {
  return {
    id: "slack",
    label: INTEGRATIONS.slack.label,
    kind: "api",
    profile: SLACK_PROFILE,
    resolve: resolveSlack,
    classify: classifySlack,
    probe: (connection, signal) => probeSlack(connection, signal, deps.http),
    tools: (connection, options) =>
      createSlackTools(slackClientFor(connection, deps.http), options),
    // Mentions must be Slack user ids; a plain @name or another system's id notifies nobody.
    checkInput: checkSlackInput,
  };
}
