// Slack through Composio: the classifier, the input rules and the run
// memory, from inputs shaped by the captured SLACK_* schemas
// (test/fixtures/surfaces/composio-direct.json) and results shaped by each
// tool's Composio output schema ({successful, data, error}, Slack's own JSON
// inside).

import { describe, expect, it } from "vitest";
import type { ClassifierSettings } from "../../../src/contracts/integration.js";
import type { JsonObject } from "../../../src/contracts/json.js";
import {
  channelFrom,
  mentionsEveryone,
  normaliseChannel,
  postedChannel,
} from "../../../src/integrations/slack/channels.js";
import { classifySlack } from "../../../src/integrations/slack/classify.js";
import { checkSlackInput } from "../../../src/integrations/slack/input-rules.js";
import { SLACK_PROFILE } from "../../../src/integrations/slack/profile.js";
import { SlackRunMemory } from "../../../src/integrations/slack/run-memory.js";
import { SETTINGS } from "./helpers.js";

const ok = (data: JsonObject): JsonObject => ({ successful: true, data, error: null });

const CHANNELS = ok({
  ok: true,
  channels: [
    { id: "C0BILLING01", name: "billing", is_member: true, is_ext_shared: false },
    { id: "C0PARTNERS1", name: "partners-acme", is_ext_shared: true },
    { id: "C0GENERAL01", name: "general" },
  ],
});

const post = (input: JsonObject) => classifySlack("SLACK_SEND_MESSAGE", input, SETTINGS);

describe("Slack channels and mentions", () => {
  it("normalises channel names and keeps ids", () => {
    expect(normaliseChannel("#Billing")).toBe("billing");
    expect(normaliseChannel(" sales-ops ")).toBe("sales-ops");
    expect(normaliseChannel("C0BILLING01")).toBe("C0BILLING01");
  });

  it("recognises broadcasts, user groups included", () => {
    for (const text of [
      "<!channel> heads up",
      "hi <!here|here>",
      "@everyone look",
      "<!subteam^S01> ping",
    ]) {
      expect(mentionsEveryone(text), text).toBe(true);
    }
    for (const text of ["mail maya@kestrel.test", "<@U0MAYA0001> done", "channel is fine"]) {
      expect(mentionsEveryone(text), text).toBe(false);
    }
  });

  it("reads channels from Slack's results, and what a post by name reached", () => {
    expect(channelFrom({ id: "C0PARTNERS1", name: "partners-acme", is_ext_shared: true })).toEqual({
      id: "C0PARTNERS1",
      name: "partners-acme",
      externallyShared: true,
    });
    expect(channelFrom({ id: "not-an-id", name: "x" })).toBeNull();
    expect(
      postedChannel(
        { channel: "#billing", markdown_text: "x" },
        ok({ ok: true, channel: "C0BILLING01", ts: "1790604312.000200" }),
      ),
    ).toEqual({ id: "C0BILLING01", name: "billing", externallyShared: false });
    // Posted by id: nothing new is learned; a failed post teaches nothing.
    expect(
      postedChannel({ channel: "C0BILLING01" }, ok({ ok: true, channel: "C0BILLING01" })),
    ).toBeNull();
    expect(
      postedChannel({ channel: "#billing" }, { successful: false, data: { channel: "C0X12" } }),
    ).toBeNull();
    expect(postedChannel({ channel: "#billing" }, ok({ ok: false, channel: "C0X12" }))).toBeNull();
  });
});

