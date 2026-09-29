/**
 * J2 Refund a duplicate charge: the agent finds Harbor & Pine's duplicate
 * September charge in Stripe, checks it was not refunded already, proposes
 * the refund (financial: approval), then logs a HubSpot note. Slack is not
 * connected in the fake world, so the agent says #billing was not told.
 * Variants: denied, declined by Stripe (402), and an invalid first attempt
 * that the agent's schema check rejects before any approval.
 */
import type { Fakes } from "../support/fakes/index.js";
import { Checks, expectedIdempotencyKey, firstLine, HARBOR_PINE, MAYA, NOW_ISO } from "./facts.js";
import {
  type RunFacts,
  type Scenario,
  type ScriptedCall,
  type Step,
  type StepContext,
  text,
  toolUseId,
} from "./script.js";
import { ASSOCIATION, associate, hubspot, stripe } from "./tools.js";

export const J2_PROMPT =
  "Harbor & Pine were charged twice for September. Refund the duplicate, note it in HubSpot and let #billing know.";

const findCustomer: Step = () => [
  text("Looking up Harbor & Pine in Stripe."),
  stripe.findCustomers("j2_customer", { email: HARBOR_PINE.contactEmail }),
];

const listCharges: Step = (context) => [
  stripe.listCharges("j2_charges", {
    customer: context.pick("j2_customer", /(cus_\w+)/, HARBOR_PINE.stripeCustomer),
    created_after: "2026-09-01",
    limit: 10,
  }),
];

const checkRefunds: Step = (context) => [
  text(
    `Two $490.00 charges on September 22: ${HARBOR_PINE.paidCharge} paid invoice KA-7F31-0007; ${context.pick("j2_charges", /(ch_KAhp_0922b)/, HARBOR_PINE.duplicateCharge)} came four minutes later with no invoice, so it is the duplicate. Checking it has not been refunded already.`,
  ),
  stripe.listRefunds("j2_existing_refunds", { charge: HARBOR_PINE.duplicateCharge }),
];

const refundCall = (id: string): ScriptedCall =>
  stripe.createRefund(id, {
    charge: HARBOR_PINE.duplicateCharge,
    amount: HARBOR_PINE.chargeAmountMinor,
    reason: "duplicate",
    metadata: { source: "revenue-desk", gmail_thread: HARBOR_PINE.gmailThread },
  });

const refund: Step = () => [
  text(
    `No refund exists yet. Refunding $490.00 on ${HARBOR_PINE.duplicateCharge} needs your approval.`,
  ),
  refundCall("j2_refund"),
];

/**
 * Why the refund was not made, said to the user. The tool result is written
 * for the model (a JSON failure, "Blocked by policy: … do not retry it."),
 * so a reply never repeats it as it is.
 */
export function refundNotMade(resultText: string | undefined, charge: string): string {
  const line = firstLine(resultText);
  if (line.startsWith("Blocked by policy")) {
    return `Financial actions are set to deny, so I did not refund ${charge}.`;
  }
  if (line.startsWith("The user declined")) {
    return `You declined the refund, so I did not refund ${charge}.`;
  }
  let failure: { readonly message?: unknown } | undefined;
  try {
    failure = (JSON.parse(line) as { error?: { message?: unknown } }).error;
  } catch {
    failure = undefined;
  }
  if (typeof failure?.message === "string") {
    return `Stripe declined the refund: ${failure.message} I did not refund ${charge}.`;
  }
  return `I did not refund ${charge}: ${line}`;
}

/** After the refund: record it, or stop and say why not. */
const recordOrStop =
  (refundId: string): Step =>
  (context) => {
    const result = context.result(refundId);
    if (result === undefined || result.isError) {
      return [
        text(
          `${refundNotMade(result?.text, HARBOR_PINE.duplicateCharge)} Nothing was logged in HubSpot.`,
        ),
      ];
    }
    const stripeRefund = context.pick(refundId, /\b(re_[A-Za-z0-9]+)\b/, "re_unknown");
    return [
      text("Refunded. Logging it in HubSpot."),
      hubspot.createNote("j2_note", {
        body: `Refunded duplicate charge ${HARBOR_PINE.duplicateCharge} ($490.00, refund ${stripeRefund}). The September Growth plan was charged twice on 2026-09-22; Dana Whitfield asked in Gmail thread ${HARBOR_PINE.gmailThread}.`,
        timestamp: NOW_ISO,
        ownerId: MAYA.hubspotOwner,
        associations: [
          associate(HARBOR_PINE.hubspotContact, ASSOCIATION.noteToContact),
          associate(HARBOR_PINE.hubspotCompany, ASSOCIATION.noteToCompany),
        ],
      }),
    ];
  };

