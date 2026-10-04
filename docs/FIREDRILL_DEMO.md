# Try Revenue Desk with Firedrill

Run Revenue Desk's existing agent and UI on your computer while synthetic Gmail,
Google Calendar, QuickBooks, Slack, HubSpot and Stripe run in Firedrill. This is
an explicit test mode: ordinary `pnpm dev`, `pnpm start` and `revenue-desk ask`
still use real services.

You need Node.js 22.22.3+, pnpm 9.15.4, a Firedrill account and your Anthropic API
key. Synthetic integrations do not need Composio OAuth or real vendor keys.
**The model still uses your Anthropic account and incurs usage.**

## Install and create your own Tools

```sh
git clone https://github.com/firedrill-tools/revenue-desk.git
cd revenue-desk
pnpm install --frozen-lockfile
pnpm build
pnpm exec firedrill init
```

During `init`, create or select your project, then choose **Gmail**, **Google
Calendar**, **QuickBooks**, **Slack** and **HubSpot**, starter data and a
persistent connection. Keep the project, ready setup and environment IDs.
If you already initialized, select the same project and use `tools add`.

Add **Stripe** in a second persistent setup:

```sh
pnpm exec firedrill library list
pnpm exec firedrill tools add --tool YOUR_STRIPE_LIBRARY_ID --initial-state starter --use reusable --name "Revenue Desk Stripe" --compute-ttl-ms 7200000 --wait
```

Replace the library ID with Stripe's actual ID from the list. Keep this setup's
ID and environment ID too. The five-Tool setup and Stripe are separate because
the current QuickBooks and Stripe Tools both expose the MCP aliases
`create_customer` and `create_invoice`; a combined build rejects that
collision. The local agent can connect to both, but the saved tests below
evaluate each setup separately. Do not claim one six-Tool isolated case.

Set your own returned values—not example-account IDs:

```sh
export FIREDRILL_DEMO_PROJECT_ID=YOUR_PROJECT_ID
export FIREDRILL_DEMO_CORE_ENVIRONMENT_ID=YOUR_FIVE_TOOL_ENVIRONMENT_ID
export FIREDRILL_DEMO_STRIPE_ENVIRONMENT_ID=YOUR_STRIPE_ENVIRONMENT_ID
```

Provide `ANTHROPIC_API_KEY` in your shell through your normal secret manager.
Alternatively, set `REVENUE_DESK_MODEL_ENV_PATH` to a private file outside this
repository containing only `ANTHROPIC_API_KEY`. Do not use a production-service
credential file for this test mode.

## Use the agent manually

```sh
pnpm demo:firedrill
```

Open http://127.0.0.1:4321. **Synthetic Tools** identifies this mode.
**Connections** shows the six synthetic connections. Start with:

> List my synthetic Gmail inbox and summarize one message. Do not change anything.

Then ask it to read the Stripe balance or QuickBooks company information.
Revenue Desk's normal gateway, approval policy and local run history remain
active. The launcher starts or resumes paused Tool compute as needed, issues
short-lived `local-dev` actor bindings, and forwards the model key and these
bindings—not real Composio, HubSpot or Stripe credentials.

The starter setups use the `local-dev` actor expected by this adapter. The
credentials last at most an hour; restart the launcher to refresh them. Compute
and credential lifetimes are separate. Pausing preserves Tool data, and
restarting your agent does not reset it. Stop the local app with Ctrl-C.

A headless read-only task uses the same connections:

```sh
pnpm demo:firedrill ask --json \
  --policy '{"internal_write":"deny","outbound":"deny","financial":"deny","destructive":"deny"}' \
  'Read the synthetic Gmail inbox, Stripe balance and QuickBooks company info. Do not change anything.'
```

