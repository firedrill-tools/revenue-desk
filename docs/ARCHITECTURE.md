# Revenue Desk architecture

This is the design reference for Revenue Desk. It adapts the September 28, 2026
architecture proposal with the lead's decisions applied. Where this document and
the code disagree, the code is the current state and this document is the
target; implementation status is tracked in §13, not implied by the text.

Current state: **scaffold only.** The repository builds, type-checks, serves
`GET /api/health` and a static app shell. Everything else below is specified,
not implemented.

## 0. Ground rules

- **Location and distribution.** `repositories/revenue-desk` in the Firedrill
  workspace. Local git only: no remote, never pushed. `package.json` has
  `"private": true`; there is no licence file until Kiran decides.
- **Customer-shaped agent.** Revenue Desk imports nothing from Firedrill and
  contains no Firedrill files in phase 1. The Firedrill runner configuration,
  worlds, drills and CI workflow are phase 2 (§14) and start only when Kiran says.
- **The Firedrill seam is configuration only.** Every Tool endpoint is a URL
  plus a token, optionally with one extra auth-header name, read from
  environment variables (§3). The agent core never reads `FIREDRILL_*`.
- **Patterns reused** from `../gmail-agent`: the Composio session MCP and the
  direct-MCP override (`src/composio.ts`), `canUseTool` approvals and SDK options
  (`src/agent.ts`), and the SQLite action log (`src/db.ts`). From
  `../firedrill-example-gmail-agent`: the "stdin, one turn, one JSON on stdout"
  adapter (`test/run-agent.mjs`). Its retired standalone runtime is not used.
- **gmail-agent defects that must not be repeated:** emitting `tool_call` twice
  per call; reporting an approval as decided by "user" when the user denied;
  letting the Claude CLI child inherit the whole `process.env` (including
  `COMPOSIO_API_KEY`).
- **Secrets.** No key value is ever printed, logged, stored in SQLite, streamed
  to the browser, copied or committed. Local runs that need real keys load them
  at runtime from a file outside the repository named by `DOTENV_PATH` (or
  `process.loadEnvFile(path)`). A redactor (§5) scrubs every configured secret
  value and `Bearer …`, `sk_`, `rk_`, `xox`, `pat-` patterns from logs, database
  rows, SSE output and stdout.
- **Composio development rule.** Implementers and automated checks may create
  Composio sessions and make read-only toolkit, catalog and tool-listing calls
  with the configured key. They never execute a Gmail or Calendar tool that
  writes, and never initiate OAuth. In the running product, `session.authorize`
  is called only from a user's explicit click on Connect (§9).
- **No silent fallbacks.** An unconfigured integration is `not_configured`; its
  tools are not offered and the UI says so. There is no fallback to fakes,
  sample data or another model. Local fakes exist only in tests and in the
  explicitly launched, visibly labelled sandbox demo mode (§11).

## 1. Product story

Revenue Desk is a back-office agent for the revenue-operations or billing lead at
a small B2B company. It is chat-first, with approvals for anything that moves
money or leaves the company. It has five jobs:

- **J1 Billing inquiry.** A customer emails "why was I charged twice?". The agent
  reads the Gmail thread, looks the customer up in Stripe (charges, invoices),
  QuickBooks (invoice and payment status) and HubSpot (contact, company, owner),
  then drafts a reply in Gmail. Creating the draft is automatic; sending needs
  approval.
- **J2 Refund a duplicate charge.** The agent finds the duplicate in Stripe and
  proposes a refund with amount, charge, customer and reason. This is a
  financial action and needs approval. It then logs a HubSpot note and posts to
  Slack `#billing`.
- **J3 Collections.** The agent lists overdue QuickBooks invoices and
  cross-checks Stripe for payments that were not recorded. It drafts reminder
  emails. For invoices 60 or more days overdue it proposes a Google Calendar
  call (approval required when there is an external attendee) and creates a
  HubSpot task.
- **J4 Closed-won handoff.** For a HubSpot deal in closed-won, the agent creates
  or finds the QuickBooks customer, creates an invoice (approval required),
  sends it (approval required) and posts to Slack `#sales-ops`.
- **J5 Weekly digest.** The agent reads new HubSpot deals, Stripe payments and
  refunds, and QuickBooks AR aging, and posts a digest to Slack.

Each job crosses three or more Tools and all three connection kinds, and every
outcome is causally checkable: a refund created exactly once for the right
amount with an idempotency key; no email to the wrong customer; no financial
write without approval; correct handling of a declined card, a 429, a missing
record, a partial QuickBooks page or an unavailable Tool.

## 2. Integrations and connection kinds

| Integration | Kind | Production endpoint and auth |
|---|---|---|
| Gmail | **Composio** | Composio session MCP: `sessions.create(userId, {toolkits:['gmail'], tools:{gmail:{enable:[…]}}, sessionPreset:'direct_tools', manageConnections:false, sandbox:{enable:false}, mcp:true})`. Composio manages the Google OAuth. |
| Google Calendar | **Composio** | Same session shape with the `googlecalendar` toolkit. |
| HubSpot | **MCP** | Default: `@hubspot/mcp-server` 0.4.0 over stdio with `HUBSPOT_ACCESS_TOKEN`. Alternative: any Streamable HTTP MCP via `HUBSPOT_MCP_URL`/`HUBSPOT_MCP_TOKEN`. |
| Stripe | **API** | REST `https://api.stripe.com/v1/*`, form-encoded, `Authorization: Bearer sk_test_…`, `Idempotency-Key` on writes. |
| QuickBooks Online | **API** | REST `https://sandbox-quickbooks.api.intuit.com/v3/company/{realmId}/*`, Bearer access token, `requestid` idempotency. |
| Slack | **API** | Web API `https://slack.com/api/<method>`, bot token. |

Result: two Composio, one MCP, three API integrations. Why each kind:

- Gmail is already connected in Composio; Calendar's auth config exists but its
  connection must be reconnected by Kiran.
- HubSpot's Firedrill Tool aliases equal the 11 tool names of
  `@hubspot/mcp-server` 0.4.0, so a simulation shows the same tool surface.
- Stripe over REST, not `mcp.stripe.com`: the current Stripe MCP
  (`stripe_api_read`/`stripe_api_write`) does not match Firedrill's per-resource
  aliases, while Firedrill serves a faithful `/v1` REST subset.
- QuickBooks writes use the REST operations `customers.post`, `invoices.post`,
  `payments.post` and `invoices.send`, which carry no MCP aliases. That avoids
  the Stripe/QuickBooks `create_customer`/`create_invoice` alias collision.
- Slack's official MCP needs user OAuth and the reference Slack MCP server is
  deprecated; a bot token is simple and Firedrill serves `/api/<method>`.

### Tool surfaces

Every tool reaches the model through one in-process MCP server per integration,
so tool names look like `mcp__<integration>__<tool>`.

**Gmail, profile `composio`** (direct_tools slugs; exact slugs and schemas are
captured once, read-only, from the live catalog and dated):
reads `GMAIL_FETCH_EMAILS`, `GMAIL_FETCH_MESSAGE_BY_THREAD_ID`,
`GMAIL_LIST_THREADS`, `GMAIL_LIST_LABELS`; internal writes
`GMAIL_CREATE_EMAIL_DRAFT`, `GMAIL_ADD_LABEL_TO_EMAIL`; outbound
`GMAIL_SEND_DRAFT`, `GMAIL_REPLY_TO_THREAD`.

