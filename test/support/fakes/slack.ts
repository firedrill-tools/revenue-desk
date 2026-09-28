/**
 * A stateful, contract-faithful local fake of the Slack Web API (the methods
 * of the slack-api profile), loaded from test/fixtures/business/slack.json.
 * Test-only.
 *
 * Contract points it enforces, as Slack does:
 * - `POST /api/<method>` (GET for reads too) with the bot token as
 *   `Authorization: Bearer xoxb-…` or a `token` form field. JSON bodies need
 *   the Bearer header, and a missing charset adds the `missing_charset`
 *   warning.
 * - Both error modes: most errors are HTTP 200 with `{ok:false, error}`
 *   (not_authed, invalid_auth, channel_not_found, not_in_channel,
 *   is_archived, no_text, missing_scope with needed/provided, ...), while
 *   rate limits are HTTP 429 with `Retry-After` and server failures are 5xx
 *   (both injected with `faults`).
 * - Cursor paging through `response_metadata.next_cursor`.
 * - Scopes from the fixture (`x-oauth-scopes`), checked per method.
 */
import type { JsonObject, JsonValue } from "../../../src/contracts/json.js";
import type { FakeClock } from "./core/clock.js";
import {
  bearerToken,
  FakeHttpServer,
  type FakeRequest,
  type FakeResponse,
  type FaultHandle,
  mediaType,
  type RecordedHttpRequest,
  Router,
} from "./core/http.js";
import type { SlackFixture } from "./fixtures.js";

export interface SlackFakeOptions {
  readonly fixture: SlackFixture;
  readonly clock: FakeClock;
  /** The only token the fake accepts. */
  readonly botToken: string;
  readonly prefix?: string;
}

interface Message {
  readonly channel: string;
  readonly ts: string;
  readonly user: string;
  readonly botId: string | null;
  text: string;
  readonly threadTs: string | null;
  readonly blocks: JsonValue | null;
  reactions: { name: string; users: string[] }[];
}

/** A message the bot posted, for assertions. */
export interface SlackPost {
  readonly channel: string;
  readonly channelName: string;
  readonly ts: string;
  readonly text: string;
  readonly threadTs: string | null;
}

class SlackError extends Error {
  constructor(
    readonly error: string,
    readonly extra: JsonObject = {},
  ) {
    super(error);
  }
}

type Params = Readonly<Record<string, JsonValue>>;

interface MethodSpec {
  readonly scopes: readonly string[];
  readonly handler: (params: Params) => JsonObject;
}

const KNOWN_EMOJI = new Set([
  "white_check_mark",
  "eyes",
  "moneybag",
  "heavy_check_mark",
  "thumbsup",
  "+1",
  "warning",
  "memo",
  "tada",
  "hourglass",
]);

export class SlackFake {
  readonly http: FakeHttpServer;
  private readonly team: SlackFixture["team"];
  private readonly bot: SlackFixture["bot"];
  private readonly users: SlackFixture["users"];
  private readonly channels: SlackFixture["channels"];
  private readonly messages: Message[] = [];
  private readonly clock: FakeClock;
  private readonly botToken: string;
  private scopes: string[];
  private lastTs = 0;

  private constructor(options: SlackFakeOptions) {
    const fixture = structuredClone(options.fixture);
    this.team = fixture.team;
    this.bot = fixture.bot;
    this.users = fixture.users;
    this.channels = fixture.channels;
    this.scopes = [...fixture.bot.scopes];
    this.clock = options.clock;
    this.botToken = options.botToken;
    for (const message of fixture.messages) {
      this.messages.push({
        channel: message.channel,
        ts: message.ts,
        user: message.user,
        botId: null,
        text: message.text,
        threadTs: message.threadTs ?? null,
        blocks: null,
        reactions: [],
      });
    }
    const router = new Router();
    for (const method of ["GET", "POST"]) {
      router.add(method, "/api/:method", (request) => this.dispatch(request));
    }
    this.http = new FakeHttpServer({
      name: "slack",
      clock: options.clock,
      router,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      notFound: () => ({ status: 404, body: "<html><body>Not Found</body></html>" }),
    });
  }

  static async start(options: SlackFakeOptions): Promise<SlackFake> {
    const fake = new SlackFake(options);
    await fake.http.start();
    return fake;
  }

  /** SLACK_API_BASE_URL (origin plus prefix; methods are under /api). */
  get baseUrl(): string {
    return this.http.baseUrl;
  }

