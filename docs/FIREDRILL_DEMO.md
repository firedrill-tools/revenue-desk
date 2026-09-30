# Revenue Desk with Firedrill Tools

This is an opt-in local demo composition. Revenue Desk's agent and web app run on
your computer; Gmail, Calendar, QuickBooks, Slack, HubSpot and Stripe are
synthetic Tools running in Firedrill. The normal `pnpm dev`, `pnpm start` and
`revenue-desk ask` paths still use Revenue Desk's ordinary integrations. No
provider account or provider API key is used by this demo command.

## Start the demo

Install dependencies with `pnpm install`. Sign in with the Firedrill CLI once
(`pnpm exec firedrill login`); the demo launcher uses that existing login.
Create a file outside this repository containing only `ANTHROPIC_API_KEY`, or
provide that variable in your shell. Never put the key or a world credential
in this repository.

The prepared demo project has two ready Tool setups. The first contains Gmail,
Google Calendar, QuickBooks, Slack and HubSpot. Stripe is in the second setup
because the current QuickBooks and Stripe Tool packages both declare the MCP
aliases `create_customer` and `create_invoice`; the six-package world build
rejects that collision. Revenue Desk joins the two actor-scoped connections
locally. This is one agent with six synthetic integrations, **not** a claim that
one Firedrill test case covers both worlds.

```sh
export FIREDRILL_DEMO_PROJECT_ID=prj_1ba42b556f01c8adf7ca0a19
export FIREDRILL_DEMO_CORE_ENVIRONMENT_ID=env_50dccd8236fedad96cc557b5
export FIREDRILL_DEMO_STRIPE_ENVIRONMENT_ID=env_29b27458d2448d1b7c5c0824
export REVENUE_DESK_MODEL_ENV_PATH=/absolute/path/to/model-only.env
pnpm demo:firedrill
```