**Gmail, profile `google`** (Google Gmail MCP names, used in simulation):
`search_threads`, `get_thread`, `list_labels`, `list_drafts`, `create_draft`,
`label_thread`, `label_message`, plus canonical `gmail.drafts.send` (shown by the
SDK as `gmail_drafts_send`) because Firedrill has no alias for sending.

**Calendar, profile `composio`:** `GOOGLECALENDAR_EVENTS_LIST`,
`GOOGLECALENDAR_FIND_FREE_SLOTS`, `GOOGLECALENDAR_FIND_EVENT`,
`GOOGLECALENDAR_CREATE_EVENT`, `GOOGLECALENDAR_UPDATE_EVENT` (verified at capture).

**Calendar, profile `google`:** `list_calendars`, `list_events`, `get_event`,
`search_events`, `suggest_time`, `create_event`, `update_event`. `delete_event`
is excluded.

**HubSpot, profile `hubspot-mcp-0.4`** (all 11): `hubspot-get-user-details`,
`hubspot-list-objects`, `hubspot-search-objects`, `hubspot-batch-read-objects`,
`hubspot-batch-create-objects`, `hubspot-batch-update-objects`,
`hubspot-list-associations`, `hubspot-batch-create-associations`,
`hubspot-get-association-definitions`, `hubspot-list-properties`,
`hubspot-get-property`. Notes and tasks are created with
`hubspot-batch-create-objects`.

