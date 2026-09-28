import { describe, expect, it } from "vitest";
import type { SlackConnection } from "../../../src/contracts/integration.js";
import type { JsonObject, JsonValue } from "../../../src/contracts/json.js";
import type { ApiTool } from "../../../src/integrations/shared/api-tool.js";
import { classifySlack } from "../../../src/integrations/slack/classify.js";
import { SlackClient, slackError } from "../../../src/integrations/slack/client.js";
import { createSlackIntegration, probeSlack } from "../../../src/integrations/slack/definition.js";
import { SLACK_PROFILE } from "../../../src/integrations/slack/profile.js";
import { resolveSlack } from "../../../src/integrations/slack/resolve.js";
import {
  at,
  callContext,
  mockFetch,
  paramsOf,
  type Reply,
  SETTINGS,
  secret,
  testEnv,
} from "./helpers.js";

const TOKEN = "xoxb-unit-test-token";

const connection: SlackConnection = {
  integration: "slack",
  kind: "api",
  profile: "slack-api",
  endpointLabel: "slack.test",
  api: { baseUrl: "https://slack.test/prefix", botToken: secret(TOKEN) },
};

function setup(
  reply: (index: number, body: Record<string, string>) => Reply | Error,
  timezone?: string,
) {
  const mock = mockFetch((request, index) => reply(index, paramsOf(request.body)));
  const options = timezone === undefined ? { currency: "USD" } : { currency: "USD", timezone };
  const tools = new Map(
    createSlackIntegration({ http: mock.http })
      .tools(connection, options)
      .map((tool) => [tool.name, tool]),
  );
  const run = (name: string, args: JsonObject): Promise<JsonValue> => {
    const tool: ApiTool | undefined = tools.get(name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool.run(args, callContext());
  };
  const call = (index = 0) => {
    const request = mock.requests[index];
    return { method: request?.url.pathname, form: paramsOf(request?.body ?? "") };
  };
  return { mock, tools, run, call };
}

describe("Slack formatting and times", () => {
  it("tells the model that post text is Slack mrkdwn: no tables, headings or emoji", () => {
    const { tools } = setup(() => ({ json: { ok: true } }));
    const post = tools.get("post_message");
    expect(post?.description).toContain("Slack mrkdwn, not Markdown");
    expect(post?.description).toContain("Post about an action only after it succeeded");
    const text = post?.input.text as { description?: string } | undefined;
    expect(text?.description).toContain("<@U123> to mention a person");
    expect(text?.description).toContain("a plain @name mentions nobody");
    expect(text?.description).toContain("Markdown tables, # headings and **double asterisks**");
    expect(text?.description).toContain("No emoji.");
  });

  it("writes message times in the workspace time zone", async () => {
    const { run } = setup(
      () => ({ json: { ok: true, channel: "C0BILLING01", ts: "1790600465.632000" } }),
      "America/New_York",
    );
    await expect(
      run("post_message", { channel: "#billing", text: "Refund issued." }),
    ).resolves.toEqual({
      channel: "C0BILLING01",
      ts: "1790600465.632000",
      time: "2026-09-28T09:01:05.632-04:00",
    });
  });
});

describe("SlackClient", () => {
  it("posts form bodies to /api/<method> under the prefix with the bot token", async () => {
    const mock = mockFetch(() => ({ json: { ok: true, channels: [] } }));
    const client = new SlackClient({
      baseUrl: "https://slack.test/prefix",
      botToken: secret(TOKEN),
      http: mock.http,
    });
    await client.read(
      "conversations.list",
      { limit: 5, cursor: undefined, exclude_archived: true },
      undefined,
    );
    const [request] = mock.requests;
    expect(request?.method).toBe("POST");
    expect(request?.url.toString()).toBe("https://slack.test/prefix/api/conversations.list");
    expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request?.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded; charset=utf-8",
    );
    expect(paramsOf(request?.body ?? "")).toEqual({ limit: "5", exclude_archived: "true" });
  });

  it("turns ok:false on HTTP 200 into an error with Slack's code", async () => {
    const mock = mockFetch(() => ({ json: { ok: false, error: "channel_not_found" } }));
    const client = new SlackClient({
      baseUrl: "https://slack.test",
      botToken: secret(TOKEN),
      http: mock.http,
    });
    await expect(
      client.write("chat.postMessage", { channel: "#nope", text: "x" }, undefined),
    ).rejects.toMatchObject({
      provider: "slack",
      status: 200,
      code: "channel_not_found",
      message: "The channel was not found, or the bot cannot see it.",
    });
  });

  it("handles HTTP errors, missing scopes and unknown codes", () => {
    expect(
      slackError(200, { ok: false, error: "missing_scope", needed: "chat:write" }).toJSON(),
    ).toMatchObject({
      code: "missing_scope",
      message: "The bot token lacks the chat:write scope.",
    });
    expect(slackError(500, undefined).toJSON()).toEqual({
      provider: "slack",
      status: 500,
      code: "http_500",
      message: "Slack returned HTTP 500.",
    });
    expect(slackError(429, undefined).toJSON()).toMatchObject({ code: "ratelimited" });
    expect(slackError(200, { ok: false, error: "fatal_error" }).toJSON()).toMatchObject({
      message: "Slack returned error fatal_error.",
    });
  });

  it("retries reads on 429 with Retry-After but never retries a post", async () => {
    const reads = mockFetch(
      (_, index): Reply =>
        index === 0
          ? {
              status: 429,
              headers: { "retry-after": "3" },
              json: { ok: false, error: "ratelimited" },
            }
          : { json: { ok: true } },
    );
    const client = new SlackClient({
      baseUrl: "https://slack.test",
      botToken: secret(TOKEN),
      http: reads.http,
    });
    await expect(
      client.read("conversations.history", { channel: "C1" }, undefined),
    ).resolves.toEqual({ ok: true });
    expect(reads.sleeps).toEqual([3000]);

    const posts = mockFetch(() => ({ status: 429, headers: { "retry-after": "1" } }));
    const writer = new SlackClient({
      baseUrl: "https://slack.test",
      botToken: secret(TOKEN),
      http: posts.http,
    });
    await expect(
      writer.write("chat.postMessage", { channel: "C1", text: "x" }, undefined),
    ).rejects.toMatchObject({ status: 429, code: "ratelimited" });
    expect(posts.requests).toHaveLength(1);
  });
});