Open [the local Revenue Desk app](http://127.0.0.1:4321). The **Synthetic
Tools** label confirms this composition. Open **Connections** to see all six
connections pointing to `world.firedrill.run`. Chat with Revenue Desk normally;
its existing agent, gateway, policy checks, approvals and run history remain in
use. A separate demo state directory keeps these conversations out of ordinary
Revenue Desk data.

For a repeatable headless run, use the same exports and pass Revenue Desk's
existing `ask` command through the launcher:

```sh
pnpm demo:firedrill ask --json \
  --policy '{"internal_write":"deny","outbound":"deny","financial":"deny","destructive":"deny"}' \
  'Read the synthetic Gmail inbox, Stripe balance and QuickBooks company info. Do not change anything.'
```

The launcher resumes paused Tool compute when necessary, requests fresh
actor-scoped credentials, builds locally, and starts the app or command. It
passes only the model key and synthetic bindings to Revenue Desk; real
Composio, HubSpot and Stripe credentials are rejected. The world credentials
expire after at most one hour. Restart the command to renew them. The reusable
Tools retain their state across compute pauses; restarting the local agent
does not reset them. Use Ctrl-C to stop the local app.

## Run saved tests and simulations

The repository also has two saved read-only test setups. They derive from the
same selected Tools but allocate **fresh case-scoped state** for each run, so
the test adapter does not borrow a reusable demo credential. The five-Tool
setup has an inbox-reading test and an accounting-company test; the Stripe
setup has a balance-reading test. Their source is in
[`firedrill.core.tests.json`](../firedrill.core.tests.json) and
[`firedrill.stripe.tests.json`](../firedrill.stripe.tests.json). Each check
requires an observed successful Tool operation. A completed model reply by
itself does not pass a check.

```sh
export FIREDRILL_DEMO_PROJECT_ID=prj_1ba42b556f01c8adf7ca0a19
export FIREDRILL_DEMO_CORE_TEST_SETUP_ID=setup_aa6ebe3e885ddbd15da0329c
export FIREDRILL_DEMO_STRIPE_TEST_SETUP_ID=setup_08de323e7adcf377942cbdcc
export REVENUE_DESK_MODEL_ENV_PATH=/absolute/path/to/model-only.env
pnpm demo:firedrill:test
```

Pass `core` or `stripe` after the command to run one setup. The script builds
Revenue Desk, invokes the installed Firedrill CLI, and prints the Results link.
It needs your Firedrill CLI login; it forwards the model key but no real
provider keys. The command target receives only its case's scoped HTTP/MCP
binding and runs Revenue Desk's actual agent and approval gateway. It denies
all write classes for these read-only tests. The target returns an execution
result; Firedrill, not the agent, evaluates the saved assertions. For repeated
or parallel independent cases, use the same saved setups and command target in
the Firedrill Simulator or a `firedrill run` batch; see the
[simulation guide](https://docs.firedrill.run/guides/simulations).

The prepared account currently allows two concurrent Tool sessions. The two
ready reusable demo environments occupy both slots, so a fresh isolated test
case cannot start at the same time. Before running the saved tests, stop the
local demo and suspend the reusable environments; suspension keeps their data.
After testing, wake both and restart `pnpm demo:firedrill` to obtain fresh
credentials:

```sh
pnpm exec firedrill environment suspend --project "$FIREDRILL_DEMO_PROJECT_ID" --environment "$FIREDRILL_DEMO_CORE_ENVIRONMENT_ID" --wait
pnpm exec firedrill environment suspend --project "$FIREDRILL_DEMO_PROJECT_ID" --environment "$FIREDRILL_DEMO_STRIPE_ENVIRONMENT_ID" --wait
pnpm demo:firedrill:test core
pnpm demo:firedrill:test stripe
pnpm exec firedrill environment wake --project "$FIREDRILL_DEMO_PROJECT_ID" --environment "$FIREDRILL_DEMO_CORE_ENVIRONMENT_ID" --ttl-ms 7200000 --wait
pnpm exec firedrill environment wake --project "$FIREDRILL_DEMO_PROJECT_ID" --environment "$FIREDRILL_DEMO_STRIPE_ENVIRONMENT_ID" --ttl-ms 7200000 --wait
```

These commands are separate rather than hidden inside the test launcher:
pausing a shared Tool connection may interrupt someone using the live demo.
If a runner stops while the batch is finishing, use the `resume` subcommand
with the relative recovery file printed by Firedrill. It reads the original
request and does not repeat an uncertain agent invocation:

```sh
pnpm demo:firedrill:test resume .firedrill/cloud/simulation-<printed-id>.json
```

The first attempted managed Stripe test on 2026-09-30 queued for capacity and
expired before the agent target started; it was cancelled. After pausing both
reusable sessions, the [core batch](https://app.firedrill.run/app/results/simulations/cisuite_f1d9f89ac7f46ff0cfd38888?project=prj_1ba42b556f01c8adf7ca0a19)
sealed with **2 passed, 0 failed**, and the
[Stripe batch](https://app.firedrill.run/app/results/simulations/cisuite_38c2d3a365d8db4d8aa34eb1?project=prj_1ba42b556f01c8adf7ca0a19)
sealed with **1 passed, 0 failed**. The core CLI wait lost its final receipt
during cleanup; resuming its saved request returned the sealed verdict without
rerunning either case. Both reusable sessions were then woken and confirmed
ready again.

The two setups cannot form one six-Tool isolated case while the Tool aliases
collide. Thus a combined cross-provider verdict is not currently claimed.
You can still demonstrate all six in the reusable local-agent flow above.

## Show the Tool apps

In the Firedrill portal, open the ready reusable Tool connection, select the
acting identity, then choose a Tool under **Open a Tool's app** and **Get app
link**. The issued browser link is short-lived; the Tool's app and its API/MCP
operations share the same synthetic state. Open the Gmail app before and after
an agent action to show that shared state. Do not publish or bookmark an issued
link as a permanent customer URL. See the
[Tool app guide](https://docs.firedrill.run/guides/tool-apps).

## What is verified, and what is not

On 2026-09-30, the local web agent completed a Gmail inbox read and message
open, then read Calendar, QuickBooks, Slack, HubSpot and Stripe through its
normal tool gateway. The headless agent separately read synthetic Stripe and
QuickBooks successfully. The first Calendar call used an unsupported
`maxResults` argument; the Tool rejected it and the agent retried with the
declared schema. These are actual agent calls, not a connection-only check.

Each Tool's starter data is an independent fictional account. Customer emails
and organizations do **not** line up across the six packages. You can show
each integration and its browser app, but a cross-system billing inquiry,
refund or handoff is not a meaningful passing test until you save coherent
per-Tool datasets and select those exact revisions in a test setup. Do not
present a model's cross-system narrative as a verified Firedrill verdict. The
[dataset guide](https://docs.firedrill.run/guides/saved-datasets) explains
versioned data and resets; the [test guide](https://docs.firedrill.run/guides/run-first-drill)
explains case-scoped runner bindings and observable checks. The reusable demo
launcher connects Tools and does not itself report a test verdict; use the
separate saved-test command above for that.

For date-sensitive work, Revenue Desk uses the local process date while the
Tools use Firedrill's virtual time. The prepared starter worlds begin in
mid-September 2026. Use explicit dates in demo prompts; do not claim that
advancing Tool time also changed the agent's clock.

## Demo prompts

Start with a read-only question: “List my synthetic Gmail inbox and summarize
the most recent billing message. Do not change anything.” Then ask Revenue
Desk to check the connected Calendar, QuickBooks, Slack, HubSpot and Stripe
accounts. In **Runs**, show the actual Tool calls and their outcomes. In the
Firedrill app, inspect the corresponding Tool setup and its recorded activity.
The two products show different sides of the same call: Revenue Desk shows
agent reasoning, approvals and tool use; Firedrill shows the synthetic Tool
state and activity.

Writes should be demonstrated only after inspecting the target record and
approval policy. Keep financial and outbound actions on `ask` or `deny` for a
read-only demo. A successful model reply is not a substitute for checking the
Tool's resulting state.
