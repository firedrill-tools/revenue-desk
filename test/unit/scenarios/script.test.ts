/**
 * The scenario engine without the SDK: step selection, tool_use id mapping,
 * drift detection against offered schemas, prompt dispatch, and the facts
 * the scripts rely on, checked against the business fixtures.
 */
import { describe, expect, it } from "vitest";
import {
  BLUEFIN,
  COPPERLEAF,
  expectedIdempotencyKey,
  HARBOR_PINE,
  JORDAN,
  MAYA,
  MERIDIAN,
  SOLSTICE,
  TIDEWATER,
} from "../../scenarios/facts.js";
import {
  ALL_SCENARIOS,
  apiError,
  call,
  chooseJob,
  currentPrompt,
  JOB_SCENARIOS,
  logicalCallId,
  promptCount,
  type Scenario,
  sandboxResponder,
  scenarioResponder,
  text,
  toolUseId,
} from "../../scenarios/index.js";
import { J5_DIGEST } from "../../scenarios/j5-weekly-digest.js";
import { loadBusinessFixtures } from "../../support/fakes/fixtures.js";
import type { MessagesBody, ScriptedBlock } from "../../support/mock-anthropic.js";

const refundSchema = {
  type: "object",
  properties: { charge: { type: "string" }, amount: { type: "integer", minimum: 1 } },
  required: ["charge", "amount"],
  additionalProperties: false,
  $schema: "http://json-schema.org/draft-07/schema#",
};

function body(
  messages: MessagesBody["messages"],
  tools = [{ name: "mcp__stripe__create_refund", input_schema: refundSchema }],
): MessagesBody {
  return { model: "claude-sonnet-5", stream: true, tools, messages };
}

const prompt = (value: string) => ({ role: "user", content: [{ type: "text", text: value }] });
const assistant = (id: string) => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "mcp__stripe__create_refund", input: {} }],
});
const result = (id: string, value: string, isError = false) => ({
  role: "user",
  content: [
    {
      type: "tool_result",
      tool_use_id: id,
      content: [{ type: "text", text: value }],
      ...(isError ? { is_error: true } : {}),
    },
  ],
});

const scenario: Scenario = {
  id: "unit",
  job: "J2",
  title: "unit",
  prompt: "Refund it.",
  approvals: {},
  expected: { status: "completed" },
  steps: [
    () => [
      text("step one"),
      call("unit_refund", "mcp__stripe__create_refund", { charge: "ch_1", amount: 5 }),
    ],
    (context) => [
      text(
        `refund ${context.pick("unit_refund", /\b(re_[A-Za-z0-9]+)\b/, "none")} ${context.result("unit_refund")?.isError === true ? "failed" : "ok"}`,
      ),
    ],
  ],
};

