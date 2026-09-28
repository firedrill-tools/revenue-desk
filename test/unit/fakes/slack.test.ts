/**
 * Contract tests for the Slack Web API fake, independent of the agent: both
 * error modes (HTTP 200 ok:false and HTTP 429/5xx), auth, encodings,
 * membership, scopes, cursor paging and what the bot posted.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../../../src/contracts/json.js";
import { createClock } from "../../support/fakes/core/clock.js";
import { FAKE_CREDENTIALS } from "../../support/fakes/credentials.js";
import { loadBusinessFixtures } from "../../support/fakes/fixtures.js";
import { SlackFake } from "../../support/fakes/slack.js";

const TOKEN = FAKE_CREDENTIALS.slackBotToken;
let slack: SlackFake;

beforeEach(async () => {
  const fixtures = loadBusinessFixtures();
  slack = await SlackFake.start({
    fixture: fixtures.slack,
    clock: createClock(fixtures.company.asOf),
    botToken: TOKEN,
    prefix: "/slack",
  });
});

afterEach(async () => {
  await slack.close();
});

interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly body: JsonObject;
}

async function api(
  method: string,
  params: Record<string, string> = {},
  options: {
    readonly token?: string | null;
    readonly json?: boolean;
    readonly charset?: boolean;
    readonly get?: boolean;
  } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  let url = `${slack.baseUrl}/api/${method}`;
  let body: string | undefined;
  if (options.get === true) {
    url += `?${new URLSearchParams(params).toString()}`;
  } else if (options.json === true) {
    headers["content-type"] =
      options.charset === false ? "application/json" : "application/json; charset=utf-8";
    body = JSON.stringify(params);
  } else {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(params).toString();
  }
  const response = await fetch(url, {
    method: options.get === true ? "GET" : "POST",
    headers,
    ...(body === undefined ? {} : { body }),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as JsonObject,
  };
}

describe("Slack fake: auth and encodings", () => {
  it("reports auth errors as HTTP 200 ok:false", async () => {
    expect(await api("auth.test", {}, { token: null })).toMatchObject({
      status: 200,
      body: { ok: false, error: "not_authed" },
    });
    expect(await api("auth.test", {}, { token: "xoxb-wrong" })).toMatchObject({
      status: 200,
      body: { ok: false, error: "invalid_auth" },
    });
    const form = await fetch(`${slack.baseUrl}/api/auth.test`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: TOKEN }).toString(),
    });
    expect(await form.json()).toMatchObject({
      ok: true,
      user_id: "U0RDBOT001",
      team: "Kestrel Analytics",
    });
  });

  it("requires the Bearer header for JSON bodies and warns on a missing charset", async () => {
    const noBearer = await fetch(`${slack.baseUrl}/api/auth.test`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(await noBearer.json()).toMatchObject({ ok: false, error: "not_authed" });
    const reply = await api(
      "chat.postMessage",
      { channel: "#billing", text: "hi" },
      { json: true, charset: false },
    );
    expect(reply.body).toMatchObject({
      ok: true,
      warning: "missing_charset",
      response_metadata: { warnings: ["missing_charset"] },
    });
  });

  it("answers unknown methods with unknown_method and reports scopes in headers", async () => {
    const unknown = await api("chat.shout");
    expect(unknown).toMatchObject({ status: 404, body: { ok: false, error: "unknown_method" } });
    const reply = await api("auth.test");
    expect(reply.headers.get("x-oauth-scopes")).toContain("chat:write");
  });
});

describe("Slack fake: channels, history and users", () => {
  it("lists the channels the bot can see, paging with cursors", async () => {
    const first = await api("conversations.list", {
      limit: "2",
      types: "public_channel,private_channel",
    });
    const names = ((first.body.channels as JsonObject[]) ?? []).map((channel) => channel.name);
    expect(names).toEqual(["billing", "sales-ops"]);
    const cursor = String((first.body.response_metadata as JsonObject).next_cursor);
    expect(cursor).not.toBe("");
    const rest = await api("conversations.list", {
      cursor,
      limit: "10",
      types: "public_channel,private_channel",
    });
    const restNames = (rest.body.channels as JsonObject[]).map((channel) => channel.name);
    expect(restNames).toEqual(["revenue", "general", "deals-2025"]);
    expect(restNames).not.toContain("leadership");
    expect((rest.body.response_metadata as JsonObject).next_cursor).toBe("");
    const active = await api("conversations.list", { exclude_archived: "true" });
    expect((active.body.channels as JsonObject[]).map((channel) => channel.name)).not.toContain(
      "deals-2025",
    );
  });

  it("reads history newest first and thread replies, but only where the bot is a member", async () => {
    const history = await api("conversations.history", { channel: "C0BILLING01" }, { get: true });
    const messages = history.body.messages as JsonObject[];
    expect(messages.map((message) => message.ts)).toEqual([
      "1790449920.000100",
      "1790341800.000100",
    ]);
    expect(messages[0]).toMatchObject({ reply_count: 1, thread_ts: "1790449920.000100" });
    const replies = await api("conversations.replies", {
      channel: "C0BILLING01",
      ts: "1790449920.000100",
    });
    expect((replies.body.messages as JsonObject[]).map((message) => message.text)).toEqual([
      expect.stringContaining("charged twice"),
      "On it Monday.",
    ]);
    expect((await api("conversations.history", { channel: "#general" })).body).toEqual({
      ok: false,
      error: "not_in_channel",
    });
    expect((await api("conversations.history", { channel: "#leadership" })).body).toEqual({
      ok: false,
      error: "channel_not_found",
    });
    expect(
      (await api("conversations.replies", { channel: "C0BILLING01", ts: "1.2" })).body,
    ).toMatchObject({ ok: false, error: "thread_not_found" });
  });

  it("finds users by email and id", async () => {
    const found = await api("users.lookupByEmail", { email: "Priya@kestrel.test" });
    expect(found.body).toMatchObject({
      ok: true,
      user: { id: "U0PRIYA001", profile: { email: "priya@kestrel.test" } },
    });
    expect((await api("users.lookupByEmail", { email: "nobody@kestrel.test" })).body).toMatchObject(
      { ok: false, error: "users_not_found" },
    );
    expect((await api("users.info", { user: "U0SAM00001" })).body).toMatchObject({
      ok: true,
      user: { real_name: "Sam Okafor" },
    });
    const list = await api("users.list", { limit: "2" });
    expect((list.body.members as JsonObject[]).length).toBe(2);
  });

  it("answers missing_scope with needed and provided", async () => {
    slack.setScopes(["chat:write"]);
    const reply = await api("users.lookupByEmail", { email: "maya@kestrel.test" });
    expect(reply.body).toEqual({
      ok: false,
      error: "missing_scope",
      needed: "users:read.email",
      provided: "chat:write",
    });
  });
});

describe("Slack fake: posting and reactions", () => {
  it("posts by name or id, records it, and refuses channels it cannot post to", async () => {
    const posted = await api("chat.postMessage", {
      channel: "#billing",
      text: "Refunded $490.00 to Harbor & Pine.",
    });
    expect(posted.body).toMatchObject({
      ok: true,
      channel: "C0BILLING01",
      ts: "1790600400.000000",
      message: {
        text: "Refunded $490.00 to Harbor & Pine.",
        bot_id: "B0RDBOT001",
        user: "U0RDBOT001",
      },
    });
    const second = await api("chat.postMessage", {
      channel: "C0SALESOPS1",
      text: "Invoiced Solstice.",
    });
    expect(second.body.ts).toBe("1790600400.000100");
    expect((await api("chat.postMessage", { channel: "#general", text: "x" })).body).toEqual({
      ok: false,
      error: "not_in_channel",
    });
    expect((await api("chat.postMessage", { channel: "#deals-2025", text: "x" })).body).toEqual({
      ok: false,
      error: "is_archived",
    });
    expect((await api("chat.postMessage", { channel: "#nowhere", text: "x" })).body).toEqual({
      ok: false,
      error: "channel_not_found",
    });
    expect((await api("chat.postMessage", { channel: "#billing", text: " " })).body).toEqual({
      ok: false,
      error: "no_text",
    });
    expect(slack.posts()).toEqual([
      {
        channel: "C0BILLING01",
        channelName: "#billing",
        ts: "1790600400.000000",
        text: "Refunded $490.00 to Harbor & Pine.",
        threadTs: null,
      },
      {
        channel: "C0SALESOPS1",
        channelName: "#sales-ops",
        ts: "1790600400.000100",
        text: "Invoiced Solstice.",
        threadTs: null,
      },
    ]);
  });

  it("replies in threads and adds reactions once", async () => {
    const reply = await api("chat.postMessage", {
      channel: "#billing",
      text: "Done.",
      thread_ts: "1790449920.000100",
    });
    expect(reply.body).toMatchObject({ ok: true, message: { thread_ts: "1790449920.000100" } });
    const added = await api("reactions.add", {
      channel: "C0BILLING01",
      timestamp: "1790449920.000100",
      name: "white_check_mark",
    });
    expect(added.body).toEqual({ ok: true });
    expect(
      (
        await api("reactions.add", {
          channel: "C0BILLING01",
          timestamp: "1790449920.000100",
          name: "white_check_mark",
        })
      ).body,
    ).toEqual({ ok: false, error: "already_reacted" });
    expect(
      (
        await api("reactions.add", {
          channel: "C0BILLING01",
          timestamp: "1790449920.000100",
          name: "not-an-emoji",
        })
      ).body,
    ).toEqual({ ok: false, error: "invalid_name" });
    expect(slack.reactions()).toEqual([
      { channel: "C0BILLING01", ts: "1790449920.000100", name: "white_check_mark" },
    ]);
  });
});

describe("Slack fake: injected failures", () => {
  it("injects ok:false, 429 with Retry-After and 5xx", async () => {
    slack.faults.error("chat.postMessage", "channel_not_found");
    expect((await api("chat.postMessage", { channel: "#billing", text: "x" })).body).toEqual({
      ok: false,
      error: "channel_not_found",
    });
    slack.faults.rateLimit("conversations.history", { retryAfterSeconds: 3 });
    const limited = await api("conversations.history", { channel: "C0BILLING01" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("3");
    expect(limited.body).toEqual({ ok: false, error: "ratelimited" });
    slack.faults.serverError("auth.test", { status: 503 });
    expect((await api("auth.test")).status).toBe(503);
    expect(slack.posts()).toEqual([]);
  });
});
