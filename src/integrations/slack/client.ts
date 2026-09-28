// A typed fetch client for the Slack Web API (https://slack.com/api/<method>).
//
// - Bot token as a Bearer credential; form-encoded POST bodies.
// - Slack reports most errors as HTTP 200 with {ok:false, error}; HTTP 4xx
//   and 5xx are handled too, and 429 carries Retry-After.
// - Reads retry on 429 and pre-send network errors; writes never retry
//   (Slack has no idempotency key, so a retried post could appear twice).

import type { SecretValue } from "../../contracts/env.js";
import type { JsonObject, JsonValue } from "../../contracts/json.js";
import { ApiToolError, transportFailure } from "../shared/errors.js";
import { type HttpDeps, sendHttp, TransportError } from "../shared/http.js";
import { asObject, bool, str } from "../shared/json.js";
import { scrub } from "../shared/text.js";
import { joinUrl } from "../shared/url.js";

export const SLACK_PROVIDER = "slack";

export type SlackParams = Readonly<Record<string, string | number | boolean | undefined>>;

export type SlackClientOptions = {
  readonly baseUrl: string;
  readonly botToken: SecretValue;
  readonly http?: HttpDeps;
};

const MESSAGES: Readonly<Record<string, string>> = {
  channel_not_found: "The channel was not found, or the bot cannot see it.",
  not_in_channel: "The bot is not a member of this channel; invite it to the channel first.",
  is_archived: "The channel is archived.",
  invalid_auth: "Slack rejected the bot token.",
  not_authed: "No bot token was sent.",
  account_inactive: "The bot token belongs to a deactivated app or workspace.",
  token_revoked: "The bot token has been revoked.",
  token_expired: "The bot token has expired.",
  ratelimited: "Slack's rate limit was reached; try again later.",
  msg_too_long: "The message is too long.",
  no_text: "The message has no text.",
  restricted_action: "The workspace does not allow the bot to do this.",
  user_not_found: "The user was not found.",
  thread_not_found: "The thread was not found.",
  message_not_found: "The message was not found.",
  already_reacted: "The bot already added this reaction.",
  invalid_name: "That emoji name does not exist.",
  invalid_cursor: "The page cursor is invalid or expired.",
};

/** A Slack error code as an ApiToolError with a plain message. */
export function slackError(
  status: number,
  body: JsonValue | undefined,
  secrets: readonly string[] = [],
): ApiToolError {
  const root = asObject(body);
  const code = str(root, "error") ?? (status === 429 ? "ratelimited" : `http_${status}`);
  let message =
    MESSAGES[code] ??
    `Slack returned ${code === `http_${status}` ? `HTTP ${status}` : `error ${code}`}.`;
  if (code === "missing_scope") {
    const needed = str(root, "needed");
    message = `The bot token lacks the ${needed ?? "required"} scope.`;
  }
  return new ApiToolError(SLACK_PROVIDER, scrub(message, secrets), { status, code });
}

export class SlackClient {
  readonly #baseUrl: string;
  readonly #botToken: SecretValue;
  readonly #http: HttpDeps;

  constructor(options: SlackClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#botToken = options.botToken;
    this.#http = options.http ?? {};
  }

  /** A side-effect-free method (conversations.history, users.info, …). */
  read(method: string, params: SlackParams, signal: AbortSignal | undefined): Promise<JsonObject> {
    return this.#call(method, params, true, signal);
  }

  /** A method with side effects (chat.postMessage, reactions.add). Never retried. */
  write(method: string, params: SlackParams, signal: AbortSignal | undefined): Promise<JsonObject> {
    return this.#call(method, params, false, signal);
  }

  async #call(
    method: string,
    params: SlackParams,
    retryable: boolean,
    signal: AbortSignal | undefined,
  ): Promise<JsonObject> {
    if (!/^[a-z]+(?:\.[a-zA-Z]+)+$/.test(method))
      throw new Error(`invalid Slack method: ${method}`);
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) form.set(key, String(value));
    }
    const token = this.#botToken.reveal();
    let response: Awaited<ReturnType<typeof sendHttp>>;
    try {
      response = await sendHttp(
        {
          method: "POST",
          url: joinUrl(this.#baseUrl, `api/${method}`),
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded; charset=utf-8",
          },
          body: form.toString(),
          retryable,
          signal,
        },
        this.#http,
      );
    } catch (error) {
      if (error instanceof TransportError) throw transportFailure(SLACK_PROVIDER, error);
      throw error;
    }
    const body = asObject(response.json);
    if (response.status < 200 || response.status >= 300 || bool(body, "ok") !== true) {
      throw slackError(response.status, response.json, [token]);
    }
    return body ?? {};
  }
}
