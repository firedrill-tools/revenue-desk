# Revenue Desk architecture

This is the design reference for Revenue Desk. It adapts the September 28, 2026
architecture proposal with the lead's decisions, the spike results and the
scope change applied (see the decisions log at the end). Where this document
and the code disagree, the code is the current state and this document is the
target; implementation status is tracked in §13, not implied by the text.

Current state (2026-09-29): **integrated.** The six workstreams are built and
wired: `pnpm start` and `pnpm dev` serve the full `/api` and the app, the CLI
runs against the shared database, and `pnpm verify` (typecheck, lint, unit,
integration and full-stack tests, build, CLI and UI end-to-end suites) is
green. §13 has the status and what is still open; the optional live
read-only E2E has not been built or run.

## 0. Ground rules

- **Scope: the agent only.** Revenue Desk is built as an ordinary production
  agent. Connecting it to any external test or simulation platform, and CI for
  that, are out of scope until Kiran asks (decisions log).
- **Location and distribution.** `repositories/revenue-desk` in this
  workspace. Local git only: no remote, never pushed. `package.json` has
  `"private": true`; there is no licence file until Kiran decides.
- **Configuration is ordinary.** Each integration has its own base URL and
  credential variables (§3). There are no adapter-specific variables or
  output contracts.
- **Patterns reused** from `../gmail-agent`: the Composio session MCP
  (`src/composio.ts`), `canUseTool` approvals and SDK options (`src/agent.ts`),
  and the SQLite action log (`src/db.ts`).
- **gmail-agent defects that must not be repeated:** emitting `tool_call` twice
  per call; reporting an approval as decided by "user" when the user denied;
  letting the Claude CLI child inherit the whole `process.env` (including
  `COMPOSIO_API_KEY`).
- **Secrets.** No key value is ever printed, logged, stored in SQLite, streamed
  to the browser, copied or committed. Local runs that need real keys load them
  at runtime from a file outside the repository named by `DOTENV_PATH` (or
  `process.loadEnvFile(path)`). Secrets travel as `SecretValue`
  (`src/contracts/env.ts`), which serialises as `[redacted]`. A redactor (§5)
  scrubs every configured secret value and `Bearer …`, `sk_`, `rk_`, `xox`,
  `pat-` patterns from logs, database rows, SSE output and stdout.
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

Each job crosses three or more systems and all three connection kinds, and
every outcome is checkable in tests: a refund created exactly once for the
right amount with an idempotency key; no email to the wrong customer; no
financial write without approval; correct handling of a declined card, a 429,
a missing record, a partial QuickBooks page or an unavailable integration.

## 2. Integrations and connection kinds

| Integration | Kind | Production endpoint and auth |
|---|---|---|
| Gmail | **Composio** | Composio session MCP: `sessions.create(userId, {toolkits, tools:{<toolkit>:{enable:[…]}}, sessionPreset:'direct_tools', manageConnections:false, sandbox:{enable:false}, mcp:true})`. Composio manages the Google OAuth. |
| Google Calendar | **Composio** | The same session, `googlecalendar` toolkit. |
| HubSpot | **MCP** | Default: `@hubspot/mcp-server` 0.4.0 over stdio with `HUBSPOT_ACCESS_TOKEN`. Alternative: any Streamable HTTP MCP via `HUBSPOT_MCP_URL`/`HUBSPOT_MCP_TOKEN`. |
| Stripe | **API** | REST `https://api.stripe.com/v1/*`, form-encoded, `Authorization: Bearer sk_test_…`, `Idempotency-Key` on writes. |
| QuickBooks Online | **API** | REST `https://sandbox-quickbooks.api.intuit.com/v3/company/{realmId}/*`, Bearer access token, `requestid` idempotency. |
| Slack | **API** | Web API `https://slack.com/api/<method>`, bot token. |

Result: two Composio, one MCP, three API integrations
(`INTEGRATIONS` in `src/contracts/integration.ts`). Why each kind:

- **Gmail and Calendar through Composio:** Composio holds the Google OAuth
  grant, so the agent never stores Google tokens. Gmail is already connected in
  Composio; Calendar's connection must be reconnected by Kiran.
- **HubSpot through MCP:** HubSpot publishes an official MCP server, so the MCP
  path runs a real vendor server. Any Streamable HTTP MCP server can replace it.
- **Stripe, QuickBooks and Slack through their REST APIs:** direct REST is the
  most common and most testable integration style. Stripe and QuickBooks have
  sandbox accounts, idempotency keys and documented error envelopes; a Slack bot
  token is simple to obtain, while Slack's official MCP needs user OAuth and
  the reference Slack MCP server is deprecated.

### Tool surfaces

Every tool reaches the model through one in-process MCP server per integration,
so tool names look like `mcp__<integration>__<tool>`. Operations are named
`<integration>.<resource>.<verb>`. The base class applies before the input is
known; `classify()` decides the final class from the complete input (§5, §7).
These tables are the frozen profiles; W2 implements them as `ToolProfile`s.

**Gmail, profile `composio`** (Composio `direct_tools` slugs, captured
read-only in `test/fixtures/surfaces/composio-direct.json`; allowlist and
access levels in `src/integrations/composio/session.ts`):

| Tool | Operation | Base class |
|---|---|---|
| `GMAIL_FETCH_EMAILS` | `gmail.messages.list` | read |
| `GMAIL_FETCH_MESSAGE_BY_THREAD_ID` | `gmail.threads.get` | read |
| `GMAIL_LIST_THREADS` | `gmail.threads.list` | read |
| `GMAIL_LIST_LABELS` | `gmail.labels.list` | read |
| `GMAIL_CREATE_EMAIL_DRAFT` | `gmail.drafts.create` | internal_write |
| `GMAIL_ADD_LABEL_TO_EMAIL` | `gmail.messages.label` | internal_write |
| `GMAIL_SEND_DRAFT` | `gmail.drafts.send` | outbound |
| `GMAIL_REPLY_TO_THREAD` | `gmail.threads.reply` | outbound |

**Google Calendar, profile `composio`:**

| Tool | Operation | Base class |
|---|---|---|
| `GOOGLECALENDAR_EVENTS_LIST` | `google_calendar.events.list` | read |
| `GOOGLECALENDAR_FIND_FREE_SLOTS` | `google_calendar.freebusy.query` | read |
| `GOOGLECALENDAR_FIND_EVENT` | `google_calendar.events.find` | read |
| `GOOGLECALENDAR_CREATE_EVENT` | `google_calendar.events.create` | outbound; internal_write when every attendee is inside `internalEmailDomains` and the calendar is `primary`, an internal address or listed in `internalCalendarIds` |
| `GOOGLECALENDAR_UPDATE_EVENT` | `google_calendar.events.update` | as create, and outbound unless this run read the event (events list, search, create or update result) and its current guests are all internal and none is dropped with a notification: the update is a full replacement |

**HubSpot, profile `hubspot-mcp-0.4`** (10 of the 21 tools of 0.4.0, captured
in `test/fixtures/surfaces/hubspot-mcp-0.4.0.json`). The jobs need CRM reads
and creating or updating records. Notes and tasks are created with
`hubspot-batch-create-objects`, their associations inline in
`inputs[].associations[]` (0.4.0 requires `associationCategory`), so one call
creates the record and its links. The other 11 tools (property and engagement
administration, association batches, workflows, links, feedback) are not
offered.

| Tool | Operation | Base class |
|---|---|---|
| `hubspot-get-user-details` | `hubspot.account.get` | read |
| `hubspot-list-objects` | `hubspot.objects.list` | read |
| `hubspot-search-objects` | `hubspot.objects.search` | read |
| `hubspot-batch-read-objects` | `hubspot.objects.batch_read` | read |
| `hubspot-list-associations` | `hubspot.associations.list` | read |
| `hubspot-get-association-definitions` | `hubspot.associations.definitions` | read |
| `hubspot-list-properties` | `hubspot.properties.list` | read |
| `hubspot-get-property` | `hubspot.properties.get` | read |
| `hubspot-batch-create-objects` | `hubspot.<objectType>.create`, e.g. `hubspot.notes.create` | internal_write |
| `hubspot-batch-update-objects` | `hubspot.<objectType>.update` | internal_write |

**Stripe** (own tools, each 1:1 with a REST operation):

| Tool | REST route | Operation | Base class |
|---|---|---|---|
| `find_customers` | `GET /v1/customers?email=&limit=` | `stripe.customers.list` | read |
| `get_customer` | `GET /v1/customers/{id}` | `stripe.customers.retrieve` | read |
| `list_charges` | `GET /v1/charges?customer=` | `stripe.charges.list` | read |
| `list_payment_intents` | `GET /v1/payment_intents` | `stripe.payment_intents.list` | read |
| `list_invoices` | `GET /v1/invoices` | `stripe.invoices.list` | read |
| `get_invoice` | `GET /v1/invoices/{id}` | `stripe.invoices.retrieve` | read |
| `list_subscriptions` | `GET /v1/subscriptions` | `stripe.subscriptions.list` | read |
| `list_refunds` | `GET /v1/refunds` | `stripe.refunds.list` | read |
| `get_balance` | `GET /v1/balance` | `stripe.balance.retrieve` | read |
| `create_refund` | `POST /v1/refunds` | `stripe.refunds.create` | financial |
| `cancel_subscription` | `DELETE /v1/subscriptions/{id}` | `stripe.subscriptions.cancel` | financial |

