// Slack channels and mentions as the Composio Slack tools take and return
// them. SLACK_SEND_MESSAGE takes a channel id (C…, G…, D…) or a name with or
// without "#"; the workspace's allowlist holds names such as "#billing" (or
// ids). A channel id says nothing about which channel it is: its name comes
// only from Slack's own results (SlackRunMemory).

import type { JsonObject, JsonValue } from "../../contracts/json.js";
import { asObject, bool, field, isObject, obj, str } from "../shared/json.js";

export const SLACK_ID = {
  /** Public (C), private (G) and direct (D) conversation ids. */
  channel: /^[CGD][A-Z0-9]{2,}$/,
  user: /^[UW][A-Z0-9]{2,}$/,
} as const;

/** A channel as a Slack result in this run described it. */
export type KnownChannel = {
  readonly id: string;
  /** Lower case, without "#". */
  readonly name: string | null;
  /** Shared with another organisation (Slack Connect): a post reaches people outside the company. */
  readonly externallyShared: boolean;
};

/** Lookups into the channels the run's earlier Slack calls returned. */
export interface SlackKnown {
  channelById(id: string): KnownChannel | undefined;
  channelByName(name: string): KnownChannel | undefined;
}

export const NOTHING_KNOWN: SlackKnown = {
  channelById: () => undefined,
  channelByName: () => undefined,
};

export function isChannelId(value: string): boolean {
  return SLACK_ID.channel.test(value.trim());
}

/** A user id given as the channel: Slack delivers the post as a direct message. */
export function isUserId(value: string): boolean {
  return SLACK_ID.user.test(value.trim());
}

/** "#Billing", "billing" -> "billing"; channel and user ids keep their case. */
export function normaliseChannel(channel: string): string {
  const trimmed = channel.trim();
  if (isChannelId(trimmed) || isUserId(trimmed)) return trimmed;
  return trimmed.replace(/^#/, "").toLowerCase();
}

/**
 * A plain "@" that starts a mention: not inside a word, an email address
 * ("ap@here.example") or Slack's own syntax ("<@U…>"), but after a space, a
 * bracket or Markdown emphasis ("*@here*", "_@channel_", "`@everyone`").
 */
export const MENTION_START = "(?<![A-Za-z0-9.@+<-])@";

const BROADCAST = new RegExp(
  String.raw`<!(?:channel|here|everyone)(?:\|[^>]*)?>|<!subteam\^[^>]+>|${MENTION_START}(?:channel|here|everyone)(?![A-Za-z0-9])`,
  "i",
);

/** True when a message would notify a whole channel, the workspace or a user group. */
export function mentionsEveryone(text: string): boolean {
  return BROADCAST.test(text);
}

/** `data` of a successful Composio result (or the bare result); undefined when it failed. */
export function resultData(output: JsonValue): JsonObject | undefined {
  const top = asObject(output);
  if (top === undefined || field(top, "successful") === false) return undefined;
  const data = field(top, "data");
  if (data === undefined) return top;
  const object = asObject(data);
  return object === undefined || field(object, "ok") === false ? undefined : object;
}

/** A channel object of a Slack result ({id, name, is_ext_shared, …}). */
export function channelFrom(value: JsonValue | undefined): KnownChannel | null {
  if (!isObject(value)) return null;
  const id = str(value, "id");
  if (id === undefined || !isChannelId(id)) return null;
  const name = str(value, "name_normalized") ?? str(value, "name");
  return {
    id,
    name: name === undefined ? null : normaliseChannel(name),
    externallyShared:
      bool(value, "is_ext_shared") === true || bool(value, "is_pending_ext_shared") === true,
  };
}

/** The channel a successful SLACK_SEND_MESSAGE reached: Slack's id for the name it was given. */
export function postedChannel(input: JsonObject, output: JsonValue): KnownChannel | null {
  const data = resultData(output);
  const id = str(data, "channel") ?? str(obj(data, "message"), "channel");
  const given = str(input, "channel");
  if (
    id === undefined ||
    !isChannelId(id) ||
    given === undefined ||
    isChannelId(given) ||
    isUserId(given)
  ) {
    return null;
  }
  return { id, name: normaliseChannel(given), externallyShared: false };
}