  get requests(): readonly RecordedHttpRequest[] {
    return this.http.requests;
  }

  close(): Promise<void> {
    return this.http.close();
  }

  // --- Assertions and setup -----------------------------------------------------

  /** Messages the bot posted, in order. */
  posts(): SlackPost[] {
    return this.messages
      .filter((message) => message.user === this.bot.userId)
      .sort((a, b) => Number(a.ts) - Number(b.ts))
      .map((message) => ({
        channel: message.channel,
        channelName: `#${this.channels.find((channel) => channel.id === message.channel)?.name ?? "?"}`,
        ts: message.ts,
        text: message.text,
        threadTs: message.threadTs,
      }));
  }

  /** Reactions the bot added: channel, message ts and emoji name. */
  reactions(): { readonly channel: string; readonly ts: string; readonly name: string }[] {
    return this.messages.flatMap((message) =>
      message.reactions
        .filter((reaction) => reaction.users.includes(this.bot.userId))
        .map((reaction) => ({ channel: message.channel, ts: message.ts, name: reaction.name })),
    );
  }

  /** Replaces the bot token's scopes (to exercise missing_scope). */
  setScopes(scopes: readonly string[]): void {
    this.scopes = [...scopes];
  }

  // --- Faults -----------------------------------------------------------------

  readonly faults = {
    /** HTTP 200 `{ok:false, error}` for a method, e.g. ("chat.postMessage", "channel_not_found"). */
    error: (
      method: string,
      error: string,
      options: { readonly times?: number } = {},
    ): FaultHandle =>
      this.http.injectFault({
        name: `slack-${error}`,
        path: `/api/${method}`,
        ...(options.times === undefined ? {} : { times: options.times }),
        respond: { status: 200, body: { ok: false, error } },
      }),
    /** HTTP 429 with Retry-After and `{ok:false, error:"ratelimited"}`. */
    rateLimit: (
      method: string,
      options: { readonly times?: number; readonly retryAfterSeconds?: number } = {},
    ): FaultHandle =>
      this.http.injectFault({
        name: "slack-429-ratelimited",
        path: `/api/${method}`,
        ...(options.times === undefined ? {} : { times: options.times }),
        respond: {
          status: 429,
          headers: { "retry-after": String(options.retryAfterSeconds ?? 1) },
          body: { ok: false, error: "ratelimited" },
        },
      }),
    /** An HTTP 5xx with Slack's `{ok:false}` body. */
    serverError: (
      method: string,
      options: { readonly times?: number; readonly status?: number } = {},
    ): FaultHandle =>
      this.http.injectFault({
        name: `slack-${options.status ?? 500}`,
        path: `/api/${method}`,
        ...(options.times === undefined ? {} : { times: options.times }),
        respond: { status: options.status ?? 500, body: { ok: false, error: "internal_error" } },
      }),
  };

  // --- Dispatch ---------------------------------------------------------------

  private methods(): Readonly<Record<string, MethodSpec>> {
    return {
      "auth.test": { scopes: [], handler: () => this.authTest() },
      "conversations.list": {
        scopes: ["channels:read"],
        handler: (params) => this.conversationsList(params),
      },
      "conversations.info": {
        scopes: ["channels:read"],
        handler: (params) => ({ channel: this.channelJson(this.channel(params)) }),
      },
      "conversations.history": {
        scopes: ["channels:history"],
        handler: (params) => this.history(params),
      },
      "conversations.replies": {
        scopes: ["channels:history"],
        handler: (params) => this.replies(params),
      },
      "users.list": { scopes: ["users:read"], handler: (params) => this.usersList(params) },
      "users.info": {
        scopes: ["users:read"],
        handler: (params) => ({ user: this.userJson(this.user(params)) }),
      },
      "users.lookupByEmail": {
        scopes: ["users:read.email"],
        handler: (params) => this.lookupByEmail(params),
      },
      "chat.postMessage": { scopes: ["chat:write"], handler: (params) => this.postMessage(params) },
      "reactions.add": {
        scopes: ["reactions:write"],
        handler: (params) => this.addReaction(params),
      },
    };
  }

