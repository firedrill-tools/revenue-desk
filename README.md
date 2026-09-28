# Revenue Desk

Revenue Desk is a back-office agent for the revenue-operations or billing lead
at a small B2B company. It works across Gmail, Google Calendar, HubSpot,
Stripe, QuickBooks Online and Slack from one chat, and asks a person before
anything that moves money or reaches people outside the company. It runs
locally: a Node server bound to 127.0.0.1, a web app, and a headless CLI that
share one SQLite database.

It is built on the Claude Agent SDK. The design reference, including the
decisions log and the implementation status of each part, is
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What it does

| Job | What the agent does | Approval |
|---|---|---|
| Billing inquiry | Reads the customer's Gmail thread, looks the customer up in Stripe (charges, invoices), QuickBooks (invoice and payment status) and HubSpot (contact, company, owner), and drafts a reply in Gmail. | The draft is automatic; sending asks. |
| Refund a duplicate charge | Finds the duplicate in Stripe and proposes a refund with amount, charge, customer and reason, then logs a HubSpot note and posts to the billing Slack channel. | The refund asks. |
| Collections | Lists overdue QuickBooks invoices, checks Stripe for payments that were never recorded, drafts reminder emails, and for invoices 60 or more days overdue proposes a Google Calendar call and creates a HubSpot task. | A call with an external attendee asks. |
| Closed-won handoff | For a HubSpot deal in closed-won, finds or creates the QuickBooks customer, creates and sends the invoice, and posts to the sales-ops Slack channel. | Creating and sending the invoice each ask. |
| Weekly digest | Reads new HubSpot deals, Stripe payments and refunds, and QuickBooks AR aging, and posts a digest to Slack. | Automatic when the channel is allowlisted. |

## How it connects

Each integration uses one of three connection types. Every tool reaches the
model through an in-process gateway server per integration (tool names look
like `mcp__stripe__create_refund`), which offers only the listed tools,
classifies every call for the approval policy, records it, and keeps
integration credentials inside the Revenue Desk process: the Claude CLI child
process receives none of them.

| Integration | Connection | Tools | Why this connection |
|---|---|---|---|
| Gmail | Composio | fetch emails, read a thread, list threads and labels; create a draft, add a label; send a draft, reply to a thread | Composio holds the Google OAuth grant, so Revenue Desk never stores Google tokens. Sessions use Composio's `direct_tools` preset with an explicit tool allowlist. |
| Google Calendar | Composio | list events, find free slots, find an event; create and update events | The same Composio session and OAuth handling as Gmail. |
| HubSpot | MCP | account details; list, search and batch-read objects; associations and properties; batch-create and batch-update objects (notes and tasks are created with their associations in one call) | HubSpot publishes an official MCP server, `@hubspot/mcp-server` 0.4.0, which Revenue Desk runs over stdio. Any Streamable HTTP MCP server can replace it. 10 of its 21 tools are offered. |
| Stripe | API | find and get customers; list charges, payment intents, invoices, subscriptions and refunds; get an invoice; get the balance; create a refund; cancel a subscription | Direct REST: test-mode keys, idempotency keys on writes and documented error envelopes. |
| QuickBooks Online | API | company info; find, get and create customers; list and get invoices; list payments; create, send and void invoices; record a payment | Direct REST against the sandbox company, with `requestid` idempotency on writes. |
| Slack | API | list channels, read a channel or thread, find a user; post a message, add a reaction | A bot token is simple to obtain; Slack's official MCP server needs user OAuth and the reference Slack MCP server is deprecated. |

An integration without configuration is shown as not configured and its tools
are not offered; there is no fallback to sample data or to another model.

## Requirements

- Node.js 22.22.3 or later (developed on Node 24)
- pnpm 9.15.4 (pinned in `package.json`)
- Optional dependencies enabled: the Claude Agent SDK's native binary comes
  from an optional per-platform package.

## Setup

1. Install dependencies:

   ```sh
   pnpm install
   ```

