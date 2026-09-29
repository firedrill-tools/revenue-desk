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
| Billing inquiry | Reads the customer's Gmail thread, looks the customer up in Stripe (charges, invoices), QuickBooks (invoices and payments) and HubSpot (contact, company, owner), and drafts a reply in Gmail. | The draft is automatic; sending asks. |
| Refund a duplicate charge | Finds the duplicate in Stripe and proposes a refund with amount, charge, customer and reason, then logs a HubSpot note and posts to the billing Slack channel. | The refund asks. |
| Collections | Lists overdue QuickBooks invoices, checks Stripe for payments that were never recorded, drafts reminder emails, and for invoices 60 or more days overdue proposes a Google Calendar call and creates a HubSpot task. | A call with an external attendee asks. |
| Closed-won handoff | For a HubSpot deal in closed-won, finds or creates the QuickBooks customer, creates the invoice, emails it to the billing contact from Gmail (Composio's QuickBooks tools cannot email an invoice), and posts to the sales-ops Slack channel. | Creating the invoice asks; sending the email asks. |
| Weekly digest | Reads new HubSpot deals, Stripe payments and refunds, and QuickBooks AR aging, and posts a digest to Slack. | Automatic when the channel is allowlisted. |

The agent is instructed to call a refund, invoice, payment or cancellation
tool only when you asked for that action. When it finds one is needed (a
duplicate charge, a payment never recorded), it recommends it with the
amount and the record, asks in its reply and finishes the rest of the task.
It drafts, notes and posts about an action only after the action succeeded,
and promises a customer nothing that has not been approved and done. These
are instructions to the model; the approval policy below is what enforces
them.

## How it connects

Every integration is a real service; nothing is mocked or simulated in the
product. Each uses one of three connection types: Composio for every system
Composio supports (Gmail, Google Calendar, QuickBooks Online, Slack), MCP for
HubSpot and the REST API for Stripe. Every tool reaches the model through an
in-process gateway server per integration (tool names look like
`mcp__stripe__create_refund` or `mcp__quickbooks__QUICKBOOKS_CREATE_INVOICE`),
which offers only the listed tools, classifies every call for the approval
policy, records it, and keeps integration credentials inside the Revenue Desk
process: the Claude CLI child process receives none of them.

| Integration | Connection | Tools | Why this connection |
|---|---|---|---|
| Gmail | Composio | fetch emails, read a thread, list threads and labels; create a draft, add a label; send a draft, reply to a thread | Composio holds the Google OAuth grant, so Revenue Desk never stores Google tokens. One Composio session per run serves all four Composio integrations, with the `direct_tools` preset and an explicit tool allowlist per toolkit. |
| Google Calendar | Composio | list events, find free slots, find an event; create and update events | The same Composio session and OAuth handling as Gmail. |
| QuickBooks Online | Composio | company info; query and read customers; query and read invoices (overdue included); query payments; query products and services; the AR aging report; create a customer; create an invoice; record a payment | Composio holds the Intuit OAuth grant (Composio-managed OAuth; Connect asks which QuickBooks server: the default is real company data, `https://sandbox-quickbooks.api.intuit.com` a sandbox company). Composio's QuickBooks toolkit has no tool that emails or voids an invoice, so an invoice is emailed from Gmail. Amounts are decimals in the company currency. |
| Slack | Composio | find and list channels, read a channel's history or a thread, find users; post a message (Markdown), add a reaction | Composio holds the Slack OAuth grant (Composio-managed OAuth, user scopes: posts appear as the Slack user who connected). |
| HubSpot | MCP | account details; list, search and batch-read objects; associations and properties; batch-create and batch-update objects (notes and tasks are created with their associations in one call); list owners, to name who a record is assigned to | HubSpot publishes an official MCP server, `@hubspot/mcp-server` 0.4.0, which Revenue Desk runs over stdio. Any Streamable HTTP MCP server can replace it. 10 of its 21 tools are offered. The owners lookup is Revenue Desk's own read-only tool against HubSpot's REST API with the same token, because the MCP server has none; it is offered with the stdio server only, so HubSpot has 11 tools over stdio and 10 with `HUBSPOT_MCP_URL`. |
| Stripe | API | find customers by exact email or by name (Stripe's customer search), get a customer; list charges, payment intents, invoices, subscriptions and refunds; get an invoice; get the balance; create a refund; cancel a subscription | Direct REST: test-mode keys, idempotency keys on writes and documented error envelopes. |

An integration without configuration is shown as not configured, and a
Composio integration nobody has connected shows as needing sign-in; neither
is offered to the agent. There is no fallback to sample data or to another
model.

Some rules are checked before a call reaches the system, because the tool's
schema cannot state them; the call is rejected and the model is told what to
fix:

- **HubSpot:** creating a note, task, call, meeting or email needs
  `hs_timestamp` (for a task, its due time).
- **Slack:** a post is standard Markdown in `markdown_text` (Slack renders
  headings, bold, lists and tables there); Block Kit `blocks` are refused, so
  the approval card shows exactly what is posted. A plain `@name` (which
  notifies nobody) or a `<@…>` mention that is not a Slack user id is
  refused; mention people as `<@U…>` with the id from a user search.
- **QuickBooks:** every invoice line needs its `Amount` (the card shows the
  total from them), and recording a payment never charges a card
  (`process_payment` and `credit_card_payment` are refused).
- **Any tool:** an empty value is refused with "pass a value a system or
  the user gave you, or leave the field out".

Times the Stripe tools return are written in the workspace time zone
(Settings) with their UTC offset.

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
   - **Gmail, Google Calendar, QuickBooks Online and Slack (Composio).**
     `COMPOSIO_API_KEY` (a Composio project key) and `COMPOSIO_USER_ID` (the
     Composio user whose accounts the agent uses; there is no default).
     `COMPOSIO_USER_ID` is any stable id you choose, for example your email
     address; Connect creates the connections under it. Then start the app,
     open **Connections** and click **Connect** for each of the four:
     Composio's hosted sign-in opens in a new tab (Google, Intuit or Slack).
     Use **Check** afterwards. Revenue Desk starts a Composio sign-in only
     from that click. QuickBooks asks which server to use: keep the default
     for real company data, or choose
     `https://sandbox-quickbooks.api.intuit.com` for a sandbox company. Slack
     connects with user scopes, so posts appear as the person who connected.
   - **Stripe.** `STRIPE_SECRET_KEY`, a test-mode `sk_test_` or restricted
     `rk_test_` key. Live keys are refused (see
     [Approvals and safety](#approvals-and-safety)).
   - **HubSpot.** Either `HUBSPOT_ACCESS_TOKEN`, a private-app token with CRM
     read and write access for contacts, companies, deals, notes and tasks,
     plus `crm.objects.owners.read` for the owners lookup (the bundled MCP
     server runs over stdio with it, and the owners lookup calls
     `HUBSPOT_API_BASE_URL`, default `https://api.hubspot.com`, with the same
     token), or `HUBSPOT_MCP_URL` for any Streamable HTTP MCP server, with
     `HUBSPOT_MCP_TOKEN` when it needs a bearer token (no owners lookup
     then). HubSpot ends creation of legacy private apps on 2026-10-26.

4. In the app, open **Settings** and fill in the company profile, the
   internal email domains (recipients and attendees outside them are
   external), any shared Google calendars the company owns (apart from your
   primary calendar and calendars whose id is an internal address, every
   calendar that is not listed counts as external), the Slack notices
   channel and the channels the agent may post to without asking, and the
   time zone. The time zone sets the business date ("today", with its
   weekday) and the zone of the times the Stripe tools return.

Without `ANTHROPIC_API_KEY` the app says so and offers no job to start. The
server checks every configured connection read-only in the background when
it starts; until its check finishes, a connection shows as not checked yet.

## Running

| Command | What it runs |
|---|---|
| `pnpm dev` | The API server on 127.0.0.1:4320 (`tsx watch`) and Vite on http://127.0.0.1:4321, which proxies `/api` to the server. Open port 4321; port 4320 answers only the API (and a page pointing to 4321). |
| `pnpm build && pnpm start` | Builds the web app into `dist/web` and the server and CLI into `dist/`, then serves the API and the built app on http://127.0.0.1:4320. |
| `pnpm dev:sandbox` | The labelled demo: see [Sandbox demo](#sandbox-demo). |
| `node dist/cli/main.js ask "…"` | The headless CLI (after `pnpm build`); see [Command line](#command-line). |

The server listens on 127.0.0.1 only; `PORT` changes the port. The server and
the CLI share the state directory (`AGENT_STATE_DIR`, default `./data`), so
CLI conversations and runs appear in the app with source `cli`.

### Sandbox demo

`pnpm dev:sandbox` starts local fake Stripe, HubSpot MCP and Composio
services on loopback ports, then the server and the app with
`AGENT_SANDBOX=1` and every integration pointed at the fakes through the
ordinary base-URL variables. The fakes hold one fictional company on `*.test`
domains. The Composio fake runs Gmail and Google Calendar; it lists
QuickBooks and Slack but has no data for them, so they show as needing
sign-in and the scripted jobs say what they could not do without them. The model is the scripted test model, which plays the five jobs by
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
| `--timeout-ms <ms>` | Wall-clock limit, at most 2147483647 (about 24.8 days); the run is stopped and ends timed out. |
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
node dist/cli/main.js ask "Why was Harbor & Pine Outfitters charged twice?"
node dist/cli/main.js ask --json "List invoices more than 60 days overdue" | jq .toolCalls
echo "Post this week's revenue digest to Slack" | node dist/cli/main.js ask -
node dist/cli/main.js ask --conversation <id> "Draft the reminder emails"
```

`--policy '{"financial":"auto"}'` lets that run refund, invoice and record
payments without asking; use it only against test accounts.

Without a build, run `node --import tsx src/cli/main.ts ask …`. `pnpm cli ask …`
also works for trying it and passes the exit code through, but pnpm prints
its own banner on stdout (unless `-s`), so do not use it where stdout is
parsed.

## Approvals and safety

Every tool call is classified from its complete input into an action class,
and the class's mode decides what happens:

| Action class | Examples | Default |
|---|---|---|
| `read` | Any lookup, search or list | automatic |
| `internal_write` | Gmail drafts and labels (other than Trash and Spam), HubSpot notes, tasks and other CRM records, Slack posts to allowlisted channels that do not notify everyone (`@channel`, `@here`, `@everyone`, a user group), Slack reactions, calendar events on an internal calendar (your primary one, one whose id is an internal address, or a listed company calendar) whose attendees are all internal, creating a QuickBooks customer without an opening balance | automatic |
| `outbound` | Sending or replying to email, calendar events with an external attendee or on a calendar that is not internal, an update of an event whose current guests the run has not read (an update replaces the guest list), Slack posts to any other channel, a direct message, a channel shared with another organisation, a channel id the run has not seen named, or a post that notifies everyone | asks |
| `financial` | Stripe refunds and subscription cancellations; creating a QuickBooks invoice, recording a QuickBooks payment, and creating a QuickBooks customer with an opening balance | asks |
| `destructive` | Adding the Trash or Spam label to a Gmail message | denied |

- **Changing the policy.** The Settings screen saves a mode per class.
  `AGENT_POLICY` (JSON, for example `{"financial":"deny"}`) overrides it and
  locks those classes in the app. The CLI's `--policy` overrides both for one
  run.
- **Approval cards** show the exact consequence and its facts, naming
  records by what the systems returned earlier in the same run rather than
  by internal ids. Examples from the sandbox:
  - "Refund $490.00 to Harbor & Pine Outfitters on Stripe charge ch_…", with
    the charge's amount, date and description, what was already refunded
    (this run's refunds included), and a "Check" line first when the refund
    is more than what is left;
  - "Send the Gmail draft to dana@harborpine.test", with To, Cc, Bcc,
    subject, thread and body of the draft the run created (a draft the run
    did not create says its recipients could not be confirmed);
  - "Record a $1,980.00 payment from Meridian Labs against invoice 1051",
    flagged when it exceeds the invoice's open balance or the invoice
    belongs to another customer;
  - "Create a $18,000.00 invoice for Solstice Energy Cooperative (not sent)",
    with each line, the due date and the billing email;
  - a calendar event with its weekday and time in the event's zone, who is
    outside the company, who is removed, and whom Google emails;
  - a Slack post with its channel (named from the run's channel search when
    the call gives an id) and the message text, line breaks kept.

  A write sent without an answer shows "May already be applied" on later
  cards. A call blocked by policy reads "Blocked by policy" with the reason
  and a link to the policy; an approved call that then failed reads
  "Approved, then failed" with the reason.
- **Waiting and deciding.** A pending approval is denied after
  `AGENT_APPROVAL_TIMEOUT_MS` (15 minutes by default). Approvals are made in
  the app on the machine that runs Revenue Desk (it answers on loopback
  only); the phone layout is for narrow windows, not for remote devices.
  While one waits, the tab title shows the count ("(1) Revenue Desk"), the
  new-chat screen lists it under "Waiting for your decision", and the
  conversation list names what waits; a call queued behind it reads "Waits
  for your decision above". Stop cancels the run and its pending approvals.
  After a denial the agent reports it and does not retry. Arguments are
  validated against the tool's schema and the rules above before any
  approval is asked, so an invalid call is never put in front of a person.
- **Writes happen once.** Stripe writes carry an `Idempotency-Key` derived
  from the run and the model's tool-call id. Writes are never retried
  automatically; reads retry at most
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
  secret values and token shapes (`Bearer …`, `sk_`, `rk_`, `sk-ant-`,
  `xox…`, `pat-`) from logs, stored rows, streamed output and CLI output.
- **Local only, single user.** The server binds to 127.0.0.1 and refuses
  requests whose `Host` is not loopback. It assumes a single-user machine:
  loopback, `Origin` and CSRF checks stop other websites, not other programs
  or other accounts on the same host, which can reach 127.0.0.1, take a
  session and act with this configuration's credentials. Do not run it on a
  shared host. Every `/api` request except `/api/health` and
  `/api/session` needs the per-session cookie, reads included. Changing
  requests also need a matching `x-rd-csrf` header and
  `Content-Type: application/json`, and are refused when the browser sends a
  foreign `Origin`. Pages carry a Content-Security-Policy that lets the
  browser load and connect only to Revenue Desk itself, and the agent's
  replies never render images, so text the model repeats cannot make the
  browser fetch a URL. Under `pnpm dev`, Vite sends no CORS headers and serves
  only the web app, the shared contracts and dependencies, never `./data`.
- **One run at a time per conversation**, whether it was started in the app
  or by the CLI (the database refuses a second running run), and at most four
  runs at once in the server; a run waiting on an approval holds its slot.
  While the server shuts down it starts no new run.
- **Runs whose process died.** Every run records the process that owns it.
  If the server crashes or a CLI is killed (SIGKILL) mid-run, the run is
  failed as `server_restart`, its pending approvals expire and its
  conversation is freed: at the next server start, when the CLI opens the
  database, before a busy conversation is refused, and when the app lists
  conversations or runs. Runs of processes that are still alive are never
  touched.
- **Connections follow the runs.** A call whose provider refuses the
  credential itself (Stripe or HubSpot 401) marks the connection needing
  sign-in, so the next run leaves it out; a Stripe or HubSpot 403 or a card
  decline does not. Composio reports its own sign-ins (Gmail, Calendar,
  QuickBooks, Slack) through Check. Connections re-checks rows older than
  30 minutes when you open it.
- **Composio** sign-in starts only from a click on Connect. Composio sessions
  offer the tools that reach other people or move money (sending email,
  calendar events, Slack posts, QuickBooks invoices and payments) only when
  the policy does not deny both outbound and financial actions; every call
  is still classified and gated on its own.

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
| `runs` | One row per turn: source, mode, status, model, effort, usage and cost (its own requests only, even in a resumed session), stop and terminal reasons, error, snapshots of the policy and the connections it used, the owning process (pid and start time) and the SDK session. |
| `tool_calls` | The action log: one row per tool call with its connection type, operation, class, decision, redacted input, compacted output, error, the provider's HTTP status (successes included) and, for a Stripe or QuickBooks write, the idempotency key it sent. |
| `approvals` | One row per approval request with its facts, status, who decided, reason and expiry. |

Migrations (`src/db/migrations`, `0000` to `0005`) are applied when the
server or the CLI opens the database.
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

| Command | What it covers | Tests (2026-09-29) |
|---|---|---|
| `pnpm test` | Vitest unit and integration tests, no network: contracts and schema, configuration, clients, classifiers and the cards they build, input rules, policy, redaction, the event-to-stream mapping, security guards, database repositories and run recovery, the web client's libraries, the CLI, QuickBooks and Slack against the captured Composio schemas, and the real Claude Agent SDK against a scripted Messages API on loopback with local fakes of Stripe, HubSpot and Composio (which runs Gmail and Calendar and reports QuickBooks and Slack not connected). The full-stack suite (`test/integration/e2e`) plays the jobs, decisions, stops and failures over the HTTP API of the real server and checks the database rows against what happened in each fake. | 1,130 |
| `pnpm test:e2e-cli` | The built CLI (`dist/cli/main.js`) as a separate process against the fakes and the scripted model: human and `--json` output, the run shown in the app, exit codes, SIGTERM, a CLI killed with SIGKILL not blocking its conversation, four runs at once with separate state directories, the shebang. Run `pnpm build` first. | 8 |
| `pnpm test:e2e` | Playwright UI tests of the built app in the sandbox (started by the suite on port 4320, which must be free) in the installed Google Chrome, on desktop and phone viewports: the jobs with approvals, reload, Stop and keyboard-only approval; conversation names; the inspector; every connection state, Check and Connect; a policy block; no request to another host; waiting approvals outside their conversation; a failed approved refund; no model key; dark mode, reduced motion, 44px touch targets, the rail, Runs and table alignment. Each checks accessibility (axe) and, on the phone, that the page never scrolls sideways. Run `pnpm build` first. | 49, plus 1 skipped (touch targets run on the phone only) |
| `pnpm typecheck`, `pnpm lint` | TypeScript and Biome. | |
| `pnpm verify` | Typecheck, lint, `pnpm test`, the build, then the CLI and UI end-to-end suites. | |
| `LIVE_E2E=1 pnpm test:live` | Opt-in, against real services, read-only, and not part of `pnpm verify`: see [Live tests](#live-tests). | 1 live, 11 offline |

`pnpm build` warns that the chat screen's JavaScript chunk is larger than
500 kB; the build succeeds.

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
  runs. QuickBooks and Slack have no local fake, so they are not connected
  in these runs. Each approval is decided
  by the job's rules (the correct refund, invoice or call is approved; a wrong
  charge, an unrequested payment or refund, an email that promises a refund
  nobody approved, or an email the user asked only to draft is denied), and
  every card is checked against the call's input. The
  key comes from `--key-file` (default `.env`). Transcripts, the database and
  a summary go to `<dir>`, which must be outside the repository; spend is kept
  in `<dir>/spend.json`, and a run that could take it past `--budget-usd`
  (default 8) is not started. Each run may cost up to its cap: $2 per server
  turn and $1 per CLI run by default, or `--run-cap-usd` (at most 2), which
  the script enforces through `AGENT_MAX_BUDGET_USD` and `--max-budget-usd`
  so more runs fit a small budget. `--jobs j1,j3` and `--no-cli` narrow the
  run. The script checks that nothing it wrote contains a key.

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
| `COMPOSIO_API_KEY` | Composio (Gmail, Google Calendar, QuickBooks, Slack) | yes | product | Composio project key. Gmail, Google Calendar, QuickBooks and Slack need it. |
| `COMPOSIO_USER_ID` | Composio (Gmail, Google Calendar, QuickBooks, Slack) |  | product | The Composio user whose connections are used. No default in code. |
| `COMPOSIO_BASE_URL` | Composio (Gmail, Google Calendar, QuickBooks, Slack) |  | product | Composio API base URL. Default https://backend.composio.dev. |
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
<!-- env-table:end -->

`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and `CLAUDE_CODE_MAX_RETRIES` are
passed to the Claude CLI child process when set, and are otherwise unused.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The CLI exits 3 with "ANTHROPIC_API_KEY is not set" | The key is in neither the environment nor the `DOTENV_PATH` file. Check that `DOTENV_PATH` is exported in the shell that runs the command. |
| "DOTENV_PATH names …, which could not be read" | The path is wrong or the file is not readable by you. A relative path resolves against the current directory. |
| An integration shows **Not configured** | Connections lists the missing variable names. Add them to the file `DOTENV_PATH` names and restart the server: configuration is read only at start. |
| Stripe shows **Invalid configuration** | A live key (`sk_live_`, `rk_live_`) is configured. Use a test key. |
| Gmail, Google Calendar, QuickBooks or Slack needs sign-in or has expired | Click **Connect** in Connections, finish the Composio sign-in, then **Check**. Until then its tools are not offered and the agent says so. |
| QuickBooks shows another company's data, or none | Composio's QuickBooks connection asks which server to use when you connect: the default is real company data; a sandbox company needs `https://sandbox-quickbooks.api.intuit.com`. Connect again and choose the one you mean. |
| HubSpot is unavailable at the start of a run | The stdio MCP server could not start or rejected the token, or `HUBSPOT_MCP_URL` is unreachable. Check `HUBSPOT_ACCESS_TOKEN`, or the URL and `HUBSPOT_MCP_TOKEN`, then **Check** in Connections. |
| A run fails with `model_error` | The model id is wrong or unavailable to your key, or the API failed. Revenue Desk never switches models; set `AGENT_MODEL` or `--model`. |
| A run fails with `max_turns` or `budget_exceeded` | Raise `AGENT_MAX_TURNS` or `AGENT_MAX_BUDGET_USD`, or `--max-turns` and `--max-budget-usd` for one CLI run. |
| An action was "blocked by policy" in the CLI | Its class is `ask` and the CLI cannot ask. Run it in the app, or allow the class for one run with `--policy`. |
| The CLI exits 2 for `--conversation` | The id is not in this state directory, or the conversation has an active run in the app; wait for it or stop it. |
| An approval disappeared as "expired" | The server restarted while it was pending, or `AGENT_APPROVAL_TIMEOUT_MS` passed. Ask again. |
| A run failed with `server_restart` | The process running it exited mid-run (a crash, a restart, a CLI killed with SIGKILL). Revenue Desk failed it so the conversation is free again; its pending approvals expired. Ask again. |
| "Revenue Desk is shutting down and starts no new run" (503) | The server received SIGINT or SIGTERM. Start it again. |
| A call was rejected before it ran (`is missing "hs_timestamp"`, `is empty`, `mentions …, which is not a Slack user id`, `/Amount is needed`) | Revenue Desk checked a rule the system enforces or a formatting rule, and nothing reached the system. The agent is told what to fix, so it can repeat the call corrected. |
| HubSpot owners show as ids | The owners lookup needs the stdio server (`HUBSPOT_ACCESS_TOKEN`) and the token's `crm.objects.owners.read` scope; with `HUBSPOT_MCP_URL` it is not offered. |
| Dates or aging are off by a day | The business date is today in the Settings time zone. Set the time zone, or `AGENT_BUSINESS_DATE` for a fixed date. |
| "address already in use" on 4320 or 4321 | Another process holds the port. Stop it, or set `PORT` (the Vite proxy expects 4320). |
| Tests fail with "No native Claude Agent SDK binary" | Optional dependencies were skipped. Run `pnpm install` again without `--no-optional`. |
| `pnpm test:e2e` cannot find a browser, or port 4320 is in use | The suite uses the installed Google Chrome; stop any Revenue Desk server on 4320 first (it never reuses one), and run `pnpm build` before the suite. |

This repository is private and local-only. It has no licence file yet.