  private dispatch(request: FakeRequest): FakeResponse {
    const name = request.params.method ?? "";
    const spec = this.methods()[name];
    const headers = {
      "x-oauth-scopes": this.scopes.join(","),
      "x-accepted-oauth-scopes": spec?.scopes.join(",") ?? "",
    };
    const answer = (body: JsonObject, status = 200): FakeResponse => ({
      status,
      headers: { ...headers, "content-type": "application/json; charset=utf-8" },
      body,
    });
    if (spec === undefined)
      return answer({ ok: false, error: "unknown_method", req_method: name }, 404);

    const parsed = this.parameters(request);
    if ("error" in parsed) return answer({ ok: false, error: parsed.error });
    const { params, warnings } = parsed;
    const token = bearerToken(request) ?? (typeof params.token === "string" ? params.token : null);
    if (token === null) return answer({ ok: false, error: "not_authed" });
    if (token !== this.botToken) return answer({ ok: false, error: "invalid_auth" });
    const needed = spec.scopes.find((scope) => !this.scopes.includes(scope));
    if (needed !== undefined) {
      return answer({ ok: false, error: "missing_scope", needed, provided: this.scopes.join(",") });
    }
    const meta: JsonObject =
      warnings.length === 0 ? {} : { warning: warnings.join(","), response_metadata: { warnings } };
    try {
      const result = spec.handler(params);
      const responseMetadata = result.response_metadata;
      return answer({
        ok: true,
        ...result,
        ...meta,
        ...(responseMetadata !== undefined && warnings.length > 0
          ? { response_metadata: { ...(responseMetadata as JsonObject), warnings } }
          : {}),
      });
    } catch (error) {
      if (!(error instanceof SlackError)) throw error;
      return answer({ ok: false, error: error.error, ...error.extra, ...meta });
    }
  }

  private parameters(
    request: FakeRequest,
  ): { readonly params: Params; readonly warnings: string[] } | { readonly error: string } {
    const params: Record<string, JsonValue> = Object.fromEntries(request.query);
    const warnings: string[] = [];
    if (request.rawBody === "") return { params, warnings };
    const type = mediaType(request);
    if (type === "application/x-www-form-urlencoded") {
      for (const [key, value] of new URLSearchParams(request.rawBody)) params[key] = value;
      return { params, warnings };
    }
    if (type === "application/json") {
      if (bearerToken(request) === null) return { error: "not_authed" };
      if (!/charset=utf-8/i.test(request.headers["content-type"] ?? ""))
        warnings.push("missing_charset");
      try {
        const body: unknown = JSON.parse(request.rawBody);
        if (body === null || typeof body !== "object" || Array.isArray(body))
          return { error: "invalid_json" };
        Object.assign(params, body as JsonObject);
        return { params, warnings };
      } catch {
        return { error: "invalid_json" };
      }
    }
    return { error: "invalid_form_data" };
  }

  // --- Methods ----------------------------------------------------------------

  private authTest(): JsonObject {
    return {
      url: this.team.url,
      team: this.team.name,
      user: this.bot.name,
      team_id: this.team.id,
      user_id: this.bot.userId,
      bot_id: this.bot.botId,
      is_enterprise_install: false,
    };
  }

  private conversationsList(params: Params): JsonObject {
    const types = String(params.types ?? "public_channel")
      .split(",")
      .map((type) => type.trim());
    const excludeArchived = params.exclude_archived === true || params.exclude_archived === "true";
    const visible = this.channels.filter(
      (channel) =>
        (channel.isPrivate
          ? types.includes("private_channel") && channel.botIsMember
          : types.includes("public_channel")) && !(excludeArchived && channel.isArchived),
    );
    const { page, nextCursor } = paginate(visible, params, 100, 1000);
    return {
      channels: page.map((channel) => this.channelJson(channel)),
      response_metadata: { next_cursor: nextCursor },
    };
  }

  private history(params: Params): JsonObject {
    const channel = this.readableChannel(params);
    const oldest = Number(params.oldest ?? 0);
    const latest = params.latest === undefined ? Number.POSITIVE_INFINITY : Number(params.latest);
    const inclusive = params.inclusive === true || params.inclusive === "true";
    const top = this.messages
      .filter(
        (message) =>
          message.channel === channel.id &&
          (message.threadTs === null || message.threadTs === message.ts) &&
          (inclusive
            ? Number(message.ts) >= oldest && Number(message.ts) <= latest
            : Number(message.ts) > oldest && Number(message.ts) < latest),
      )
      .sort((a, b) => Number(b.ts) - Number(a.ts));
    const { page, nextCursor } = paginate(top, params, 100, 999);
    return {
      messages: page.map((message) => this.messageJson(message)),
      has_more: nextCursor !== "",
      pin_count: 0,
      response_metadata: { next_cursor: nextCursor },
    };
  }