/** Slack is not connected in the fake world: #billing is not told, and the reply says so. */
export const J2_SLACK_UNAVAILABLE = "Slack is not connected, so #billing was not told.";

function summary(context: StepContext): string {
  const note = context.result("j2_note");
  const parts = [`Refunded $490.00 on the duplicate charge ${HARBOR_PINE.duplicateCharge}.`];
  parts.push(
    note !== undefined && !note.isError
      ? "Logged a note on Dana's HubSpot contact and company."
      : `The HubSpot note failed: ${firstLine(note?.text)}`,
  );
  parts.push(J2_SLACK_UNAVAILABLE);
  return parts.join(" ");
}

const J2_STEPS: readonly Step[] = [
  findCustomer,
  listCharges,
  checkRefunds,
  refund,
  recordOrStop("j2_refund"),
  (context) => [text(summary(context))],
];

function verifyRefunded(fakes: Fakes, run: RunFacts, refundCallId: string): string[] {
  const checks = new Checks();
  const refunds = fakes.stripe.refunds({ charge: HARBOR_PINE.duplicateCharge });
  checks.equal(
    refunds.map((entry) => [entry.amount, entry.reason, entry.status]),
    [[HARBOR_PINE.chargeAmountMinor, "duplicate", "succeeded"]],
    "exactly one $490.00 duplicate refund",
  );
  const writes = fakes.stripe
    .writes()
    .filter((write) => write.path === "/v1/refunds" && !write.replayed);
  checks.equal(
    writes.map((write) => write.idempotencyKey),
    [expectedIdempotencyKey(run.runId, toolUseId(refundCallId, run.turn))],
    "one refund request carrying sha256(runId:toolUseId) as Idempotency-Key",
  );
  const notes = fakes.hubspot.crm.created("notes", fakes.hubspot.crm.firstCreatedId);
  checks.equal(notes.length, 1, "one HubSpot note");
  checks.that(
    JSON.stringify(notes).includes(`"toId":"${HARBOR_PINE.hubspotContact}"`) &&
      JSON.stringify(notes).includes(`"toId":"${HARBOR_PINE.hubspotCompany}"`),
    "the note is associated with Dana's contact and company",
  );
  return checks.problems;
}

function verifyNotRefunded(fakes: Fakes): string[] {
  const checks = new Checks();
  checks.equal(
    fakes.stripe.refunds({ charge: HARBOR_PINE.duplicateCharge }).length,
    0,
    "no refund",
  );
  checks.equal(fakes.hubspot.writes().length, 0, "no HubSpot writes");
  return checks.problems;
}

export const J2_REFUND_DUPLICATE: Scenario = {
  id: "j2-refund-duplicate",
  job: "J2",
  title: "Refund a duplicate charge and note it",
  prompt: J2_PROMPT,
  steps: J2_STEPS,
  approvals: { j2_refund: "approve" },
  expected: { status: "completed", replyIncludes: ["Refunded $490.00", J2_SLACK_UNAVAILABLE] },
  verify: (fakes, run) => verifyRefunded(fakes, run, "j2_refund"),
};

export const J2_REFUND_DENIED: Scenario = {
  ...J2_REFUND_DUPLICATE,
  id: "j2-refund-denied",
  title: "The user denies the refund",
  approvals: { j2_refund: "deny" },
  expected: {
    status: "completed",
    replyIncludes: ["You declined the refund, so I did not refund"],
  },
  verify: (fakes) => {
    const problems = verifyNotRefunded(fakes);
    const attempts = fakes.stripe.http.requestsTo("POST", "/v1/refunds");
    if (attempts.length !== 0)
      problems.push(`a denied refund reached Stripe ${attempts.length} time(s)`);
    return problems;
  },
};

export const J2_STRIPE_DECLINE: Scenario = {
  ...J2_REFUND_DUPLICATE,
  id: "fail-stripe-402",
  job: "failure",
  title: "Stripe answers the approved refund with a 402 decline",
  arrange: (fakes) => {
    fakes.stripe.faults.decline("/v1/refunds", { method: "POST" });
  },
  expected: {
    status: "completed",
    replyIncludes: ["Stripe declined the refund: Your card was declined.", "I did not refund"],
  },
  verify: (fakes) => {
    const problems = verifyNotRefunded(fakes);
    const attempts = fakes.stripe.http.requestsTo("POST", "/v1/refunds");
    if (attempts.length !== 1)
      problems.push(`expected exactly one refund attempt (no retry), saw ${attempts.length}`);
    return problems;
  },
};