**QuickBooks** (own tools):

| Tool | REST route | Operation | Base class |
|---|---|---|---|
| `get_company_info` | `GET /companyinfo/{realm}` (also the business clock) | `quickbooks.company_info.get` | read |
| `find_customers` | `GET /query` (Customer) | `quickbooks.customers.query` | read |
| `get_customer` | `GET /customer/{id}` | `quickbooks.customers.get` | read |
| `list_invoices` | `GET /query` (Invoice, balance and due filters); pages until an empty `QueryResponse` | `quickbooks.invoices.query` | read |
| `get_invoice` | `GET /invoice/{id}` | `quickbooks.invoices.get` | read |
| `list_payments` | `GET /query` (Payment) | `quickbooks.payments.query` | read |
| `create_customer` | `POST /customer` | `quickbooks.customers.create` | internal_write |
| `create_invoice` | `POST /invoice` | `quickbooks.invoices.create` | financial |
| `send_invoice` | `POST /invoice/{id}/send` | `quickbooks.invoices.send` | financial |
| `record_payment` | `POST /payment` | `quickbooks.payments.create` | financial |
| `void_invoice` | `POST /invoice?operation=void` | `quickbooks.invoices.void` | financial |

**Slack** (own tools):

| Tool | Web API method | Operation | Base class |
|---|---|---|---|
| `list_channels` | `conversations.list` | `slack.conversations.list` | read |
| `read_channel` | `conversations.history` | `slack.conversations.history` | read |
| `read_thread` | `conversations.replies` | `slack.conversations.replies` | read |
| `find_user` | `users.list` / `users.info` | `slack.users.lookup` | read |
| `post_message` | `chat.postMessage` | `slack.chat.post_message` | outbound; internal_write when the channel is in `allowedSlackChannels` |
| `add_reaction` | `reactions.add` | `slack.reactions.add` | internal_write |

Slack reports most errors as HTTP 200 with `ok:false`; the client also handles
HTTP 4xx/5xx and 429 with `Retry-After`.

## 3. Environment and configuration contract

The source of truth is `src/contracts/env.ts`: `ENV_VARS` (every name, its
group, whether it is a secret, product or test scope) and the `AgentEnv`
snapshot type. `.env.example` lists exactly those names in the same order; a
unit test keeps them equal. The config layer (`src/config/env.ts`, W1) reads
`process.env` once at start into an immutable `AgentEnv` and never mutates it.

- **Model:** `ANTHROPIC_API_KEY` (required to run), `ANTHROPIC_BASE_URL`
  (optional; tests point it at the scripted API), `AGENT_MODEL` (default
  **`claude-sonnet-5`**), `AGENT_EFFORT` (default **`medium`**; low, medium,
  high, xhigh, max), `AGENT_THINKING_DISPLAY` (`summarized` in the UI,
  `omitted` in the CLI when unset), `AGENT_MAX_TURNS` (30),
  `AGENT_MAX_BUDGET_USD` (2.00 per run).
  - **No silent model fallback.** The SDK `fallbackModel` option is never set.
    An unavailable or invalid model fails the run with `model_error`; the
    configured model is what runs.
  - Model precedence for a run: CLI flag, then Settings (`defaultModel`,
    `defaultEffort`), then the environment, then the defaults.
- **Runtime:** `PORT` (4320; the server always binds to 127.0.0.1),
  `AGENT_STATE_DIR` (`./data`, git-ignored, shared by server and CLI),
  `AGENT_POLICY` (JSON modes per action class; those classes are locked in the
  app), `AGENT_BUSINESS_DATE` (YYYY-MM-DD the agent treats as today; default
  today in the workspace time zone; useful for reproducible tests and demos),
  `AGENT_APPROVAL_TIMEOUT_MS` (900000), `AGENT_SANDBOX` (set only by
  `pnpm dev:sandbox`, §11), `DOTENV_PATH`.
- **Composio:** `COMPOSIO_API_KEY`, `COMPOSIO_USER_ID` (from configuration
  only; **there is no default user id in code**), `COMPOSIO_BASE_URL`
  (default `https://backend.composio.dev`). Missing key or user id make Gmail
  and Calendar `not_configured`.
- **HubSpot:** `HUBSPOT_MCP_URL` (+ optional `HUBSPOT_MCP_TOKEN`) selects any
  Streamable HTTP MCP server. Otherwise stdio: `HUBSPOT_ACCESS_TOKEN` is passed
  to the child as `PRIVATE_APP_ACCESS_TOKEN` in an explicit child environment,
  and `HUBSPOT_API_BASE_URL` becomes its `BASE_URL_OVERRIDE`.
  `HUBSPOT_MCP_COMMAND`/`HUBSPOT_MCP_ARGS` (JSON array) replace the command for
  tests. The default command is `process.execPath` plus the resolved
  `@hubspot/mcp-server` bin; never `npx` at runtime.
- **Stripe:** `STRIPE_SECRET_KEY` (keys starting `sk_live_`/`rk_live_` are
  refused, state `invalid`, unless `ALLOW_LIVE_STRIPE=1`), `STRIPE_API_BASE_URL`
  (`https://api.stripe.com`), `STRIPE_API_VERSION`.
- **QuickBooks:** `QBO_ACCESS_TOKEN`, `QBO_REALM_ID`, `QBO_API_BASE_URL`
  (`https://sandbox-quickbooks.api.intuit.com`), `QBO_MINOR_VERSION`.
- **Slack:** `SLACK_BOT_TOKEN`, `SLACK_API_BASE_URL` (`https://slack.com`).
- **Base URLs** may contain a path prefix; clients join paths without dropping
  it.