  private replies(params: Params): JsonObject {
    const channel = this.readableChannel(params);
    const ts = requiredString(params, "ts");
    const parent = this.messages.find(
      (message) => message.channel === channel.id && message.ts === ts,
    );
    if (parent === undefined) throw new SlackError("thread_not_found");
    const thread = this.messages
      .filter(
        (message) =>
          message.channel === channel.id && (message.ts === ts || message.threadTs === ts),
      )
      .sort((a, b) => Number(a.ts) - Number(b.ts));
    const { page, nextCursor } = paginate(thread, params, 1000, 1000);
    return {
      messages: page.map((message) => this.messageJson(message)),
      has_more: nextCursor !== "",
      response_metadata: { next_cursor: nextCursor },
    };
  }

  private usersList(params: Params): JsonObject {
    const all = [...this.users.map((user) => this.userJson(user)), this.botUserJson()];
    const { page, nextCursor } = paginate(all, params, 100, 1000);
    return {
      members: page,
      cache_ts: this.clock.unix(),
      response_metadata: { next_cursor: nextCursor },
    };
  }

  private lookupByEmail(params: Params): JsonObject {
    const email = requiredString(params, "email").toLowerCase();
    const user = this.users.find((entry) => entry.email.toLowerCase() === email);
    if (user === undefined) throw new SlackError("users_not_found");
    return { user: this.userJson(user) };
  }

  private postMessage(params: Params): JsonObject {
    const channel = this.channel(params);
    if (channel.isArchived) throw new SlackError("is_archived");
    if (!channel.botIsMember) throw new SlackError("not_in_channel");
    const text = typeof params.text === "string" ? params.text : "";
    let blocks: JsonValue | null = null;
    if (params.blocks !== undefined) {
      try {
        blocks =
          typeof params.blocks === "string"
            ? (JSON.parse(params.blocks) as JsonValue)
            : params.blocks;
      } catch {
        throw new SlackError("invalid_blocks_format");
      }
      if (!Array.isArray(blocks)) throw new SlackError("invalid_blocks_format");
    }
    if (text.trim() === "" && (blocks === null || (Array.isArray(blocks) && blocks.length === 0))) {
      throw new SlackError("no_text");
    }
    if (text.length > 40_000) throw new SlackError("msg_too_long");
    const threadTs =
      typeof params.thread_ts === "string" && params.thread_ts !== "" ? params.thread_ts : null;
    if (
      threadTs !== null &&
      !this.messages.some((message) => message.channel === channel.id && message.ts === threadTs)
    ) {
      throw new SlackError("thread_not_found");
    }
    const message: Message = {
      channel: channel.id,
      ts: this.nextTs(),
      user: this.bot.userId,
      botId: this.bot.botId,
      text,
      threadTs,
      blocks,
      reactions: [],
    };
    this.messages.push(message);
    return { channel: channel.id, ts: message.ts, message: this.messageJson(message) };
  }

  private addReaction(params: Params): JsonObject {
    const channel = this.readableChannel(params);
    const ts = requiredString(params, "timestamp");
    const name = requiredString(params, "name").replace(/^:|:$/g, "");
    if (!KNOWN_EMOJI.has(name)) throw new SlackError("invalid_name");
    const message = this.messages.find((entry) => entry.channel === channel.id && entry.ts === ts);
    if (message === undefined) throw new SlackError("message_not_found");
    let reaction = message.reactions.find((entry) => entry.name === name);
    if (reaction === undefined) {
      reaction = { name, users: [] };
      message.reactions.push(reaction);
    }
    if (reaction.users.includes(this.bot.userId)) throw new SlackError("already_reacted");
    reaction.users.push(this.bot.userId);
    return {};
  }

  // --- Lookups and renderers ------------------------------------------------------