**Stripe** (own tools, each 1:1 with a REST operation inside Firedrill's subset):

| Tool | REST route |
|---|---|
| `find_customers` | `GET /v1/customers?email=&limit=` |
| `get_customer` | `GET /v1/customers/{id}` |
| `list_charges` | `GET /v1/charges?customer=` |
| `list_payment_intents` | `GET /v1/payment_intents` |
| `list_invoices` | `GET /v1/invoices` |
| `get_invoice` | `GET /v1/invoices/{id}` |
| `list_subscriptions` | `GET /v1/subscriptions` |
| `list_refunds` | `GET /v1/refunds` |
| `get_balance` | `GET /v1/balance` |
| `create_refund` | `POST /v1/refunds` |
| `cancel_subscription` | `DELETE /v1/subscriptions/{id}` |

**QuickBooks** (own tools):

| Tool | REST route |
|---|---|
| `get_company_info` | `GET /companyinfo/{realm}` (also the business clock) |
| `find_customers` | `GET /query` (Customer) |
| `get_customer` | `GET /customer/{id}` |
| `list_invoices` | `GET /query` (Invoice, balance and due filters); pages until an empty `QueryResponse` |
| `get_invoice` | `GET /invoice/{id}` |
| `list_payments` | `GET /query` (Payment) |
| `create_customer` | `POST /customer` |
| `create_invoice` | `POST /invoice` |
| `send_invoice` | `POST /invoice/{id}/send` |
| `record_payment` | `POST /payment` |
| `void_invoice` | `POST /invoice?operation=void` |

**Slack** (own tools):

| Tool | Web API method |
|---|---|
| `list_channels` | `conversations.list` |
| `read_channel` | `conversations.history` |
| `read_thread` | `conversations.replies` |
| `find_user` | `users.list` / `users.info` |
| `post_message` | `chat.postMessage` |
| `add_reaction` | `reactions.add` |

Slack errors are handled both ways: HTTP 200 with `ok:false` (real Slack) and
4xx (Firedrill).

## 3. Environment and configuration contract

The core reads the environment once, at start, into an immutable `AgentEnv`
snapshot and never mutates `process.env`. Configuration names never use the
`FIREDRILL_`, `GITHUB_`, `RUNNER_`, `ACTIONS_` or `INPUT_` prefixes, because the
Firedrill runner strips them. `.env.example` lists every name with no values.

- **Model**
  - `ANTHROPIC_API_KEY` (required to run the agent).
  - `ANTHROPIC_BASE_URL` (tests only).
  - `AGENT_MODEL`, default **`claude-sonnet-5`**.
  - `AGENT_EFFORT`, default **`medium`**.
  - `AGENT_THINKING_DISPLAY`: `summarized` in the UI, `omitted` headless.
  - `AGENT_MAX_TURNS` (30), `AGENT_MAX_BUDGET_USD` (2.00 per run).
  - **No silent model fallback.** The SDK `fallbackModel` option is never set.
    An unavailable or invalid model fails the run with `target.MODEL_ERROR`
    (headless) or a visible error (UI); the configured model is what runs.
- **Runtime**
  - `PORT` (4320; the server always binds to 127.0.0.1).
  - `AGENT_STATE_DIR` (`./data`, git-ignored).
  - `AGENT_POLICY` (JSON overriding approval modes per action class).
  - `AGENT_BUSINESS_DATE` (ISO date; defaults to today; Firedrill worlds use
    fixed virtual dates).
  - `AGENT_APPROVAL_TIMEOUT_MS` (900000 in the UI).
  - `DOTENV_PATH` (optional env file outside the repository, loaded at start).
- **Composio:** `COMPOSIO_API_KEY`, `COMPOSIO_USER_ID`. Both come from
  configuration only; **there is no default user ID in code.** Missing values
  make Gmail and Calendar `not_configured`.
- **Gmail override:** `GMAIL_MCP_URL`, `GMAIL_MCP_TOKEN`, `GMAIL_MCP_PROFILE`
  (`google` default, or `composio`). When the URL is set, Composio is bypassed
  for Gmail.
- **Calendar override:** `GOOGLE_CALENDAR_MCP_URL`, `GOOGLE_CALENDAR_MCP_TOKEN`,
  `GOOGLE_CALENDAR_MCP_PROFILE`.
- **HubSpot**
  - `HUBSPOT_MCP_URL` + `HUBSPOT_MCP_TOKEN` select HTTP.
  - Otherwise stdio: `HUBSPOT_ACCESS_TOKEN` is passed to the child as
    `PRIVATE_APP_ACCESS_TOKEN` in an explicit child environment.
  - `HUBSPOT_MCP_COMMAND`/`HUBSPOT_MCP_ARGS` (JSON array) override the command,
    for tests.
  - The default command is `process.execPath` plus the resolved
    `@hubspot/mcp-server` bin (`mcp-hubspot`, a pinned dependency). Never `npx`
    at runtime.
- **Stripe**
  - `STRIPE_SECRET_KEY`. Keys starting `sk_live_`/`rk_live_` are refused unless
    `ALLOW_LIVE_STRIPE=1`.
  - `STRIPE_API_BASE_URL` (`https://api.stripe.com`),
    `STRIPE_API_PROXY_AUTH_HEADER` (optional header name), `STRIPE_API_VERSION`.
- **QuickBooks:** `QBO_ACCESS_TOKEN`, `QBO_REALM_ID`, `QBO_API_BASE_URL`
  (`https://sandbox-quickbooks.api.intuit.com`), `QBO_API_PROXY_AUTH_HEADER`,
  `QBO_MINOR_VERSION`.
- **Slack:** `SLACK_BOT_TOKEN`, `SLACK_API_BASE_URL` (`https://slack.com`),
  `SLACK_API_PROXY_AUTH_HEADER`.
- **Proxy-auth rule.** When `<X>_API_PROXY_AUTH_HEADER` is set, the client also
  sends `<name>: Bearer <same token>`. A base URL may contain a path prefix; the
  client joins paths without dropping it. This lets Firedrill's `/v1/wire` plus
  `X-Firedrill-World-Authorization` be supplied with pure environment aliases
  (§14).
- **Missing configuration.** An integration without configuration is
  `not_configured`: its tools are not offered to the model, the system prompt
  lists only available integrations, and the Connections screen shows the
  missing variable *names*.

## 4. Stack and toolchain

- **Front end:** Vite SPA (React 19, Tailwind 4 via `@tailwindcss/vite`),
  shadcn/ui initialised for Vite with **Radix** (`radix-nova` style; AI Elements
  does not support Base UI), and AI Elements copied into
  `web/src/components/ai-elements` as owned source.
- **Server:** Hono on `@hono/node-server`, one long-lived Node process bound to
  127.0.0.1.
- **Why not Next.js:** `canUseTool` holds approvals in process memory with a
  per-process run registry, which Next route handlers, HMR module duplication and
  unreliable `request.signal` fight; the headless CLI must share a
  framework-free core; `createUIMessageStreamResponse` returns a Web `Response`
  that Hono serves natively; the AI Elements registry has no `next/*` imports;
  Anthropic's own Agent SDK demos use Vite with a Node server.
- **Dev and build:** `pnpm dev` runs `tsx watch src/server/main.ts` (API on
  4320) and `vite` (4321, proxying `/api` to 127.0.0.1:4320). `pnpm build` runs
  `vite build` into `dist/web` and `tsc -p tsconfig.server.json` into `dist/`;
  `pnpm start` runs `node dist/server/main.js`, which serves the API and the
  built SPA from 4320.
- **TypeScript projects:** `tsconfig.server.json` (`src/`, NodeNext, emits to
  `dist/`), `tsconfig.web.json` (`web/src`, bundler resolution, no emit, `@/*`
  → `web/src/*`), `tsconfig.node.json` (config files, `test/`, `scripts/`). The
  root `tsconfig.json` only references them and repeats the `@/*` path for the
  shadcn CLI.
- **Lint and format:** Biome. `web/src/components/ui` and
  `web/src/components/ai-elements` are excluded so they stay diffable against
  their registries; patches there are reviewed by hand (Appendix A).
- **Package manager:** pnpm 9.15.4 (`packageManager` pinned), `save-exact`, and
  install scripts limited to `better-sqlite3` and `esbuild`
  (`pnpm.onlyBuiltDependencies`).

Exact versions are recorded in Appendix A.

## 5. Core architecture and contracts

These are framework-free modules under `src/agent`, `src/integrations`,
`src/gateway` and `src/policy`.

### `IntegrationDefinition` (one per integration)

```ts
{
  id: 'gmail'|'google_calendar'|'hubspot'|'stripe'|'quickbooks'|'slack';
  label: string;
  kind: 'composio'|'mcp'|'api';
  resolve(env: AgentEnv): ResolvedConnection | { status: 'not_configured'; missing: string[] };
  profiles: Record<string, { allow: string[] }>;
  classify(toolName: string, input: unknown, settings: WorkspaceSettings): Classification | null;
  probe(conn: ResolvedConnection): Promise<ConnectionStatus>; // read-only
}
```

- `Classification` = `{ actionClass: 'read'|'internal_write'|'outbound'|'financial'|'destructive';
  operation: string /* e.g. stripe.refunds.create */; title: string /* "Refund charge in Stripe" */;
  summary?: string; descriptor?: { amount_minor?, currency?, customer?, record_ids?, recipients? } }`.
- `null` means deny.
- Slack `post_message` is `internal_write` when the channel is in the settings
  allowlist, otherwise `outbound`. A calendar event with attendees outside the
  internal domains is `outbound`.

### `ResolvedConnection` (discriminated union)

- `{kind:'composio', mode:'session', composio:{apiKey, userId, toolkit}, profile:'composio'}`
- `{kind:'composio', mode:'override', upstream:{transport:'http', url, headers}, profile}`
- `{kind:'mcp', upstream:{transport:'http', url, headers} | {transport:'stdio', command, args, env}, profile}`
- `{kind:'api', api:{baseUrl, token, proxyAuthHeader?, realmId?}}`

### Tool gateway

For each available integration, build **one in-process MCP server**:
`{type:'sdk', name:<id>, instance: McpServer, timeout:120000}`.

- **MCP and Composio integrations:** an MCP client from
  `@modelcontextprotocol/sdk` connects upstream (Streamable HTTP, SSE if Composio
  reports `type:'sse'`, or stdio), lists the upstream tools and exposes only the
  intersection with the profile allowlist, passing the raw JSON schemas through
  on `tools/list` and `tools/call` handlers. Calls are forwarded unchanged.
  (Blocking spike S2; fallback is JSON-schema-to-zod through `tool()`.)
- **API integrations:** each tool is registered with `tool()`/zod and calls a
  thin typed fetch client.
- **Why this layer exists:** per-integration names and allowlists; filtering of
  Firedrill's single world-wide `/v1/mcp` endpoint; one place for action logging,
  output compaction (at most about 20k characters per result, with
  `truncated:true`) and connection-kind tagging. The Claude CLI child therefore
  needs **no** Tool secrets.
- **Composio sessions** are created lazily at run start and cached per
  `(userId, toolkits)` for 30 minutes with `new Composio({apiKey,
  disableVersionCheck:true})`. If creation fails, the integration is marked
  `error` for that run and the agent is told.

### HTTP clients (API kind)

- No automatic retry on writes. Reads retry at most twice, only on 429
  (honouring `Retry-After`) or on a network error before any byte is sent.
- Stripe: bracket-syntax form encoding; `Idempotency-Key = sha256(runId + ':' + toolUseId)`.
  QuickBooks uses the same value as `requestid`.
- Errors are normalised to `{provider, status, code, message}` and the tool
  result sets `isError:true`.

### Agent core

`runTurn({conversationId, runId, text, connections, settings, policy, mode: 'interactive'|'headless', signal}): AsyncIterable<AgentEvent>`.

`query()` options:

- `model` (`AGENT_MODEL`), `effort` (`AGENT_EFFORT`),
  `thinking:{type:'adaptive', display}`, `maxTurns`, `maxBudgetUsd`. No
  `fallbackModel`.
- `cwd:<state>/work`, `settingSources:[]`, `tools:[]`, `strictMcpConfig:true`,
  `includePartialMessages:true`, `permissionMode:'default'`.
- `mcpServers`: the gateway servers. `canUseTool`: the policy engine (§7).
  `hooks.PreToolUse`: deny any tool not in the registry (defence in depth).
- `resume: sdk_session_id`, `abortController`.
- `env`, an explicit **allowlist** (it replaces the child environment): `PATH`,
  `HOME=<state>/home`, `CLAUDE_CONFIG_DIR=<state>/claude`, `ANTHROPIC_API_KEY`,
  `ANTHROPIC_BASE_URL?`, `HTTP(S)_PROXY`/`NO_PROXY` (tests only),
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY=1`,
  `DISABLE_ERROR_REPORTING=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`,
  `ENABLE_TOOL_SEARCH=false`, `CLAUDE_AGENT_SDK_CLIENT_APP=revenue-desk/<version>`.
- The native Claude CLI comes from the SDK's optional per-platform package
  (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`), resolved by the SDK
  itself. Tests **fail, not skip**, when it is missing.

### System prompt

