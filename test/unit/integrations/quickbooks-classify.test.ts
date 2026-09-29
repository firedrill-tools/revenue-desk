// QuickBooks through Composio: the classifier, the approval cards and the
// run memory, from inputs shaped by the captured QUICKBOOKS_* schemas
// (test/fixtures/surfaces/composio-direct.json) and results shaped by each
// tool's Composio output schema ({successful, data, error}, QuickBooks' own
// JSON inside, amounts as decimals or numeric strings).

import { describe, expect, it } from "vitest";
import type { JsonObject, JsonValue } from "../../../src/contracts/json.js";
import { OUTCOME_UNKNOWN } from "../../../src/gateway/types.js";
import { classifyQuickBooks } from "../../../src/integrations/quickbooks/classify.js";
import { checkQuickBooksInput } from "../../../src/integrations/quickbooks/input-rules.js";
import { QUICKBOOKS_PROFILE } from "../../../src/integrations/quickbooks/profile.js";
import {
  customerFrom,
  decimal,
  entitiesOf,
  invoiceFrom,
  paymentFrom,
} from "../../../src/integrations/quickbooks/records.js";
import { QuickBooksRunMemory } from "../../../src/integrations/quickbooks/run-memory.js";
import { SETTINGS } from "./helpers.js";

/** Composio's wrapper around a tool's data. */
const ok = (data: JsonValue): JsonObject => ({ successful: true, data, error: null });

const INVOICE_A: JsonObject = {
  Id: "151",
  DocNumber: "1051",
  TxnDate: "2026-08-10",
  DueDate: "2026-09-09",
  TotalAmt: 1980,
  Balance: 1980,
  CustomerRef: { value: "63", name: "Customer A" },
  BillEmail: { Address: "ap@customer-a.example" },
  CurrencyRef: { value: "USD", name: "United States Dollar" },
};

const INVOICE_B: JsonObject = {
  Id: "143",
  DocNumber: "1043",
  DueDate: "2026-07-20",
  TotalAmt: 3600,
  Balance: 3600,
  CustomerRef: { value: "61", name: "Customer B" },
};

/** QUICKBOOKS_QUERY_INVOICES answers `data.Invoice[]`. */
const INVOICES = ok({
  Invoice: [INVOICE_A, INVOICE_B],
  startPosition: 1,
  maxResults: 2,
  totalCount: 2,
});

const PAYMENT_INPUT: JsonObject = {
  customer_id: "63",
  total_amt: 1980,
  lines: [{ Amount: 1980, LinkedTxn: [{ TxnId: "151", TxnType: "Invoice" }] }],
  txn_date: "2026-09-10",
  payment_ref_num: "ch_KAmer_0910",
};