describe("scenario responder", () => {
  it("answers step n with the scenario's step and maps logical ids to tool_use ids", () => {
    const responder = scenarioResponder(scenario);
    const first = responder.respond(body([prompt("Refund it.")]), 0) as ScriptedBlock[];
    expect(first).toEqual([
      { type: "text", text: "step one" },
      {
        type: "tool_use",
        id: "toolu_unit_refund",
        name: "mcp__stripe__create_refund",
        input: { charge: "ch_1", amount: 5 },
      },
    ]);
    const second = responder.respond(
      body([
        prompt("Refund it."),
        assistant("toolu_unit_refund"),
        result("toolu_unit_refund", '{"id":"re_RD0001"}'),
      ]),
      1,
    );
    expect(second).toEqual([{ type: "text", text: "refund re_RD0001 ok" }]);
    expect(responder.problems).toEqual([]);
    expect(responder.played.get("unit")).toBe(2);
  });

  it("uses turn-suffixed ids from the second prompt of a conversation on", () => {
    const responder = scenarioResponder(scenario);
    const messages = [
      prompt("Refund it."),
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      prompt("Refund it."),
    ];
    const reply = responder.respond(body(messages), 2) as ScriptedBlock[];
    expect(reply[1]).toMatchObject({ id: "toolu_unit_refund_t2" });
    expect(logicalCallId("toolu_unit_refund_t2")).toBe("unit_refund");
    expect(toolUseId("unit_refund", 3)).toBe("toolu_unit_refund_t3");
  });

  it("records drift: tools that are not offered and inputs the offered schema refuses", () => {
    const drifting: Scenario = {
      ...scenario,
      steps: [
        () => [
          call("bad_args", "mcp__stripe__create_refund", { charge: "ch_1", amount_minor: 5 }),
          call("gone", "mcp__stripe__delete_everything", {}),
          call(
            "meant_invalid",
            "mcp__stripe__create_refund",
            { charge: "ch_1", amount: -1 },
            { expectInvalid: true },
          ),
        ],
      ],
    };
    const responder = scenarioResponder(drifting);
    responder.respond(body([prompt("Refund it.")]), 0);
    expect(responder.problems.map((problem) => problem.message)).toEqual([
      expect.stringMatching(
        /^bad_args: .*missing required property "amount".*unexpected property "amount_minor"/,
      ),
      "gone: mcp__stripe__delete_everything is not offered",
    ]);
  });

  it("reports a missing value and an exhausted script", () => {
    const responder = scenarioResponder(scenario);
    responder.respond(
      body([
        prompt("Refund it."),
        assistant("toolu_unit_refund"),
        result("toolu_unit_refund", "boom", true),
      ]),
      1,
    );
    responder.respond(
      body([
        prompt("Refund it."),
        assistant("toolu_unit_refund"),
        result("toolu_unit_refund", "x"),
        { role: "assistant", content: [{ type: "text", text: "t" }] },
      ]),
      2,
    );
    expect(responder.problems.map((problem) => problem.message)).toEqual([
      expect.stringContaining("unit_refund: /\\b(re_[A-Za-z0-9]+)\\b/ not found"),
      "the script has 2 steps but the agent asked for step 3",
    ]);
  });

  it("passes API errors through and answers side requests (no tools) with the default", () => {
    const failing = scenarioResponder({
      ...scenario,
      steps: [() => apiError(529, "overloaded_error", "Overloaded", { "x-should-retry": "false" })],
    });
    expect(failing.respond(body([prompt("Refund it.")]), 0)).toEqual({
      httpStatus: 529,
      errorType: "overloaded_error",
      message: "Overloaded",
      headers: { "x-should-retry": "false" },
    });
    expect(failing.respond({ model: "m", messages: [prompt("title please")] }, 1)).toBeUndefined();
  });

  it("reads the user's prompt, ignoring system reminders, and counts prompts", () => {
    const request = body([
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>ctx</system-reminder>" },
          { type: "text", text: "Refund it." },
        ],
      },
    ]);
    expect(currentPrompt(request)).toBe("Refund it.");
    expect(promptCount(request)).toBe(1);
  });
});

