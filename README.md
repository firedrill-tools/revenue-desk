# Revenue Desk

A runnable example agent for [Firedrill](https://firedrill.run).
[Try it against synthetic Tools](docs/FIREDRILL_DEMO.md) for a CLI-first setup,
the React chat UI, saved behavioral tests, SDK simulations and opt-in CI.
That path uses your own model key but no real vendor-service credentials.

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

The ordinary application mode connects to real services. The separate
[Firedrill test mode](docs/FIREDRILL_DEMO.md) explicitly connects to synthetic
Tools instead; it is never a silent fallback. Ordinary mode uses one of three
connection types: Composio for every system
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
| QuickBooks Online | Composio | company info; query and read customers; query and read invoices (overdue included); query payments; query products and services; the AR aging report; create a customer; create an invoice; record a payment | Composio holds the Intuit OAuth grant (Composio-managed OAuth, which connects a real or trial QuickBooks Online company; an Intuit sandbox company is not supported yet, see [Setup](#setup)). Composio's QuickBooks toolkit has no tool that emails or voids an invoice, so an invoice is emailed from Gmail. Amounts are decimals in the company currency. |
| Slack | Composio | find and list channels, read a channel's history or a thread, find users; post a message (Markdown), add a reaction | Composio holds the Slack OAuth grant (Composio-managed OAuth, user scopes: posts appear as the Slack user who connected). |
| HubSpot | MCP | account details; list, search and batch-read objects; associations and properties; batch-create and batch-update objects (notes and tasks are created with their associations in one call); list owners, to name who a record is assigned to | HubSpot publishes an official MCP server, `@hubspot/mcp-server` 0.4.0, which Revenue Desk always runs over stdio with `HUBSPOT_ACCESS_TOKEN`; nothing can replace it. 10 of its 21 tools are offered. The owners lookup is Revenue Desk's own read-only tool against HubSpot's REST API with the same token, because the MCP server has none, so HubSpot has 11 tools. |
| Stripe | API | find customers by exact email or by name (Stripe's customer search), get a customer; list charges, payment intents, invoices, subscriptions and refunds; get an invoice; get the balance; create a refund; cancel a subscription | Direct REST: test-mode keys, idempotency keys on writes and documented error envelopes. |

An integration without configuration is shown as not configured, and a
Composio integration nobody has connected shows as needing sign-in; neither
is offered to the agent. There is no fallback to sample data or to another
model.

Where each service is reached is fixed in the code
(`src/integrations/shared/vendors.ts`), not configured: Composio at
`https://backend.composio.dev`, Stripe at `https://api.stripe.com`, HubSpot's
MCP server at its own default `https://api.hubspot.com` (it is never given a
host override), and the HubSpot owners lookup at `https://api.hubapi.com`.
Ordinary-mode configuration supplies credentials only; endpoint substitution
is limited to the explicit Firedrill test-side composition. As a second guard,
a Composio session endpoint or sign-in
link that is not HTTPS on a public host (one on this machine, `*.localhost`
or a private network) is refused before anything connects to it or opens
it.

Some rules are checked before a call reaches the system, because the tool's
schema cannot state them; the call is rejected and the model is told what to
fix:

- **HubSpot:** creating a note, task, call, meeting or email needs
  `hs_timestamp` (for a task, its due time).
- **Slack:** a post is standard Markdown in `markdown_text` (Slack renders
  headings, bold, lists and tables there); Block Kit `blocks` and
  `fallback_text` (which Slack shows in notifications) are refused, so the
  approval card shows exactly what is posted. A plain `@name` (which
  notifies nobody) or a `<@…>` mention that is not a Slack user id is
  refused; mention people as `<@U…>` with the id from a user search.
- **QuickBooks:** every invoice line needs its `Amount` (the card shows the
  total from them); customers and linked invoices are named by their
  QuickBooks Id (digits), not by name or invoice number; and recording a
  payment never charges a card (`process_payment` and
  `credit_card_payment` are refused).
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
     from that click, and each click starts a new sign-in request in
     Composio. QuickBooks connects through Composio's own Intuit app, which
     reaches a real or trial QuickBooks Online company; an Intuit sandbox
     company needs your own Intuit developer app as a Composio auth config,
     which Revenue Desk does not select yet. Slack connects with user scopes,
     so posts appear as the person who connected; use a workspace you
     administer (an admin may need to approve Composio's app).
   - **Stripe.** `STRIPE_SECRET_KEY`, a test-mode `sk_test_` or restricted
     `rk_test_` key. Live keys are refused (see
     [Approvals and safety](#approvals-and-safety)).
   - **HubSpot.** `HUBSPOT_ACCESS_TOKEN`, a private-app token with CRM read
     and write access for contacts, companies, deals, notes and tasks, plus
     `crm.objects.owners.read` for the owners lookup. HubSpot's official MCP
     server (`@hubspot/mcp-server` 0.4.x, installed with the other
     dependencies) runs over stdio with it, and the owners lookup calls
     HubSpot's REST API with the same token. HubSpot ends creation of legacy
     private apps on 2026-10-26.

4. In the app, open **Settings** and fill in the company profile, the
   internal email domains (recipients and attendees outside them are
   external), any shared Google calendars the company owns (apart from your
   primary calendar and calendars whose id is an internal address, every
   calendar that is not listed counts as external), the Slack notices
   channel and the channels the agent may post to without asking, and the
   time zone. The time zone sets the business date ("today", with its
   weekday; always the current date there, with no override) and the zone of
   the times the Stripe tools return.

Without `ANTHROPIC_API_KEY` the app says so and offers no job to start. The
server checks every configured connection read-only in the background when
it starts; until its check finishes, a connection shows as not checked yet.

## Running

| Command | What it runs |
|---|---|
| `pnpm dev` | The API server on 127.0.0.1:4320 (`tsx watch`) and Vite on http://127.0.0.1:4321, which proxies `/api` to the server. Open port 4321; port 4320 answers only the API (and a page pointing to 4321). |
| `pnpm build && pnpm start` | Builds the web app into `dist/web` and the server and CLI into `dist/`, then serves the API and the built app on http://127.0.0.1:4320. |
| `node dist/cli/main.js ask "…"` | The headless CLI (after `pnpm build`); see [Command line](#command-line). |

The server listens on 127.0.0.1 only; `PORT` changes the port. The server and
the CLI share the state directory (`AGENT_STATE_DIR`, default `./data`), so
CLI conversations and runs appear in the app with source `cli`.

### Synthetic Tool demo

Revenue Desk also has an explicit, local [Firedrill demo mode](docs/FIREDRILL_DEMO.md).
It runs the same agent and approval gateway against six synthetic Tools without
connecting real provider accounts. The regular commands above are unchanged;
synthetic mode starts only with `pnpm demo:firedrill`.

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
exits within about 1.5 seconds, also when it arrives while the CLI is still
starting; a second signal skips the wait. The exception
is a write that is already executing (a refund, invoice, payment or post):
the CLI says so on stderr and waits for its answer, at most about 70 seconds,
because it may already be applied; a second signal stops waiting, and the
write is recorded as `outcome_unknown` with its idempotency key. No work
continues after the output is written.

Examples:

```sh
node dist/cli/main.js ask "Which customers were charged twice this month?"
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
| `internal_write` | Gmail drafts and labels (other than Trash and Spam), HubSpot notes, tasks and other CRM records, Slack posts to allowlisted channels that do not notify everyone (`@channel`, `@here`, `@everyone`, also inside Markdown emphasis such as `*@here*`, or a user group), Slack reactions outside direct messages and shared channels, calendar events on an internal calendar (your primary one, one whose id is an internal address, or a listed company calendar) whose attendees are all internal, creating a QuickBooks customer without an opening balance | automatic |
| `outbound` | Sending or replying to email, calendar events with an external attendee or on a calendar that is not internal, an update of an event whose current guests the run has not read (an update replaces the guest list), Slack posts to any other channel, a direct message (including a post addressed to a person's user id), a channel shared with another organisation, a channel id the run has not seen named, or a post that notifies everyone; a Slack reaction in a direct message or a shared channel | asks |
| `financial` | Stripe refunds and subscription cancellations; creating a QuickBooks invoice, recording a QuickBooks payment, and creating a QuickBooks customer with an opening balance | asks |
| `destructive` | Adding the Trash or Spam label to a Gmail message | denied |

- **Changing the policy.** The Settings screen saves a mode per class.
  `AGENT_POLICY` (JSON, for example `{"financial":"deny"}`) overrides it and
  locks those classes in the app. The CLI's `--policy` overrides both for one
  run.
- **Approval cards** show the exact consequence and its facts, naming
  records by what the systems returned earlier in the same run rather than
  by internal ids. For example:
  - "Refund $490.00 to <customer> on Stripe charge ch_…", with
    the charge's amount, date and description, what was already refunded
    (this run's refunds included), and a "Check" line first when the refund
    is more than what is left;
  - "Send the Gmail draft to <recipient>", with To, Cc, Bcc,
    subject, thread and body of the draft the run created (a draft the run
    did not create says its recipients could not be confirmed);
  - "Record a $1,980.00 payment from <customer> against invoice 1051",
    with any credit memo it applies, flagged when it exceeds the invoice's
    open balance or the invoice belongs to another customer;
  - "Create a $18,000.00 invoice for <customer> (not sent)",
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
  `xox…`, `pat-`, Composio's `ak_`) from logs, stored rows, streamed output and CLI output.
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
| `tool_calls` | The action log: one row per tool call with its connection type, operation, class, decision, redacted input, compacted output, error, the provider's HTTP status (successes included) and, for a Stripe write, the idempotency key it sent. |
| `approvals` | One row per approval request with its facts, status, who decided, reason and expiry. |

Migrations (`src/db/migrations`, `0000` to `0006`) are applied when the
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

Nothing in the tests stands in for a service, the model or a business.
Unit tests check Revenue Desk's own logic with the smallest input it needs;
everything that talks to a service or to the model runs against the real one,
in the opt-in live suites.

| Command | What it covers | Tests (2026-09-29) |
|---|---|---|
| `pnpm test` | Vitest, no network and no model: configuration and redaction (the pinned vendor hosts, removed variables ignored, the private-network check on Composio's endpoints and sign-in links, and the real Composio SDK reaching only Composio's host); contracts and the database schema; the policy engine and the approval gate; the classifiers and the approval cards they build; input rules and schema validation (every captured HubSpot and Composio schema compiles); Stripe form encoding and error normalisation; the event-to-stream mapping; security guards; database repositories, run ownership and recovery on a real SQLite file; the web client's libraries; the CLI's arguments, settings and output. Where a unit needs a caller or an answer, its test gives it the smallest one in place: an in-process stub of the agent core or of an integration definition, a `fetch` that answers what the test says, or a minimal MCP server in memory. None is shared between tests or copies a vendor's service, and no test points Revenue Desk's configuration at a local server (there is no host to configure). It also starts the real `@hubspot/mcp-server` over stdio (with the network blocked), the real Vite dev server, and the CLI's run start against a real database. | 905 in 81 files |
| `pnpm test:cli` | The built CLI (`dist/cli/main.js`) as a separate process, for everything it decides before a model call: the shebang, help and version; usage errors (exit 2, nothing on stdout); configuration errors (exit 3, one `--json` summary, no database written); `DOTENV_PATH`; an unknown conversation and one whose run belongs to another live process; SIGTERM, SIGINT and `--timeout-ms` before a run starts, including a SIGINT while the CLI is still loading; no key in any output. Run `pnpm build` first. | 18 |
| `pnpm test:e2e` | Playwright against the built app with the real configuration (`DOTENV_PATH`, default `.env`) and a fresh database in the system temp directory, in the installed Google Chrome on desktop and phone viewports. The new chat; every screen in light and dark; phone touch targets; reduced motion; the conversation rail; Runs; that the browser loads nothing from another host; Connections showing exactly the states the server checked, with Connect and Check where they apply (Check is clicked; Connect is not, because it starts a real sign-in); Settings saved and read back, with an empty company name flagged only once the profile is edited; and a second, unconfigured server that says it cannot run and offers no job. Every screen is checked with axe, and on the phone for sideways scrolling. No test starts a job. Run `pnpm build` first. The app starts on port 4320, which must be free, or on `E2E_PORT` when set (for example beside a Revenue Desk already on 4320). | 29, plus 1 skipped (touch targets run on the phone only) |
| `pnpm typecheck`, `pnpm lint` | TypeScript and Biome. | |
| `pnpm verify` | Typecheck, lint, `pnpm test`, the build, `pnpm test:cli` and `pnpm test:e2e`. | |
| `LIVE_E2E=1 pnpm test:live` | The real model and the real accounts, read-only: see [Live tests](#live-tests). | 16 |
| `LIVE_E2E=1 pnpm test:live:ui` | The chat in the browser with the real model and the connected Gmail. | 2 |
| `LIVE_E2E=1 LIVE_E2E_WRITES=1 pnpm test:live:writes` | Real changes, on test-safe targets only. | 5 |

`pnpm build` warns that the chat screen's JavaScript chunk is larger than
500 kB; the build succeeds.

### Live tests

The live suites are not part of `pnpm verify`. Each refuses to start without
`LIVE_E2E=1` (and the write suite also without `LIVE_E2E_WRITES=1`), because
they call the real Anthropic API, cost money and use real accounts.

- **Configuration.** Keys come from the file `DOTENV_PATH` names (default this
  repository's `.env`, which git ignores) and are never printed. Each run
  gets an explicit environment with the model key and the variables of the
  systems under test only.
- **What is not connected is skipped, never faked.** Before each test the
  connections are checked read-only, as **Check** does. A system that is not
  connected or not configured is skipped with the reason and what to do, for
  example "Slack needs sign-in (needs_auth): Slack is not connected. Click
  Connect in Connections to sign in." or "HubSpot is not configured: set
  HUBSPOT_ACCESS_TOKEN in …/.env."
- **`LIVE_REQUIRE` turns those skips into failures.** Set it to a
  comma-separated list of integration ids (`gmail`, `google_calendar`,
  `hubspot`, `stripe`, `quickbooks`, `slack`) or to `all`. A listed
  integration whose test cannot run (not configured, not connected, or in
  the write suite no test-safe target, such as an unset
  `LIVE_SLACK_TEST_CHANNEL` or a HubSpot account that is not a test
  account) fails with the reason instead of skipping, for example
  `LIVE_E2E=1 LIVE_REQUIRE=gmail,stripe pnpm test:live`. Unset, nothing is
  required and a partial setup still runs. An id that is not an integration
  fails the suite before anything runs. It applies to `pnpm test:live`,
  `pnpm test:live:ui` (Gmail) and `pnpm test:live:writes`.
- **Real data stays out of the output.** Tests print states, counts, tool
  names and cost only. Set `LIVE_OUT_DIR` to a directory outside the
  repository to keep each run's state directory, summary and stderr (and the
  browser suite's artifacts) there for review; otherwise they go to a
  temporary directory.

Read-only (`LIVE_E2E=1 pnpm test:live`, `test/live`):

- `connections.test.ts`, without the model: every integration's check ends
  in a definite state, and each connected integration answers one read
  through the product's run gateway, the same MCP servers the model calls
  (Gmail labels, Calendar events, QuickBooks company info, Slack channels,
  HubSpot account details, Stripe balance). A read-only policy opens a
  read-only Composio session, which offers no write tool.
- `read-only.test.ts`: for each of the six systems, the real model answers a
  question from the headless CLI with every class except `read` denied and
  a $0.50 cap. It asserts that the run completed, at least one read of that
  system ran, nothing else ran, the database agrees and the cost stayed
  under the cap.
- `cli.test.ts`, the model without any integration: the reply on stdout and
  the status line on stderr; `--json` continuing the conversation; the app
  listing both runs as the CLI's; SIGTERM mid-run (exit 130 within 2
  seconds); and a CLI killed with SIGKILL, whose conversation the next
  invocation recovers.

In the browser (`LIVE_E2E=1 pnpm test:live:ui`,
`test/e2e-ui/chat.live.spec.ts`, desktop): a read-only question answered
from Gmail (tool rows, the answer, the inspector, the run's cost, and on the
server only reads); and an approval card for a Gmail draft (internal writes
set to ask) that names the recipient and is denied with the keyboard alone,
so nothing is created. This suite keeps no trace, screenshot or HTML report.

Writes (`LIVE_E2E=1 LIVE_E2E_WRITES=1 pnpm test:live:writes`,
`test/live/writes`), each on a test-safe target only, removing what it made
where the API allows:

- **Stripe**, test mode only (an `sk_test_` or `rk_test_` key that Stripe
  reports as test mode): the test creates a customer and a PaymentIntent
  confirmed with `pm_card_visa`; the agent refunds that charge with financial
  actions set to auto; the test checks there is exactly one refund, sent with
  an idempotency key, then deletes the customer (Stripe keeps test payments
  and refunds).
- **Gmail**: a draft to the connected account's own address, with drafts
  allowed and nothing outbound (the session offers no send tool); deleted
  afterwards.
- **Slack**: one post to the channel named in `LIVE_SLACK_TEST_CHANNEL`, the
  workspace's only allowlisted channel; deleted afterwards. Skipped when the
  variable is not set (a failure with `slack` in `LIVE_REQUIRE`).
- **HubSpot**: only when HubSpot reports the account as a developer test
  account or a sandbox; a task, deleted afterwards.
- **QuickBooks**: only when every active QuickBooks account of the Composio
  user has `https://sandbox-quickbooks.api.intuit.com` as its base URL; a
  customer, which stays in the sandbox company (QuickBooks does not delete
  customers). With Composio's own Intuit app (a real or trial company) the
  test refuses.

Last run (2026-09-29): `pnpm test:live` 8 passed and 8 skipped (Google
Calendar, QuickBooks and Slack need sign-in; HubSpot is not configured), with
Gmail and Stripe read by the model; `pnpm test:live:ui` 2 passed. The write
suite has not been run.

## Configuration

Configuration comes only from environment variables, read once at start
(`.env.example` lists them in this order).

<!-- env-table:start: generated from src/contracts/env.ts by test/unit/readme.test.ts -->
| Variable | Group | Secret | Meaning |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Model | yes | Required to run the agent. |
| `AGENT_MODEL` | Model |  | Model id. Default claude-sonnet-5. No silent fallback. |
| `AGENT_EFFORT` | Model |  | low, medium, high, xhigh or max. Default medium. |
| `AGENT_THINKING_DISPLAY` | Model |  | summarized or omitted. Default summarized in the UI, omitted in the CLI. |
| `AGENT_MAX_TURNS` | Model |  | Turn limit per run. Default 30. |
| `AGENT_MAX_BUDGET_USD` | Model |  | Spend limit per run in USD. Default 2.00. |
| `PORT` | Runtime |  | API server port, always bound to 127.0.0.1. Default 4320. |
| `AGENT_STATE_DIR` | Runtime |  | Database, work directory and Claude config. Default ./data (git-ignored). |
| `AGENT_POLICY` | Runtime |  | JSON approval modes per action class, e.g. {"financial":"deny"}. Locks them. |
| `AGENT_APPROVAL_TIMEOUT_MS` | Runtime |  | How long a pending approval waits before it is denied. Default 900000. |
| `DOTENV_PATH` | Runtime |  | An env file outside the repository to load at start. |
| `COMPOSIO_API_KEY` | Composio (Gmail, Google Calendar, QuickBooks, Slack) | yes | Composio project key. Gmail, Google Calendar, QuickBooks and Slack need it. |
| `COMPOSIO_USER_ID` | Composio (Gmail, Google Calendar, QuickBooks, Slack) |  | The Composio user whose connections are used. No default in code. |
| `HUBSPOT_ACCESS_TOKEN` | HubSpot | yes | Private-app token for HubSpot's official @hubspot/mcp-server 0.4.x, run over stdio. |
| `STRIPE_SECRET_KEY` | Stripe | yes | sk_test_/rk_test_ key. Live keys are refused unless ALLOW_LIVE_STRIPE=1. |
| `ALLOW_LIVE_STRIPE` | Stripe |  | Set to 1 to accept a live Stripe key. |
| `STRIPE_API_VERSION` | Stripe |  | Stripe-Version header. Default: the account's version. |
<!-- env-table:end -->

`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and `CLAUDE_CODE_MAX_RETRIES` are
passed to the Claude CLI child process when set, and are otherwise unused.

No variable chooses a service's host (see [How it connects](#how-it-connects)).
Variables that earlier builds read are ignored if still set:
`COMPOSIO_BASE_URL`, `STRIPE_API_BASE_URL`, `HUBSPOT_API_BASE_URL`,
`HUBSPOT_MCP_URL`, `HUBSPOT_MCP_TOKEN` and `AGENT_BUSINESS_DATE`. The
Composio SDK's own `COMPOSIO_BASE_URL` and user config file are overridden
too: Revenue Desk always gives it Composio's host.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The CLI exits 3 with "ANTHROPIC_API_KEY is not set" | The key is in neither the environment nor the `DOTENV_PATH` file. Check that `DOTENV_PATH` is exported in the shell that runs the command. |
| "DOTENV_PATH names …, which could not be read" | The path is wrong or the file is not readable by you. A relative path resolves against the current directory. |
| An integration shows **Not configured** | Connections lists the missing variable names. Add them to the file `DOTENV_PATH` names and restart the server: configuration is read only at start. |
| Stripe shows **Invalid configuration** | A live key (`sk_live_`, `rk_live_`) is configured. Use a test key. |
| Gmail, Google Calendar, QuickBooks or Slack needs sign-in or has expired | Click **Connect** in Connections, finish the Composio sign-in, then **Check**. Until then its tools are not offered and the agent says so. |
| QuickBooks shows another company's data, or none | Composio uses the QuickBooks company chosen when you connected. Connect again and pick the company you mean. Composio's own Intuit app reaches real and trial companies, not an Intuit sandbox company. |
| Gmail, Google Calendar, QuickBooks and Slack all say "Composio rejected the API key" | `COMPOSIO_API_KEY` is wrong or was revoked. Put a current Composio project key in the file `DOTENV_PATH` names and restart Revenue Desk. |
| HubSpot is unavailable at the start of a run | HubSpot's MCP server could not start (run `pnpm install`; only `@hubspot/mcp-server` 0.4.x is launched) or HubSpot rejected the token. Check `HUBSPOT_ACCESS_TOKEN`, then **Check** in Connections. |
| Connect or a run says Composio returned a sign-in link or session MCP URL that "points at this machine or a private network" (or "is not HTTPS") | Revenue Desk refused it and opened or connected to nothing. Composio's own answers are HTTPS on public hosts, so something on the network answered for `backend.composio.dev` (a filtering proxy, or DNS that resolves it elsewhere). Fix the network, then **Check** or **Connect** again. |
| A run fails with `model_error` | The model id is wrong or unavailable to your key, or the API failed. Revenue Desk never switches models; set `AGENT_MODEL` or `--model`. |
| A run fails with `max_turns` or `budget_exceeded` | Raise `AGENT_MAX_TURNS` or `AGENT_MAX_BUDGET_USD`, or `--max-turns` and `--max-budget-usd` for one CLI run. |
| An action was "blocked by policy" in the CLI | Its class is `ask` and the CLI cannot ask. Run it in the app, or allow the class for one run with `--policy`. |
| The CLI exits 2 for `--conversation` | The id is not in this state directory, or the conversation has an active run in the app; wait for it or stop it. |
| An approval disappeared as "expired" | The server restarted while it was pending, or `AGENT_APPROVAL_TIMEOUT_MS` passed. Ask again. |
| A run failed with `server_restart` | The process running it exited mid-run (a crash, a restart, a CLI killed with SIGKILL). Revenue Desk failed it so the conversation is free again; its pending approvals expired. Ask again. |
| "Revenue Desk is shutting down and starts no new run" (503) | The server received SIGINT or SIGTERM. Start it again. |
| A call was rejected before it ran (`is missing "hs_timestamp"`, `is empty`, `mentions …, which is not a Slack user id`, `/Amount is needed`) | Revenue Desk checked a rule the system enforces or a formatting rule, and nothing reached the system. The agent is told what to fix, so it can repeat the call corrected. |
| HubSpot owners show as ids | The owners lookup needs the token's `crm.objects.owners.read` scope. Add it to the private app and **Check** again. |
| Dates or aging are off by a day | The business date is always today in the Settings time zone; there is no fixed-date override. Set the time zone in **Settings**. |
| "address already in use" on 4320 or 4321 | Another process holds the port. Stop it, or set `PORT` (the Vite proxy expects 4320). |
| Every run fails before the model answers | One cause: optional dependencies were skipped, and the Claude Agent SDK's native binary comes from an optional per-platform package. Run `pnpm install` again without `--no-optional`. |
| `pnpm test:e2e` cannot find a browser, or port 4320 is in use | The suite uses the installed Google Chrome, and never reuses a server already on its port: stop the Revenue Desk server on 4320, or run the suite on another port with `E2E_PORT=4330 pnpm test:e2e`. Run `pnpm build` before the suite. |
| A live test is skipped | Its system is not connected or not configured; the skip names it and what to do (Connect in Connections, or the variable to set). To make such a test fail instead, list the integration in `LIVE_REQUIRE`. |
| A live test fails with "… is required by LIVE_REQUIRE but cannot be tested" | `LIVE_REQUIRE` lists that integration and its test could not run; the rest of the message says why and what to do. Connect or configure it, or remove it from `LIVE_REQUIRE`. |

This is a public reference example. Revenue Desk's original code currently has
no license grant; review that before copying or redistributing it. Third-party
UI components retain the licenses in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