describe("Slack tools", () => {
  it("are exactly the slack-api profile", () => {
    const { tools } = setup(() => ({ json: { ok: true } }));
    expect([...tools.keys()].sort()).toEqual(Object.keys(SLACK_PROFILE.tools).sort());
  });

  it("list_channels projects channels and filters by name", async () => {
    const channels: JsonObject[] = [
      {
        id: "C1",
        name: "billing",
        is_private: false,
        is_member: true,
        num_members: 4,
        topic: { value: "Refunds" },
        purpose: { value: "" },
      },
      { id: "C2", name: "random", is_private: false, is_member: false },
    ];
    const { run, call } = setup(() => ({
      json: { ok: true, channels, response_metadata: { next_cursor: "" } },
    }));
    const result = await run("list_channels", {
      name_contains: "#bill",
      include_private: false,
      limit: 200,
    });
    expect(call()).toEqual({
      method: "/prefix/api/conversations.list",
      form: { types: "public_channel", exclude_archived: "true", limit: "200" },
    });
    expect(result).toEqual({
      channels: [
        {
          id: "C1",
          name: "billing",
          is_private: false,
          is_member: true,
          num_members: 4,
          topic: "Refunds",
        },
      ],
      next_cursor: null,
    });
  });

  it("read_channel converts the time window to Slack timestamps", async () => {
    const { run, call } = setup(() => ({
      json: {
        ok: true,
        has_more: true,
        messages: [
          {
            ts: "1790000000.000100",
            user: "U1",
            text: "refund?",
            thread_ts: "1790000000.000100",
            reply_count: 2,
            blocks: [],
          },
        ],
        response_metadata: { next_cursor: "abc" },
      },
    }));
    const result = await run("read_channel", { channel: "C1", after: "2026-09-01", limit: 30 });
    expect(call().form).toEqual({
      channel: "C1",
      oldest: String(Date.UTC(2026, 8, 1) / 1000),
      limit: "30",
    });
    expect(result).toEqual({
      messages: [
        {
          ts: "1790000000.000100",
          time: "2026-09-21T14:13:20.000Z",
          user: "U1",
          text: "refund?",
          thread_ts: "1790000000.000100",
          reply_count: 2,
        },
      ],
      has_more: true,
      next_cursor: "abc",
    });
  });

  it("read_thread reads replies of a parent ts", async () => {
    const { run, call } = setup(() => ({ json: { ok: true, messages: [] } }));
    await run("read_thread", { channel: "C1", thread_ts: "1790000000.000100", limit: 50 });
    expect(call()).toEqual({
      method: "/prefix/api/conversations.replies",
      form: { channel: "C1", ts: "1790000000.000100", limit: "50" },
    });
  });

  it("find_user looks up an id, or searches users.list page by page", async () => {
    const byId = setup(() => ({
      json: {
        ok: true,
        user: {
          id: "U1",
          name: "ana",
          real_name: "Ana Diaz",
          profile: { email: "ana@kestrel.test", display_name: "ana" },
        },
      },
    }));
    await expect(byId.run("find_user", { user_id: "U1" })).resolves.toEqual({
      users: [
        {
          id: "U1",
          name: "ana",
          real_name: "Ana Diaz",
          display_name: "ana",
          email: "ana@kestrel.test",
        },
      ],
      complete: true,
    });
    expect(byId.call().method).toBe("/prefix/api/users.info");

    const pages: Reply[] = [
      {
        json: {
          ok: true,
          members: [{ id: "U1", name: "bo", profile: { email: "bo@kestrel.test" } }],
          response_metadata: { next_cursor: "p2" },
        },
      },
      {
        json: {
          ok: true,
          members: [{ id: "U2", name: "ana", profile: { email: "Ana@Kestrel.test" } }],
          response_metadata: { next_cursor: "" },
        },
      },
    ];
    const search = setup((index) => pages[index] ?? { json: { ok: true } });
    const result = await search.run("find_user", { query: "ANA@" });
    expect(at(result, "users")).toEqual([{ id: "U2", name: "ana", email: "Ana@Kestrel.test" }]);
    expect(at(result, "complete")).toBe(true);
    expect(search.call(1).form).toEqual({ limit: "200", cursor: "p2" });

    const neither = setup(() => ({ json: { ok: true } }));
    await expect(neither.run("find_user", {})).rejects.toMatchObject({ code: "invalid_request" });
    expect(neither.mock.requests).toHaveLength(0);
  });

  it("post_message posts once without link unfurling", async () => {
    const { run, call, mock } = setup(() => ({
      json: { ok: true, channel: "C1", ts: "1790000000.000200" },
    }));
    await expect(
      run("post_message", {
        channel: "Billing",
        text: "Refunded ch_2",
        thread_ts: "1790000000.000100",
      }),
    ).resolves.toEqual({
      channel: "C1",
      ts: "1790000000.000200",
      time: "2026-09-21T14:13:20.000Z",
    });
    expect(call()).toEqual({
      method: "/prefix/api/chat.postMessage",
      form: {
        channel: "#billing",
        text: "Refunded ch_2",
        thread_ts: "1790000000.000100",
        unfurl_links: "false",
        unfurl_media: "false",
      },
    });
    expect(mock.requests).toHaveLength(1);
  });

  it("add_reaction treats an existing reaction as done", async () => {
    const added = setup(() => ({ json: { ok: true } }));
    await expect(
      added.run("add_reaction", {
        channel: "C1",
        timestamp: "1790000000.000100",
        name: "white_check_mark",
      }),
    ).resolves.toEqual({ added: true, already_reacted: false });
    const again = setup(() => ({ json: { ok: false, error: "already_reacted" } }));
    await expect(
      again.run("add_reaction", {
        channel: "C1",
        timestamp: "1790000000.000100",
        name: "white_check_mark",
      }),
    ).resolves.toEqual({ added: false, already_reacted: true });
    const failing = setup(() => ({ json: { ok: false, error: "invalid_name" } }));
    await expect(
      failing.run("add_reaction", { channel: "C1", timestamp: "1790000000.000100", name: "nope" }),
    ).rejects.toMatchObject({ code: "invalid_name" });
  });
});