  /** A channel by id, or by name with or without '#'. Private channels the bot is not in do not exist for it. */
  private channel(params: Params): SlackFixture["channels"][number] {
    const raw = requiredString(params, "channel", "channel_not_found");
    const name = raw.replace(/^#/, "").toLowerCase();
    const channel = this.channels.find((entry) => entry.id === raw || entry.name === name);
    if (channel === undefined || (channel.isPrivate && !channel.botIsMember)) {
      throw new SlackError("channel_not_found");
    }
    return channel;
  }

  private readableChannel(params: Params): SlackFixture["channels"][number] {
    const channel = this.channel(params);
    if (!channel.botIsMember) throw new SlackError("not_in_channel");
    return channel;
  }

  private user(params: Params): SlackFixture["users"][number] {
    const id = requiredString(params, "user", "user_not_found");
    const user = this.users.find((entry) => entry.id === id);
    if (user === undefined) throw new SlackError("user_not_found");
    return user;
  }

  private nextTs(): string {
    const micros = Math.max(this.clock.now().getTime() * 1000, this.lastTs + 100);
    this.lastTs = micros;
    const seconds = Math.floor(micros / 1_000_000);
    return `${seconds}.${String(micros % 1_000_000).padStart(6, "0")}`;
  }

  private channelJson(channel: SlackFixture["channels"][number]): JsonObject {
    return {
      id: channel.id,
      name: channel.name,
      is_channel: !channel.isPrivate,
      is_group: false,
      is_im: false,
      is_private: channel.isPrivate,
      is_archived: channel.isArchived,
      is_general: channel.name === "general",
      is_member: channel.botIsMember,
      created: channel.created,
      creator: "U0MAYA0001",
      name_normalized: channel.name,
      num_members: channel.members.length,
      topic: { value: channel.topic, creator: "U0MAYA0001", last_set: channel.created },
      purpose: { value: channel.topic, creator: "U0MAYA0001", last_set: channel.created },
    };
  }

  private messageJson(message: Message): JsonObject {
    const replies = this.messages.filter(
      (entry) => entry.threadTs === message.ts && entry.ts !== message.ts,
    );
    return {
      type: "message",
      ...(message.botId === null ? {} : { subtype: "bot_message", bot_id: message.botId }),
      user: message.user,
      text: message.text,
      ts: message.ts,
      team: this.team.id,
      ...(message.threadTs === null ? {} : { thread_ts: message.threadTs }),
      ...(replies.length === 0 ? {} : { thread_ts: message.ts, reply_count: replies.length }),
      ...(message.blocks === null ? {} : { blocks: message.blocks }),
      ...(message.reactions.length === 0
        ? {}
        : {
            reactions: message.reactions.map((reaction) => ({
              name: reaction.name,
              users: reaction.users,
              count: reaction.users.length,
            })),
          }),
    };
  }

  private userJson(user: SlackFixture["users"][number]): JsonObject {
    return {
      id: user.id,
      team_id: this.team.id,
      name: user.name,
      deleted: false,
      real_name: user.realName,
      tz: "America/New_York",
      is_bot: false,
      is_admin: false,
      profile: {
        real_name: user.realName,
        display_name: user.name,
        title: user.title,
        email: this.scopes.includes("users:read.email") ? user.email : null,
      },
    };
  }

  private botUserJson(): JsonObject {
    return {
      id: this.bot.userId,
      team_id: this.team.id,
      name: this.bot.name,
      deleted: false,
      real_name: "Revenue Desk",
      is_bot: true,
      is_admin: false,
      profile: { real_name: "Revenue Desk", display_name: this.bot.name, bot_id: this.bot.botId },
    };
  }
}

function requiredString(params: Params, name: string, missing = "invalid_arguments"): string {
  const value = params[name];
  if (typeof value !== "string" || value === "") throw new SlackError(missing);
  return value;
}

/** Slack cursor paging: the cursor is an opaque base64 offset. */
function paginate<T>(
  items: readonly T[],
  params: Params,
  defaultLimit: number,
  maxLimit: number,
): { readonly page: T[]; readonly nextCursor: string } {
  const rawLimit = params.limit === undefined ? defaultLimit : Number(params.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 0) throw new SlackError("invalid_limit");
  const limit = rawLimit === 0 ? defaultLimit : Math.min(rawLimit, maxLimit);
  let offset = 0;
  if (typeof params.cursor === "string" && params.cursor !== "") {
    const decoded = /^offset:(\d+)$/.exec(Buffer.from(params.cursor, "base64").toString("utf8"));
    if (decoded === null) throw new SlackError("invalid_cursor");
    offset = Number(decoded[1]);
  }
  const page = items.slice(offset, offset + limit);
  const next =
    offset + limit < items.length ? Buffer.from(`offset:${offset + limit}`).toString("base64") : "";
  return { page, nextCursor: next };
}