describe("QuickBooks records from Composio results", () => {
  it("reads decimals given as numbers or numeric strings", () => {
    expect(decimal(1980)).toBe(1980);
    expect(decimal("18000.00")).toBe(18_000);
    expect(decimal(" 12.5 ")).toBe(12.5);
    expect(decimal("12,5")).toBeUndefined();
    expect(decimal(null)).toBeUndefined();
    expect(decimal(Number.NaN)).toBeUndefined();
  });

  it("finds records wherever each tool puts them", () => {
    // QUICKBOOKS_QUERY_INVOICES: data.Invoice[].
    expect(entitiesOf(INVOICES, "Invoice").map((record) => record.Id)).toEqual(["151", "143"]);
    // QUICKBOOKS_QUERY_CUSTOMERS / _PAYMENTS: data.QueryResponse.<Type>[].
    expect(
      entitiesOf(ok({ QueryResponse: { Customer: [{ Id: "63" }], maxResults: 1 } }), "Customer"),
    ).toEqual([{ Id: "63" }]);
    // QUICKBOOKS_CREATE_CUSTOMER: data.Customer.
    expect(entitiesOf(ok({ Customer: { Id: "68" }, time: "t" }), "Customer")).toEqual([
      { Id: "68" },
    ]);
    // QUICKBOOKS_READ_INVOICE / CREATE_INVOICE / CREATE_PAYMENT: the record itself.
    expect(entitiesOf(ok(INVOICE_A), "Invoice", { single: true })).toEqual([INVOICE_A]);
    expect(entitiesOf(ok(INVOICE_A), "Invoice")).toEqual([]);
    // Bare data (no wrapper) is read the same way; a failed call yields nothing.
    expect(entitiesOf({ Invoice: [INVOICE_A] }, "Invoice")).toHaveLength(1);
    expect(entitiesOf({ successful: false, data: { Invoice: [INVOICE_A] } }, "Invoice")).toEqual(
      [],
    );
    expect(entitiesOf("Invoice 1051", "Invoice")).toEqual([]);
  });

  it("projects customers, invoices and payments in minor units", () => {
    expect(
      customerFrom({
        Id: "63",
        DisplayName: "Customer A",
        PrimaryEmailAddr: { Address: "ap@customer-a.example" },
      }),
    ).toEqual({ id: "63", displayName: "Customer A", email: "ap@customer-a.example" });
    expect(customerFrom({ Id: "70", GivenName: "Marco", FamilyName: "Bellini" })).toEqual({
      id: "70",
      displayName: "Marco Bellini",
      email: null,
    });
    expect(customerFrom({ DisplayName: "No id" })).toBeNull();
    expect(invoiceFrom(INVOICE_A, "EUR")).toEqual({
      id: "151",
      docNumber: "1051",
      customerId: "63",
      customerName: "Customer A",
      billEmail: "ap@customer-a.example",
      totalMinor: 198_000,
      balanceMinor: 198_000,
      currency: "USD",
      dueDate: "2026-09-09",
    });
    // QUICKBOOKS_CREATE_INVOICE returns amounts as strings; no CurrencyRef uses the fallback.
    expect(
      invoiceFrom({ Id: "158", DocNumber: "1058", TotalAmt: "18000.00", Balance: "18000" }, "USD"),
    ).toMatchObject({ totalMinor: 1_800_000, balanceMinor: 1_800_000, currency: null });
    expect(
      paymentFrom(
        {
          Id: "90",
          TotalAmt: "1980.00",
          CustomerRef: { value: "63", name: "Customer A" },
          Line: [
            { Amount: "1500", LinkedTxn: [{ TxnId: "151", TxnType: "Invoice" }] },
            { Amount: 480, LinkedTxn: [{ TxnId: "12", TxnType: "CreditMemo" }] },
          ],
        },
        "USD",
      ),
    ).toEqual({
      id: "90",
      customerId: "63",
      customerName: "Customer A",
      totalMinor: 198_000,
      currency: null,
      applied: [{ invoiceId: "151", amountMinor: 150_000 }],
    });
  });
});