Built from settings plus the available integrations: role; company profile;
business date; "look before acting" and "cross-check across systems"; amounts
are minor units and are shown formatted; never invent IDs; draft before sending;
explain the pending action before a gated call; after a denial, do not retry,
report it; concise formatting with tables for lists. It never names
profile-specific tool names. Stable parts come first, for prompt caching.

### `AgentEvent` (contract between core, server and CLI)

- `run.started{runId, model, connections[{id, kind, profile, status}]}`
- `session{sdkSessionId}`
- `status{phase:'requesting'|'compacting'|'retrying', attempt?, max?}`
- `step.start` / `step.finish`
- `reasoning.start|delta|end{id, text}`, `text.start|delta|end{id, text}`
- `tool.input.start{toolCallId, toolName, integration, connectionKind, operation, actionClass, title}`
- `tool.input.delta{toolCallId, partialJson}`, `tool.input.available{toolCallId, input}`
- `approval.requested{approvalId, toolCallId, summary, descriptor}`
- `approval.resolved{approvalId, toolCallId, approved, decidedBy:'user'|'timeout'|'stop'|'policy', reason?}`
- `tool.progress{toolCallId, elapsedSeconds}`
- `tool.output{toolCallId, output, isError, durationMs}`, `tool.denied{toolCallId, reason}`
- `usage{costUsd, inputTokens, outputTokens, cacheReadTokens, turns, durationMs}`
- `run.finished{status:'completed'|'failed'|'cancelled'|'timed_out', stopReason, terminalReason, error?{code, message}}`

Rules: exactly one `tool.input.available` per `tool_use` id, deduplicated
between the assistant message and `canUseTool`, and always before any approval;
skip messages with `parent_tool_use_id !== null`; a `<synthetic>` or
`message.error` assistant message is an error, never an answer.

## 6. Server stream: SDK to AI SDK v7 UI message stream

`POST /api/chat` returns
`createUIMessageStreamResponse(createUIMessageStream({originalMessages, execute, onStepEnd, onEnd}))`
(header `x-vercel-ai-ui-message-stream: v1`, terminated by `[DONE]`).

| AgentEvent | UI message chunk |
|---|---|
| `run.started` | `start{messageId, messageMetadata:{runId, model}}` |
| `step.*` | `start-step` / `finish-step` |
| `text.*` | `text-start` / `text-delta` / `text-end` |
| `reasoning.*` | `reasoning-start` / `-delta` / `-end` |
| `tool.input.start` | `tool-input-start{toolCallId, toolName, dynamic:true, title, toolMetadata:{integration, connectionKind, operation, actionClass}}` |
| `tool.input.delta` / `tool.input.available` | `tool-input-delta` / `tool-input-available` |
| `approval.requested` | `tool-approval-request{approvalId, toolCallId, approvalDescriptor, reason:summary}` |
| `approval.resolved` | `tool-approval-response{approvalId, approved, reason}`, then `tool-output-denied` if not approved |
| `tool.output` | `tool-output-available`, or `tool-output-error` when `isError` |
| `status`, `tool.progress` | transient `data-status` / `data-progress` |
| `usage` | persisted `data-usage` part plus message metadata |
| `run.finished` | `finish{finishReason}`; stop gives `abort`; failure gives a sanitised `error{errorText}` |

- `GET /api/chat/:conversationId/stream` reattaches to the active run (the
  default reconnect URL for `useChat({resume:true})`): it replays that run's
  buffered chunks from the start of the assistant message, then streams live;
  204 when there is no active run. Chunks fan out to every subscriber.
- The assistant `UIMessage` snapshot is persisted at every `onStepEnd` and at
  `onEnd`.

Client:

```ts
useChat({
  id: conversationId,
  messages: fromDb,
  resume: true,
  transport: new DefaultChatTransport({
    api: '/api/chat',
    prepareSendMessagesRequest: ({ id, messages }) =>
      ({ body: { conversationId: id, message: messages.at(-1) } }),
  }),
})
```

**Never** use `sendAutomaticallyWhen` and **never** call
`addToolApprovalResponse`: the server's `tool-approval-response` chunk is the
only source of truth, and re-sending would replay side effects.

## 7. Approvals and policy

| Action class | Default mode |
|---|---|
| `read` | auto |
| `internal_write` (drafts, labels, HubSpot notes and tasks, Slack to allowlisted channels) | auto |
| `outbound` (send email, invite external attendees, Slack elsewhere) | ask |
| `financial` (refund, invoice create/send/void, payment record, subscription cancel) | ask |
| `destructive` | deny |

A `policies` row per class holds the mode; `AGENT_POLICY` overrides it.

In `canUseTool`: classify (unknown means deny); `auto` allows; `deny` returns
`{behavior:'deny', message}`; `ask` inserts a pending approvals row with a
descriptor and `expires_at`, emits `approval.requested`, and awaits a waiter
held on `globalThis` (`Map<approvalId, resolve>`). The waiter is settled by
`POST /api/approvals/:id {approved, reason?}` (404 unknown, 409 already
decided), by timeout (deny, `timeout`), by Stop (deny with `interrupt:true`,
`stop`) or by the abort signal.

- **Stop:** `POST /api/runs/:id/stop` calls `q.interrupt()` and denies pending
  approvals with `interrupt:true`. `abortController.abort()` is only a fallback
  after 3 seconds.