Open the corresponding Tool instance in Firedrill to see availability, recorded
activity and its **Open app** action when a browser app is available. Its UI,
HTTP and MCP operations use the same seeded state. Issued Tool-app links are
short-lived access links, not permanent public URLs.
[Tool apps](https://docs.firedrill.run/guides/tool-apps)

## Save and run the supplied tests

The files `firedrill.core.tests.json` and `firedrill.stripe.tests.json` define
three read-only tasks: list and open email, read accounting company info, and
read a Stripe balance. Assertions require successful observed operations; a
convincing model reply cannot pass them.

Derive a test setup from each original ready setup:

```sh
pnpm exec firedrill tools add --from-setup YOUR_FIVE_TOOL_SETUP_ID --tests firedrill.core.tests.json --wait
pnpm exec firedrill tools add --from-setup YOUR_STRIPE_SETUP_ID --tests firedrill.stripe.tests.json --wait
```

These commands save new immutable setups. They do not modify your original
connections or execute the agent. Set the **new** returned setup IDs:

```sh
export FIREDRILL_DEMO_CORE_TEST_SETUP_ID=YOUR_NEW_CORE_TEST_SETUP_ID
export FIREDRILL_DEMO_STRIPE_TEST_SETUP_ID=YOUR_NEW_STRIPE_TEST_SETUP_ID
pnpm demo:firedrill:test
```

Use `pnpm demo:firedrill:test core` or `stripe` to run one setup. The script
builds the local agent and invokes the published CLI. For each case, the
adapter creates fresh local agent state and receives only its isolated case's
Tool bindings. These read-only tests deny all write categories.

Firedrill retains saved tests, simulation history, verdicts and Tool evidence.
Open the result URL printed by the CLI. For automated-first records without a
reusable source environment, select **All project tests**, **All project
simulations**, or project-wide Results history; do not assume they belong to
Default. [History scope](https://docs.firedrill.run/guides/simulations#history-scope)

If your account's concurrent-session allowance is occupied by reusable
connections, stop the local app and deliberately suspend those environments
before testing. Do not pause a shared connection without coordinating with
its users:

```sh
pnpm exec firedrill environment suspend --environment "$FIREDRILL_DEMO_CORE_ENVIRONMENT_ID" --wait
pnpm exec firedrill environment suspend --environment "$FIREDRILL_DEMO_STRIPE_ENVIRONMENT_ID" --wait
pnpm demo:firedrill:test
```

Run `pnpm demo:firedrill` afterwards to resume those connections. If a CLI wait
is interrupted, paste its printed recovery command, or use the wrapper:

```sh
pnpm demo:firedrill:test resume .firedrill/cloud/simulation-PRINTED_ID.json
```

Keep that ignored recovery file private. Resume follows the original request;
starting again with a new request can repeat uncertain agent work.

## Run simulations with the SDK

The included SDK runner calls `runSimulation` from the same published package.
It invokes the actual Revenue Desk command target and attaches agent outputs
and redacted runner logs. No local world kernel is installed.

Provide a project-scoped `FIREDRILL_CREDENTIAL` from your Firedrill credentials
settings or CLI. Keep the model key in `ANTHROPIC_API_KEY`; unlike the manual
launcher, this script does not load a model-key file.

```sh
pnpm build
pnpm demo:firedrill:sdk core --check
pnpm demo:firedrill:sdk core
pnpm demo:firedrill:sdk stripe
```

`--check` validates the local selection without contacting Firedrill or a
model. It is not an execution proof. Increase independent cases explicitly:

```sh
export FIREDRILL_DEMO_SEEDS='["42","43","44"]'
export FIREDRILL_DEMO_REPETITIONS=2
export FIREDRILL_DEMO_CONCURRENCY=1
pnpm demo:firedrill:sdk core
```

For the two core drills this requests 12 cases. Repetitions and seeds alone do
not create 12 different authored scenarios. Each case can incur model usage;
concurrency is constrained by your Firedrill allowance and provider limits.
Start small. The script prints the simulation's real counts, conclusion and
result link. Recovery checkpoints and receipts stay under ignored
`.firedrill/cto-sdk/`. To recover, use the printed checkpoint:

```sh
pnpm demo:firedrill:sdk core --resume .firedrill/cto-sdk/PRINTED_DIRECTORY/checkpoint.json
```

API/MCP execution does not automatically capture Tool UI screenshots. This
runner records real outputs and logs. Browser evidence requires an explicitly
configured browser test or capture integration.
[SDK simulations](https://docs.firedrill.run/guides/simulations#run-from-the-sdk)

## Run in GitHub Actions

The ordinary CI workflow runs offline checks and a build. **Firedrill drills**
is opt-in. In your own repository, set:

- Variables: `FIREDRILL_PROJECT_ID`, `FIREDRILL_CORE_TEST_SETUP_ID`,
  `FIREDRILL_STRIPE_TEST_SETUP_ID`.
- Secrets: `FIREDRILL_CREDENTIAL` and `ANTHROPIC_API_KEY`.

Run the workflow manually first. Set `FIREDRILL_DRILLS_ENABLED=true` to also
run on trusted main pushes and same-repository PRs. Fork PRs do not receive
credentials or run provider-backed drills. No GitHub App is needed for this
direct CLI workflow. [Revision-bound PR integration](https://docs.firedrill.run/guides/pull-request-ci)

## Data and limits

Starter data is fictional and independent per Tool. The same customer does
not necessarily exist across all six systems. Save coherent datasets before
testing cross-system refunds, collections or handoffs:
[saved datasets](https://docs.firedrill.run/guides/saved-datasets).

The Tool clock is virtual; the agent's process still uses the local date.
Advancing Tool time does not change the agent's clock. For date-sensitive tasks
supply explicit dates and inspect both the task and recorded Tool evidence.

This example keeps the normal agent intact and adds a test-side composition.
It supports the selected operations implemented in `src/firedrill-demo/catalog.ts`,
not every possible upstream service feature. Ordinary real-service setup and
security details remain in the root README.