describe("classifyQuickBooks", () => {
  it("classifies every read of the profile as read", () => {
    for (const spec of Object.values(QUICKBOOKS_PROFILE.tools)) {
      if (spec.baseClass !== "read") continue;
      expect(classifyQuickBooks(spec.name, {}, SETTINGS)).toEqual({
        actionClass: "read",
        operation: spec.operation,
        title: spec.title,
      });
    }
  });

  it("creates a customer as internal_write, naming it and its email", () => {
    expect(
      classifyQuickBooks(
        "QUICKBOOKS_CREATE_CUSTOMER",
        {
          display_name: "Customer C Inc",
          CompanyName: "Customer C Inc",
          given_name: "Marco",
          family_name: "Bellini",
          PrimaryEmailAddr: { Address: "marco@customer-c.example" },
        },
        SETTINGS,
      ),
    ).toEqual({
      actionClass: "internal_write",
      operation: "quickbooks.customers.create",
      title: "Create customer in QuickBooks",
      details: {
        consequence: 'Create QuickBooks customer "Customer C Inc"',
        facts: [
          { label: "Customer", value: "Customer C Inc" },
          { label: "Email", value: "marco@customer-c.example" },
        ],
      },
    });
    // A person's name parts stand in for a missing display name.
    expect(
      classifyQuickBooks(
        "QUICKBOOKS_CREATE_CUSTOMER",
        { given_name: "Marco", family_name: "Bellini" },
        SETTINGS,
      )?.details?.consequence,
    ).toBe('Create QuickBooks customer "Marco Bellini"');
  });

  it("creates a customer with an opening balance as financial: it books money owed", () => {
    expect(
      classifyQuickBooks(
        "QUICKBOOKS_CREATE_CUSTOMER",
        { display_name: "Customer D", Balance: 1250.5, OpenBalanceDate: "2026-09-01" },
        SETTINGS,
      ),
    ).toEqual({
      actionClass: "financial",
      operation: "quickbooks.customers.create",
      title: "Create customer in QuickBooks",
      details: {
        consequence: 'Create QuickBooks customer "Customer D" with an opening balance of $1,250.50',
        facts: [
          { label: "Customer", value: "Customer D" },
          { label: "Opening balance", value: "$1,250.50" },
          { label: "As of", value: "2026-09-01" },
        ],
        amount: { amountMinor: 125_050, currency: "USD" },
      },
    });
    expect(
      classifyQuickBooks("QUICKBOOKS_CREATE_CUSTOMER", { display_name: "X", Balance: 0 }, SETTINGS)
        ?.actionClass,
    ).toBe("internal_write");
  });

  it("totals an invoice from its line amounts, discounts subtracted, and says it is not sent", () => {
    const result = classifyQuickBooks(
      "QUICKBOOKS_CREATE_INVOICE",
      {
        customer_id: "58",
        lines: [
          {
            DetailType: "SalesItemLineDetail",
            Amount: 1200,
            Description: "Seats",
            SalesItemLineDetail: { ItemRef: { value: "3" }, Qty: 3, UnitPrice: 400 },
          },
          {
            DetailType: "SalesItemLineDetail",
            Amount: "14.99",
            SalesItemLineDetail: { ItemRef: { value: "4", name: "Setup" } },
          },
          { DetailType: "SubTotalLineDetail", Amount: 1214.99 },
          { DetailType: "DiscountLineDetail", Amount: 50, Description: "Loyalty" },
        ],
        due_date: "2026-10-28",
        doc_number: "1058",
        bill_email: { Address: "ap@acme.test" },
        customer_memo: { value: "Thank you." },
      },
      SETTINGS,
    );
    expect(result).toEqual({
      actionClass: "financial",
      operation: "quickbooks.invoices.create",
      title: "Create invoice in QuickBooks",
      details: {
        consequence: "Create a $1,164.99 invoice for QuickBooks customer 58 (not sent)",
        facts: [
          { label: "Customer", value: "QuickBooks customer 58 (not read in this run)" },
          { label: "Total before tax", value: "$1,164.99" },
          { label: "Lines", value: "3 lines" },
          { label: "Seats", value: "3 x $400.00" },
          { label: "Setup", value: "$14.99" },
          { label: "Loyalty", value: "Discount −$50.00" },
          { label: "Due", value: "2026-10-28" },
          { label: "Invoice number", value: "1058" },
          { label: "Billing email", value: "ap@acme.test" },
          { label: "Message on invoice", value: "Thank you." },
          { label: "Sent", value: "No: QuickBooks does not email it" },
        ],
        amount: { amountMinor: 116_499, currency: "USD" },
        recordIds: ["58"],
      },
    });
  });

  it("uses the invoice's own currency when it names one", () => {
    const result = classifyQuickBooks(
      "QUICKBOOKS_CREATE_INVOICE",
      {
        customer_id: "58",
        currency_ref: { value: "eur" },
        lines: [{ DetailType: "SalesItemLineDetail", Amount: 99.5 }],
      },
      SETTINGS,
    );
    expect(result?.details?.amount).toEqual({ amountMinor: 9950, currency: "EUR" });
    expect(result?.details?.consequence).toBe(
      "Create a €99.50 invoice for QuickBooks customer 58 (not sent)",
    );
  });

  it("records a payment as financial, applied to the invoices its lines link", () => {
    expect(classifyQuickBooks("QUICKBOOKS_CREATE_PAYMENT", PAYMENT_INPUT, SETTINGS)).toEqual({
      actionClass: "financial",
      operation: "quickbooks.payments.create",
      title: "Record payment in QuickBooks",
      details: {
        consequence:
          "Record a $1,980.00 payment from QuickBooks customer 63 against QuickBooks invoice 151",
        facts: [
          { label: "Amount", value: "$1,980.00" },
          { label: "Customer", value: "QuickBooks customer 63 (not read in this run)" },
          {
            label: "Applied to",
            value: "$1,980.00 to QuickBooks invoice 151 (not read in this run)",
          },
          { label: "Date received", value: "2026-09-10" },
          { label: "Reference", value: "ch_KAmer_0910" },
        ],
        amount: { amountMinor: 198_000, currency: "USD" },
        recordIds: ["63", "151"],
      },
    });
    const unapplied = classifyQuickBooks(
      "QUICKBOOKS_CREATE_PAYMENT",
      { customer_id: "63", total_amt: 100, lines: [] },
      SETTINGS,
    );
    expect(unapplied?.details?.facts).toContainEqual({ label: "Applied to", value: "Unapplied" });
    const partly = classifyQuickBooks(
      "QUICKBOOKS_CREATE_PAYMENT",
      {
        customer_id: "63",
        total_amt: 2000,
        lines: [{ Amount: 1980, LinkedTxn: [{ TxnId: "151", TxnType: "Invoice" }] }],
      },
      SETTINGS,
    );
    expect(partly?.details?.facts).toContainEqual({ label: "Unapplied", value: "$20.00" });
  });

  it("shows a payment line linked to a credit memo, not as unapplied", () => {
    const withCredit = classifyQuickBooks(
      "QUICKBOOKS_CREATE_PAYMENT",
      {
        customer_id: "63",
        total_amt: 1500,
        lines: [
          { Amount: 1980, LinkedTxn: [{ TxnId: "151", TxnType: "Invoice" }] },
          { Amount: 480, LinkedTxn: [{ TxnId: "12", TxnType: "CreditMemo" }] },
        ],
      },
      SETTINGS,
    );
    expect(withCredit?.details?.consequence).toBe(
      "Record a $1,500.00 payment from QuickBooks customer 63 against QuickBooks invoice 151 and QuickBooks credit memo 12",
    );
    expect(withCredit?.details?.facts).toContainEqual({
      label: "Applied to",
      value: "$480.00 to QuickBooks credit memo 12",
    });
    expect(withCredit?.details?.facts).not.toContainEqual({
      label: "Applied to",
      value: "Unapplied",
    });
    expect(withCredit?.details?.facts.map((fact) => fact.label)).not.toContain("Unapplied");
    const creditOnly = classifyQuickBooks(
      "QUICKBOOKS_CREATE_PAYMENT",
      {
        customer_id: "63",
        total_amt: 500,
        lines: [{ Amount: 480, LinkedTxn: [{ TxnId: "12", TxnType: "CreditMemo" }] }],
      },
      SETTINGS,
    );
    expect(creditOnly?.details?.facts).toEqual(
      expect.arrayContaining([
        { label: "Applied to", value: "$480.00 to QuickBooks credit memo 12" },
        { label: "Unapplied", value: "$20.00" },
      ]),
    );
    expect(creditOnly?.details?.facts).not.toContainEqual({
      label: "Applied to",
      value: "Unapplied",
    });
  });

  it("denies unknown tools, card charges and inputs it cannot total", () => {
    expect(classifyQuickBooks("QUICKBOOKS_DELETE_ITEM", {}, SETTINGS)).toBeNull();
    expect(classifyQuickBooks("send_invoice", { invoice_id: "1" }, SETTINGS)).toBeNull();
    expect(classifyQuickBooks("toString", {}, SETTINGS)).toBeNull();
    expect(
      classifyQuickBooks(
        "QUICKBOOKS_CREATE_PAYMENT",
        { ...PAYMENT_INPUT, process_payment: true },
        SETTINGS,
      ),
    ).toBeNull();
    expect(
      classifyQuickBooks(
        "QUICKBOOKS_CREATE_PAYMENT",
        { ...PAYMENT_INPUT, credit_card_payment: { CreditChargeInfo: {} } },
        SETTINGS,
      ),
    ).toBeNull();
    expect(
      classifyQuickBooks("QUICKBOOKS_CREATE_PAYMENT", { customer_id: "63", lines: [] }, SETTINGS),
    ).toBeNull();
    for (const lines of [[], [{ DetailType: "SalesItemLineDetail" }], ["x"], [{ Amount: -5 }]]) {
      expect(
        classifyQuickBooks("QUICKBOOKS_CREATE_INVOICE", { customer_id: "58", lines }, SETTINGS),
        JSON.stringify(lines),
      ).toBeNull();
    }
    expect(
      classifyQuickBooks(
        "QUICKBOOKS_CREATE_INVOICE",
        { customer_id: "Acme", lines: [{ Amount: 1 }] },
        SETTINGS,
      ),
    ).toBeNull();
  });
});