2. Create your configuration file outside the repository and point
   `DOTENV_PATH` at it. Keys never belong in the repository.

   ```sh
   mkdir -p ~/.config/revenue-desk
   cp .env.example ~/.config/revenue-desk/revenue-desk.env
   chmod 600 ~/.config/revenue-desk/revenue-desk.env
   export DOTENV_PATH=~/.config/revenue-desk/revenue-desk.env
   ```

   A variable set to a non-empty value in the environment wins over the file.
   Leave a variable empty to use its default. [Configuration](#configuration)
   lists every variable.

3. Fill in what you use:

   - **Model (required).** `ANTHROPIC_API_KEY`. The default model is
     `claude-sonnet-5` at effort `medium` (`AGENT_MODEL`, `AGENT_EFFORT`);
     an unavailable model fails the run instead of falling back to another.
   - **Gmail and Google Calendar.** `COMPOSIO_API_KEY` (a Composio project
     key) and `COMPOSIO_USER_ID` (the Composio user whose Google accounts the
     agent uses; there is no default). Then start the app, open
     **Connections** and click **Connect** for Gmail and for Google Calendar:
     Composio's hosted sign-in opens in a new tab. Use **Check** afterwards.
     Revenue Desk starts a Composio sign-in only from that click.
   - **Stripe.** `STRIPE_SECRET_KEY`, a test-mode `sk_test_` or restricted
     `rk_test_` key. Live keys are refused (see
     [Approvals and safety](#approvals-and-safety)).
   - **HubSpot.** Either `HUBSPOT_ACCESS_TOKEN`, a private-app token with CRM
     read and write access for contacts, companies, deals, notes and tasks
     (the bundled MCP server runs over stdio with it), or `HUBSPOT_MCP_URL`
     for any Streamable HTTP MCP server, with `HUBSPOT_MCP_TOKEN` when it
     needs a bearer token. HubSpot ends creation of legacy private apps on
     2026-10-26.
   - **QuickBooks Online.** `QBO_ACCESS_TOKEN` and `QBO_REALM_ID` (the company
     id) for a sandbox company from the Intuit developer portal. The default
     base URL is the sandbox API. Access tokens expire after an hour and
     Revenue Desk does not refresh them; set a new token when calls start
     failing with 401.
   - **Slack.** `SLACK_BOT_TOKEN`, a bot token (`xoxb-`). The tools call
     `conversations.list`, `conversations.history`, `conversations.replies`,
     `users.list`, `users.info`, `chat.postMessage` and `reactions.add`, which
     need the `channels:read`, `channels:history`, `users:read`, `chat:write`
     and `reactions:write` scopes, plus `groups:read` and `groups:history` for
     private channels and `users:read.email` to match people by email address.
     Invite the bot to the channels it should read or post in.

4. In the app, open **Settings** and fill in the company profile, the
   internal email domains (recipients and attendees outside them are
   external), any shared Google calendars the company owns (every other
   calendar except your primary one counts as external), the Slack channels
   the agent may post to without asking, and the time zone.

## Running

| Command | What it runs |
|---|---|
| `pnpm dev` | The API server on 127.0.0.1:4320 (`tsx watch`) and Vite on http://127.0.0.1:4321, which proxies `/api` to the server. Open port 4321. |
| `pnpm build && pnpm start` | Builds the web app into `dist/web` and the server and CLI into `dist/`, then serves the API and the built app on http://127.0.0.1:4320. |
| `pnpm dev:sandbox` | The labelled demo: see [Sandbox demo](#sandbox-demo). |
| `node dist/cli/main.js ask "…"` | The headless CLI (after `pnpm build`); see [Command line](#command-line). |

The server listens on 127.0.0.1 only; `PORT` changes the port. The server and
the CLI share the state directory (`AGENT_STATE_DIR`, default `./data`), so
CLI conversations and runs appear in the app with source `cli`.

### Sandbox demo

`pnpm dev:sandbox` starts local fake Stripe, QuickBooks, Slack, HubSpot MCP and
Composio services on loopback ports, then the server and the app with
`AGENT_SANDBOX=1` and every integration pointed at the fakes through the
ordinary base-URL variables. The fakes hold one fictional company on `*.test`
domains. The model is the scripted test model, which plays the five jobs by
prompt, unless `ANTHROPIC_API_KEY` is set in the environment of the script
(it is never read from a file) or you pass `--model real`; `--model scripted`
forces the scripted one. The app bar and the Connections screen show "Local
sandbox" for the whole session, and the server refuses to start if any
configured endpoint is not loopback. Sandbox data never replaces missing
configuration in normal mode.

Options: `--hubspot stdio|http` (the pinned vendor server over stdio, or the
fake's HTTP MCP endpoint), `--state-dir <dir>` (keep the database between
runs; the default is a temporary directory), `--no-web` (API only) and
`--built`, which runs the production build (`pnpm build` first): the server
then serves the built app itself on http://127.0.0.1:4320 and Vite is not
started.

## Command line

```text
revenue-desk ask [options] "<prompt>"
revenue-desk ask [options] -          # read the prompt from stdin
revenue-desk --help | --version
```

Each call runs one turn in headless mode. Nothing waits for a person: an
action whose approval mode is `ask` is denied (the model is told
"Requires human approval; not available in headless mode.") unless `--policy`
or `AGENT_POLICY` sets its class to `auto`. The CLI then names the class that
would allow it.

| Option | Meaning |
|---|---|
| `--json` | Print exactly one run summary as JSON on stdout, then a newline. |
| `--conversation <id>` | Continue an existing conversation; its SDK session is resumed. |
| `--policy <json>` | Approval modes for this run, for example `'{"financial":"auto"}'`. Wins over `AGENT_POLICY` and Settings. |
| `--model <id>` | Model for this run (default: Settings, then `AGENT_MODEL`). |
| `--effort <level>` | `low`, `medium`, `high`, `xhigh` or `max` (default: Settings, then `AGENT_EFFORT`). |
| `--max-turns <n>` | Turn limit for this run (default `AGENT_MAX_TURNS`). |
| `--max-budget-usd <usd>` | Spend limit for this run (default `AGENT_MAX_BUDGET_USD`). |
| `--timeout-ms <ms>` | Wall-clock limit; the run is stopped and ends timed out. |
| `--state-dir <path>` | State directory for this invocation, overriding `AGENT_STATE_DIR`. |

Output:

- Without `--json`, the reply streams to stdout. Tool activity (a line when a
  call starts, with its connection type, and one with its outcome),
  unavailable integrations, model retries and a final status line go to
  stderr.
- With `--json`, stdout carries only the summary: `kind`
  (`revenue-desk.run-summary`), `version`, run and conversation ids, status,
  reply, model, effort, start and finish times, usage and cost, stop and
  terminal reasons, error, the integrations' availability, and each tool call
  with its decision (inputs and outputs are left out; the Runs screen has
  them). Progress still goes to stderr. Anything a library prints goes to
  stderr as well: stdout is guarded before any other module loads.

| Exit code | Meaning |
|---|---|
| 0 | Completed. |
| 1 | Failed: model error, turn or budget limit, or an internal error. |
| 2 | Usage error, an unknown conversation, or one with an active run. Nothing ran; no summary is printed. |
| 3 | Configuration error, such as a missing `ANTHROPIC_API_KEY` or an unreadable `DOTENV_PATH`. Nothing ran. |
| 124 | Timed out (`--timeout-ms`). |
| 130 | Cancelled by SIGINT or SIGTERM. |

With `--json` the summary is printed for every outcome except exit 2. For a
configuration error it carries the run and conversation ids the invocation
had reserved; nothing was written under them.

SIGINT or SIGTERM interrupts the run, prints the summary with `--json` and
exits within about 1.5 seconds; a second signal skips the wait. The exception
is a write that is already executing (a refund, invoice, payment or post):
the CLI says so on stderr and waits for its answer, at most about 70 seconds,
because it may already be applied; a second signal stops waiting, and the
write is recorded as `outcome_unknown` with its idempotency key. No work
continues after the output is written.

Examples:

```sh
node dist/cli/main.js ask "Why was Kestrel Analytics charged twice?"
node dist/cli/main.js ask --json "List invoices more than 60 days overdue" | jq .toolCalls
echo "Post this week's revenue digest to Slack" | node dist/cli/main.js ask -
node dist/cli/main.js ask --conversation <id> "Draft the reminder emails"
```

`--policy '{"financial":"auto"}'` lets that run refund, invoice and record
payments without asking; use it only against test accounts.

Without a build, run `node --import tsx src/cli/main.ts ask …`. `pnpm cli ask …`
also works for trying it, but pnpm prints a banner on stdout (unless `-s`) and
reports every non-zero exit code as 1, so do not use it in scripts.

## Approvals and safety

Every tool call is classified from its complete input into an action class,
and the class's mode decides what happens:

| Action class | Examples | Default |
|---|---|---|
| `read` | Any lookup, search or list | automatic |
| `internal_write` | Gmail drafts and labels, HubSpot notes and tasks, Slack posts to allowlisted channels, calendar events on your own or a listed company calendar whose attendees are all internal, creating a QuickBooks customer | automatic |
| `outbound` | Sending or replying to email, calendar events with an external attendee or on a calendar that is not listed as the company's, an update of an event whose current guests the run has not read (an update replaces the guest list), Slack posts to any other channel | asks |
| `financial` | Stripe refunds and subscription cancellations; QuickBooks invoice create, send and void, and recording a payment | asks |
| `destructive` | (no tool is destructive today) | denied |

- **Changing the policy.** The Settings screen saves a mode per class.
  `AGENT_POLICY` (JSON, for example `{"financial":"deny"}`) overrides it and
  locks those classes in the app. The CLI's `--policy` overrides both for one
  run.
- **Approval cards** show the exact consequence ("Refund $49.00 to Kestrel
  Analytics") and its facts. A pending approval is denied after
  `AGENT_APPROVAL_TIMEOUT_MS` (15 minutes by default). Stop cancels the run
  and its pending approvals. After a denial the agent reports it and does not
  retry. Arguments are validated against the tool's schema before any
  approval is asked, so an invalid call is never put in front of a person.
- **Writes happen once.** Stripe writes carry an `Idempotency-Key` and
  QuickBooks writes a `requestid`, both derived from the run and the model's
  tool-call id. Writes are never retried automatically; reads retry at most
  twice, on 429 or a connection error. A write that has started is not
  cancelled by Stop or a time limit: the run waits for the provider's answer
  (at most about 70 seconds) and records what really happened. A write sent
  without an answer (a timeout, a dropped connection, a shutdown) is recorded
  as `outcome_unknown` with its idempotency key, and the agent is told to
  check the record rather than try again.
- **Live Stripe keys are refused.** A `sk_live_` or `rk_live_` key makes
  Stripe `invalid` and its tools are not offered, unless
  `ALLOW_LIVE_STRIPE=1`.
- **Secrets.** Keys are read from the environment or the `DOTENV_PATH` file
  and are never printed, logged, stored in the database or sent to the
  browser. The Claude CLI child process receives `ANTHROPIC_API_KEY` and no
  integration credential, in an explicit environment rather than a copy of
  Revenue Desk's. A redactor removes configured
  secret values and token shapes (`Bearer …`, `sk_`, `rk_`, `xox…`, `pat-`)
  from logs, stored rows, streamed output and CLI output.
- **Local only.** The server binds to 127.0.0.1 and refuses requests whose
  `Host` is not loopback. Every `/api` request except `/api/health` and
  `/api/session` needs the per-session cookie, reads included. Changing
  requests also need a matching `x-rd-csrf` header and
  `Content-Type: application/json`, and are refused when the browser sends a
  foreign `Origin`. Pages carry a Content-Security-Policy that lets the
  browser load and connect only to Revenue Desk itself, and the agent's
  replies never render images, so text the model repeats cannot make the
  browser fetch a URL. Under `pnpm dev`, Vite sends no CORS headers and serves
  only the web app, the shared contracts and dependencies, never `./data`.
  One run at a time per conversation, at most four at once.
- **Composio** sign-in starts only from a click on Connect. Composio sessions
  offer outbound Gmail and Calendar tools only when the policy does not deny
  outbound actions.

## Data and the database

Everything lives in the state directory (`AGENT_STATE_DIR`, default `./data`,
git-ignored):

| Path | Contents |
|---|---|
| `revenue-desk.sqlite` (with `-wal` and `-shm`) | The database, shared by the server and the CLI (SQLite in WAL mode). |
| `work/` | The Claude CLI's working directory. |
| `home/` | `HOME` for the Claude CLI child process. |
| `claude/` | Its `CLAUDE_CONFIG_DIR`, which holds the SDK sessions used to resume conversations. |

Tables:

| Table | Holds |
|---|---|
| `workspace_settings` | The single settings row: company profile, sender and signature, internal email domains, company calendars, Slack notification channel and allowlist, time zone, currency, default model and effort. |
| `policies` | The saved approval mode per action class. |
| `connections` | The last known status of each integration: state, endpoint host, masked account hint, missing variable names, last check. |
| `conversations` | Title, source (`ui` or `cli`), status, SDK session id, cost and token totals. |
| `messages` | The rendered chat messages of each conversation. |
| `runs` | One row per turn: source, mode, status, model, effort, usage and cost, stop and terminal reasons, error, and snapshots of the policy and the connections it used. |
| `tool_calls` | The action log: one row per tool call with its connection type, operation, class, decision, redacted input, compacted output, error, HTTP status and idempotency key. |
| `approvals` | One row per approval request with its facts, status, who decided, reason and expiry. |

Migrations are applied when the server or the CLI opens the database.
`pnpm db:seed` writes the default settings and policies (it is idempotent).
There is no sample data: conversations, runs and tool calls exist only after
real use. Money is stored in integer minor units with its currency. No secret
is ever stored.

To reset, stop the server and any CLI run, then delete the state directory,
or only `revenue-desk.sqlite*` to keep the SDK sessions directory:

```sh
rm -rf data
pnpm db:seed
```

After changing `src/db/schema.ts`, run `pnpm db:generate` and commit the
generated migration in `src/db/migrations`.

## Testing

| Command | What it covers |
|---|---|
| `pnpm test` | Vitest unit and integration tests, no network: contracts and schema, configuration, clients, classifiers, policy, redaction, the event-to-stream mapping, database repositories, the CLI, and the real Claude Agent SDK against a scripted Messages API on loopback with contract-faithful local fakes of every integration. The full-stack suite (`test/integration/e2e`) plays the jobs, decisions and failures over the HTTP API of the real server and checks the database rows against what happened in each fake. |
| `pnpm test:e2e-cli` | The built CLI (`dist/cli/main.js`) as a separate process against the fakes and the scripted model: human and `--json` output, exit codes, SIGTERM, parallel runs with separate state directories. Run `pnpm build` first. |
| `pnpm test:e2e` | Playwright UI tests of the built app in the sandbox (started by the suite on port 4320, which must be free) in the installed Google Chrome, on desktop and phone viewports, with an accessibility check. Run `pnpm build` first. |
| `pnpm typecheck`, `pnpm lint` | TypeScript and Biome. |
| `pnpm verify` | Typecheck, lint, `pnpm test`, the build, then the CLI and UI end-to-end suites. |
| `LIVE_E2E=1 pnpm test:live` | Opt-in, against real services, and not part of `pnpm verify`: see [Live tests](#live-tests). |

### Live tests

Both refuse to start unless `LIVE_E2E=1` is set, because they call the real
Anthropic API and cost money. Keys are read at run time from files outside
the tracked tree and are never printed.

- **`LIVE_E2E=1 pnpm test:live`** runs `test/live`. The Gmail test asks the
  headless CLI (from source) to summarise the three most recent emails in the
  connected inbox, with every class except `read` denied (so the Composio
  session is read-only and offers no write tool) and
  `AGENT_MAX_BUDGET_USD=0.50`. It first checks the connections read-only, as
  **Check** does, then asserts that the run completed, only Gmail reads ran,
  nothing was drafted, sent or labelled, and the cost stayed under the cap.
  `COMPOSIO_API_KEY` and `COMPOSIO_USER_ID` come from `DOTENV_PATH` (default
  `../gmail-agent/.env`), `ANTHROPIC_API_KEY` from `LIVE_MODEL_ENV` (default
  `.env`, which git ignores). The reply holds real email, so the test prints
  only counts and tool names; set `LIVE_OUT_DIR` to a directory outside the
  repository to keep the run's database and summary there for review.
  `test/live` also checks the live script's approval rules offline.
- **`LIVE_E2E=1 node --import tsx scripts/live-e2e.ts --out <dir>`** plays the
  five jobs with the real model against the sandbox fakes, through the HTTP
  API with the production build (`pnpm build` first), then three headless CLI
  runs, one of them without QuickBooks configuration. Each approval is decided
  by the job's rules (the correct refund, invoice or call is approved; a wrong
  charge, an unrequested payment or refund, or an email the user asked only to
  draft is denied), and every card is checked against the call's input. The
  key comes from `--key-file` (default `.env`). Transcripts, the database and
  a summary go to `<dir>`, which must be outside the repository; spend is kept
  in `<dir>/spend.json`, and a run that could take it past `--budget-usd`
  (default 8) is not started. `--jobs j1,j3` and `--no-cli` narrow the run.

Real-SDK tests run the Claude CLI with `ANTHROPIC_BASE_URL` pointing at the
scripted API and proxies that refuse any non-loopback connection. They fail,
rather than skip, when the SDK's native binary is missing.

## Configuration

Configuration comes only from environment variables, read once at start
(`.env.example` lists them in this order). Variables with scope "tests,
sandbox" exist for tests and the sandbox demo; leave them unset otherwise.

<!-- env-table:start: generated from src/contracts/env.ts by test/unit/readme.test.ts -->
| Variable | Group | Secret | Scope | Meaning |
|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | Model | yes | product | Required to run the agent. |
| `ANTHROPIC_BASE_URL` | Model |  | tests, sandbox | Messages API base URL; tests point it at the local scripted API. |
| `AGENT_MODEL` | Model |  | product | Model id. Default claude-sonnet-5. No silent fallback. |
| `AGENT_EFFORT` | Model |  | product | low, medium, high, xhigh or max. Default medium. |
| `AGENT_THINKING_DISPLAY` | Model |  | product | summarized or omitted. Default summarized in the UI, omitted in the CLI. |
| `AGENT_MAX_TURNS` | Model |  | product | Turn limit per run. Default 30. |
| `AGENT_MAX_BUDGET_USD` | Model |  | product | Spend limit per run in USD. Default 2.00. |
| `PORT` | Runtime |  | product | API server port, always bound to 127.0.0.1. Default 4320. |
| `AGENT_STATE_DIR` | Runtime |  | product | Database, work directory and Claude config. Default ./data (git-ignored). |
| `AGENT_POLICY` | Runtime |  | product | JSON approval modes per action class, e.g. {"financial":"deny"}. Locks them. |
| `AGENT_BUSINESS_DATE` | Runtime |  | product | YYYY-MM-DD the agent treats as today. Default: today in the workspace time zone. |
| `AGENT_APPROVAL_TIMEOUT_MS` | Runtime |  | product | How long a pending approval waits before it is denied. Default 900000. |
| `AGENT_SANDBOX` | Runtime |  | tests, sandbox | Set to 1 only by pnpm dev:sandbox: labels the app 'Local sandbox' and refuses any non-loopback endpoint. |
| `DOTENV_PATH` | Runtime |  | product | An env file outside the repository to load at start. |
| `COMPOSIO_API_KEY` | Gmail, Google Calendar | yes | product | Composio project key. Gmail and Google Calendar need it. |
| `COMPOSIO_USER_ID` | Gmail, Google Calendar |  | product | The Composio user whose connections are used. No default in code. |
| `COMPOSIO_BASE_URL` | Gmail, Google Calendar |  | product | Composio API base URL. Default https://backend.composio.dev. |
| `HUBSPOT_ACCESS_TOKEN` | HubSpot | yes | product | Private-app token for the bundled @hubspot/mcp-server over stdio. |
| `HUBSPOT_API_BASE_URL` | HubSpot |  | product | HubSpot API base URL for the stdio server (BASE_URL_OVERRIDE). Default: the server's. |
| `HUBSPOT_MCP_URL` | HubSpot |  | product | Any Streamable HTTP MCP server for HubSpot; replaces the stdio server when set. |
| `HUBSPOT_MCP_TOKEN` | HubSpot | yes | product | Bearer token for HUBSPOT_MCP_URL. |
| `HUBSPOT_MCP_COMMAND` | HubSpot |  | tests, sandbox | Replaces the stdio command (tests). |
| `HUBSPOT_MCP_ARGS` | HubSpot |  | tests, sandbox | JSON array of arguments for HUBSPOT_MCP_COMMAND (tests). |
| `STRIPE_SECRET_KEY` | Stripe | yes | product | sk_test_/rk_test_ key. Live keys are refused unless ALLOW_LIVE_STRIPE=1. |
| `ALLOW_LIVE_STRIPE` | Stripe |  | product | Set to 1 to accept a live Stripe key. |
| `STRIPE_API_BASE_URL` | Stripe |  | product | Default https://api.stripe.com. A path prefix is kept. |
| `STRIPE_API_VERSION` | Stripe |  | product | Stripe-Version header. Default: the account's version. |
| `QBO_ACCESS_TOKEN` | QuickBooks Online | yes | product | OAuth access token (expires hourly). |
| `QBO_REALM_ID` | QuickBooks Online |  | product | Company (realm) id. |
| `QBO_API_BASE_URL` | QuickBooks Online |  | product | Default https://sandbox-quickbooks.api.intuit.com. A path prefix is kept. |
| `QBO_MINOR_VERSION` | QuickBooks Online |  | product | minorversion query parameter. Default: omitted. |
| `SLACK_BOT_TOKEN` | Slack | yes | product | Bot token (xoxb-). |
| `SLACK_API_BASE_URL` | Slack |  | product | Default https://slack.com. A path prefix is kept. |
<!-- env-table:end -->

`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and `CLAUDE_CODE_MAX_RETRIES` are
passed to the Claude CLI child process when set, and are otherwise unused.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The CLI exits 3 with "ANTHROPIC_API_KEY is not set" | The key is in neither the environment nor the `DOTENV_PATH` file. Check that `DOTENV_PATH` is exported in the shell that runs the command. |
| "DOTENV_PATH names …, which could not be read" | The path is wrong or the file is not readable by you. A relative path resolves against the current directory. |
| An integration shows **Not configured** | Connections lists the missing variable names. Set them and restart the server. |
| Stripe shows **Invalid** | A live key (`sk_live_`, `rk_live_`) is configured. Use a test key. |
| Gmail or Google Calendar needs sign-in or has expired | Click **Connect** in Connections, finish the Composio sign-in, then **Check**. Until then its tools are not offered and the agent says so. |
| QuickBooks calls fail with 401 | The access token expired (after an hour). Set a new `QBO_ACCESS_TOKEN` and restart. A 403 usually means `QBO_REALM_ID` does not match the token's company. |
| HubSpot is unavailable at the start of a run | The stdio MCP server could not start or rejected the token, or `HUBSPOT_MCP_URL` is unreachable. Check `HUBSPOT_ACCESS_TOKEN`, or the URL and `HUBSPOT_MCP_TOKEN`, then **Check** in Connections. |
| A run fails with `model_error` | The model id is wrong or unavailable to your key, or the API failed. Revenue Desk never switches models; set `AGENT_MODEL` or `--model`. |
| A run fails with `max_turns` or `budget_exceeded` | Raise `AGENT_MAX_TURNS` or `AGENT_MAX_BUDGET_USD`, or `--max-turns` and `--max-budget-usd` for one CLI run. |
| An action was "blocked by policy" in the CLI | Its class is `ask` and the CLI cannot ask. Run it in the app, or allow the class for one run with `--policy`. |
| The CLI exits 2 for `--conversation` | The id is not in this state directory, or the conversation has an active run in the app; wait for it or stop it. |
| An approval disappeared as "expired" | The server restarted while it was pending, or `AGENT_APPROVAL_TIMEOUT_MS` passed. Ask again. |
| Dates or aging are off by a day | The business date is today in the Settings time zone. Set the time zone, or `AGENT_BUSINESS_DATE` for a fixed date. |
| "address already in use" on 4320 or 4321 | Another process holds the port. Stop it, or set `PORT` (the Vite proxy expects 4320). |
| Tests fail with "No native Claude Agent SDK binary" | Optional dependencies were skipped. Run `pnpm install` again without `--no-optional`. |
| `pnpm test:e2e` cannot find a browser, or port 4320 is in use | The suite uses the installed Google Chrome; stop any Revenue Desk server on 4320 first (it never reuses one), and run `pnpm build` before the suite. |

This repository is private and local-only. It has no licence file yet.
