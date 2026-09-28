// Classifies Slack tool calls (docs/ARCHITECTURE.md §2, §7). Posting to a
// channel in allowedSlackChannels is internal_write; any other channel, and
// any message that notifies a whole channel, is outbound.

import type {
  ApprovalFact,
  Classification,
  ClassifierSettings,
} from "../../contracts/integration.js";
import type { JsonObject } from "../../contracts/json.js";
import { fromSpec, specOf } from "../shared/profile.js";
import { multilinePreview } from "../shared/text.js";
import { SLACK_PROFILE } from "./profile.js";
import { channelLabel, mentionsEveryone, normaliseChannel, postMessageInput } from "./schemas.js";

export function isAllowedChannel(channel: string, settings: ClassifierSettings): boolean {
  const target = normaliseChannel(channel);
  return settings.allowedSlackChannels.some((allowed) => normaliseChannel(allowed) === target);
}

function classifyPost(input: JsonObject, settings: ClassifierSettings): Classification | null {
  const parsed = postMessageInput.safeParse(input);
  if (!parsed.success) return null;
  const { channel, text, thread_ts: threadTs } = parsed.data;
  const label = channelLabel(channel);
  const allowed = isAllowedChannel(channel, settings);
  const broadcast = mentionsEveryone(text);
  const facts: ApprovalFact[] = [{ label: "Channel", value: label }];
  if (threadTs !== undefined) facts.push({ label: "In thread", value: threadTs });
  facts.push({ label: "Message", value: multilinePreview(text) });
  if (broadcast) facts.push({ label: "Notifies", value: "Everyone in the channel" });
  if (!allowed) facts.push({ label: "Allowed channel", value: "No" });
  const where = threadTs === undefined ? `to ${label}` : `in a thread in ${label}`;
  const details = {
    consequence: `Post a message ${where} in Slack${broadcast ? ", notifying everyone" : ""}`,
    facts,
    recipients: [label],
  };
  const common = {
    operation: "slack.chat.post_message",
    title: `Post to ${label} in Slack`,
  } as const;
  return allowed && !broadcast
    ? { ...common, actionClass: "internal_write", details }
    : { ...common, actionClass: "outbound", details };
}

export function classifySlack(
  tool: string,
  input: JsonObject,
  settings: ClassifierSettings,
): Classification | null {
  const spec = specOf(SLACK_PROFILE, tool);
  if (spec === undefined) return null;
  if (spec.name === "post_message") return classifyPost(input, settings);
  return fromSpec(spec);
}