/** The agent's first refund call has an invalid amount; its schema check rejects it before any approval. */
export const J2_INVALID_ARGUMENTS: Scenario = {
  ...J2_REFUND_DUPLICATE,
  id: "guard-invalid-refund-arguments",
  job: "failure",
  title: "An invalid refund call is rejected before approval, then corrected",
  steps: [
    findCustomer,
    listCharges,
    checkRefunds,
    () => [
      text("Refunding the duplicate charge."),
      stripe.createRefund(
        "j2_refund_invalid",
        { charge: HARBOR_PINE.duplicateCharge, amount: -49_000, reason: "duplicate" },
        { expectInvalid: true },
      ),
    ],
    (context) => {
      const rejected = context.result("j2_refund_invalid");
      return [
        text(
          `That call was rejected (${firstLine(rejected?.text)}). Correcting the amount to 49000 minor units.`,
        ),
        refundCall("j2_refund"),
      ];
    },
    recordOrStop("j2_refund"),
    (context) => [text(summary(context))],
  ],
  approvals: { j2_refund: "approve" },
  verify: (fakes, run) => {
    const problems = verifyRefunded(fakes, run, "j2_refund");
    const bodies = fakes.stripe.http.requestsTo("POST", "/v1/refunds").map((entry) => entry.body);
    if (bodies.some((body) => body.includes("amount=-")))
      problems.push("the invalid refund reached Stripe");
    return problems;
  },
};

/** The user stops the run while the refund approval is pending: nothing is refunded or announced. */
export const J2_STOPPED_AT_APPROVAL: Scenario = {
  ...J2_REFUND_DUPLICATE,
  id: "stop-during-refund-approval",
  job: "failure",
  title: "The run is stopped while the refund waits for approval",
  approvals: { j2_refund: "stop" },
  expected: { status: "cancelled" },
  verify: (fakes) => {
    const problems = verifyNotRefunded(fakes);
    const attempts = fakes.stripe.http.requestsTo("POST", "/v1/refunds");
    if (attempts.length !== 0)
      problems.push(`a stopped refund reached Stripe ${attempts.length} time(s)`);
    return problems;
  },
};

const noteAssociations = [
  associate(HARBOR_PINE.hubspotContact, ASSOCIATION.noteToContact),
  associate(HARBOR_PINE.hubspotCompany, ASSOCIATION.noteToCompany),
];

/**
 * The live lane's J2, played deterministically: the agent knows only the
 * company name, so it searches Stripe by name (no guessed address); its first
 * HubSpot note has no hs_timestamp, which the gateway refuses before HubSpot
 * sees it, and the corrected note follows.
 */
export const J2_NAME_SEARCH_AND_NOTE_RULE: Scenario = {
  ...J2_REFUND_DUPLICATE,
  id: "guard-name-search-and-note-timestamp",
  job: "failure",
  title: "Stripe found by name; a note without hs_timestamp is refused before HubSpot",
  steps: [
    () => [
      text("Looking up Harbor & Pine in Stripe by name."),
      stripe.findCustomers("j2_customer", { name: "Harbor & Pine" }),
    ],
    listCharges,
    checkRefunds,
    refund,
    (context) => {
      const stripeRefund = context.pick("j2_refund", /\b(re_[A-Za-z0-9]+)\b/, "re_unknown");
      return [
        text("Refunded. Logging it in HubSpot."),
        hubspot.createUntimedNote("j2_note_untimed", {
          body: `Refunded duplicate charge ${HARBOR_PINE.duplicateCharge} ($490.00, refund ${stripeRefund}).`,
          associations: noteAssociations,
        }),
      ];
    },
    (context) => {
      const refused = context.result("j2_note_untimed");
      if (refused === undefined || !refused.isError || !refused.text.includes("hs_timestamp")) {
        context.problem(`the untimed note was not refused for hs_timestamp: ${refused?.text}`);
      }
      return [
        text("HubSpot needs the note's time; adding it."),
        hubspot.createNote("j2_note", {
          body: `Refunded duplicate charge ${HARBOR_PINE.duplicateCharge} ($490.00).`,
          timestamp: NOW_ISO,
          associations: noteAssociations,
        }),
      ];
    },
    (context) => [text(summary(context))],
  ],
  approvals: { j2_refund: "approve" },
  verify: (fakes, run) => {
    const problems = verifyRefunded(fakes, run, "j2_refund");
    const checks = new Checks();
    checks.equal(
      fakes.stripe.http.requestsTo("GET", "/v1/customers/search").length,
      1,
      "Stripe was searched by name once",
    );
    checks.equal(
      fakes.stripe.http.requestsTo("GET", "/v1/customers").length,
      0,
      "no lookup by a guessed email",
    );
    checks.equal(fakes.hubspot.writes().length, 1, "only the corrected note reached HubSpot");
    return [...problems, ...checks.problems];
  },
};
