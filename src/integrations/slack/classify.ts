// Classifies Slack calls (Composio, docs/ARCHITECTURE.md §2, §7). Posting to
// a channel in allowedSlackChannels is internal_write; any other channel, a
// direct message, a channel shared with another organisation, and any
// message that notifies a whole channel or group, is outbound. Reactions are
// internal_write.
//
// SLACK_SEND_MESSAGE takes a channel name or id. A name is compared with the
// allowlist directly; an id is allowed only when the allowlist lists that id
// or the run's earlier Slack results (SlackRunMemory, `known` here) showed
// the id is an allowlisted channel. A channel whose name the run has not
// read asks, and its card says so.
//
// Denied (null): a post with Block Kit `blocks` or without `markdown_text`
// (the input rules in input-rules.ts reject both first, with a message): the
// card must show exactly what is posted.

import type {
  ApprovalFact,
  Classification,
  ClassifierSettings,
} from "../../contracts/integration.js";
import type { JsonObject } from "../../contracts/json.js";
import { bool, field, str } from "../shared/json.js";
import { fromSpec, specOf } from "../shared/profile.js";
import { multilinePreview } from "../shared/text.js";
import {
  isChannelId,
  type KnownChannel,
  mentionsEveryone,
  NOTHING_KNOWN,
  normaliseChannel,
  type SlackKnown,
} from "./channels.js";
import { SLACK_PROFILE } from "./profile.js";

/** Where a post goes, as far as the input and the run's Slack results tell. */
type Target = {
  /** "#billing", or the id when its name is unknown. */
  readonly label: string;
  /** The Channel fact. */
  readonly fact: string;
  readonly allowed: boolean;
  readonly direct: boolean;
  readonly externallyShared: boolean;
};

function allowlisted(settings: ClassifierSettings): Set<string> {
  return new Set(settings.allowedSlackChannels.map(normaliseChannel));
}

function targetOf(channel: string, settings: ClassifierSettings, known: SlackKnown): Target {
  const allowed = allowlisted(settings);
  const normalised = normaliseChannel(channel);
  if (isChannelId(normalised)) {
    const seen: KnownChannel | undefined = known.channelById(normalised);
    const name = seen?.name ?? null;
    return {
      label: name === null ? normalised : `#${name}`,
      fact:
        name === null
          ? `${normalised} (its name was not read in this run)`
          : `#${name} (${normalised})`,
      allowed: allowed.has(normalised) || (name !== null && allowed.has(name)),
      direct: normalised.startsWith("D"),
      externallyShared: seen?.externallyShared === true,
    };
  }
  const seen = known.channelByName(normalised);
  return {
    label: `#${normalised}`,
    fact: seen === undefined ? `#${normalised}` : `#${normalised} (${seen.id})`,
    allowed: allowed.has(normalised) || (seen !== undefined && allowed.has(seen.id)),
    direct: false,
    externallyShared: seen?.externallyShared === true,
  };
}

function classifyPost(
  input: JsonObject,
  settings: ClassifierSettings,
  known: SlackKnown,
): Classification | null {
  const channel = str(input, "channel");
  const text = str(input, "markdown_text");
  const blocks = field(input, "blocks");
  if (channel === undefined || text === undefined) return null;
  if (blocks !== undefined && blocks !== null) return null;
  const target = targetOf(channel, settings, known);
  const threadTs = str(input, "thread_ts");
  const alsoInChannel = threadTs !== undefined && bool(input, "reply_broadcast") === true;
  const broadcast = mentionsEveryone(text);
  const facts: ApprovalFact[] = [{ label: "Channel", value: target.fact }];
  if (threadTs !== undefined) {
    facts.push({
      label: "In thread",
      value: alsoInChannel ? `${threadTs}, also shown in the channel` : threadTs,
    });
  }
  facts.push({ label: "Message", value: multilinePreview(text) });
  if (broadcast) facts.push({ label: "Notifies", value: "Everyone in the channel or group" });
  if (target.direct) facts.push({ label: "Direct message", value: "Yes" });
  if (target.externallyShared) {
    facts.push({
      label: "Shared channel",
      value: "Shared with another organisation: people outside the company read it",
    });
  }
  if (!target.allowed) facts.push({ label: "Allowed channel", value: "No" });
  const where = threadTs === undefined ? `to ${target.label}` : `in a thread in ${target.label}`;
  const details = {
    consequence: `Post a message ${where} in Slack${broadcast ? ", notifying everyone" : ""}`,
    facts,
    recipients: [target.label],
  };
  const common = {
    operation: "slack.chat.post_message",
    title: `Post to ${target.label} in Slack`,
  } as const;
  const internal = target.allowed && !broadcast && !target.direct && !target.externallyShared;
  return internal
    ? { ...common, actionClass: "internal_write", details }
    : { ...common, actionClass: "outbound", details };
}

function classifyReaction(input: JsonObject, known: SlackKnown, settings: ClassifierSettings) {
  const channel = str(input, "channel");
  const timestamp = str(input, "timestamp");
  const name = str(input, "name");
  if (channel === undefined || timestamp === undefined || name === undefined) return null;
  const target = targetOf(channel, settings, known);
  return {
    actionClass: "internal_write",
    operation: "slack.reactions.add",
    title: "Add reaction in Slack",
    details: {
      consequence: `React with :${name.replace(/^:|:$/g, "")}: to a message in ${target.label}`,
      facts: [
        { label: "Channel", value: target.fact },
        { label: "Message", value: timestamp },
        { label: "Reaction", value: `:${name.replace(/^:|:$/g, "")}:` },
      ],
      recordIds: [timestamp],
    },
  } as const satisfies Classification;
}

/**
 * The classification of a Slack call. `known` holds the channels the run's
 * earlier Slack calls returned (SlackRunMemory); without it, a post to a
 * channel id asks unless the allowlist names that id.
 */
export function classifySlack(
  tool: string,
  input: JsonObject,
  settings: ClassifierSettings,
  known: SlackKnown = NOTHING_KNOWN,
): Classification | null {
  const spec = specOf(SLACK_PROFILE, tool);
  if (spec === undefined) return null;
  if (spec.name === "SLACK_SEND_MESSAGE") return classifyPost(input, settings, known);
  if (spec.name === "SLACK_ADD_REACTION_TO_AN_ITEM") {
    return classifyReaction(input, known, settings);
  }
  return fromSpec(spec);
}
