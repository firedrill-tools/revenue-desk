import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../../src/contracts/json.js";
import { classifyQuickBooks } from "../../../src/integrations/quickbooks/classify.js";
import { QUICKBOOKS_PROFILE } from "../../../src/integrations/quickbooks/profile.js";
import { SETTINGS } from "./helpers.js";

describe("classifyQuickBooks", () => {
  it("classifies reads as read", () => {
    for (const spec of Object.values(QUICKBOOKS_PROFILE.tools)) {
      if (spec.baseClass !== "read") continue;
      expect(classifyQuickBooks(spec.name, {}, SETTINGS)).toEqual({
        actionClass: "read",
        operation: spec.operation,
        title: spec.title,
      });
    }
  });

  it("classifies creating a customer as internal_write", () => {
    expect(
      classifyQuickBooks(
        "create_customer",
        { display_name: "Acme Logistics", email: "ap@acme.test" },
        SETTINGS,
      ),
    ).toEqual({
      actionClass: "internal_write",
      operation: "quickbooks.customers.create",
      title: "Create customer in QuickBooks",
      details: {
        consequence: 'Create QuickBooks customer "Acme Logistics"',
        facts: [
          { label: "Customer", value: "Acme Logistics" },
          { label: "Billing email", value: "ap@acme.test" },
        ],
      },
    });
  });

  it("totals an invoice from its lines", () => {
    const result = classifyQuickBooks(
      "create_invoice",
      {
        customer_id: "58",
        lines: [
          { description: "Seats", quantity: 3, unit_price_minor: 40_000 },
          { unit_price_minor: 999, quantity: 1.5 },
          { description: "Setup", unit_price_minor: 5000 },
        ],
        due_date: "2026-10-28",
        bill_email: "ap@acme.test",
      },
      SETTINGS,
    );
    expect(result).toEqual({
      actionClass: "financial",
      operation: "quickbooks.invoices.create",
      title: "Create invoice in QuickBooks",
      details: {
        consequence: "Create a $1,264.99 invoice for QuickBooks customer 58 (not sent)",
        facts: [
          { label: "Customer", value: "58" },
          { label: "Total", value: "$1,264.99" },
          { label: "Lines", value: "3 lines" },
          { label: "Seats", value: "3 x $400.00" },
          { label: "Line 2", value: "1.5 x $9.99" },
          { label: "Setup", value: "1 x $50.00" },
          { label: "Due", value: "2026-10-28" },
          { label: "Bill to", value: "ap@acme.test" },
        ],
        amount: { amountMinor: 126_499, currency: "USD" },
        recordIds: ["58"],
      },
    });
  });

  it("names the recipient when sending an invoice", () => {
    expect(
      classifyQuickBooks("send_invoice", { invoice_id: "130", send_to: "ap@acme.test" }, SETTINGS),
    ).toMatchObject({
      actionClass: "financial",
      operation: "quickbooks.invoices.send",
      details: {
        consequence: "Email QuickBooks invoice 130 to ap@acme.test",
        recipients: ["ap@acme.test"],
        recordIds: ["130"],
      },
    });
    const billing = classifyQuickBooks("send_invoice", { invoice_id: "130" }, SETTINGS);
    expect(billing?.details?.consequence).toBe(
      "Email QuickBooks invoice 130 to the invoice's billing email",
    );
    expect(billing?.details?.recipients).toBeUndefined();
  });

  it("records payments and voids as financial", () => {
    expect(
      classifyQuickBooks(
        "record_payment",
        { customer_id: "58", amount_minor: 4900, invoice_id: "130", reference: "ch_2" },
        SETTINGS,
      ),
    ).toMatchObject({
      actionClass: "financial",
      operation: "quickbooks.payments.create",
      details: {
        consequence: "Record a $49.00 payment from QuickBooks customer 58 against invoice 130",
        amount: { amountMinor: 4900, currency: "USD" },
        recordIds: ["58", "130"],
      },
    });
    expect(
      classifyQuickBooks("record_payment", { customer_id: "58", amount_minor: 100 }, SETTINGS)
        ?.details?.facts,
    ).toContainEqual({ label: "Applied to", value: "Unapplied" });
    expect(
      classifyQuickBooks("void_invoice", { invoice_id: "130", sync_token: "3" }, SETTINGS),
    ).toMatchObject({
      actionClass: "financial",
      operation: "quickbooks.invoices.void",
      details: { recordIds: ["130"] },
    });
  });

  it("denies unknown tools and invalid inputs", () => {
    const denied: Array<[string, JsonObject]> = [
      ["delete_invoice", {}],
      ["create_invoice", { customer_id: "58", lines: [] }],
      ["create_invoice", { customer_id: "x", lines: [{ unit_price_minor: 1 }] }],
      ["create_invoice", { customer_id: "58", lines: [{ unit_price_minor: 1.5 }] }],
      ["record_payment", { customer_id: "58", amount_minor: 0 }],
      ["send_invoice", { invoice_id: "130", send_to: "not-an-email" }],
      ["void_invoice", { invoice_id: "130" }],
      ["create_customer", {}],
    ];
    for (const [tool, input] of denied) {
      expect(
        classifyQuickBooks(tool, input, SETTINGS),
        `${tool} ${JSON.stringify(input)}`,
      ).toBeNull();
    }
  });
});