describe("classifySlack", () => {
  it("classifies reads as read and reactions as internal_write", () => {
    for (const name of ["list_channels", "read_channel", "read_thread", "find_user"]) {
      expect(classifySlack(name, {}, SETTINGS)?.actionClass).toBe("read");
    }
    expect(classifySlack("add_reaction", {}, SETTINGS)).toEqual({
      actionClass: "internal_write",
      operation: "slack.reactions.add",
      title: "Add reaction in Slack",
    });
  });

  it("posts to allowed channels as internal_write, however they are written", () => {
    for (const channel of ["#billing", "billing", "#Billing"]) {
      expect(classifySlack("post_message", { channel, text: "Refunded ch_2" }, SETTINGS)).toEqual({
        actionClass: "internal_write",
        operation: "slack.chat.post_message",
        title: "Post to #billing in Slack",
        details: {
          consequence: "Post a message to #billing in Slack",
          facts: [
            { label: "Channel", value: "#billing" },
            { label: "Message", value: "Refunded ch_2" },
          ],
          recipients: ["#billing"],
        },
      });
    }
  });

  it("posts anywhere else, or to everyone, as outbound", () => {
    expect(
      classifySlack("post_message", { channel: "#general", text: "hi" }, SETTINGS),
    ).toMatchObject({
      actionClass: "outbound",
      title: "Post to #general in Slack",
      details: {
        recipients: ["#general"],
        facts: expect.arrayContaining([{ label: "Allowed channel", value: "No" }]),
      },
    });
    expect(
      classifySlack("post_message", { channel: "C0123ABC", text: "hi" }, SETTINGS),
    ).toMatchObject({
      actionClass: "outbound",
      title: "Post to C0123ABC in Slack",
    });
    expect(
      classifySlack(
        "post_message",
        { channel: "C0123ABC", text: "hi" },
        { ...SETTINGS, allowedSlackChannels: ["C0123ABC"] },
      )?.actionClass,
    ).toBe("internal_write");
    for (const text of ["<!channel> refunds done", "heads up @here", "<!everyone|everyone>"]) {
      expect(classifySlack("post_message", { channel: "#billing", text }, SETTINGS)).toMatchObject({
        actionClass: "outbound",
        details: { consequence: "Post a message to #billing in Slack, notifying everyone" },
      });
    }
    expect(
      classifySlack("post_message", { channel: "#billing", text: "mail me@here.test" }, SETTINGS)
        ?.actionClass,
    ).toBe("internal_write");
    expect(
      classifySlack(
        "post_message",
        { channel: "#billing", text: "done", thread_ts: "1790000000.000100" },
        SETTINGS,
      )?.details?.consequence,
    ).toBe("Post a message in a thread in #billing in Slack");
  });

  it("denies unknown tools and invalid posts", () => {
    expect(classifySlack("chat_delete", {}, SETTINGS)).toBeNull();
    expect(classifySlack("post_message", { channel: "#billing" }, SETTINGS)).toBeNull();
    expect(classifySlack("post_message", { channel: "#billing", text: "" }, SETTINGS)).toBeNull();
    expect(
      classifySlack("post_message", { channel: "bad channel", text: "x" }, SETTINGS),
    ).toBeNull();
  });
});