describe("classifySlack", () => {
  it("classifies reads as read and reactions as internal_write", () => {
    for (const spec of Object.values(SLACK_PROFILE.tools)) {
      if (spec.baseClass !== "read") continue;
      expect(classifySlack(spec.name, {}, SETTINGS)).toEqual({
        actionClass: "read",
        operation: spec.operation,
        title: spec.title,
      });
    }
    expect(
      classifySlack(
        "SLACK_ADD_REACTION_TO_AN_ITEM",
        { channel: "C0BILLING01", timestamp: "1790604312.000200", name: ":white_check_mark:" },
        SETTINGS,
      ),
    ).toEqual({
      actionClass: "internal_write",
      operation: "slack.reactions.add",
      title: "Add reaction in Slack",
      details: {
        consequence: "React with :white_check_mark: to a message in C0BILLING01",
        facts: [
          { label: "Channel", value: "C0BILLING01 (its name was not read in this run)" },
          { label: "Message", value: "1790604312.000200" },
          { label: "Reaction", value: ":white_check_mark:" },
        ],
        recordIds: ["1790604312.000200"],
      },
    });
  });

  it("posts to an allowed channel as internal_write, however its name is written", () => {
    for (const channel of ["#billing", "billing", "#Billing", "sales-ops"]) {
      expect(
        post({ channel, markdown_text: "Refunded the duplicate." })?.actionClass,
        channel,
      ).toBe("internal_write");
    }
    expect(
      post({ channel: "billing", markdown_text: "Refunded **$490.00**.\n- Harbor & Pine" }),
    ).toEqual({
      actionClass: "internal_write",
      operation: "slack.chat.post_message",
      title: "Post to #billing in Slack",
      details: {
        consequence: "Post a message to #billing in Slack",
        facts: [
          { label: "Channel", value: "#billing" },
          { label: "Message", value: "Refunded **$490.00**.\n- Harbor & Pine" },
        ],
        recipients: ["#billing"],
      },
    });
  });

  it("posts anywhere else, to everyone, or as a direct message as outbound", () => {
    const general = post({ channel: "general", markdown_text: "hello" });
    expect(general).toMatchObject({
      actionClass: "outbound",
      title: "Post to #general in Slack",
      details: { facts: expect.arrayContaining([{ label: "Allowed channel", value: "No" }]) },
    });
    const everyone = post({ channel: "#billing", markdown_text: "<!channel> refunds are done" });
    expect(everyone).toMatchObject({
      actionClass: "outbound",
      details: {
        consequence: "Post a message to #billing in Slack, notifying everyone",
        facts: expect.arrayContaining([
          { label: "Notifies", value: "Everyone in the channel or group" },
        ]),
      },
    });
    const direct = classifySlack(
      "SLACK_SEND_MESSAGE",
      { channel: "D0MAYA00001", markdown_text: "Refunded." },
      { ...SETTINGS, allowedSlackChannels: [...SETTINGS.allowedSlackChannels] },
    );
    expect(direct).toMatchObject({
      actionClass: "outbound",
      details: { facts: expect.arrayContaining([{ label: "Direct message", value: "Yes" }]) },
    });
    const thread = post({
      channel: "#billing",
      markdown_text: "Done.",
      thread_ts: "1790604312.000200",
      reply_broadcast: true,
    });
    expect(thread).toMatchObject({
      actionClass: "internal_write",
      details: {
        consequence: "Post a message in a thread in #billing in Slack",
        facts: expect.arrayContaining([
          { label: "In thread", value: "1790604312.000200, also shown in the channel" },
        ]),
      },
    });
  });

  it("asks for a channel id it cannot name, unless the allowlist names that id", () => {
    expect(post({ channel: "C0BILLING01", markdown_text: "x" })).toMatchObject({
      actionClass: "outbound",
      title: "Post to C0BILLING01 in Slack",
      details: {
        facts: expect.arrayContaining([
          { label: "Channel", value: "C0BILLING01 (its name was not read in this run)" },
        ]),
      },
    });
    const byId: ClassifierSettings = { ...SETTINGS, allowedSlackChannels: ["C0BILLING01"] };
    expect(
      classifySlack("SLACK_SEND_MESSAGE", { channel: "C0BILLING01", markdown_text: "x" }, byId)
        ?.actionClass,
    ).toBe("internal_write");
  });

  it("denies unknown tools, Block Kit posts and posts without text", () => {
    expect(classifySlack("SLACK_DELETE_CHANNEL", { channel: "C0X12" }, SETTINGS)).toBeNull();
    expect(classifySlack("post_message", { channel: "#billing", text: "x" }, SETTINGS)).toBeNull();
    expect(post({ channel: "#billing" })).toBeNull();
    expect(
      post({ channel: "#billing", markdown_text: "x", blocks: [{ type: "divider" }] }),
    ).toBeNull();
    expect(post({ markdown_text: "x" })).toBeNull();
    expect(
      classifySlack("SLACK_ADD_REACTION_TO_AN_ITEM", { channel: "C0X12", name: "eyes" }, SETTINGS),
    ).toBeNull();
  });
});

describe("Slack input rules", () => {
  const issues = (input: JsonObject) =>
    checkSlackInput("SLACK_SEND_MESSAGE", input).map((issue) => `${issue.path} ${issue.message}`);

  it("accept standard Markdown, user-id mentions, email addresses and broadcasts", () => {
    expect(
      issues({
        channel: "#revenue",
        markdown_text:
          "# Weekly digest\n\n| Deal | Amount |\n|---|---|\n| Solstice | $18,000 |\n\n**Owner:** <@U0MAYA0001>, mail maya@kestrel.test <!here>",
      }),
    ).toEqual([]);
  });

  it("refuse mentions that notify nobody, before the post reaches Slack", () => {
    expect(issues({ channel: "#billing", markdown_text: "Thanks @Sam and <@71001>" })).toEqual([
      "/markdown_text mentions <@71001>, which is not a Slack user id (U… or W…): find the person with a Slack user search and use their id, or write their name without a mention",
      "/markdown_text has a plain @Sam, which mentions nobody in Slack: find the person with a Slack user search and write <@USERID>, or write the name without @",
    ]);
  });

  it("need the message as markdown_text, never Block Kit", () => {
    expect(issues({ channel: "#billing" })).toEqual([
      "/markdown_text is needed: the message itself, as standard Markdown",
    ]);
    expect(
      issues({ channel: "#billing", markdown_text: "x", blocks: [{ type: "section" }] }),
    ).toEqual([
      "/blocks is not used by Revenue Desk: write the message as Markdown in markdown_text and leave blocks and fallback_text out",
    ]);
    expect(checkSlackInput("SLACK_FIND_USERS", { search_query: "@Sam" })).toEqual([]);
  });
});

