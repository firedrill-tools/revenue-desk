import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../../src/contracts/json.js";
import {
  classifyQuickBooks,
  UNCONFIRMED_BILL_EMAIL,
} from "../../../src/integrations/quickbooks/classify.js";
import { QUICKBOOKS_PROFILE } from "../../../src/integrations/quickbooks/profile.js";
import { QuickBooksRunMemory } from "../../../src/integrations/quickbooks/run-memory.js";
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
    // Without send_to, QuickBooks uses the invoice's saved billing email, which only a read
    // in this run can confirm: the card says so.
    const billing = classifyQuickBooks("send_invoice", { invoice_id: "130" }, SETTINGS);
    expect(billing?.details?.consequence).toBe(
      "Email QuickBooks invoice 130 to its billing email, which could not be confirmed",
    );
    expect(billing?.details?.facts).toContainEqual({
      label: "Recipient",
      value: UNCONFIRMED_BILL_EMAIL,
    });
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
        consequence:
          "Record a $49.00 payment from QuickBooks customer 58 against QuickBooks invoice 130",
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

/** What a run's QuickBooks reads returned, as the gateway hands them to the memory. */
const INVOICE_1051 = {
  id: "151",
  doc_number: "1051",
  customer: { id: "63", name: "Meridian Labs" },
  total_minor: 198_000,
  balance_minor: 198_000,
  currency: "USD",
  bill_email: "irene@meridianlabs.test",
};

function classified(memory: QuickBooksRunMemory, tool: string, input: JsonObject) {
  const base = classifyQuickBooks(tool, input, SETTINGS);
  if (base === null) throw new Error(`expected a classification of ${tool}`);
  return memory.refine(tool, input, base);
}