describe("QuickBooks input rules", () => {
  it("needs a decimal Amount on every invoice line, and at least one line", () => {
    expect(
      checkQuickBooksInput("QUICKBOOKS_CREATE_INVOICE", {
        customer_id: "58",
        lines: [{ DetailType: "SalesItemLineDetail", Amount: 10 }],
      }),
    ).toEqual([]);
    expect(
      checkQuickBooksInput("QUICKBOOKS_CREATE_INVOICE", {
        customer_id: "58",
        lines: [{ DetailType: "SalesItemLineDetail", Amount: 10 }, { Description: "no amount" }],
      }).map((issue) => issue.path),
    ).toEqual(["/lines/1/Amount"]);
    expect(
      checkQuickBooksInput("QUICKBOOKS_CREATE_INVOICE", { customer_id: "58", lines: [] })[0]
        ?.message,
    ).toMatch(/^is empty: give at least one line/);
  });

  it("refuses a payment that would charge a card, and leaves other tools alone", () => {
    expect(checkQuickBooksInput("QUICKBOOKS_CREATE_PAYMENT", PAYMENT_INPUT)).toEqual([]);
    expect(
      checkQuickBooksInput("QUICKBOOKS_CREATE_PAYMENT", {
        ...PAYMENT_INPUT,
        process_payment: true,
        credit_card_payment: {},
      }).map((issue) => issue.path),
    ).toEqual(["/process_payment", "/credit_card_payment"]);
    expect(
      checkQuickBooksInput("QUICKBOOKS_CREATE_PAYMENT", {
        ...PAYMENT_INPUT,
        process_payment: false,
      }),
    ).toEqual([]);
    expect(checkQuickBooksInput("QUICKBOOKS_QUERY_INVOICES", { lines: [] })).toEqual([]);
  });

  it("needs QuickBooks Ids for the customer and each linked transaction, never a name", () => {
    expect(
      checkQuickBooksInput("QUICKBOOKS_CREATE_INVOICE", {
        customer_id: "Acme",
        lines: [{ DetailType: "SalesItemLineDetail", Amount: 10 }],
      }).map((issue) => `${issue.path} ${issue.message}`),
    ).toEqual([
      '/customer_id is not a QuickBooks customer Id: use the Id (digits, e.g. "58") from a customer search or read, not the name',
    ]);
    expect(
      checkQuickBooksInput("QUICKBOOKS_CREATE_PAYMENT", {
        ...PAYMENT_INPUT,
        customer_id: "Acme",
        lines: [{ Amount: 1980, LinkedTxn: [{ TxnId: "INV-1051", TxnType: "Invoice" }] }],
      }).map((issue) => issue.path),
    ).toEqual(["/customer_id", "/lines/0/LinkedTxn/0/TxnId"]);
  });
});