describe("the sandbox's scripted model", () => {
  it("maps exact prompts and keywords to J1–J5 and explains itself otherwise", () => {
    for (const job of JOB_SCENARIOS) expect(chooseJob(job.prompt)).toBe(job);
    expect(chooseJob("please refund the duplicate for Harbor & Pine")?.id).toBe(
      "j2-refund-duplicate",
    );
    expect(chooseJob("what is overdue?")?.id).toBe("j3-collections");
    expect(chooseJob("write the weekly digest")?.id).toBe("j5-weekly-digest");
    expect(chooseJob("hello")).toBeUndefined();
    const responder = sandboxResponder();
    const reply = responder.respond(body([prompt("hello")]), 0) as ScriptedBlock[];
    expect(reply[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("scripted model"),
    });
  });

  it("gives every scenario a unique id", () => {
    const ids = ALL_SCENARIOS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("scenario facts agree with the business fixtures", () => {
  const fixtures = loadBusinessFixtures();

  it("Harbor & Pine: the duplicate charge, customer ids and thread", () => {
    const charge = fixtures.stripe.charges.find(
      (entry) => entry.id === HARBOR_PINE.duplicateCharge,
    );
    expect(charge).toMatchObject({
      customer: HARBOR_PINE.stripeCustomer,
      amount: HARBOR_PINE.chargeAmountMinor,
      invoice: null,
    });
    expect(
      fixtures.stripe.charges.find((entry) => entry.id === HARBOR_PINE.paidCharge)?.invoice,
    ).not.toBeNull();
    expect(
      fixtures.gmail.messages.find((entry) => entry.threadId === HARBOR_PINE.gmailThread)?.from,
    ).toContain(HARBOR_PINE.contactEmail);
    const customer = fixtures.company.customers.find((entry) => entry.key === "harbor-pine");
    expect(customer).toMatchObject({
      stripeCustomer: HARBOR_PINE.stripeCustomer,
      quickbooksCustomer: HARBOR_PINE.quickbooksCustomer,
      hubspotCompany: HARBOR_PINE.hubspotCompany,
      hubspotContact: HARBOR_PINE.hubspotContact,
    });
  });

  it("collections: invoice numbers, threads and the unrecorded Meridian charge", () => {
    const numbers = fixtures.quickbooks.invoices.map((entry) => entry.DocNumber);
    for (const number of [COPPERLEAF.invoice, TIDEWATER.invoice, MERIDIAN.invoice, BLUEFIN.invoice])
      expect(numbers).toContain(number);
    expect(
      fixtures.stripe.charges.find((entry) => entry.id === MERIDIAN.unrecordedCharge)?.metadata,
    ).toEqual({ qbo_invoice: MERIDIAN.invoice });
    expect(
      fixtures.quickbooks.payments.some(
        (entry) => entry.PaymentRefNum === MERIDIAN.unrecordedCharge,
      ),
    ).toBe(false);
    expect(
      fixtures.gmail.messages.find((entry) => entry.threadId === TIDEWATER.gmailThread),
    ).toBeDefined();
    expect(
      fixtures.gmail.messages.find((entry) => entry.threadId === COPPERLEAF.reminderThread)?.to[0],
    ).toContain(COPPERLEAF.contactEmail);
  });

  it("Solstice: the deal, the contact and the ids the fakes will assign", () => {
    const deal = fixtures.hubspot.objects.deals.find((entry) => entry.id === SOLSTICE.hubspotDeal);
    expect(deal?.properties).toMatchObject({
      dealstage: "closedwon",
      amount: String(SOLSTICE.amountMinor / 100),
    });
    expect(
      fixtures.hubspot.objects.contacts.find((entry) => entry.id === SOLSTICE.hubspotContact)
        ?.properties.email,
    ).toBe(SOLSTICE.contactEmail);
    expect(fixtures.quickbooks.customers.some((entry) => entry.DisplayName === SOLSTICE.name)).toBe(
      false,
    );
    const maxCustomer = Math.max(...fixtures.quickbooks.customers.map((entry) => Number(entry.Id)));
    const maxInvoice = Math.max(...fixtures.quickbooks.invoices.map((entry) => Number(entry.Id)));
    expect(String(maxCustomer + 1)).toBe(SOLSTICE.expectedCustomerId);
    expect(String(maxInvoice + 1)).toBe(SOLSTICE.expectedInvoiceId);
    expect(String(fixtures.quickbooks.nextDocNumber)).toBe(SOLSTICE.expectedDocNumber);
  });

  it("owners and the digest's numbers follow from the fixtures", () => {
    expect(fixtures.hubspot.owners.find((entry) => entry.email === MAYA.email)?.id).toBe(
      MAYA.hubspotOwner,
    );
    expect(fixtures.hubspot.owners.find((entry) => entry.email === JORDAN.email)?.id).toBe(
      JORDAN.hubspotOwner,
    );
    const weekStart = Date.parse("2026-09-21T00:00:00Z") / 1000;
    const week = fixtures.stripe.charges.filter((entry) => entry.created >= weekStart);
    const paid = week
      .filter((entry) => entry.status === "succeeded")
      .reduce((sum, entry) => sum + entry.amount, 0);
    expect(paid).toBe(112_900);
    expect(J5_DIGEST).toContain("$1,129.00");
    const open = fixtures.quickbooks.invoices
      .map((invoice) => {
        const total = invoice.Line.reduce((sum, line) => sum + line.Amount, 0);
        const paidAmount = fixtures.quickbooks.payments
          .flatMap((payment) => payment.Line)
          .filter((line) => line.LinkedTxn.some((linked) => linked.TxnId === invoice.Id))
          .reduce((sum, line) => sum + line.Amount, 0);
        return total - paidAmount;
      })
      .reduce((sum, balance) => sum + balance, 0);
    expect(open).toBe(9028);
    expect(J5_DIGEST).toContain("$9,028.00");
  });

  it("derives idempotency keys as hex sha256 of runId:toolUseId", () => {
    expect(expectedIdempotencyKey("run_1", "toolu_a")).toMatch(/^[0-9a-f]{64}$/);
    expect(expectedIdempotencyKey("run_1", "toolu_a")).not.toBe(
      expectedIdempotencyKey("run_1", "toolu_b"),
    );
  });
});