describe("QuickBooks cards with what the run read (QuickBooksRunMemory)", () => {
  it("records a payment against an invoice by the customer's name and the invoice number", () => {
    const memory = new QuickBooksRunMemory(SETTINGS);
    memory.record("list_invoices", {}, { invoices: [INVOICE_1051], count: 1 }, false);
    const card = classified(memory, "record_payment", {
      customer_id: "63",
      invoice_id: "151",
      amount_minor: 198_000,
    });
    expect(card.details).toMatchObject({
      consequence: "Record a $1,980.00 payment from Meridian Labs against invoice 1051",
      amount: { amountMinor: 198_000, currency: "USD" },
      recordIds: ["63", "151"],
    });
    expect(card.details?.facts).toEqual(
      expect.arrayContaining([
        { label: "Customer", value: "Meridian Labs (QuickBooks customer 63)" },
        {
          label: "Applied to",
          value: "Invoice 1051 (QuickBooks id 151), open balance $1,980.00",
        },
      ]),
    );
  });

  it("names a customer found with find_customers", () => {
    const memory = new QuickBooksRunMemory(SETTINGS);
    memory.record(
      "find_customers",
      { name: "Meridian" },
      {
        customers: [{ id: "63", display_name: "Meridian Labs", email: "irene@meridianlabs.test" }],
      },
      false,
    );
    expect(
      classified(memory, "record_payment", { customer_id: "63", amount_minor: 100 }).details
        ?.consequence,
    ).toBe("Record a $1.00 payment from Meridian Labs");
  });

  it("flags a payment whose invoice belongs to another customer", () => {
    const memory = new QuickBooksRunMemory(SETTINGS);
    memory.record("list_invoices", {}, { invoices: [INVOICE_1051] }, false);
    memory.record("get_customer", {}, { id: "64", display_name: "Tidewater Logistics" }, false);
    const card = classified(memory, "record_payment", {
      customer_id: "64",
      invoice_id: "151",
      amount_minor: 100,
    });
    expect(card.details?.facts).toContainEqual({
      label: "Mismatch",
      value: "The invoice belongs to Meridian Labs, not this customer",
    });
  });

  it("creates an invoice for a customer by name, from a search or the customer it created", () => {
    const memory = new QuickBooksRunMemory(SETTINGS);
    memory.record(
      "create_customer",
      {},
      { id: "68", display_name: "Solstice Energy Cooperative", email: "marco@solstice.test" },
      false,
    );
    const card = classified(memory, "create_invoice", {
      customer_id: "68",
      lines: [{ quantity: 1, unit_price_minor: 1_800_000 }],
    });
    expect(card.details?.consequence).toBe(
      "Create a $18,000.00 invoice for Solstice Energy Cooperative (not sent)",
    );
    expect(card.details?.facts[0]).toEqual({
      label: "Customer",
      value: "Solstice Energy Cooperative (QuickBooks customer 68)",
    });
  });

  it("sends an invoice it created to the invoice's billing email, by number, total and customer", () => {
    const memory = new QuickBooksRunMemory(SETTINGS);
    memory.record(
      "create_invoice",
      {},
      {
        id: "158",
        doc_number: "1058",
        customer: { id: "68", name: "Solstice Energy Cooperative" },
        total_minor: 1_800_000,
        balance_minor: 1_800_000,
        currency: "USD",
        bill_email: "marco@solstice.test",
      },
      false,
    );
    const card = classified(memory, "send_invoice", { invoice_id: "158" });
    expect(card).toMatchObject({
      actionClass: "financial",
      details: {
        consequence:
          "Email invoice 1058 ($18,000.00, Solstice Energy Cooperative) to marco@solstice.test",
        recipients: ["marco@solstice.test"],
        amount: { amountMinor: 1_800_000, currency: "USD" },
        recordIds: ["158"],
      },
    });
    expect(card.details?.facts).toEqual([
      { label: "Invoice", value: "1058 (QuickBooks id 158)" },
      { label: "Customer", value: "Solstice Energy Cooperative (QuickBooks customer 68)" },
      { label: "Invoice total", value: "$18,000.00" },
      { label: "Open balance", value: "$18,000.00" },
      { label: "Recipient", value: "marco@solstice.test" },
    ]);
    // send_to wins over the saved billing email.
    expect(
      classified(memory, "send_invoice", { invoice_id: "158", send_to: "ap@solstice.test" }).details
        ?.recipients,
    ).toEqual(["ap@solstice.test"]);
  });

  it("voids an invoice by its number", () => {
    const memory = new QuickBooksRunMemory(SETTINGS);
    memory.record("get_invoice", {}, INVOICE_1051, false);
    expect(
      classified(memory, "void_invoice", { invoice_id: "151", sync_token: "0" }).details
        ?.consequence,
    ).toBe("Void invoice 1051; its amounts become zero");
  });

  it("learns only from successful QuickBooks results, never from the model's inputs", () => {
    const memory = new QuickBooksRunMemory(SETTINGS);
    // A failed call and a model's own input name nothing.
    memory.record("get_customer", {}, { id: "63", display_name: "Meridian Labs" }, true);
    memory.record(
      "create_customer",
      { display_name: "Invented Name" },
      "QuickBooks returned an error",
      false,
    );
    memory.record("find_customers", { name: "Meridian" }, { customers: [], count: 0 }, false);
    const card = classified(memory, "create_invoice", {
      customer_id: "63",
      lines: [{ quantity: 1, unit_price_minor: 100 }],
    });
    expect(card.details?.consequence).toBe(
      "Create a $1.00 invoice for QuickBooks customer 63 (not sent)",
    );
    // Reads and other tools are not refined.
    const read = classifyQuickBooks("list_invoices", {}, SETTINGS);
    if (read === null) throw new Error("expected a classification");
    expect(memory.refine("list_invoices", {}, read)).toEqual(read);
  });

  it("names a customer seen only through an invoice or payment reference", () => {
    const memory = new QuickBooksRunMemory(SETTINGS);
    memory.record(
      "list_payments",
      {},
      { payments: [{ id: "9", customer: { id: "70", name: "Bluefin Dental Group" } }] },
      false,
    );
    expect(
      classified(memory, "record_payment", { customer_id: "70", amount_minor: 75_000 }).details
        ?.consequence,
    ).toBe("Record a $750.00 payment from Bluefin Dental Group");
  });
});