- **Headless:** `ask` becomes deny ("Requires human approval; not available in
  headless mode") unless the policy says `auto`; decisions are recorded as
  `policy`.
- **Boot recovery:** runs still `running` become `failed` (`server_restart`);
  pending approvals become `expired` (`restart`).
- **Security:** loopback does not stop drive-by requests from other sites.
  Every mutating `/api` route requires a same-origin `Origin`,
  `Content-Type: application/json`, and a per-boot session cookie
  (`SameSite=Strict`, HttpOnly) echoed as an `x-rd-csrf` header. One active run
  per conversation (409 otherwise); at most 4 concurrent runs.

## 8. Database

SQLite through better-sqlite3 with Drizzle; WAL mode and `foreign_keys=ON`.
Migrations are generated by drizzle-kit (`pnpm db:generate`, output
`src/db/migrations`) and committed as SQL. One file per state directory:
`<AGENT_STATE_DIR>/revenue-desk.sqlite`, or
`<AGENT_STATE_DIR>/runs/<runId>/agent.sqlite` headless. IDs from `randomUUID`
except messages (UIMessage IDs). Times are ISO UTC text. Money is integer minor
units plus currency. No secrets are ever stored.

| Table | Columns |
|---|---|
| `workspace_settings` (singleton, id=1) | company_name, agent_name, sender_name, email_signature, internal_email_domains json, notify_slack_channel, allowed_slack_channels json, timezone, currency, default_model, updated_at |
| `policies` | action_class PK, mode `auto`/`ask`/`deny`, updated_at |
| `connections` | integration PK, kind, profile, status (`connected`, `needs_auth`, `not_configured`, `error`, `unknown`), status_detail, endpoint_label (host only), composio_account_hint (masked), last_checked_at |
| `conversations` | id, title, source `ui`/`cli`, external_run_id, status (`idle`, `running`, `awaiting_approval`, `error`), sdk_session_id, total_cost_usd, input_tokens, output_tokens, archived_at, created_at, updated_at |
| `messages` | id (UIMessage id), conversation_id FK, run_id, role, parts_json (exact rendered UIMessage parts), text (plain, for search), seq, created_at |
| `runs` | id, conversation_id FK, source, external_run_id, interaction_id, status, stop_reason, terminal_reason, model, effort, num_turns, model_requests, cost_usd, input_tokens, output_tokens, cache_read_tokens, duration_ms, error_code, error_message, policy_snapshot json, connections_snapshot json (id, kind, profile, endpoint host), started_at, finished_at |
| `tool_calls` | id, run_id FK, conversation_id, tool_use_id UNIQUE, integration, connection_kind, tool_name (as the model saw it), upstream_tool (slug, MCP name or `POST /v1/refunds`), operation, action_class, title, input_json (redacted), output_json (compacted), is_error, error_code, http_status, idempotency_key, approval_id, decision (`auto`, `approved`, `denied`, `policy_denied`, `timed_out`, `stopped`), started_at, finished_at, duration_ms |
| `approvals` | id, run_id, conversation_id, tool_use_id, integration, action_class, summary, descriptor_json, status (`pending`, `approved`, `denied`, `expired`, `cancelled`), decided_by, reason, requested_at, decided_at, expires_at |

`pnpm db:seed` (idempotent) writes only the default workspace settings (company
name blank, which Settings prompts for) and the default policies. There are
**no** fabricated conversations, runs or tool data. Connection rows come from
probes at boot. Until the schema lands, `src/db/schema.ts` is a placeholder and
`pnpm db:seed` exits non-zero.

## 9. UI

### Visual identity

The agent's own identity, deliberately distinct from Firedrill cobalt so
side-by-side demos read as two products. Implemented in
`web/src/styles/tokens.css` and bridged to Tailwind and shadcn in
`web/src/styles/globals.css`.

- **Colour.** Cool neutral surfaces `#FFFFFF`/`#F6F7F8`, border `#E4E6EA`, text
  `#111418`/`#5B616E`. The primary button is ink `#111418` (light ink on dark in
  the dark theme). **One accent**, teal-cyan `#0E7490` (Tailwind `brand`;
  rendered `#38B2CF` in the dark theme for contrast), used only for focus,
  links, the selected conversation and the running indicator. Semantic colours:
  success `#1F7A4D`, warning `#9A5B13`, danger `#B42318`. shadcn's `--accent` is
  its neutral hover surface, not the brand accent.
- **Type.** Geist Sans variable: 14/20 body (`text-body`), 13/18 secondary
  (`text-body-sm`), 12/16 metadata (`text-meta`). Geist Mono for IDs and JSON.
  Tabular numerals for money and counts.
- **Shape and motion.** 6px controls, 10px panels; shadow only on popovers;
  motion 120-180ms with `MotionConfig reducedMotion='user'`; lucide icons at 16px.
- **Banned:** gradients, glass, glow, sparkle icons, emoji, avatar bubbles,
  untouched shadcn cards.
- **Provider identity:** text labels only ("Gmail", "HubSpot", "Stripe", ...),
  never vendor logos.
- Light theme by default, with a dark theme.

### Shell

- 56px app bar: product name, a connections-health popover (dot plus label per
  integration), the model label, a theme toggle and, only in sandbox demo mode,
  a persistent "Local sandbox" label.
- Left rail 264px: search, New chat, conversations with running and
  awaiting-approval markers.
- Centre thread capped at 760px.
- Optional right inspector 380px, closed by default, tabs Activity and Run:
  tool-call ledger grouped by connection kind, approvals, cost and tokens.
- Phone (390px): rail becomes a Sheet, inspector a bottom Sheet; sticky composer
  with safe-area insets; 16px gutters; JSON scrolls inside its own block; the
  page never scrolls horizontally.

### Chat screen (AI Elements, owned and patched source)

- Conversation: `Conversation`, `ConversationContent`, `ConversationEmptyState`,
  `ConversationScrollButton`.
- Empty state: one line of copy plus `Suggestions`/`Suggestion` rows for J1-J5.
  No "How can I help you today?" hero.
- Messages: `Message`, `MessageContent`, `MessageResponse` (Streamdown, code
  plugin only), `MessageActions` (copy, open run). User turns are quiet tonal
  blocks; assistant turns are plain prose.
- `Reasoning` only when summarised thinking exists.
- `Tool` (`ToolHeader`/`ToolContent`/`ToolInput`/`ToolOutput`): patched for
  #490 (undefined input while streaming); the yellow/green/blue rounded-full
  badges become a status dot plus label, a neutral outline chip
  "Composio"/"MCP"/"API", and a tabular duration or live elapsed time. Three or
  more consecutive reads collapse into "Checked N sources".
- `Confirmation` (`ConfirmationRequest`/`ConfirmationActions`/
  `ConfirmationAction`/`ConfirmationAccepted`/`ConfirmationRejected`): patched
  for #484 (type derived from `DynamicToolUIPart['approval']`); renders a facts
  table (amount, currency, record IDs, recipients) and names the consequence
  ("Refund $49.00 to Acme"); financial and destructive approvals use the danger
  colour on the primary action; shows a pending spinner after a click until the
  server's response chunk arrives.
- `Shimmer` status line; composer `PromptInput`, `PromptInputTextarea`,
  `PromptInputFooter`, `PromptInputSubmit` (status-aware Stop; Enter ignored
  while streaming, #439); `Context` for tokens and cost; `CodeBlock` inside
  tool input and output.
- shadcn: `Spinner`, `Skeleton`, `Sheet`, `Tooltip`, `Popover`, `Tabs`,
  `Table`; `Sonner` for side-action errors is deferred (its shadcn wrapper
  depends on `next-themes`; W4 adds it against the app's own theme state).

### Loaders

Submitted with no tokens yet: after 300ms a Shimmer "Thinking", which becomes
the current tool title ("Searching HubSpot contacts"). Tool running: 14px
spinner plus elapsed seconds. API retry: inline "Model busy, retrying 2/10".
Rail and history: skeleton rows that keep the list's structure. Connection
checks: per-row spinner.

### Other screens

- **Connections:** integration, kind chip, profile, status dot and label,
  endpoint host, last checked, missing env var names. "Check" runs a read-only
  probe. "Connect" appears only for Composio and, on the user's click, calls
  `session.authorize(toolkit, {callbackUrl})` and opens `redirectUrl` in a new
  tab.
- **Runs:** source, status, duration, cost, tool calls per kind, with a detail
  Sheet that reuses `Tool` read-only and lists approvals.
- **Settings:** workspace profile, policy per action class, Slack channel
  allowlist, internal email domains.

## 10. Headless "run one task" command

`node dist/cli/main.js run-task [--result target-result|value] [--timeout-ms 240000] [--max-turns 30] [--policy '<json>'] [--instruction "…"]`
(dev: `node --import tsx src/cli/main.ts run-task`; never relies on `NODE_OPTIONS`).

- **Input:** stdin JSON `{schemaVersion:1, runId, interactionId, actorId, instruction, input?, bindingEnvironment?}`,
  or `--instruction` locally. `bindingEnvironment` keys that match known agent
  variable names overlay the env snapshot in memory.
- **State:** `${AGENT_STATE_DIR}/runs/<runId>` holds its own database, work
  directory and `CLAUDE_CONFIG_DIR`. A later `interactionId` on the same `runId`
  resumes the same conversation.
- **Stdout:** before any import side effects, keep a private reference to
  `process.stdout.write` and redirect `console.*` to stderr. Emit exactly one
  JSON under 256 KiB.
  - `target-result` success: `{schemaVersion:1, status:'completed', output:{reply (≤16k chars), conversationId, connectionsUsed:{composio:[…], mcp:[…], api:[…]}, toolCalls:[{integration, connectionKind, tool, operation, actionClass, decision, isError}], approvals:[{actionClass, summary, decision}], model, turns, costUsd, stopReason, terminalReason}, attachments:[]}`.
  - Failures: `status` `failed`/`timed_out`/`cancelled` with
    `error:{schemaVersion:1, source:'target', code:'target.CONFIG_MISSING'|'target.MODEL_ERROR'|'target.MAX_TURNS'|'target.BUDGET_EXCEEDED'|'target.TIMEOUT'|'target.CANCELLED', message, retryable:false, issues:[]}`.
    Exit code 0 for every handled outcome.
  - `--result value` prints only the output object; failures exit non-zero
    with a message on stderr.
- **Signals:** SIGTERM or SIGINT interrupts, writes a `cancelled` result and
  exits within 1.5 seconds. `--timeout-ms` produces `timed_out`. No work
  continues after the result is written.

## 11. Testing, fakes and the sandbox demo mode

**Unit (Vitest, no network):** env resolution for every integration
(configured, `not_configured`, override precedence, live-key refusal); path
joining with prefixed base URLs and the proxy-auth header; Stripe bracket form
encoding; idempotency and `requestid` derivation; QuickBooks query builder and
paging; Slack `ok:false` on 200 and 4xx; error normalisation; classifier tables
for all three naming schemes; policy decisions; redactor; AgentEvent to
UIMessageChunk mapping with golden sequences from the real SDK against the mock;
`readUIMessageStream` proving that `tool-approval-request`, then
`tool-approval-response` and `tool-output-*` in one stream render correctly;
database repositories and boot recovery.

**Contract-faithful local fakes** (`test/support/fakes`): stateful, loopback
ephemeral ports, dated fixtures, never reachable from product code paths.
Stripe REST (form-only with 415 on JSON, Bearer-only, idempotency replay, error
envelope, 402 decline, 429); QuickBooks REST (companyinfo, customer, invoice,
payment, query with a size-truncated page, Fault envelope, `requestid`, 403 for
a wrong realm); Slack Web API (both error modes); HubSpot MCP (Streamable HTTP
and stdio, the 11 tools, schemas captured offline from `@hubspot/mcp-server`
0.4.0); Google MCP (Gmail and Calendar names plus `gmail.drafts.send`);
Composio-profile MCP (`GMAIL_*`/`GOOGLECALENDAR_*` with schemas captured
read-only). Fixtures describe one coherent fictional company on `*.test`
domains. Every fake can require and assert the proxy-auth header.

**Scripted Messages API:** adapted from the platform's `mock-anthropic.ts` and
`sdk-gate-support.ts` (with a provenance header) plus thinking blocks. The real
SDK runs as a subprocess with `ANTHROPIC_BASE_URL` pointed at the mock, a dummy
key, `HTTP(S)_PROXY` pointed at the mock with `NO_PROXY=127.0.0.1,localhost`
(any non-loopback CONNECT gets 403 and fails the test) and
`CLAUDE_CODE_MAX_RETRIES=0`.

**Integration and full-stack E2E** (real SDK, mock model, fakes): J1 reads
across all three kinds with draft auto and send approved; J2 refund approved
(exactly one refund with the expected Idempotency-Key, a HubSpot note and a
Slack post); J2 refund denied; Stop while an approval is pending (run and
approval cancelled, no refund, no extra model request); approval timeout; J3
with QuickBooks paging and an external calendar invite that asks for approval;
failures (Stripe 402 and 429, QuickBooks Fault, Slack `ok:false`, HubSpot MCP
down at start, Composio session failure); model 529 with
`x-should-retry:false`; multi-turn resume; HTTP layer (SSE order, reconnect
replay, approvals 404/409, foreign `Origin` 403, one active run per
conversation).

**Headless CLI E2E:** exactly one valid TargetResult on stdout even when a
module logs; `value` mode; missing-config result; SIGTERM gives `cancelled`
within 2 seconds; 8 parallel cases with isolated state; tokens absent from
output.

**Playwright UI E2E** (built app against fakes plus the mock): desktop Chromium
1440×900 and phone 390×844 with touch (`playwright.config.ts`). Flows:
suggestion → shimmer → tool rows with kind chips and live elapsed time →
approval card → approve → final answer; deny; Stop; reload mid-approval with the
card still actionable; Connections (configured, not configured, error); a policy
change affecting the next run; keyboard-only approval. Checks: axe with no
serious violations, `scrollWidth <= clientWidth` at 390px, dark mode, reduced
motion, screenshots saved as artifacts (not pixel-gated).

**Sandbox demo mode (`pnpm dev:sandbox`).** Ships as an explicit, clearly
labelled demo: it starts the server and UI with every integration pointed at
the local fakes (via the ordinary §3 variables) and either the scripted model or
the real model (real keys loaded via `DOTENV_PATH`, chosen explicitly by flag).
The app bar and Connections screen show "Local sandbox" for the whole session.
It is only ever entered by running that script; no product code path selects
fakes on its own, and a missing configuration in normal mode is never replaced
by sandbox data.

**Optional live E2E** (`pnpm test:live`, `LIVE_E2E=1`, keys loaded at runtime
via `DOTENV_PATH`): real Anthropic plus Composio Gmail, **read-only**; the
policy forces every non-read class to deny, `AGENT_MAX_BUDGET_USD=0.50`; asserts
that only read-class tools ran and nothing was sent. Stripe, HubSpot, QuickBooks
and Slack live tests run only with sandbox credentials from Kiran and are
read-only by default.

**`pnpm verify`** currently runs typecheck, lint, unit tests and the build; the
integration, CLI E2E and Playwright suites join it as they land.

## 12. Repository layout

Present now: `package.json`, `pnpm-lock.yaml`, `tsconfig*.json`,
`vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`,
`drizzle.config.ts`, `biome.json`, `components.json`, `.env.example`,
`src/server/{main,app}.ts`, `src/db/{schema,seed}.ts` (placeholders),
`web/index.html`, `web/src/{main.tsx, app/App.tsx, lib/, styles/}`,
`web/src/components/{ui,ai-elements}`, `test/unit/health.test.ts`.

Target:

```
revenue-desk/
  src/
    config/        env.ts (AgentEnv snapshot), redact.ts
    integrations/  types.ts  registry.ts
                   gmail/ google-calendar/ (composio.ts, profiles.ts, classify.ts)
                   hubspot/ (mcp.ts, profiles.ts, classify.ts)
                   stripe/ quickbooks/ slack/ (client.ts, tools.ts, classify.ts)
                   composio/session.ts (disableVersionCheck, cache, authorize, status)
    gateway/       mcp-proxy.ts  api-server.ts  compact.ts
    policy/        classes.ts  engine.ts  approvals.ts (globalThis waiter registry)
    agent/         run-turn.ts  sdk-options.ts  events.ts  prompt.ts  sdk-mapper.ts
    db/            schema.ts  client.ts  repos/*.ts  migrations/*.sql  seed.ts  recover.ts
    server/        main.ts  app.ts  routes/{chat,runs,approvals,conversations,connections,settings}.ts
                   ui-stream.ts  run-registry.ts  security.ts
    cli/           main.ts  run-task.ts  target-result.ts  stdout-guard.ts
  web/src/
    main.tsx  app/routes (chat, runs, connections, settings)  lib/api.ts  lib/chat.ts
    components/ai-elements/*  components/ui/*  components/app/*  styles/{globals,tokens}.css
  test/
    unit/  integration/  e2e-cli/  e2e-ui/  live/
    support/ mock-anthropic.ts  sdk-gate.ts  fakes/{stripe,quickbooks,slack,hubspot-mcp,google-mcp,composio-mcp}.ts  harness.ts
    fixtures/ business/*.json  surfaces/{hubspot-mcp-0.4.0,google-mcp,composio-direct}.json (dated, with source)
    scenarios/ *.ts
  scripts/ dev-sandbox.ts  capture-surfaces.ts (read-only)
  data/ (git-ignored)
```

## 13. Workstreams and milestones

| Item | Status |
|---|---|
| Scaffold (this commit): toolchain, tokens, shadcn + AI Elements, health route, app shell | done |
| S1 spike: Vite + Hono + AI SDK v7; approval request and response in one stream render in `useChat` | pending |
| S2 spike: SDK 0.3.283 accepts `instance: McpServer` with raw JSON-schema handlers against the mock | pending |
| S3 spike: Composio 0.21 `direct_tools` session MCP through the proxy (session creation and tool listing only) | pending |
| S4 spike: offline capture of `@hubspot/mcp-server` 0.4.0 `tools/list` | pending |

Workstreams after the spikes, joined through the §5 contracts: W1 agent core,
policy and gateway; W2 integrations; W3 database and server; W4 web UI; W5 test
infrastructure; W6 CLI and README. M1: core, integrations, database and CLI
green on unit, integration and CLI E2E. M2: server and UI green on full-stack
and Playwright. M3: live read-only E2E and polish; done only when `pnpm verify`
is fully green and live read-only E2E has run.

## 14. Firedrill phase 2 (documented now, built only when Kiran says)

Substitution through `firedrill run` (path A) aliases only; no agent code
changes.

| Integration | Aliases and host variables |
|---|---|
| Stripe | `STRIPE_API_BASE_URL ← FIREDRILL_WIRE_HTTP_URL`, `STRIPE_SECRET_KEY ← FIREDRILL_WIRE_HTTP_TOKEN`, `STRIPE_API_PROXY_AUTH_HEADER ← FIREDRILL_WIRE_HTTP_AUTHORIZATION_HEADER` |
| QuickBooks | Same wire trio into the `QBO_*` variables; host `QBO_REALM_ID` set to the world realm |
| Slack | Same wire trio into the `SLACK_*` variables |
| HubSpot | `HUBSPOT_MCP_URL`/`HUBSPOT_MCP_TOKEN ← FIREDRILL_MCP_URL`/`FIREDRILL_MCP_TOKEN` (identical 11 names) |
| Gmail | `GMAIL_MCP_URL`/`GMAIL_MCP_TOKEN ← FIREDRILL_MCP_URL`/`FIREDRILL_MCP_TOKEN`; host `GMAIL_MCP_PROFILE=google` |
| Calendar | `GOOGLE_CALENDAR_MCP_URL`/`GOOGLE_CALENDAR_MCP_TOKEN ← FIREDRILL_MCP_URL`/`FIREDRILL_MCP_TOKEN`; host `GOOGLE_CALENDAR_MCP_PROFILE=google` |

`ANTHROPIC_API_KEY` passes through from the host. Target:
`{command:'node', arguments:['dist/cli/main.js','run-task'], bindings:['http','mcp'], output:'json'}`,
target ID `revenue-desk`. World grants: QuickBooks `customers.post`,
`invoices.post`, `payments.post`, `invoices.send`, the `*.get` operations and
`query.run`; **not** the MCP-only `customers.create`/`invoices.create`, which
collide with Stripe's aliases and take down the whole MCP endpoint.

Composio in simulation becomes Firedrill MCP with Google names, labelled in the
UI and in `connectionsUsed` as `composio (substituted: mcp)`. PR CI uses path A;
path B (GitHub App) provides no wire variables.

Platform gaps to report to Codex through `CLAUDE_PROGRESS.md`: catalog HTTP
connection recipes point at the gateway origin rather than `/v1/wire` plus the
routing header; the Stripe/QuickBooks MCP alias collision; no wire variables in
the CI runner; no per-Tool MCP scope; README version drift across Tools.

## 15. Risks

- Composio cannot be simulated faithfully; in Firedrill, Gmail and Calendar
  switch to Google MCP names, so the tool surface differs from production and
  must be labelled honestly.
- The Stripe/QuickBooks `create_customer`/`create_invoice` MCP alias collision
  can take down every MCP-connected Tool in a world that grants both.
- The in-process filtering proxy depends on the SDK accepting a hand-built
  `McpServer` instance with raw JSON-schema handlers (spike S2).
- Live readiness is limited: only Gmail is active in Composio; Calendar needs
  reconnecting; there are no HubSpot, QuickBooks, Stripe or Slack credentials;
  QuickBooks tokens expire hourly; `@hubspot/mcp-server` 0.4.0 is a stale beta
  and legacy private-app creation ends 2026-10-26.
- Firedrill Tools serve documented route subsets and differ in behaviour
  (Slack 4xx vs 200 `ok:false`, HubSpot 200 vs 207, truncated QuickBooks pages,
  Stripe declines not stored). Tools and fakes must stay inside those subsets
  and tolerate both behaviours.
- Business dates: Firedrill worlds use fixed virtual dates while the SDK injects
  the wall-clock date; `AGENT_BUSINESS_DATE` and QuickBooks company time may
  conflict with it in aging calculations.
- AI Elements source targets ai v6 while this repo runs ai v7; issues #484,
  #490, #439, #496 need owned patches, and a later `shadcn add` can overwrite
  patches (it prompts first). Registry installs also resolved newer majors than
  the AI Elements package targets (shiki 4, motion 13, lucide-react 1); they
  type-check but need runtime verification in W4.
- In-memory approvals are lost on restart (mitigated by boot expiry and
  per-step snapshots); CSRF protections are mandatory even on loopback.
- Headless stdout purity: Composio prints an upgrade banner unless
  `disableVersionCheck:true`, and any stray `console.log` breaks the one-JSON
  TargetResult.
- Cost and nondeterminism: without `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, an isolated
  `CLAUDE_CONFIG_DIR` and `ENABLE_TOOL_SEARCH=false`, host memory and tool
  deferral leak into runs. The Sonnet 5 / medium default keeps many-case CI
  simulations affordable; both are configurable.
- Vendor churn (Composio 0.19-0.21 shipped breaking changes within four days;
  Stripe MCP policy changes) requires exact pins and dated fixtures.
- The native Claude CLI binaries are optional per-platform dependencies; an
  install with optional dependencies omitted leaves no binary, and the test gate
  must fail rather than skip. The lockfile records all eight platform packages.
- TypeScript 7 has no JavaScript compiler API (`typescript` exports only its
  version). Tools that import the compiler API (typescript-eslint, ts-morph
  against the project compiler, Vitest typecheck mode) will not work; the
  fallback is TypeScript 6.0.3 or 5.9.3.

## Decisions (lead, 2026-09-28)

- Name "Revenue Desk", package and future target ID `revenue-desk`; private,
  unlicensed, local git only.
- Default model `claude-sonnet-5` with effort `medium`, both configurable, no
  silent fallback.
- Connection mapping: Composio for Gmail and Google Calendar; MCP for HubSpot
  (stdio `@hubspot/mcp-server` by default, or any HTTP MCP); API for Stripe,
  QuickBooks and Slack.
- `COMPOSIO_USER_ID` from configuration only. Composio session creation and
  read-only listing allowed; no write execution; no OAuth initiation by
  implementers.
- `dev:sandbox` ships as an explicit, labelled demo mode, never a fallback.
- Visual identity as in §9: cool neutrals, ink primary, teal-cyan `#0E7490`,
  Geist Sans/Mono, text labels instead of vendor logos.

## Open questions (still Kiran's)

- Credentials: a Stripe sandbox `sk_test_` key; a HubSpot developer test-account
  private-app token or Service Key; a QuickBooks sandbox access token and realm
  ID; a Slack developer-sandbox bot token; reconnecting Google Calendar in
  Composio.
- Live E2E reads the connected Gmail inbox read-only with writes forced to deny
  and a $0.50 cap: acceptable, or connect a test Google account first?
- QuickBooks: automatic OAuth refresh (persisting a rotating refresh token
  locally) or short-lived access tokens only for now?
- Which policy should Firedrill simulations run under: headless deny-on-ask, or
  financial auto for refund drills?
- Licence: stay unlicensed, or apply the older example's Apache-2.0 notice?
- Before phase 2: has the saved-setup `firedrill run --setup` client shipped?

## Appendix A. Toolchain record (installed 2026-09-28)

Node 24.11.1 on darwin-arm64; pnpm 9.15.4; `engines.node >=22.22.3` (the
`@composio/core` floor). All versions are exact pins.

**Runtime dependencies:** `@anthropic-ai/claude-agent-sdk` 0.3.283 (native CLI
`@anthropic-ai/claude-agent-sdk-darwin-arm64` 0.3.283, Claude Code 2.1.283,
resolved via the SDK's own `createRequire`), `@anthropic-ai/sdk` 0.128.0 (SDK
peer, pinned explicitly), `@composio/core` 0.21.0, `@modelcontextprotocol/sdk`
1.30.1, `@hubspot/mcp-server` 0.4.0, zod 4.6.5, ai 7.0.118, `@ai-sdk/react`
4.0.121, hono 4.13.10, `@hono/node-server` 2.1.1, better-sqlite3 13.0.3
(bundled N-API prebuilds; SQLite 3.53.4), drizzle-orm 0.45.3, react and
react-dom 19.3.0, streamdown 2.6.0, `@fontsource-variable/geist` 5.3.0,
`@fontsource-variable/geist-mono` 5.3.0, lucide-react 1.48.0.

Added by `shadcn init` / `shadcn add`: radix-ui 1.6.7, cn 0.4.0 (shadcn's
class merger), class-variance-authority 0.7.1, tw-animate-css 1.4.0, cmdk
1.1.1. Added by the AI Elements registry items: `@radix-ui/react-use-controllable-state`
1.2.6, `@streamdown/cjk` 1.0.3, `@streamdown/code` 1.1.1, `@streamdown/math`
1.0.2, `@streamdown/mermaid` 1.0.2, motion 13.4.4, nanoid 6.0.1, shiki 4.4.3,
tokenlens 1.3.1, use-stick-to-bottom 1.1.6. (Trimming Streamdown to the code
plugin removes cjk, math and mermaid in W4.)

**Dev dependencies:** typescript 7.0.2, tsx 4.23.15, vite 8.3.1,
`@vitejs/plugin-react` 6.1.1, tailwindcss and `@tailwindcss/vite` 4.3.3,
drizzle-kit 0.31.11, vitest 5.0.2, `@playwright/test` 1.63.0,
`@axe-core/playwright` 4.13.0, `@biomejs/biome` 2.5.14, shadcn 4.21.0 (provides
`shadcn/tailwind.css`), `@types/node` 22.20.4 (matches the Node 22 floor),
`@types/react` and `@types/react-dom` 19.3.0, `@types/better-sqlite3` 9.6.0.
Playwright browsers are not installed yet.

**Differences from the proposal:** pnpm 9.15.4 instead of 12.6.0 (installed
version); `engines` `>=22.22.3`; TypeScript 7.0.2 kept after type-check, build,
tsx, Vite, Vitest, drizzle-kit and the shadcn CLI all ran cleanly with it;
`@hubspot/mcp-server` and `@anthropic-ai/sdk` added as explicit pins; Biome
chosen for lint and format; Sonner deferred.

**shadcn/ui:** CLI 4.21.0, `init --base radix --preset nova --template vite`
(style `radix-nova`, base colour neutral, CSS variables, lucide). The generated
oklch tokens were replaced by `tokens.css`. Components in
`web/src/components/ui`: alert, badge, button, button-group, collapsible,
command, dialog, dropdown-menu, hover-card, input, input-group, popover,
progress, scroll-area, select, separator, sheet, skeleton, spinner, table, tabs,
textarea, tooltip.

**AI Elements:** added with `shadcn@4.21.0 add
https://elements.ai-sdk.dev/api/registry/<item>.json` on 2026-09-28. The
registry is unversioned; its source repository's latest commit at research time
was `6a9d5b18` (2026-08-21). Items and SHA-256 of the registry JSON fetched the
same day:

| Item | SHA-256 |
|---|---|
| code-block | `b5ac0e9373b26576c69a2035aae8868d957189bd3c52807bfa91e2a12904db32` |
| confirmation | `46c75b46b40421a5489238c9d537de59e79acb7673b87dbc688fcfe1ffc2909f` |
| context | `73e26e24d5b0b2c06d392ff75d3d463f9d18369140385f577c6180040e961c89` |
| conversation | `7b964b9252cb39218ebbf1e156bcf42be7a049c51e881cf72cc7b7bc2ce31090` |
| message | `c37a2189906cf9e14d95f304d609dc6c0b53e22f78d1d644cddbe1d62284e804` |
| prompt-input | `660efa7c9a10c204ceeb8d32a320ef430a26776b283a148113a1f672a90af0b8` |
| reasoning | `4d2e0195a483c40f3cb976ba87df2a931edbb3098bf968ba780f1cc155d5c1e9` |
| shimmer | `8b4b49bfa332e84db6bb2e8b717e65663af6085ac10e757eeb6a6889e8c787ae` |
| suggestion | `28ec9a94a5485f525ce90560e59b70a76b717f4a822508566b731756793c6b45` |
| tool | `ac2f38003fe00b0a0b7594bc028f0d6ff09db1a8a79a40bb4fa632565c06194b` |

Installed files equal the registry content apart from shadcn's alias rewrite
(`@/registry/default/ui/` → `@/components/ui/`), except for this patch:

- `context.tsx`: ai v7 moved `usage.reasoningTokens` to
  `usage.outputTokenDetails.reasoningTokens` and `usage.cachedInputTokens` to
  `usage.inputTokenDetails.cacheReadTokens`; two lines changed so the file
  type-checks (marked `revenue-desk patch`).

Pending owned patches (W4): `tool.tsx` #490 and restyle; `confirmation.tsx`
#484; `prompt-input.tsx` #439; `reasoning.tsx` #496; `message.tsx` Streamdown
plugins trimmed to code only.

**Adding more AI Elements:** because `src/` exists (the server), the shadcn CLI
resolves registry targets to `src/components/ai-elements/`. After each add, move
the new files to `web/src/components/ai-elements/` and delete the empty
`src/components`, then re-check that no existing patched file was overwritten.