describe("Slack cards with what the run read (SlackRunMemory)", () => {
  it("names a channel id from the run's channel search, and allows it when it is allowlisted", () => {
    const memory = new SlackRunMemory(SETTINGS);
    memory.record("SLACK_FIND_CHANNELS", { query: "billing" }, CHANNELS, false);
    const card = memory.refine(
      "SLACK_SEND_MESSAGE",
      { channel: "C0BILLING01", markdown_text: "Refunded." },
      {
        actionClass: "outbound",
        operation: "slack.chat.post_message",
        title: "x",
        details: { consequence: "x", facts: [] },
      },
    );
    expect(card).toMatchObject({
      actionClass: "internal_write",
      title: "Post to #billing in Slack",
      details: {
        consequence: "Post a message to #billing in Slack",
        facts: [
          { label: "Channel", value: "#billing (C0BILLING01)" },
          { label: "Message", value: "Refunded." },
        ],
        recipients: ["#billing"],
      },
    });
    expect(memory.channelByName("billing")?.id).toBe("C0BILLING01");
  });

  it("asks before posting in a channel shared with another organisation, even an allowlisted one", () => {
    const memory = new SlackRunMemory({
      ...SETTINGS,
      allowedSlackChannels: [...SETTINGS.allowedSlackChannels, "#partners-acme"],
    });
    memory.record("SLACK_LIST_ALL_CHANNELS", { limit: 200 }, CHANNELS, false);
    for (const channel of ["#partners-acme", "C0PARTNERS1"]) {
      const card = memory.refine(
        "SLACK_SEND_MESSAGE",
        { channel, markdown_text: "Invoice sent." },
        { actionClass: "internal_write", operation: "slack.chat.post_message", title: "x" },
      );
      expect(card.actionClass, channel).toBe("outbound");
      expect(card.details?.facts, channel).toContainEqual({
        label: "Shared channel",
        value: "Shared with another organisation: people outside the company read it",
      });
    }
  });

  it("learns the id Slack answered a post by name with, and nothing from failures", () => {
    const memory = new SlackRunMemory(SETTINGS);
    memory.record(
      "SLACK_SEND_MESSAGE",
      { channel: "sales-ops", markdown_text: "Handoff done." },
      ok({ ok: true, channel: "C0SALESOPS1", ts: "1790604312.000300" }),
      false,
    );
    memory.record(
      "SLACK_FIND_CHANNELS",
      { query: "x" },
      { successful: false, data: { channels: [{ id: "C0GENERAL01", name: "billing" }] } },
      false,
    );
    memory.record("SLACK_LIST_ALL_CHANNELS", {}, CHANNELS, true);
    expect(memory.channelById("C0SALESOPS1")).toEqual({
      id: "C0SALESOPS1",
      name: "sales-ops",
      externallyShared: false,
    });
    expect(memory.channelById("C0GENERAL01")).toBeUndefined();
    const reaction = memory.refine(
      "SLACK_ADD_REACTION_TO_AN_ITEM",
      { channel: "C0SALESOPS1", timestamp: "1790604312.000300", name: "eyes" },
      { actionClass: "internal_write", operation: "slack.reactions.add", title: "x" },
    );
    expect(reaction.details?.consequence).toBe("React with :eyes: to a message in #sales-ops");
    // Reads are left as they are.
    const read = {
      actionClass: "read",
      operation: "slack.users.find",
      title: "Find Slack user",
    } as const;
    expect(memory.refine("SLACK_FIND_USERS", { search_query: "maya" }, read)).toBe(read);
  });

  it("keeps a channel shared once it was seen shared", () => {
    const memory = new SlackRunMemory(SETTINGS);
    memory.record("SLACK_FIND_CHANNELS", { query: "acme" }, CHANNELS, false);
    memory.record(
      "SLACK_SEND_MESSAGE",
      { channel: "partners-acme", markdown_text: "x" },
      ok({ ok: true, channel: "C0PARTNERS1", ts: "1.2" }),
      false,
    );
    expect(memory.channelById("C0PARTNERS1")?.externallyShared).toBe(true);
  });
});