describe("Slack resolution and probe", () => {
  it("requires a bot token", () => {
    expect(resolveSlack(testEnv())).toEqual({
      status: "not_configured",
      missing: ["SLACK_BOT_TOKEN"],
    });
    expect(resolveSlack(testEnv({ slack: { botToken: secret("xoxp-user-token") } }))).toMatchObject(
      { status: "invalid", problems: [{ variable: "SLACK_BOT_TOKEN" }] },
    );
    expect(
      resolveSlack(
        testEnv({ slack: { botToken: secret(TOKEN), apiBaseUrl: "http://127.0.0.1:4430" } }),
      ),
    ).toMatchObject({
      status: "configured",
      connection: { endpointLabel: "127.0.0.1:4430", api: { baseUrl: "http://127.0.0.1:4430" } },
    });
  });

  it("probes auth.test and maps token errors", async () => {
    const ok = mockFetch(() => ({
      json: { ok: true, team: "Kestrel", team_id: "T0123456789", user: "revenue-desk" },
    }));
    await expect(probeSlack(connection, new AbortController().signal, ok.http)).resolves.toEqual({
      state: "connected",
      detail: "Connected to Kestrel as revenue-desk.",
      accountHint: "T01…789",
    });
    expect(ok.requests[0]?.url.pathname).toBe("/prefix/api/auth.test");
    const cases: Array<[string, string]> = [
      ["invalid_auth", "needs_auth"],
      ["token_revoked", "needs_auth"],
      ["missing_scope", "needs_auth"],
      ["token_expired", "expired"],
      ["fatal_error", "error"],
    ];
    for (const [code, state] of cases) {
      const mock = mockFetch(() => ({ json: { ok: false, error: code } }));
      await expect(
        probeSlack(connection, new AbortController().signal, mock.http),
      ).resolves.toMatchObject({ state });
    }
  });
});
