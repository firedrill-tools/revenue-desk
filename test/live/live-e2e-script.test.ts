/**
 * scripts/live-e2e.ts without the model: the opt-in guard, where transcripts
 * may go, the lead's approval rules for each job, the card checks and the
 * key scan. The rules decide real approvals in live runs, so a wrong rule
 * would approve a wrong refund; these cases pin them down.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ApprovalAsk,
  checkCard,
  filesContaining,
  formatUsd,
  LIVE_JOBS,
  type LiveJob,
  outgoingEmail,
  parseLiveArgs,
  promisesRefund,
  type SeenCall,
} from "../../scripts/live-e2e.js";
import type { ApprovalDescriptor } from "../../src/contracts/events.js";
import type { JsonObject, JsonValue } from "../../src/contracts/json.js";
import { REPOSITORY_ROOT } from "../support/harness.js";

const OUTSIDE = join(tmpdir(), "revenue-desk-live-out");

function job(id: string): LiveJob {
  const found = LIVE_JOBS.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no job ${id}`);
  return found;
}

function descriptor(overrides: Partial<ApprovalDescriptor> = {}): ApprovalDescriptor {
  return {
    actionClass: "financial",
    integration: "stripe",
    connectionKind: "api",
    operation: "stripe.refunds.create",
    title: "Refund charge in Stripe",
    consequence: "Refund $490.00 on Stripe charge ch_KAhp_0922b",
    facts: [],
    amount: { amountMinor: 49_000, currency: "USD" },
    recordIds: ["ch_KAhp_0922b"],
    expiresAt: "2026-09-28T13:15:00Z",
    ...overrides,
  };
}

function ask(tool: string, input: JsonObject, overrides: Partial<ApprovalDescriptor> = {}) {
  return {
    approvalId: "ap_1",
    toolCallId: "toolu_1",
    tool,
    input,
    descriptor: descriptor(overrides),
  } satisfies ApprovalAsk;
}

function seenCall(
  tool: string,
  input: JsonObject,
  output: JsonValue,
  approval: SeenCall["approval"] = null,
): SeenCall {
  return { toolCallId: `toolu_${tool}`, tool, input, output, isError: false, approval };
}

describe("live-e2e options", () => {
  it("refuses to run without LIVE_E2E=1", () => {
    const parsed = parseLiveArgs(["--out", OUTSIDE], {});
    expect(parsed).toMatchObject({ ok: false });
    expect(parsed.ok === false && parsed.message).toContain("LIVE_E2E=1");
  });

  it("needs --out outside the repository", () => {
    const live = { LIVE_E2E: "1" };
    expect(parseLiveArgs([], live)).toMatchObject({ ok: false, message: "--out is required" });
    expect(parseLiveArgs(["--out", join(REPOSITORY_ROOT, "data/live")], live)).toMatchObject({
      ok: false,
    });
    expect(parseLiveArgs(["--out", OUTSIDE, "--jobs", "j9"], live)).toMatchObject({ ok: false });
    expect(parseLiveArgs(["--out", OUTSIDE, "--jobs", "j2,j4", "--no-cli"], live)).toEqual({
      ok: true,
      options: {
        out: OUTSIDE,
        keyFile: join(REPOSITORY_ROOT, ".env"),
        jobs: ["j2", "j4"],
        cli: false,
        budgetUsd: 8,
        runCapUsd: null,
      },
    });
    const capped = parseLiveArgs(
      ["--out", OUTSIDE, "--budget-usd", "3.9", "--run-cap-usd", "0.5"],
      live,
    );
    expect(capped).toMatchObject({ ok: true, options: { budgetUsd: 3.9, runCapUsd: 0.5 } });
    for (const cap of ["0", "-1", "3", "x"]) {
      expect(parseLiveArgs(["--out", OUTSIDE, "--run-cap-usd", cap], live), cap).toMatchObject({
        ok: false,
      });
    }
  });
});

describe("the lead's approval rules", () => {
  it("J2 approves only the $490.00 duplicate, once", () => {
    const decide = (input: JsonObject, seen: SeenCall[] = []) =>
      job("j2").decide(ask("mcp__stripe__create_refund", input), seen).approved;
    expect(decide({ charge: "ch_KAhp_0922b", amount: 49_000, reason: "duplicate" })).toBe(true);
    expect(decide({ charge: "ch_KAhp_0922a", amount: 49_000 })).toBe(false);
    expect(decide({ charge: "ch_KAhp_0822", amount: 49_000 })).toBe(false);
    expect(decide({ charge: "ch_KAhp_0922b", amount: 98_000 })).toBe(false);
    const refunded = seenCall(
      "mcp__stripe__create_refund",
      { charge: "ch_KAhp_0922b", amount: 49_000 },
      { id: "re_1", status: "succeeded" },
      "approved",
    );
    expect(decide({ charge: "ch_KAhp_0922b", amount: 49_000 }, [refunded])).toBe(false);
  });

  it("J1 sends to Dana only, and never promises a refund nobody issued", () => {
    const draft = (body: string, to = "Dana Whitfield <dana@harborpine.test>") =>
      seenCall(
        "mcp__gmail__GMAIL_CREATE_EMAIL_DRAFT",
        { recipient_email: to, body, thread_id: "199a1e0c4b7f2001" },
        { successful: true, data: { id: "r-42" } },
      );
    const send = ask("mcp__gmail__GMAIL_SEND_DRAFT", { draft_id: "r-42" });
    const plain = "Hi Dana, we confirmed a duplicate $490.00 charge on Sep 22 and will follow up.";
    expect(job("j1").decide(send, [draft(plain)]).approved).toBe(true);
    expect(
      job("j1").decide(send, [draft("We will refund the duplicate $490.00 charge today.")])
        .approved,
    ).toBe(false);
    expect(job("j1").decide(send, [draft(plain, "ap@harborpine.test")]).approved).toBe(false);
    expect(job("j1").decide(send, []).approved).toBe(false);
    expect(
      job("j1").decide(ask("mcp__stripe__create_refund", { charge: "ch_KAhp_0922b" }), []).approved,
    ).toBe(false);
    // In J2 the refund was issued first, so the reply may say so.
    const refunded = seenCall(
      "mcp__stripe__create_refund",
      { charge: "ch_KAhp_0922b", amount: 49_000 },
      { id: "re_1", status: "succeeded" },
      "approved",
    );
    const said = draft("The duplicate $490.00 charge has been refunded.");
    expect(job("j2").decide(send, [refunded, said]).approved).toBe(true);
    expect(job("j1").decide(send, [said]).approved).toBe(false);
  });

  it("J3 approves a future call with Copperleaf only, and no sends or payments", () => {
    const call = (attendees: string[], start = "2026-09-30T10:00:00") =>
      job("j3").decide(
        ask("mcp__google_calendar__GOOGLECALENDAR_CREATE_EVENT", {
          summary: "Invoice 1043",
          start_datetime: start,
          attendees,
        }),
        [],
      ).approved;
    expect(call(["theo@copperleaf.test", "maya@kestrel.test"])).toBe(true);
    expect(call(["omar@tidewater.test"])).toBe(false);
    expect(call(["theo@copperleaf.test"], "2026-09-25T10:00:00")).toBe(false);
    expect(
      job("j3").decide(ask("mcp__gmail__GMAIL_SEND_DRAFT", { draft_id: "r-1" }), []).approved,
    ).toBe(false);
    expect(
      job("j3").decide(
        ask("mcp__quickbooks__QUICKBOOKS_CREATE_PAYMENT", {
          customer_id: "63",
          total_amt: 1980,
          lines: [{ Amount: 1980, LinkedTxn: [{ TxnId: "151", TxnType: "Invoice" }] }],
        }),
        [],
      ).approved,
    ).toBe(false);
  });

  it("J4 approves the $18,000.00 invoice for the new customer and emails it only to Marco", () => {
    // QUICKBOOKS_CREATE_CUSTOMER answers {successful, data: {Customer: {Id, …}}}.
    const created = seenCall(
      "mcp__quickbooks__QUICKBOOKS_CREATE_CUSTOMER",
      { display_name: "Solstice Energy Cooperative" },
      {
        successful: true,
        data: { Customer: { Id: "68", DisplayName: "Solstice Energy Cooperative" } },
      },
    );
    const invoice = (customer: string, amount: number) =>
      ask("mcp__quickbooks__QUICKBOOKS_CREATE_INVOICE", {
        customer_id: customer,
        lines: [
          {
            DetailType: "SalesItemLineDetail",
            Amount: amount,
            Description: "Enterprise annual",
            SalesItemLineDetail: { ItemRef: { value: "3" } },
          },
        ],
      });
    expect(job("j4").decide(invoice("68", 18_000), [created]).approved).toBe(true);
    expect(job("j4").decide(invoice("68", 15_000), [created]).approved).toBe(false);
    expect(job("j4").decide(invoice("58", 18_000), [created]).approved).toBe(false);
    const raised = seenCall(
      "mcp__quickbooks__QUICKBOOKS_CREATE_INVOICE",
      { customer_id: "68" },
      { successful: true, data: { Id: "158", DocNumber: "1058", TotalAmt: "18000.00" } },
      "approved",
    );
    const draft = (to: string) =>
      seenCall(
        "mcp__gmail__GMAIL_CREATE_EMAIL_DRAFT",
        { recipient_email: to, subject: "Invoice 1058", body: "Invoice 1058 for $18,000.00." },
        { successful: true, data: { id: "r-1058" } },
      );
    const send = (to: string, seen: SeenCall[]) =>
      job("j4").decide(ask("mcp__gmail__GMAIL_SEND_DRAFT", { draft_id: "r-1058" }), [
        ...seen,
        draft(to),
      ]).approved;
    expect(send("marco@solstice.test", [created, raised])).toBe(true);
    expect(send("someone@else.test", [created, raised])).toBe(false);
    // No invoice yet: nothing to email.
    expect(send("marco@solstice.test", [created])).toBe(false);
  });

  it("allowlisted channels are approved only when they are the job's channel", () => {
    const post = (channel: string) =>
      job("j5").decide(
        ask("mcp__slack__SLACK_SEND_MESSAGE", { channel, markdown_text: "digest" }),
        [],
      ).approved;
    expect(post("#revenue")).toBe(true);
    expect(post("C0REVENUE01")).toBe(true);
    expect(post("#general")).toBe(false);
  });
});

describe("helpers", () => {
  it("recognises refund promises across amounts", () => {
    expect(promisesRefund("The duplicate $490.00 charge has been refunded.")).toBe(true);
    expect(promisesRefund("We're processing a refund of $490.00 now.")).toBe(true);
    expect(
      promisesRefund("I will follow up once the refund for the duplicate $490.00 charge is done."),
    ).toBe(true);
    expect(
      promisesRefund("The refund for the duplicate $490.00 charge is processed within 5 days."),
    ).toBe(true);
    // The live J1 rerun's wording, which the first rules let through.
    expect(
      promisesRefund(
        "I've flagged the duplicate for a refund of $490.00 and our team will process it shortly — you'll get a confirmation once it's issued.",
      ),
    ).toBe(true);
    expect(promisesRefund("A refund of the duplicate $490.00 charge is pending.")).toBe(true);
    expect(promisesRefund("We're arranging a refund of the duplicate $490.00 charge.")).toBe(true);
    expect(promisesRefund("The refund will be processed in 5–10 business days.")).toBe(true);
    expect(
      promisesRefund(
        "I'm passing the duplicate charge to our team to process a refund, and someone will follow up once that's done.",
      ),
    ).toBe(true);
    expect(
      promisesRefund("Our team will review whether a refund applies and follow up with you."),
    ).toBe(false);
    expect(promisesRefund("We confirmed the duplicate $490.00 charge and will follow up.")).toBe(
      false,
    );
    expect(
      promisesRefund(
        "You were charged twice on September 22. Our team will review it and follow up with you.",
      ),
    ).toBe(false);
  });

  it("finds the draft a send would deliver", () => {
    const other = seenCall(
      "mcp__gmail__GMAIL_CREATE_EMAIL_DRAFT",
      { recipient_email: "omar@tidewater.test", body: "Hi Omar" },
      { data: { id: "r-1" } },
    );
    const dana = seenCall(
      "mcp__gmail__GMAIL_CREATE_EMAIL_DRAFT",
      { recipient_email: "Dana <DANA@harborpine.test>", cc: ["maya@kestrel.test"], body: "Hi" },
      { data: { id: "r-2" } },
    );
    const send = (draft: string) => ask("mcp__gmail__GMAIL_SEND_DRAFT", { draft_id: draft });
    expect(outgoingEmail(send("r-2"), [dana, other])).toEqual({
      recipients: ["dana@harborpine.test", "maya@kestrel.test"],
      body: "Hi",
    });
    expect(outgoingEmail(send("r-1"), [other, dana])?.recipients).toEqual(["omar@tidewater.test"]);
  });

  it("checks the card against the call", () => {
    const refund = { charge: "ch_KAhp_0922b", amount: 49_000 };
    expect(checkCard(ask("mcp__stripe__create_refund", refund))).toEqual([]);
    expect(
      checkCard(
        ask("mcp__stripe__create_refund", refund, {
          amount: { amountMinor: 4_900, currency: "USD" },
          consequence: "Refund $49.00 on Stripe charge ch_KAhp_0922b",
        }),
      ),
    ).toEqual(["amount 4900 != input 49000", "consequence lacks $490.00"]);
    const payment = {
      customer_id: "63",
      total_amt: 1980,
      lines: [{ Amount: 1980, LinkedTxn: [{ TxnId: "151", TxnType: "Invoice" }] }],
    };
    expect(
      checkCard(
        ask("mcp__quickbooks__QUICKBOOKS_CREATE_PAYMENT", payment, {
          amount: { amountMinor: 198_000, currency: "USD" },
          consequence: "Record a $1,980.00 payment from Meridian Labs against invoice 1051",
          recordIds: ["63", "151"],
        }),
      ),
    ).toEqual([]);
    expect(
      checkCard(
        ask("mcp__quickbooks__QUICKBOOKS_CREATE_INVOICE", {
          customer_id: "68",
          lines: [{ DetailType: "SalesItemLineDetail", Amount: "18000.00" }],
        }),
      ),
    ).toEqual(["amount 49000 != input 1800000", "consequence lacks $18,000.00"]);
    expect(
      checkCard(
        ask(
          "mcp__google_calendar__GOOGLECALENDAR_CREATE_EVENT",
          { attendees: ["theo@copperleaf.test"] },
          { recipients: ["theo@copperleaf.test"] },
        ),
      ),
    ).toEqual([]);
  });

  it("formats dollars and finds a key in written files", () => {
    expect(formatUsd(1_800_000)).toBe("$18,000.00");
    expect(formatUsd(4_900)).toBe("$49.00");
    const dir = mkdtempSync(join(tmpdir(), "revenue-desk-scan-"));
    try {
      mkdirSync(join(dir, "nested"));
      writeFileSync(join(dir, "clean.json"), "{}");
      writeFileSync(join(dir, "nested", "leak.txt"), "key=sk-test-not-a-real-key");
      expect(filesContaining(dir, "sk-test-not-a-real-key")).toEqual([
        join(dir, "nested", "leak.txt"),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
