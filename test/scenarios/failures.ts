/**
 * Failure scenarios: the jobs with a provider or the model failing, set up on
 * the fakes (or the scripted model) before the run. Each says how the run
 * must end and what the fakes must show afterwards.
 */
import { Checks, HARBOR_PINE } from "./facts.js";
import { J1_PROMPT, J1_STEPS, verifyJ1 } from "./j1-billing-inquiry.js";
import { J4_CLOSED_WON, verifyInvoiceFault } from "./j4-closed-won.js";
import { J5_WEEKLY_DIGEST, verifyDigestPosted } from "./j5-weekly-digest.js";
import { apiError, type Scenario, type Step, text } from "./script.js";
import { stripe } from "./tools.js";

/** A 429 on a read is retried by the client (honouring Retry-After) and the job completes. */
export const FAIL_STRIPE_429: Scenario = {
  ...J5_WEEKLY_DIGEST,
  id: "fail-stripe-429",
  job: "failure",
  title: "Stripe rate-limits a read once; the client retries it",
  arrange: (fakes) => {
    fakes.stripe.faults.rateLimit("/v1/charges", { method: "GET", times: 1, retryAfterSeconds: 1 });
  },
  verify: (fakes) => {
    const checks = new Checks();
    checks.problems.push(...verifyDigestPosted(fakes));
    checks.equal(
      fakes.stripe.http.requestsTo("GET", "/v1/charges").map((entry) => entry.status),
      [429, 200],
      "the rate-limited read was retried once",
    );
    return checks.problems;
  },
};

/** A QuickBooks Fault on the approved invoice: nothing is sent or announced. */
export const FAIL_QUICKBOOKS_FAULT: Scenario = {
  ...J4_CLOSED_WON,
  id: "fail-quickbooks-fault",
  job: "failure",
  title: "QuickBooks answers the approved invoice with a validation Fault",
  arrange: (fakes) => {
    fakes.quickbooks.faults.fault(
      /\/invoice$/,
      {
        code: "6000",
        message: "A business validation error has occurred while processing your request",
        detail: "Business Validation Error: The customer's billing address is incomplete.",
      },
      { method: "POST" },
    );
  },
  approvals: { j4_invoice: "approve" },
  expected: { status: "completed", replyIncludes: ["QuickBooks refused the invoice"] },
  verify: (fakes) => verifyInvoiceFault(fakes),
};

/** Slack answers the digest post with HTTP 200 ok:false. */
export const FAIL_SLACK_NOT_OK: Scenario = {
  ...J5_WEEKLY_DIGEST,
  id: "fail-slack-not-ok",
  job: "failure",
  title: "Slack refuses the post with ok:false",
  arrange: (fakes) => {
    fakes.slack.faults.error("chat.postMessage", "channel_not_found");
  },
  expected: { status: "completed", replyIncludes: ["was not posted", "channel_not_found"] },
  verify: (fakes) => {
    const checks = new Checks();
    checks.equal(fakes.slack.posts().length, 0, "nothing posted");
    checks.equal(
      fakes.slack.http.requestsTo("POST", "/api/chat.postMessage").length,
      1,
      "one post attempt (no retry of a write)",
    );
    return checks.problems;
  },
};

/** HubSpot's MCP server is down at start: HubSpot is unavailable and J1 goes on without it. */
export const FAIL_HUBSPOT_DOWN: Scenario = {
  id: "fail-hubspot-down",
  job: "failure",
  title: "HubSpot's MCP server is down at start",
  prompt: J1_PROMPT,
  steps: J1_STEPS.map(
    (step): Step =>
      (context) => {
        if (context.offersIntegration("hubspot")) {
          context.problem("HubSpot tools are offered although its MCP server is down");
        }
        return step(context);
      },
  ),
  hubspot: "http",
  approvals: { j1_send: "approve" },
  arrange: (fakes) => {
    fakes.hubspot.setMcpAvailable(false);
  },
  expected: { status: "completed", replyIncludes: ["HubSpot was unavailable"] },
  verify: (fakes) => {
    const checks = new Checks();
    checks.problems.push(...verifyJ1(fakes, { sent: true }));
    checks.equal(fakes.hubspot.mcpCalls.length, 0, "no HubSpot tool calls");
    return checks.problems;
  },
};

/** Composio session creation fails: Gmail and Calendar are unavailable for the run. */
export const FAIL_COMPOSIO_SESSION: Scenario = {
  id: "fail-composio-session",
  job: "failure",
  title: "Composio session creation fails",
  prompt: J1_PROMPT,
  steps: [
    (context) => {
      if (context.offersIntegration("gmail"))
        context.problem("Gmail tools are offered although the Composio session failed");
      return [
        text("Gmail is unavailable right now, so I will check Stripe using Dana's address."),
        stripe.findCustomers("jc_customer", { email: HARBOR_PINE.contactEmail }),
      ];
    },
    (context) => [
      stripe.listCharges("jc_charges", {
        customer: context.pick("jc_customer", /(cus_\w+)/, HARBOR_PINE.stripeCustomer),
        created_after: "2026-09-01",
        limit: 10,
      }),
    ],
    () => [
      text(
        `Gmail is unavailable (the Composio session could not be created), so I could not read or answer Dana's email. Stripe shows two $490.00 charges on September 22; ${HARBOR_PINE.duplicateCharge} is the duplicate.`,
      ),
    ],
  ],
  approvals: {},
  arrange: (fakes) => {
    fakes.composio.failSessions({
      status: 403,
      slug: "Project_Suspended",
      message: "This Composio project is suspended.",
    });
  },
  expected: { status: "completed", replyIncludes: ["Gmail is unavailable"] },
  verify: (fakes) => {
    const checks = new Checks();
    checks.equal(fakes.composio.toolCalls.length, 0, "no Gmail or Calendar tool calls");
    checks.equal(fakes.composio.gmail.outbox.length, 0, "no email sent");
    checks.that(
      fakes.composio.requests.some(
        (entry) => entry.path === "/api/v3.1/tool_router/session" && entry.status === 403,
      ),
      "session creation was attempted and refused",
    );
    return checks.problems;
  },
};

/** The Messages API is overloaded (529, no retry): the run fails with model_error. */
export const FAIL_MODEL_529: Scenario = {
  id: "fail-model-529",
  job: "failure",
  title: "The model API answers 529 overloaded",
  prompt: J1_PROMPT,
  steps: [() => apiError(529, "overloaded_error", "Overloaded", { "x-should-retry": "false" })],
  approvals: {},
  expected: { status: "failed", errorCode: "model_error" },
  verify: (fakes) => {
    const checks = new Checks();
    const writes =
      fakes.stripe.writes().length +
      fakes.quickbooks.writes().length +
      fakes.hubspot.writes().length +
      fakes.slack.posts().length +
      fakes.composio.toolCalls.length;
    checks.equal(writes, 0, "nothing reached any integration");
    return checks.problems;
  },
};