- **Passthrough (tests):** `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and
  `CLAUDE_CODE_MAX_RETRIES` are forwarded to the Claude CLI child when set
  (`SDK_CHILD_PASSTHROUGH_VARS`); they are not app configuration.
- **Missing or refused configuration.** `IntegrationDefinition.resolve(env)`
  returns `configured`, `not_configured` (with the missing variable *names*) or
  `invalid` (with problems that never contain values). Only configured
  integrations are offered; the system prompt lists only available ones; the
  Connections screen shows the missing names.

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
- **Contracts in the web client:** import `src/contracts/*.js` by relative
  path (`../../../src/contracts/api.js`); both type-checking and the Vite
  build resolve them, runtime constants included (checked 2026-09-28).
- **Lint and format:** Biome. `web/src/components/ui`,
  `web/src/components/ai-elements` (diffable against their registries; patches
  reviewed by hand, Appendix A) and `src/db/migrations` (generated) are
  excluded.
- **Package manager:** pnpm 9.15.4 (`packageManager` pinned), `save-exact`, and
  install scripts limited to `better-sqlite3` and `esbuild`
  (`pnpm.onlyBuiltDependencies`).

Exact versions are recorded in Appendix A.

## 5. Contracts

The shared contracts are TypeScript modules under `src/contracts/`. They are
frozen: workstreams build against them and change them only through the lead,
with a decisions-log entry. They use no Node-only globals and import no
implementation module (type-only imports from `ai` are allowed), so the
server, the CLI and the web client all import them.
`test/unit/contracts.test.ts` checks them against the libraries they describe.

| File | Contents |
|---|---|
| `json.ts` | `JsonValue`, `JsonObject` |
| `integration.ts` | `IntegrationId`, `ConnectionKind`, `INTEGRATIONS`, `ProfileId`, tool naming (`sdkToolName`, `parseSdkToolName`, `TOOL_USE_ID_META_KEY`), `ActionClass`, `ApprovalMode`, `DEFAULT_POLICY`, `ToolSpec`/`ToolProfile`/`ProfileAllowlists`/`ToolDescriptor`, `Classification`, `ActionDetails`, `Money`, `WorkspaceSettings`, `ResolvedConnection` (per integration), `ConnectionResolution`, `ConnectionState`/`ConnectionStatus`/`ProbeResult`, `ApiCallContext`, `ToolFailure`, `IntegrationDefinition`, `composioAccessFor` |
| `env.ts` | `ENV_VARS`, `EnvVarName`, `ENV_DEFAULTS`, `STATE_LAYOUT`, `SecretValue`, `ConfigProblem`, `AgentEffort`, `ModelSettings`, `AgentEnv` |
| `events.ts` | `AgentEvent` and its ordering rules, `RunTurnInput`/`RunTurn`, `ApprovalGate`, `ConnectionPlan`, `ToolMetadata`, `ApprovalDescriptor`, `RunConnection`, `StatusData`, `RunUsage`, `RunStatus`, `RunError`, `ToolDecision`, `SdkTerminalReason` |
| `api.ts` | `ChatUIMessage` (metadata and data parts), `API_PATHS`, `ApiEndpoints` (every route with params, query, body, response), `ApiErrorBody`/`API_ERROR_STATUS`, resource views, `CSRF_HEADER`, `SESSION_COOKIE`, `MAX_CONCURRENT_RUNS` |
| `cli.ts` | `ASK_FLAGS`, `AskCommand`, `CLI_EXIT_CODES`, `RunSummary` (`--json`) |

### Integrations

One `IntegrationDefinition` per integration (`src/integrations/<id>/`, W2):
`id`, `label`, `kind`, `profile` (the §2 table as a `ToolProfile`),
`resolve(env)` (reads the snapshot only), `classify(tool, input, settings)`
(`Classification | null`; null means deny) and `probe(connection, signal)`
(read-only).

- `Classification` is `{actionClass, operation, title, details?}`; `details`
  (`{consequence, facts[], amount?, recipients?, recordIds?}`) is required by
  the type for `outbound`, `financial` and `destructive`, so every card that
  can ask has its facts.
- `ResolvedConnection` is a union discriminated by `integration`: Composio
  `{composio:{apiKey, userId, baseUrl, toolkit}}`; HubSpot
  `{mcp: {transport:'http', url, token} | {transport:'stdio', accessToken, apiBaseUrl, command}}`;
  Stripe `{api:{baseUrl, secretKey, keyMode, apiVersion}}`; QuickBooks
  `{api:{baseUrl, accessToken, realmId, minorVersion}}`; Slack
  `{api:{baseUrl, botToken}}`. Every one carries `endpointLabel` (host only).
  Secrets stay `SecretValue` until the gateway builds a transport.
- Composio session exposure follows the run's policy (`composioAccessFor`):
  outbound tools are offered, and then gated, unless outbound is `deny`.
- An integration that resolves but whose last probe says `needs_auth` or
  `expired` (Calendar today) is `unavailable` for the run: its tools are not
  offered (S3: `direct_tools` lists Calendar tools even without a connection).

### Tool gateway (proved by S2)

For each available integration, build **one in-process MCP server per
`query()`**: `{type:'sdk', name:<integration>, instance, timeout:120000}`.
An instance serves one query at a time; two concurrent queries sharing one
silently get no tools.

- **MCP and Composio:** `connectUpstream` (Streamable HTTP or stdio; SSE only
  if Composio ever reports it) plus `createFilteringProxy`, which lists only
  the profile's tools with their raw upstream schemas (forwarded byte for
  byte) and refuses any other name without an upstream call.
- **API:** `createApiServer` with `defineApiTool` (zod shapes, typed `run`).
  `ApiToolContext` grows to `ApiCallContext` `{runId, toolUseId,
  idempotencyKey, signal}`.
- **Tool-use id.** The Claude CLI sends the model's tool_use id on every
  tools/call as `_meta["claudecode/toolUseId"]` (`TOOL_USE_ID_META_KEY`), to
  both server kinds (verified 2026-09-28, CLI 2.1.283). The gateway reads it to
  join each call to its action-log row and to derive
  `idempotencyKey = sha256hex(runId + ':' + toolUseId)` (Stripe
  `Idempotency-Key`, QuickBooks `requestid`). A write without it fails closed.
- **Argument validation before approval.** The CLI does not validate
  arguments of proxied tools, and the SDK validates API-tool zod shapes only
  after `canUseTool` approved them. W1 validates every call against the
  offered JSON schema (ajv, added as an explicit dependency) in a `PreToolUse`
  hook, before any approval, and returns a compact message to the model.
  Such calls are `rejected`.
- **Why this layer exists:** per-integration names and allowlists (HubSpot
  0.4.0 lists 21 tools, Revenue Desk offers 10); one place for action logging,
  output compaction (at most about 20k characters per result, with
  `truncated:true`) and connection-kind tagging. The Claude CLI child therefore
  needs **no** integration secrets.
- **Composio sessions** are created lazily and cached per
  `(toolkits, access)` for 30 minutes (`ComposioSessionManager`), with
  `disableVersionCheck:true`, `allowTracking:false` and a stderr logger. If
  creation fails, the integration is `unavailable` for that run and the agent
  is told.

### HTTP clients (API kind)

- No automatic retry on writes. Reads retry at most twice, only on 429
  (honouring `Retry-After`) or on a network error before any byte is sent.
- Stripe: bracket-syntax form encoding.
- Errors are normalised to `ToolFailure` `{provider, status, code, message}`
  (`ApiToolError`) and the tool result sets `isError:true`.

### Agent core

`RunTurn = (input: RunTurnInput) => AsyncIterable<AgentEvent>`
(`src/agent/run-turn.ts`, W1). The input carries ids, source, prompt,
`resumeSessionId`, the `AgentEnv`, `ModelSettings`, `WorkspaceSettings`, the
effective `PolicyModes`, the business date, one `ConnectionPlan` per
integration and an `AbortSignal`, plus `mode:'interactive'` with an
`ApprovalGate` or `mode:'headless'`. The core is database-free: callers
persist from the events.

`query()` options (S2 gate configuration):

- `model`, `effort`, `thinking:{type:'adaptive', display}`, `maxTurns`,
  `maxBudgetUsd`. No `fallbackModel`.
- `cwd:<state>/work`, `settingSources:[]`, `tools:[]`, `strictMcpConfig:true`,
  `includePartialMessages:true`, `permissionMode:'default'`, and **no
  `allowedTools`** (bare entries skip `canUseTool` and print
  `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`). `canUseTool` is the single policy point
  and auto-allows reads, which still run concurrently.
- `mcpServers`: the gateway servers. `hooks.PreToolUse`: deny any tool not in
  the registry and any input that fails its schema.
- `resume`, `abortController`.
- `env`, an explicit **allowlist** that replaces the child environment:
  `PATH`, `HOME=<state>/home`, `CLAUDE_CONFIG_DIR=<state>/claude`,
  `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL?`, the passthrough variables when
  set, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY=1`,
  `DISABLE_ERROR_REPORTING=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`,
  `ENABLE_TOOL_SEARCH=false`, `CLAUDE_AGENT_SDK_CLIENT_APP=revenue-desk/<version>`.
- Stop: on `signal` abort the core calls `q.interrupt()` and settles pending
  approvals as denied with `interrupt:true`; `abortController.abort()` only
  after 3 seconds. The abort reason (`RunStopReason`: user, timeout, shutdown)
  sets the finished status. A write the gateway has started is not cancelled
  with the MCP request (its own signal aborts only at `WRITE_DEADLINE_MS`,
  65 s): the core waits for executing writes up to `WRITE_DRAIN_MS` (70 s)
  before its last events, the run registry and the CLI hold a stop open while
  one executes, and a write that ends without an answer is `outcome_unknown`
  with its idempotency key, never "not run".
- The native Claude CLI comes from the SDK's optional per-platform package,
  resolved by the SDK itself. Tests **fail, not skip**, when it is missing.

### System prompt

Built from settings plus the available integrations: role; company profile;
business date; "look before acting" and "cross-check across systems"; amounts
are minor units and are shown formatted; never invent IDs; draft before sending;
explain the pending action before a gated call; after a denial, do not retry,
report it; concise formatting with tables for lists. It never names tool names.
Stable parts come first, for prompt caching. MCP server instructions reach the
model as a system message inside `messages` (S2), only when the gateway passes
them.

### `AgentEvent`

The union and its rules are in `src/contracts/events.ts`: `run.started`,
`session`, `status`, `step.start`/`step.finish`, `reasoning.*`, `text.*`,
`tool.input.start`/`.delta`/`.available`, `approval.requested`,
`approval.resolved`, `tool.progress`, `tool.output`, `tool.denied`, `usage`,
`run.finished`. The rules proved by S1 and S2:

- `run.started` first, `run.finished` last, exactly once each.
- A step is one model request; `step.finish` comes at message_stop, **before**
  any approval or output of that step's tool calls.
- Per tool call: `tool.input.start` once, deltas, `tool.input.available`
  exactly once (from the assistant message; `canUseTool` never emits a
  second), then the outcome. `approval.resolved` always precedes
  `tool.denied`/`tool.output` of that call.
- `tool.input.start` carries the tool's base class; `tool.input.available`
  carries the classification from the complete input.
- The core emits `approval.requested` only after `ApprovalGate.open()` has
  persisted the row and registered the waiter.
- Subagent messages are skipped; a `<synthetic>` or `message.error` assistant
  message fails the run with `model_error`, never becomes text.

## 6. Server stream: AgentEvent to AI SDK v7 UI message stream

`POST /api/chat` returns
`createUIMessageStreamResponse(createUIMessageStream({originalMessages, execute, onStepEnd, onEnd}))`
(header `x-vercel-ai-ui-message-stream: v1`, terminated by `[DONE]`). The
mapping is a pure function in `src/server/ui-stream.ts` that the CLI also uses
(through `readUIMessageStream`) to persist its messages, so CLI conversations
render in the app.

| AgentEvent | UI message chunk |
|---|---|
| `run.started` | `start{messageId, messageMetadata:{runId, model, effort}}`; each unavailable connection also gives a persisted `data-notice` |
| `session` | none (stored as `conversations.sdk_session_id`) |
| `status` | transient `data-status` |
| `step.start` / `step.finish` | `start-step` / `finish-step` |
| `text.*`, `reasoning.*` | `text-start`/`-delta`/`-end`, `reasoning-start`/`-delta`/`-end` |
| `tool.input.start` | `tool-input-start{toolCallId, toolName, dynamic:true, title, toolMetadata}` |
| `tool.input.delta` | `tool-input-delta{toolCallId, inputTextDelta}` |
| `tool.input.available` | `tool-input-available{toolCallId, toolName, dynamic:true, input, title, toolMetadata}` (replaces the part's toolMetadata with the classified one) |
| `approval.requested` | `tool-approval-request{approvalId, toolCallId, approvalDescriptor, reason: consequence}` |
| `approval.resolved` | `tool-approval-response{approvalId, approved, reason}` |
| `tool.denied` after an approval | `tool-output-denied` |
| `tool.denied` `policy_denied` | `tool-approval-request{isAutomatic:true, …}`, `tool-approval-response{approved:false, reason}`, `tool-output-denied` (recommended; not yet proved) |
| `tool.denied` `rejected` | `tool-output-error{errorText: reason}` |
| `tool.progress` | transient `data-progress` |
| `tool.output` | `tool-output-available{output}`, or `tool-output-error{errorText}` when `isError` |
| `usage` | persisted `data-usage` plus `message-metadata{usage}` |
| `run.finished` | `message-metadata{status}`, then `finish{finishReason}`; stopped or timed out gives `abort{reason}`; failed gives a sanitised `error{errorText}` |

Reducer facts from S1 (AI SDK 7.0.118):

- `tool-approval-request`, `tool-approval-response` and `tool-output-*`
  throw if the tool part does not exist yet; output and approval lookups by id
  search the whole message, so they may follow `finish-step` or a later
  `start-step`. `tool-input-start`/`-available` only look in the current step:
  re-sending `tool-input-available` after a new `start-step` duplicates the
  part, hence the exactly-once rule.
- `tool-output-denied` without a preceding `tool-approval-response` leaves
  `approved` undefined and the stock `ConfirmationRejected` renders nothing.
- Passing `onEnd` also runs the reducer on the server; its `responseMessage`
  equals the client's final parts. `onStepEnd` fires at `finish-step` with the
  tool still `input-available`, so the snapshot with a pending approval is
  persisted by the approval gate, not by `onStepEnd`.

Runs outlive HTTP connections. A run lives in the server's run registry; a
client disconnect only detaches that subscriber. `GET
/api/chat/:conversationId/stream` (the default reconnect URL for
`useChat({resume:true})`) replays the active run's buffered chunks from the
start of the assistant message, then streams live; 204 when there is no
active run. Chunks fan out to every subscriber. Stop is explicit (`POST
/api/runs/:id/stop`); the UI does not call `useChat().stop()` for it, it waits
for the server's `abort` chunk.

Client:

```ts
useChat<ChatUIMessage>({
  id: conversationId,
  messages: fromDb,
  resume: true,
  transport: new DefaultChatTransport({
    api: '/api/chat',
    headers: { 'x-rd-csrf': csrfToken },
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

A `policies` row per class holds the saved mode; `AGENT_POLICY` overrides and
locks it; the CLI's `--policy` overrides both for one run.

In `canUseTool`: classify (unknown or unclassifiable means deny); `auto`
allows; `deny` returns `{behavior:'deny', message}` (`policy_denied`); `ask`
calls `ApprovalGate.open()` (the server inserts the pending approvals row
with its descriptor and `expires_at`, and registers the waiter on
`globalThis`), emits `approval.requested`, and awaits the decision. The waiter
settles once: `POST /api/approvals/:id {approved, reason?}` (404 unknown, 409
already decided), the timeout (deny, `timeout`), or Stop (deny with
`interrupt:true`, `stop`). Writes are asked one at a time (S2).

- **Stop:** `POST /api/runs/:id/stop` aborts the run's signal with reason
  `user`; the run ends `cancelled` with its pending approvals `cancelled`.
- **Headless:** `ask` becomes `policy_denied` with the message "Requires human
  approval; not available in headless mode." unless the policy says `auto`.
- **Boot recovery:** runs still `running` become `failed` (`server_restart`),
  their in-flight tool calls `interrupted`; pending approvals become `expired`
  with `decided_by='restart'`.
- **Security:** loopback does not stop drive-by requests from other sites.
  - Every `/api` request must carry a loopback `Host` (`127.0.0.1`,
    `localhost` or `[::1]`, any port): the DNS-rebinding guard.
  - `GET /api/session` sets the per-boot cookie `rd_session` (HttpOnly,
    `SameSite=Strict`, `Path=/api`) and returns the matching `csrfToken` in its
    JSON body, which other origins cannot read.
  - Every other `/api` route, reads included, requires the cookie
    (conversations and runs hold email bodies, invoices and charges).
  - Every mutating route (POST, PATCH) also requires a same-origin `Origin`
    when one is sent, `Content-Type: application/json` (send `{}` when there
    is no body), and `x-rd-csrf` equal to the token.
  - Every response carries a Content-Security-Policy (`default-src 'self'`,
    `img-src 'self' data:`, `connect-src 'self'`, `frame-ancestors 'none'`),
    and model text renders no images (`web/src/lib/markdown.ts`). The Vite
    dev server has `cors: false` and serves only `web/`, `src/contracts` and
    `node_modules`.
  - One active run per conversation (409 `run_active`); at most 4 concurrent
    runs (429 `too_many_runs`).

## 8. Database

SQLite through better-sqlite3 with Drizzle (`src/db/schema.ts`), opened by
`openDatabase()` in `src/db/client.ts` with WAL, `foreign_keys=ON`,
`busy_timeout=5000` and `synchronous=NORMAL`, applying migrations on open.
Migrations are generated by drizzle-kit (`pnpm db:generate`, output
`src/db/migrations`, committed, excluded from Biome) and resolved from
`src/db/migrations` both under `tsx` and from `dist/`. One file per state
directory, `<AGENT_STATE_DIR>/revenue-desk.sqlite`, shared by the server and
the CLI (WAL lets both work at once). IDs from `randomUUID` except messages
(UIMessage ids). Times are ISO UTC text. Business money is integer minor units
plus currency; model cost is USD `REAL`. No secrets are ever stored. Every
enum column has a CHECK constraint equal to its contract list
(`test/unit/db-schema.test.ts`).

| Table | Columns |
|---|---|
| `workspace_settings` (singleton, CHECK id=1) | company_name, agent_name, sender_name, email_signature, internal_email_domains json, notify_slack_channel, allowed_slack_channels json, internal_calendar_ids json (migration `0004`), timezone, currency, default_model, default_effort, updated_at |
| `policies` | action_class PK, mode `auto`/`ask`/`deny`, updated_at |
| `connections` | integration PK, kind, profile, status (`ConnectionState`), status_detail, endpoint_label (host only), account_hint (masked), missing_vars json (names), last_checked_at, updated_at |
| `conversations` | id, title, source `ui`/`cli`, status (`idle`, `running`, `awaiting_approval`, `error`), sdk_session_id, total_cost_usd, input_tokens, output_tokens, archived_at, created_at, updated_at |
| `messages` | id (UIMessage id), conversation_id FK cascade, run_id FK set null, role `user`/`assistant`, parts_json (the rendered parts, transient data parts excluded), metadata_json, text (plain, for search), seq (unique per conversation), created_at, updated_at |
| `runs` | id, conversation_id FK cascade, source, mode, status (CHECK: `running` exactly when finished_at is null), stop_reason, terminal_reason, model, effort, user_message_id, assistant_message_id, num_turns, model_requests, cost_usd, input/output/cache_read/cache_creation tokens, duration_ms, duration_api_ms, error_code, error_message, policy_snapshot json, connections_snapshot json (`RunConnection[]`), started_at, finished_at |
| `tool_calls` | id, run_id FK cascade, conversation_id FK cascade, tool_use_id (UNIQUE with run_id), integration, connection_kind, tool_name (as the model saw it), upstream_tool, operation, action_class (all four null only for a rejected unknown tool), title, status (`ToolCallStatus`), decision (`ToolDecision`), input_json (redacted), output_json (compacted), truncated, is_error, error_code, error_message, http_status, idempotency_key, approval_id, started_at, finished_at, duration_ms |
| `approvals` | id, run_id FK cascade, conversation_id FK cascade, tool_use_id (UNIQUE with run_id), integration, action_class, operation, consequence, descriptor_json (`ApprovalDescriptor`), status (`pending`, `approved`, `denied`, `expired`, `cancelled`; CHECK: pending exactly when undecided), decided_by (`user`, `timeout`, `stop`, `restart`), reason, requested_at, decided_at, expires_at |

`approvals.tool_use_id` and `tool_calls.approval_id` are plain references,
not foreign keys: the gate writes the approval row from `canUseTool` while the
event consumer may not yet have written the tool-call row. A tool_use id is
unique only within its run (migration `0001`), and every tool-call write is
keyed by run and tool_use id, so one run's events can never change another
run's rows (a scripted model repeats ids).

`pnpm db:seed` (idempotent, W3) writes only the default workspace settings
(company name blank, which Settings prompts for) and `DEFAULT_POLICY`. There
are **no** fabricated conversations, runs or tool data. Connection rows come
from probes at boot.

## 9. UI

### Visual identity

The agent's own identity. Implemented in `web/src/styles/tokens.css` and
bridged to Tailwind and shadcn in `web/src/styles/globals.css`.

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
  integration), the model label, a theme toggle and, only in sandbox demo mode
  (`SessionInfo.mode === 'sandbox'`), a persistent "Local sandbox" label.
- Left rail 264px: search, New chat (`POST /api/conversations`), conversations
  with running and awaiting-approval markers.
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
  #490 (done in S1); the yellow/green/blue rounded-full badges become a status
  dot plus label, a neutral outline chip "Composio"/"MCP"/"API", and a tabular
  duration or live elapsed time. Three or more consecutive reads collapse into
  "Checked N sources".
- `Confirmation`: patched for #484 (done in S1); renders a facts table and
  names the consequence ("Refund $49.00 to Acme"); financial and destructive
  approvals use the danger colour on the primary action (restate the sizing
  classes when passing `className` to `ConfirmationAction`); shows a pending
  spinner after a click until the server's response chunk arrives. It renders
  a shadcn `Alert` with `role="alert"`; prefer a polite live region. A card
  with `approval.isAutomatic` reads "Blocked by policy".
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
  `POST /api/connections/:integration/connect`; the server calls
  `session.authorize(toolkit, {callbackUrl})` with a callback on its own
  origin, and the UI opens `redirectUrl` in a new tab.
- **Runs:** source, status, duration, cost, tool calls per kind, with a detail
  Sheet that reuses `Tool` read-only and lists approvals.
- **Settings:** workspace profile, policy per action class (locked classes
  shown as set by the environment), Slack channel allowlist, internal email
  domains.

## 10. Headless CLI

`revenue-desk ask "<prompt>"` (built: `node dist/cli/main.js ask …`; dev:
`node --import tsx src/cli/main.ts ask …`; `package.json` gets a `bin`
entry). The contract is `src/contracts/cli.ts`. It is useful for scripting
and drives our own end-to-end tests.

- **Prompt:** the argument, or `-` to read all of stdin.
- **Flags:** `--json`, `--conversation <id>` (continue a conversation; its SDK
  session is resumed), `--policy '<json>'`, `--model`, `--effort`,
  `--max-turns`, `--max-budget-usd`, `--timeout-ms`, `--state-dir`.
- **Mode:** headless. `ask` actions are denied unless `--policy` (or
  `AGENT_POLICY`) makes them `auto`. It uses the same state directory and
  database as the server, so its conversations and runs appear in the app with
  source `cli`.
- **Output:** without `--json`, the reply text on stdout and a one-line status
  on stderr. With `--json`, exactly one `RunSummary` JSON document on stdout
  (`kind: "revenue-desk.run-summary"`, `version: 1`: run id, conversation id,
  status, reply, model, effort, times, usage, stop and terminal reasons, error,
  connections, tool calls with their decisions). Before any module with side
  effects is imported, stdout is guarded (a private reference to
  `process.stdout.write`; `console.*` goes to stderr).
- **Exit codes** (`CLI_EXIT_CODES`): 0 completed, 1 failed, 2 usage, 3
  configuration, 124 timed out, 130 cancelled.
- **Signals:** SIGINT or SIGTERM stops the run (interrupt), prints the summary
  with `--json`, and exits within 1.5 seconds. `--timeout-ms` ends it
  `timed_out`. No work continues after the output is written.

## 11. Testing, fakes and the sandbox demo mode

**Unit (Vitest, no network):** contracts (`contracts.test.ts`) and schema
(`db-schema.test.ts`); env resolution for every integration (configured,
`not_configured`, `invalid`, live-key refusal); path joining with prefixed
base URLs; Stripe bracket form encoding; idempotency and `requestid`
derivation; QuickBooks query builder and paging; Slack `ok:false` and HTTP
errors; error normalisation; classifier tables for every profile; policy
decisions; redactor; AgentEvent to UIMessageChunk mapping with golden
sequences from the real SDK against the mock; `readUIMessageStream` proving
the approval sequences render; database repositories and boot recovery.

**Contract-faithful local fakes** (`test/support/fakes`): stateful, loopback
ephemeral ports, dated fixtures, never reachable from product code paths.
Stripe REST (form-only with 415 on JSON, Bearer-only, idempotency replay, error
envelope, 402 decline, 429); QuickBooks REST (companyinfo, customer, invoice,
payment, query with a size-truncated page, Fault envelope, `requestid`, 403 for
a wrong realm); Slack Web API (`ok:false` and HTTP errors); HubSpot MCP
(Streamable HTTP and stdio, the profile's tools, schemas from the 0.4.0
capture); Composio (a local Composio API fake that creates sessions whose MCP
endpoint is a loopback MCP fake serving the captured `GMAIL_*`/
`GOOGLECALENDAR_*` schemas, reached through `COMPOSIO_BASE_URL`; W2 allows an
`http:` session MCP URL only for loopback hosts). Fixtures describe one
coherent fictional company on `*.test` domains.

**Scripted Messages API:** `test/support/mock-anthropic.ts` and
`sdk-gate-support.ts` (adapted with provenance headers, plus thinking blocks).
The real SDK runs as a subprocess with `ANTHROPIC_BASE_URL` pointed at the
mock, a dummy key, `HTTP(S)_PROXY` pointed at the mock with
`NO_PROXY=127.0.0.1,localhost` (any non-loopback CONNECT gets 403 and fails the
test) and `CLAUDE_CODE_MAX_RETRIES=0`.

**Integration and full-stack E2E** (real SDK, mock model, fakes): J1 reads
across all three kinds with draft auto and send approved; J2 refund approved
(exactly one refund with the expected Idempotency-Key, a HubSpot note and a
Slack post); J2 refund denied; Stop while an approval is pending (run and
approval cancelled, no refund, no extra model request); approval timeout; J3
with QuickBooks paging and an external calendar invite that asks for approval;
failures (Stripe 402 and 429, QuickBooks Fault, Slack `ok:false`, HubSpot MCP
down at start, Composio session failure); model 529 with
`x-should-retry:false`; multi-turn resume; invalid arguments rejected before
approval; HTTP layer (SSE order, reconnect replay, disconnect does not stop a
run, approvals 404/409, foreign `Origin` 403, non-loopback `Host` refused,
missing CSRF 403, one active run per conversation).

**CLI E2E:** the built CLI prints the reply; `--json` prints exactly one valid
`RunSummary` even when a module logs; exit codes for completed, failed,
configuration and usage errors; SIGTERM gives `cancelled` within 2 seconds;
parallel runs with isolated `--state-dir`; tokens absent from all output; the
run appears in the database with source `cli`.

**Playwright UI E2E** (built app against fakes plus the mock): desktop Chromium
1440×900 and phone 390×844 with touch (`playwright.config.ts`). Flows:
suggestion → shimmer → tool rows with kind chips and live elapsed time →
approval card → approve → final answer; deny; Stop; reload mid-approval with the
card still actionable; Connections (configured, not configured, error); a policy
change affecting the next run; keyboard-only approval. Checks: axe with no
serious violations, `scrollWidth <= clientWidth` at 390px, dark mode, reduced
motion, screenshots saved as artifacts (not pixel-gated). The suite uses the
installed Chrome (`channel: 'chrome'`) rather than downloading Playwright's
Chromium, and needs `pnpm build` first.

**Sandbox demo mode (`pnpm dev:sandbox`).** Ships as an explicit, clearly
labelled demo: `scripts/dev-sandbox.ts` starts the fakes, then the server and
UI with `AGENT_SANDBOX=1` and every integration pointed at the fakes through the
ordinary §3 variables, with either the scripted model or the real model (real
keys loaded via `DOTENV_PATH`, chosen explicitly by flag). With
`AGENT_SANDBOX=1` the server refuses to start if any configured endpoint is not
loopback, and the app bar and Connections screen show "Local sandbox" for the
whole session. It is only ever entered by running that script; no product code
path selects fakes on its own, and a missing configuration in normal mode is
never replaced by sandbox data.

**Optional live E2E** (`pnpm test:live`, `LIVE_E2E=1`, keys loaded at runtime
via `DOTENV_PATH`): real Anthropic plus Composio Gmail, **read-only**; the
policy forces every non-read class to deny (so the Composio session is created
with access `read`), `AGENT_MAX_BUDGET_USD=0.50`; asserts that only read-class
tools ran and nothing was sent. Stripe, HubSpot, QuickBooks and Slack live tests
run only with sandbox credentials from Kiran and are read-only by default.

**Where the suites live.** Full-stack E2E: `test/integration/e2e` (in
`pnpm test`; the in-process server and a real loopback port, with every run's
`runs`, `tool_calls` and `approvals` rows read with plain SQL and compared
with what each fake recorded). CLI E2E: `test/e2e-cli` (`pnpm test:e2e-cli`,
the built `dist/cli/main.js`). Playwright: `test/e2e-ui` (`pnpm test:e2e`,
the sandbox on the production build, `scripts/dev-sandbox.ts --built --model
scripted`, in the installed Chrome; a server already on 4320 is never
reused). Scripted scenarios and their fake checks: `test/scenarios`.

**`pnpm verify`** runs typecheck, lint, `pnpm test`, the build, then
`pnpm test:e2e-cli` and `pnpm test:e2e`.

## 12. Repository layout

The layout below is in place. Differences: the approval gate is
`src/policy/approvals.ts` (the server supplies its SQLite store in
`src/server/approval-store.ts`); `src/server/run-persistence.ts` is what one
run writes, shared by the server's run registry and the CLI; the in-process
CLI tests are in `test/integration/cli` and the full-stack E2E in
`test/integration/e2e`; test helpers of the core are in `test/helpers`;
`test/live` does not exist yet.

```
revenue-desk/
  src/
    contracts/     json.ts integration.ts env.ts events.ts api.ts cli.ts   (lead)
    config/        env.ts (AgentEnv snapshot, SecretValue), redact.ts
    integrations/  registry.ts
                   gmail/ google-calendar/ (profile.ts, classify.ts, probe.ts)
                   hubspot/ (launch.ts, profile.ts, classify.ts, probe.ts)
                   stripe/ quickbooks/ slack/ (client.ts, tools.ts, profile.ts, classify.ts, probe.ts)
                   composio/session.ts
    gateway/       mcp-proxy.ts  api-server.ts  compact.ts  validate.ts  types.ts
    policy/        engine.ts
    agent/         run-turn.ts  sdk-options.ts  sdk-mapper.ts  prompt.ts
    db/            schema.ts  client.ts  repos/*.ts  migrations/  seed.ts  recover.ts
    server/        main.ts  app.ts  routes/{chat,runs,approvals,conversations,connections,settings,session}.ts
                   ui-stream.ts  run-registry.ts  approvals.ts (ApprovalGate, globalThis waiters)  security.ts
    cli/           main.ts  ask.ts  summary.ts  stdout-guard.ts
  web/src/
    main.tsx  app/routes (chat, runs, connections, settings)  lib/api.ts  lib/chat.ts
    components/ai-elements/*  components/ui/*  components/app/*  styles/{globals,tokens}.css
  test/
    unit/  integration/  e2e-cli/  e2e-ui/  live/
    support/ mock-anthropic.ts  sdk-gate-support.ts  fakes/{stripe,quickbooks,slack,hubspot-mcp,composio}.ts  harness.ts
    fixtures/ business/*.json  surfaces/{hubspot-mcp-0.4.0,composio-direct}.json (dated, with source)
    scenarios/ *.ts
  scripts/ dev-sandbox.ts  surfaces/capture-*.ts (read-only)
  data/ (git-ignored)
```

## 13. Workstreams, ownership and status

| Item | Status |
|---|---|
| Scaffold: toolchain, tokens, shadcn + AI Elements, health route, app shell | done (`9f6ab0c`) |
| S1: AI SDK v7 approval request and response in one stream, rendered by `useChat` | passed (`795cbd5`) |
| S2: SDK 0.3.283 accepts a hand-built `McpServer` with raw JSON-schema handlers; API and proxy servers | passed (`cd8d940`) |
| S3: Composio 0.21 `direct_tools` session MCP through the proxy (listing only) | passed (`20ba5c2`) |
| S4: offline capture of `@hubspot/mcp-server` 0.4.0 and the stdio launch | passed (`c8a52fb`) |
| Shared contracts, database schema, first migration and client | frozen (`b85746c`; `RunDetailView` fixed in `549d6c7`) |
| W1 config, policy, gateway, agent core (`runTurn`) | done (`d2f68a0`…`5daa5dd`) |
| W2 six integrations and the registry | done (`d3797c3`…`73569a5`) |
| W3 repositories, seed, boot recovery, `/api` routes, run registry, stream mapping | done (`50f9f1b`, `be1224b`) |
| W4 web app: chat, approvals, runs, connections, settings | done (`e5ce069`, `80db8c5`) |
| W5 fakes, fixtures, scripted J1–J5 and failure scenarios, harness, `pnpm dev:sandbox` | done (`7555ce0`…`ec67453`) |
| W6 `revenue-desk ask` CLI and README | done (`dc6c6a8`, `46af4ac`) |
| Integration: server entry point and CLI composition root wired; spike leftovers removed | done (`3462c6c`, `7427bc1`) |
| Integration fixes: run-scoped tool_use ids, plain reason for stopped calls, rejected known tools keep their integration, MCP connect error cause, composer dimming | done (`95a23ac`, `d2c99e9`, `a283b65`, `e89d965`, `9ea3b02`) |
| Full-stack E2E (jobs, decisions, failures, resume, HTTP layer) and CLI E2E | done (`e0f07ff`, `7427bc1`) |
| Playwright UI E2E: empty chat with axe, approve, reload mid-approval then deny, Stop; desktop and phone | done (`8097654`); the Connections, policy-change, keyboard-only, dark-mode and reduced-motion flows of §11 are not written yet |
| `pnpm verify` green | done |
| Optional live read-only E2E (`pnpm test:live`) | not built: needs Kiran's go-ahead on the open questions below |

Milestones M1 and M2 are met. M3 needs the live read-only E2E and a round of
polish (see "Integration follow-ups" in the decisions log).

Workstreams build in parallel against `src/contracts`. Shared files are
lead-only: `src/contracts/**`, `docs/ARCHITECTURE.md`, `package.json`,
`pnpm-lock.yaml`, `tsconfig*.json`, `vite.config.ts`, `vitest.config.ts`,
`playwright.config.ts`, `biome.json`, `drizzle.config.ts`, `.env.example`,
`src/db/schema.ts` and `src/db/migrations`. A workstream that needs a change
there (a dependency, a script, a column) asks the lead.

| Workstream | Owns | Builds against |
|---|---|---|
| W1 agent core, policy and gateway | `src/config`, `src/agent`, `src/policy`, `src/gateway` | `RunTurn`, `AgentEvent`, `AgentEnv`, `IntegrationDefinition`, `ApprovalGate`, `ApiCallContext` |
| W2 integrations | `src/integrations/**` | `IntegrationDefinition`, `ToolProfile` (§2 tables), `Classification`, `ResolvedConnection`, `ProbeResult` |
| W3 database and server | `src/db/{repos,seed,recover}`, `src/server/**` | `ApiEndpoints`, `ChatUIMessage`, `AgentEvent`, `ApprovalGate`, schema |
| W4 web UI | `web/src/**` | `ApiEndpoints`, `ChatUIMessage`, `ToolMetadata`, `ApprovalDescriptor`, `SessionInfo` |
| W5 test infrastructure | `test/support/**`, `test/fixtures/business`, `test/scenarios`, `test/e2e-ui`, `scripts/dev-sandbox.ts` | §2 tables, §11, `RunTurn` |
| W6 CLI and README | `src/cli/**`, `test/e2e-cli`, `README.md` | `src/contracts/cli.ts`, `RunTurn`, repositories |

The S1 spike routes, the spike page, its Playwright spec and the duplicated
stream types are gone; the server and the web client share `src/contracts`.

Milestones: M1: core, integrations, database and CLI green on unit,
integration and CLI E2E. M2: server and UI green on full-stack and Playwright.
M3: live read-only E2E and polish; done only when `pnpm verify` is fully green
and live read-only E2E has run.

## 14. Risks

- **Argument validation.** The CLI forwards proxied tool arguments without
  validation (missing required fields, out-of-range values and undeclared
  properties all passed in S2), and API-tool zod validation runs only after
  approval, so a user could approve an invalid financial call. Mitigation: the
  ajv `PreToolUse` check (§5).
- **Tool-use id transport.** Idempotency keys and action-log joins depend on
  the CLI's `_meta["claudecode/toolUseId"]`, an undocumented field. The SDK is
  pinned; writes fail closed without it; a W1 gate test must assert it on each
  SDK upgrade.
- **Server instances per query.** Sharing a gateway instance between two
  concurrent `query()` calls silently yields no tools; build per query.
- **In-memory approvals** are lost on restart (mitigated by boot expiry and the
  approval gate persisting the pending snapshot); CSRF, Origin and Host checks
  are mandatory even on loopback.
- **HubSpot MCP 0.4.0** is a stale beta (June 2025); legacy private-app
  creation ends 2026-10-26; Service Key compatibility is unverified. It imports
  `zod-to-json-schema` without declaring it, resolving only through pnpm
  hoisting; the lead should add `pnpm.packageExtensions` for it. Its
  `import 'dotenv/config'` could redirect the token through a stray `.env`;
  `launch.ts` points dotenv at the null device and the server runs only through
  the gateway's stdio transport, never the Claude CLI.
- **Composio:** Calendar is `needs_auth` for the configured user;
  `direct_tools` still lists its tools, so availability must come from the
  probe. The Composio logger is process-wide. Three sessions created by S3
  were not deleted (they expire). `session.authorize` always starts a new link
  flow, so it runs only on a click.
- **Live readiness:** only Gmail is connected in Composio; there are no
  HubSpot, QuickBooks, Stripe or Slack credentials; QuickBooks access tokens
  expire hourly.
- **Business date:** the SDK injects the wall-clock date into a system
  reminder, which can disagree with `AGENT_BUSINESS_DATE` or QuickBooks company
  time in aging calculations; the prompt states the business date explicitly.
- **AI Elements** source targets ai v6 while this repo runs ai v7; #484 and
  #490 are patched, #439 and #496 remain; a later `shadcn add` can overwrite
  patches (it prompts first). The spike chunk is 1.48 MB (Streamdown's cjk,
  math and mermaid plugins, and two shiki versions, 4.4.3 and 3.23.0 via
  `@streamdown/code`); W4 trims to the code plugin and aligns shiki.
- **Headless stdout purity:** Composio prints an upgrade banner through its
  logger unless `disableVersionCheck:true`, and any stray `console.log` breaks
  `--json`; the stdout guard is installed before imports.
- **Cost and nondeterminism:** without `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, an
  isolated `CLAUDE_CONFIG_DIR` and `ENABLE_TOOL_SEARCH=false`, host memory and
  tool deferral leak into runs. The Sonnet 5 / medium default keeps test and
  demo runs affordable; both are configurable.
- **Vendor churn** (Composio 0.19-0.21 shipped breaking changes within four
  days) requires exact pins and dated fixtures; fakes can drift from vendors.
- **Native Claude CLI binaries** are optional per-platform dependencies; an
  install with optional dependencies omitted leaves no binary, and the test gate
  fails rather than skips. The lockfile records all eight platform packages.
- **TypeScript 7** has no JavaScript compiler API; tools that import it
  (typescript-eslint, ts-morph against the project compiler, Vitest typecheck
  mode) will not work. Type assertions in tests are checked by `pnpm
  typecheck` instead. The fallback is TypeScript 6.0.3 or 5.9.3.
- **Migrations at runtime** are read from `src/db/migrations`, so a built copy
  needs the source tree beside `dist/` (true for this local-only app).

## Decisions log

**2026-09-28, lead (proposal decisions).**

- Name "Revenue Desk", package `revenue-desk`; private, unlicensed, local git
  only.
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

**2026-09-28, spike outcomes.**

- **S1 passed** (`795cbd5`): the §6 chunk sequence works through the real
  `DefaultChatTransport`, the v7 reducer in `useChat` and the server-side
  reducer; `finish-step` before `tool-approval-request` reduces correctly; the
  reducer quirks in §6 are recorded. SSE is not buffered by the Vite 8 proxy.
  shiki 4.4.3, motion 13.4.4 and streamdown 2.6.0 render with no console
  errors in Chrome 153. `@ai-sdk/react` 4 deprecates `experimental_throttle`
  for `throttle`.
- **S2 passed** (`cd8d940`): SDK 0.3.283 accepts a hand-built `McpServer`
  with raw JSON-schema handlers (no zod fallback needed); proxied schemas reach
  the Messages API unchanged; `canUseTool` holds writes with no model traffic;
  reads run concurrently through `canUseTool`; one server instance per
  `query()`; the argument-validation gap; exact `canUseTool` options, deny and
  unknown-tool results, message order and result fields are recorded in the
  S2 transcripts.
- **S3 passed** (`20ba5c2`): all 13 allowlisted Composio slugs exist and none
  is deprecated; the session MCP (Streamable HTTP, `backend.composio.dev`,
  protocol 2025-11-25) lists exactly them; the proxy preserves them;
  `disableVersionCheck` keeps stdout empty; `allowTracking` is off.
- **S4 passed** (`c8a52fb`): 0.4.0 lists 21 tools offline with zero network
  attempts; launch is `process.execPath` plus the resolved bin with an explicit
  child environment; versions outside 0.4.x are refused.

**2026-09-28, Kiran: scope change.** Build only the agent now.
**Firedrill integration deferred until Kiran asks:** connecting Revenue Desk
to Firedrill, simulation and CI start only when Kiran says so. Removed from the
design: the Firedrill phase-2 plan and every Firedrill rationale, variable and
open question; the Google-named tool profiles and their fixture
(`test/fixtures/surfaces/google-mcp.json`, `scripts/surfaces/capture-google-mcp.ts`);
the Gmail and Calendar MCP overrides (Gmail and Calendar are Composio only);
the `<X>_API_PROXY_AUTH_HEADER` options; the stdin one-JSON "run-task"
contract (replaced by the plain `revenue-desk ask` CLI with its own `--json`
summary); the alias comparison in the HubSpot capture and its tests (the
HubSpot surface itself stays). Test-harness provenance comments remain.

**2026-09-28, lead: contract decisions.**

- The frozen contracts live in `src/contracts/` (§5) and are checked by
  `test/unit/contracts.test.ts` against the Agent SDK, the AI SDK and
  `.env.example`.
- HubSpot profile: 10 tools; associations are created inline with
  `hubspot-batch-create-objects`, so `hubspot-batch-create-associations` is not
  offered (one call per record, one fewer write tool).
- Every tool has an operation name and base class (§2 tables);
  `classify()` sets the final class from the complete input.
- Added variables: `COMPOSIO_BASE_URL`, `HUBSPOT_API_BASE_URL` (ordinary
  per-integration base URLs, also used by fakes) and `AGENT_SANDBOX` (the
  labelled demo; refuses non-loopback endpoints).
- Composio session access is derived from the run's policy
  (`composioAccessFor`), not from configuration.
- One state directory and one database for the server and the CLI; per-run
  databases are dropped. CLI runs show in the app with source `cli`.
- The CLI's tool-use id arrives as `_meta["claudecode/toolUseId"]` on every
  tools/call (probed against the real SDK and the mock model on 2026-09-28);
  `idempotencyKey = sha256hex(runId:toolUseId)`.
- CSRF: an HttpOnly cookie cannot be echoed by page script, so
  `GET /api/session` returns the token in JSON and sets the matching cookie;
  every `/api` request also needs a loopback `Host` (DNS rebinding).
- Runs outlive HTTP connections: a disconnect detaches a subscriber and never
  stops the run (the S1 spike denied on disconnect; W3 changes that). Stop is
  `POST /api/runs/:id/stop` only.
- `ApprovalGate.open()` persists and registers before `approval.requested` is
  emitted.
- Tool decisions add `rejected` (unknown tool or schema-invalid input, before
  any policy) and `pending`; policy denials map to an automatic approval
  (`isAutomatic`) so the card can say why.
- Connection states add `expired` (Composio reports it) and `invalid`
  (refused configuration, e.g. a live Stripe key).
- Secrets are `SecretValue` in `AgentEnv` and `ResolvedConnection`.
- Conversation ids are created by the server (`POST /api/conversations`).
- `src/db/migrations` is generated and excluded from Biome.

**2026-09-29, lead: integration decisions.**

- **Per-run usage of a resumed session.** A resumed session's SDK result
  reports running totals for the whole session (`total_cost_usd`,
  `modelUsage`, `duration_api_ms`; `duration_ms` stays per query; verified on
  SDK 0.3.283), so summing runs would double-count. `runTurn` keeps each
  session's totals in `<state>/claude/revenue-desk/usage/<sessionId>.json`
  and reports the difference; without a baseline it reports the run's own
  stream tokens and a pro-rated cost. Kept inside the core; no contract change.
- **`run.finished.stopReason`** is the `RunStopReason` (user, timeout,
  shutdown) when the run's signal stopped the run, otherwise null. It is not
  the SDK result's `stop_reason`. Stored as `runs.stop_reason` and
  `RunSummary.stopReason`.
- **The system prompt** is passed as `{type:'custom', snapshot:false}`, so a
  resumed conversation gets today's business date and systems list, not the
  prompt recorded with the session.
- **SDK 0.3.283 facts.** The model sees a `PreToolUse` denial as
  `PreToolUse:<tool> hook error: <reason>`. Names that were never offered,
  and built-in tools, reach neither the hook nor `canUseTool`; the CLI
  answers "No such tool available" and the call is `rejected`. An API error
  produces a `<synthetic>` assistant message with `error`, then a result with
  `is_error`, then `query()` throws. When the budget runs out the SDK can run
  a tool and stop without its `tool_result`; the gateway observer still
  emits `tool.output`, so the action log stays complete.
- **Calls stopped before they ran.** The SDK refuses calls queued behind a
  pending approval when the run stops, with the Claude CLI's instruction to
  the model ("The user doesn't want to proceed…"). They are `stopped` with
  "Not run: the run was stopped before this call ran." instead.
- **tool_use ids are unique per run** (migration `0001`); every tool-call
  write is keyed by run and tool_use id (§8). Found when the scripted sandbox
  model repeated ids in one state directory.
- **A schema-invalid call to a known tool** keeps its integration, kind,
  operation and base class in the action log; only an unknown tool has them
  null (§8).
- **Action-log details.** `http_status` holds a failure's provider status;
  a successful API call records null (`ApiCallContext` has no way to report a
  2xx). `idempotency_key` is recorded for every call (it is derived from the
  run and the tool_use id) and sent to a provider only by writes.
- **One persistence path.** `src/server/run-persistence.ts` (recorder,
  stream mapper and message reducer) is shared by the server's run registry
  and the CLI, so a CLI run is stored exactly like an app run.
- **CLI connection plans** come from the configuration and the last checks
  the app stored in `connections`; the CLI runs no probes. An upstream it
  cannot reach is reported by the gateway at run time.
- **Server semantics inside the frozen types (W3), accepted.**
  `RunSummaryView.approvals.denied` counts denied, expired and cancelled.
  `PolicyView.source` is `default` when the saved mode equals
  `DEFAULT_POLICY`, `saved` otherwise, `environment` when `AGENT_POLICY` sets
  it. `GET /api/chat/:id/stream` answers 204 for an unknown conversation as
  well as an idle one.
- **CLI (W6), accepted.** A configuration error, or a stop before the run
  starts, still prints the `--json` summary, with the ids the invocation
  reserved; nothing is recorded under them.
- **Sandbox on the build.** `pnpm dev:sandbox --built` runs
  `dist/server/main.js`, which serves the built app itself. The Playwright
  suite starts it with `--model scripted` and never reuses a server on 4320.
- **Dependencies removed** (the web no longer imports them):
  `@streamdown/cjk`, `@streamdown/code`, `@streamdown/math`,
  `@streamdown/mermaid`, tokenlens, motion.
- **Contract changes during the build:** `549d6c7` (W3) made `RunDetailView`
  `Omit<RunSummaryView, 'approvals'> & {…}`: the intersection with the
  summary's approval counts was unsatisfiable. No other contract changed.

**2026-09-29, review fixes (security, correctness, UX).**

- **Calendar updates and shared calendars.** `GOOGLECALENDAR_UPDATE_EVENT`
  is a full replacement, so an update is outbound unless the run's
  `GoogleCalendarRunMemory` (events lists, searches, create and update
  results) shows the event's current guests are all internal and none is
  dropped with a notification. Only `primary`, internal addresses and the
  new `WorkspaceSettings.internalCalendarIds` (contract change, migration
  `0004`, Settings › Internal domains and calendars) are internal calendars;
  group calendars are outbound until listed. Cards write the time with its
  weekday in the event's zone and say in words who Google emails.

- **No fetch from model text.** A Markdown or HTML image in a reply or in
  reasoning would make the browser request its URL (data in the query) with
  no approval: images render as their alt text, Streamdown's harden step
  allows no image source, and every response has a CSP. Reads need the
  session cookie, and `pnpm dev`'s Vite server sends no CORS headers and
  denies files outside the web app (it served the SQLite database before).

- **A started write is never cancelled.** Stop, `--timeout-ms`, SIGTERM and
  the end of a query used to abort an approved refund or invoice already at
  the provider, logging it as failed or never run, and a retry would get a
  new idempotency key. Now: writes get their own 65 s deadline; the core
  announces each call as it starts (a `tool.progress` at 0 ms), and the
  recorder stores an API write's idempotency key from that moment; the core,
  the registry (not on shutdown) and the CLI wait for executing writes up to
  70 s; the HTTP layer reports a write sent without an answer as
  `outcome_unknown` (also upstream MCP writes that fail mid-call), and the
  prompt tells the model to check, never to repeat, such a write; a call
  the run ends while it executes is `outcome_unknown` with its key.

- **Cards after the run's own writes.** `StripeRunMemory` counts the run's
  refunds (and a complete `list_refunds`) in "Already refunded", lists them
  as "Refunded in this run", and flags a refund larger than what is left
  ("Check", first, and in the consequence); `QuickBooksRunMemory` lowers an
  invoice's open balance by the run's payments and zeroes a voided one. A
  refund or payment sent without an answer shows "May already be applied".
  Refund metadata is one quiet "Stored on the refund" row, and the card's
  button reads "Add a note for the agent". Email and Slack bodies keep their
  line breaks, up to about 4,000 characters, folded behind "Show all".

- **Contract changes for the UI (lead, 2026-09-29).**
  `RunSummaryView.failedToolCalls` (calls that failed at the system or whose
  outcome is unknown; rejected calls excluded), `SessionInfo.modelConfigured`
  (false without `ANTHROPIC_API_KEY`: the app says so and offers no job), and
  `ConversationSummary.pendingConsequence` (the newest pending approval's
  consequence, for the rail and the waiting list). An approved call that then
  failed reads "Approved, then failed" with the reason; a failed run's own
  `error` chunk no longer shows the "stream interrupted" banner; the run limit
  message names the approvals holding the slots. Open for Kiran: whether runs
  parked on an approval should count toward `MAX_CONCURRENT_RUNS`.

**Integration follow-ups (open).**

- The approval card for `GMAIL_SEND_DRAFT` cannot name the recipients (the
  input has only the draft id) and says "to the recipients saved in it". The
  core should fill them in from the run's earlier `GMAIL_CREATE_EMAIL_DRAFT`
  call: "no email to the wrong customer" is a J1 guarantee.
- A CLI process killed with SIGKILL leaves its run `running`, and the app then
  refuses that conversation (409). Boot recovery covers `ui` runs only; this
  needs an ownership marker (for example a pid column) or CLI-side recovery.
- No SSE heartbeat while an approval waits (up to 15 minutes): fine for
  browsers and the Vite proxy, not for a proxy with an idle timeout.
- Upstream MCP connections are opened per run (HubSpot over stdio spawns its
  server per run); pooling is a later optimisation. Composio sessions are
  cached for 30 minutes.
- `ConnectionService` (server) and `connectionSnapshot`/`checkConnection`
  (registry) apply the same availability rule twice, and Connect builds its
  own Composio session manager; consolidate.
- Unconfirmed against real accounts: QuickBooks accepting a 64-character
  `requestid`, and Stripe's handling of `Idempotency-Key` on DELETE. Stripe
  refund cards show the workspace currency (single-currency assumption).
- Assistant text and user prompts are stored and streamed as written; tool
  outputs and errors are redacted before the model or the stream sees them.
- Vitest has no `@/` alias or jsdom, so there are no component tests; UI
  behaviour is covered by the web lib unit tests and the Playwright suite.

## Open questions (Kiran's)

- Credentials: a Stripe sandbox `sk_test_` key; a HubSpot developer test-account
  private-app token or Service Key; a QuickBooks sandbox access token and realm
  ID; a Slack developer-sandbox bot token; reconnecting Google Calendar in
  Composio.
- Live E2E reads the connected Gmail inbox read-only with writes forced to deny
  and a $0.50 cap: acceptable, or connect a test Google account first?
- QuickBooks: automatic OAuth refresh (persisting a rotating refresh token
  locally) or short-lived access tokens only for now?
- Licence: stay unlicensed, or apply the older example's Apache-2.0 notice?

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
tokenlens 1.3.1, use-stick-to-bottom 1.1.6. On 2026-09-29 the web stopped
importing the Streamdown plugins, tokenlens and motion, and
`@streamdown/{cjk,code,math,mermaid}`, tokenlens and motion were removed;
shiki is used directly through `shiki/core`.

**Dev dependencies:** typescript 7.0.2, tsx 4.23.15, vite 8.3.1,
`@vitejs/plugin-react` 6.1.1, tailwindcss and `@tailwindcss/vite` 4.3.3,
drizzle-kit 0.31.11, vitest 5.0.2, `@playwright/test` 1.63.0,
`@axe-core/playwright` 4.13.0, `@biomejs/biome` 2.5.14, shadcn 4.21.0 (provides
`shadcn/tailwind.css`), `@types/node` 22.20.4 (matches the Node 22 floor),
`@types/react` and `@types/react-dom` 19.3.0, `@types/better-sqlite3` 9.6.0.
Playwright browsers are not installed yet.

**Differences from the proposal:** pnpm 9.15.4 instead of 12.6.0 (installed
version); `engines` `>=22.22.3`; TypeScript 7.0.2 kept after type-check, build,
tsx, Vite, Vitest, drizzle-kit (including `generate` for the first migration)
and the shadcn CLI all ran cleanly with it; `@hubspot/mcp-server` and
`@anthropic-ai/sdk` added as explicit pins; Biome chosen for lint and format;
Sonner deferred.

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
(`@/registry/default/ui/` → `@/components/ui/`), except for these patches,
each marked `revenue-desk patch`:

- `context.tsx`: ai v7 moved `usage.reasoningTokens` to
  `usage.outputTokenDetails.reasoningTokens` and `usage.cachedInputTokens` to
  `usage.inputTokenDetails.cacheReadTokens`; two lines changed so the file
  type-checks.
- `confirmation.tsx` (#484, S1): the approval type is
  `ToolUIPart['approval'] | DynamicToolUIPart['approval']`.
- `tool.tsx` (#490, S1): `ToolInput` returns null for undefined input and uses
  `JSON.stringify(...) ?? ''`.

Owned patches added by W4 (each marked `revenue-desk patch`): `tool.tsx`
restyle (#490 kept); `confirmation.tsx` polite live region instead of
`role="alert"` (#484); `prompt-input.tsx` Enter ignored while streaming
(#439); `reasoning.tsx` #496 and the "Thought for a moment" fix;
`message.tsx` and `reasoning.tsx` use only the app's code highlighter;
`context.tsx` takes the server's `costUsd` instead of tokenlens;
`shimmer.tsx` is CSS-only; `code-block.tsx` uses `web/src/lib/highlight.ts`
(one shiki core build, JS regex engine, two themes, seven lazily loaded
languages). shadcn: the `Sheet` overlay has no blur; every `ui` component
imports `cn` from `@/lib/utils` (`web/src/lib/cn.ts`, which maps the
`text-body`, `text-body-sm` and `text-meta` sizes around tailwind-merge), so
after a future `shadcn add` re-point `import { cn } from "cn"`. Added by the
lead: `input-group.tsx` dims the group only when its input control is
disabled (upstream's `has-disabled` also matched the disabled Send button and
rendered the composer at half opacity).

**Adding more AI Elements:** because `src/` exists (the server), the shadcn CLI
resolves registry targets to `src/components/ai-elements/`. After each add, move
the new files to `web/src/components/ai-elements/` and delete the empty
`src/components`, then re-check that no existing patched file was overwritten.