describe("QuickBooks cards with what the run read (QuickBooksRunMemory)", () => {
  it("records a payment by the customer's name and the invoice number, with its open balance", () => {
    const memory = new QuickBooksRunMemory(SETTINGS);
    memory.record("QUICKBOOKS_QUERY_INVOICES", { status: "Overdue" }, INVOICES, false);
    const card = memory.refine("QUICKBOOKS_CREATE_PAYMENT", PAYMENT_INPUT, {
      actionClass: "read",
      operation: "quickbooks.payments.create",
      title: "x",
    });
    expect(card.details).toMatchObject({
      consequence: "Record a $1,980.00 payment from Customer A against invoice 1051",
      recordIds: ["63", "151"],
    });
    expect(card.details?.facts).toEqual([
      { label: "Amount", value: "$1,980.00" },
      { label: "Customer", value: "Customer A (QuickBooks customer 63)" },
      {
        label: "Applied to",
        value: "$1,980.00 to invoice 1051 (QuickBooks id 151), open balance $1,980.00",
      },
      { label: "Date received", value: "2026-09-10" },
      { label: "Reference", value: "ch_KAmer_0910" },
    ]);
  });

  it("names customers from searches, reads and the customer the run created", () => {
    const memory = new QuickBooksRunMemory(SETTINGS);
    memory.record(
      "QUICKBOOKS_QUERY_CUSTOMERS",
      { query: "SELECT * FROM Customer WHERE DisplayName LIKE 'Fabrikam%'" },
      ok({ QueryResponse: { Customer: [{ Id: "58", DisplayName: "Fabrikam Inc" }] } }),
      false,
    );
    memory.record(
      "QUICKBOOKS_CREATE_CUSTOMER",
      { display_name: "Customer C Inc" },
      ok({ Customer: { Id: "68", DisplayName: "Customer C Inc" }, time: "t" }),
      false,
    );
    memory.record(
      "QUICKBOOKS_READ_CUSTOMER",
      { customer_id: "61" },
      ok({
        Id: "61",
        DisplayName: "Customer B",
        PrimaryEmailAddr: { Address: "a@c.test" },
      }),
      false,
    );
    const invoice = (customer: string) =>
      memory.refine(
        "QUICKBOOKS_CREATE_INVOICE",
        { customer_id: customer, lines: [{ DetailType: "SalesItemLineDetail", Amount: 18000 }] },
        { actionClass: "read", operation: "quickbooks.invoices.create", title: "x" },
      ).details;
    expect(invoice("68")?.consequence).toBe(
      "Create a $18,000.00 invoice for Customer C Inc (not sent)",
    );
    expect(invoice("68")?.facts[0]).toEqual({
      label: "Customer",
      value: "Customer C Inc (QuickBooks customer 68)",
    });
    expect(invoice("58")?.consequence).toContain("Fabrikam Inc");
    expect(invoice("61")?.consequence).toContain("Customer B");
    expect(memory.customer("61")?.email).toBe("a@c.test");
  });

  it("flags a payment above the open balance and one against another customer's invoice", () => {
    const memory = new QuickBooksRunMemory(SETTINGS);
    memory.record("QUICKBOOKS_QUERY_INVOICES", {}, INVOICES, false);
    const card = memory.refine(
      "QUICKBOOKS_CREATE_PAYMENT",
      {
        customer_id: "63",
        total_amt: 4000,
        lines: [{ Amount: 4000, LinkedTxn: [{ TxnId: "143", TxnType: "Invoice" }] }],
      },
      { actionClass: "read", operation: "quickbooks.payments.create", title: "x" },
    );
    expect(card.details?.facts.slice(0, 2)).toEqual([
      {
        label: "Mismatch",
        value: "invoice 1043 belongs to Customer B, not this customer",
      },
      {
        label: "Check",
        value: "The payment to invoice 1043 is more than its open balance of $3,600.00.",
      },
    ]);
  });

  it("learns only from successful QuickBooks results, never from the model's inputs", () => {
    const memory = new QuickBooksRunMemory(SETTINGS);
    memory.record(
      "QUICKBOOKS_CREATE_CUSTOMER",
      { display_name: "Invented By The Model" },
      { successful: false, data: {}, error: "Duplicate Name Exists Error" },
      true,
    );
    memory.record(
      "QUICKBOOKS_QUERY_INVOICES",
      {},
      { successful: false, data: { Invoice: [INVOICE_A] }, error: "boom" },
      false,
    );
    memory.record("QUICKBOOKS_CREATE_PAYMENT", PAYMENT_INPUT, "Unauthorized", true);
    expect(memory.invoice("151")).toBeUndefined();
    expect(memory.customer("63")).toBeUndefined();
    expect(memory.paymentsInRun("151")).toEqual([]);
    const card = memory.refine(
      "QUICKBOOKS_CREATE_INVOICE",
      { customer_id: "68", lines: [{ Amount: 1 }] },
      { actionClass: "read", operation: "quickbooks.invoices.create", title: "x" },
    );
    expect(card.details?.consequence).toBe(
      "Create a $1.00 invoice for QuickBooks customer 68 (not sent)",
    );
  });

  it("shows the balance after the run's own payment, so a second one is not a duplicate by accident", () => {
    const memory = new QuickBooksRunMemory(SETTINGS);
    memory.record("QUICKBOOKS_READ_INVOICE", { invoice_id: "151" }, ok(INVOICE_A), false);
    // QUICKBOOKS_CREATE_PAYMENT answers the payment itself, amounts as strings.
    memory.record(
      "QUICKBOOKS_CREATE_PAYMENT",
      PAYMENT_INPUT,
      ok({
        Id: "90",
        TotalAmt: "1980.00",
        CustomerRef: { value: "63" },
        Line: [{ Amount: "1980.00", LinkedTxn: [{ TxnId: "151", TxnType: "Invoice" }] }],
      }),
      false,
    );
    expect(memory.invoice("151")?.balanceMinor).toBe(0);
    expect(memory.paymentsInRun("151")).toEqual([
      { id: "90", amountMinor: 198_000, uncertain: false },
    ]);
    const second = memory.refine("QUICKBOOKS_CREATE_PAYMENT", PAYMENT_INPUT, {
      actionClass: "read",
      operation: "quickbooks.payments.create",
      title: "x",
    });
    expect(second.details?.facts).toEqual(
      expect.arrayContaining([
        {
          label: "Check",
          value:
            "invoice 1051 has no open balance; this payment would be left unapplied or refused.",
        },
        {
          label: "Payment recorded in this run",
          value: "$1,980.00 (payment 90) to invoice 1051",
        },
      ]),
    );
    expect(second.details?.facts[0]?.label).toBe("Check");
  });

  it("names a payment sent without an answer as possibly applied", () => {
    const memory = new QuickBooksRunMemory(SETTINGS);
    memory.record("QUICKBOOKS_QUERY_INVOICES", {}, INVOICES, false);
    // The Composio session MCP failed mid-call: the gateway reports outcome_unknown.
    memory.record(
      "QUICKBOOKS_CREATE_PAYMENT",
      PAYMENT_INPUT,
      "The quickbooks MCP server gave no result (socket hang up). This change may already have been made.",
      true,
      { provider: "quickbooks", status: null, code: OUTCOME_UNKNOWN, message: "no result" },
    );
    expect(memory.paymentsInRun("151")).toEqual([
      { id: null, amountMinor: 198_000, uncertain: true },
    ]);
    const card = memory.refine("QUICKBOOKS_CREATE_PAYMENT", PAYMENT_INPUT, {
      actionClass: "read",
      operation: "quickbooks.payments.create",
      title: "x",
    });
    expect(card.details?.facts).toContainEqual({
      label: "May already be applied",
      value:
        "$1,980.00 sent in this run to invoice 1051 got no answer from QuickBooks. Check its payments before approving another.",
    });
    // A plain failure is not remembered as a payment.
    const plain = new QuickBooksRunMemory(SETTINGS);
    plain.record("QUICKBOOKS_CREATE_PAYMENT", PAYMENT_INPUT, "refused", true, {
      provider: "quickbooks",
      status: null,
      code: null,
      message: "refused",
    });
    expect(plain.paymentsInRun("151")).toEqual([]);
  });

  it("names a customer seen only through an invoice's or payment's reference", () => {
    const memory = new QuickBooksRunMemory(SETTINGS);
    memory.record(
      "QUICKBOOKS_QUERY_PAYMENTS",
      { query: "SELECT * FROM Payment" },
      ok({
        QueryResponse: { Payment: [{ Id: "80", CustomerRef: { value: "66", name: "Soylent" } }] },
      }),
      false,
    );
    memory.record("QUICKBOOKS_QUERY_INVOICES", {}, INVOICES, false);
    expect(memory.customer("66")?.displayName).toBe("Soylent");
    expect(memory.customer("63")?.displayName).toBe("Customer A");
    // A full customer record already known is not replaced by a reference.
    memory.record(
      "QUICKBOOKS_READ_CUSTOMER",
      { customer_id: "61" },
      ok({ Id: "61", DisplayName: "Customer B LLC" }),
      false,
    );
    memory.record("QUICKBOOKS_QUERY_INVOICES", {}, INVOICES, false);
    expect(memory.customer("61")?.displayName).toBe("Customer B LLC");
  });

  it("keeps what an earlier result said when a later one leaves it out", () => {
    const memory = new QuickBooksRunMemory(SETTINGS);
    memory.record("QUICKBOOKS_READ_INVOICE", { invoice_id: "151" }, ok(INVOICE_A), false);
    // QUICKBOOKS_QUERY_INVOICES with a narrow SELECT returns fewer fields.
    memory.record(
      "QUICKBOOKS_QUERY_INVOICES",
      { query: "SELECT Id, Balance FROM Invoice" },
      ok({ Invoice: [{ Id: "151", Balance: 480 }] }),
      false,
    );
    expect(memory.invoice("151")).toMatchObject({
      docNumber: "1051",
      billEmail: "ap@customer-a.example",
      balanceMinor: 48_000,
      totalMinor: 198_000,
    });
  });
});
