// Classifies QuickBooks tool calls (docs/ARCHITECTURE.md §2, §7). Reads are
// read; creating a customer is internal_write; invoices and payments are
// financial and carry the amount, customer and recipients.

import type {
  ApprovalFact,
  Classification,
  ClassifierSettings,
} from "../../contracts/integration.js";
import type { JsonObject } from "../../contracts/json.js";
import { formatMoney, money } from "../shared/money.js";
import { fromSpec, specOf } from "../shared/profile.js";
import { countOf, preview } from "../shared/text.js";
import { QUICKBOOKS_PROFILE } from "./profile.js";
import {
  createCustomerInput,
  createInvoiceInput,
  invoiceTotalMinor,
  recordPaymentInput,
  sendInvoiceInput,
  voidInvoiceInput,
} from "./schemas.js";

function createCustomer(input: JsonObject): Classification | null {
  const parsed = createCustomerInput.safeParse(input);
  if (!parsed.success) return null;
  const { display_name: name, email } = parsed.data;
  const facts: ApprovalFact[] = [{ label: "Customer", value: name }];
  if (email !== undefined) facts.push({ label: "Billing email", value: email });
  return {
    actionClass: "internal_write",
    operation: "quickbooks.customers.create",
    title: "Create customer in QuickBooks",
    details: { consequence: `Create QuickBooks customer "${preview(name, 80)}"`, facts },
  };
}

function createInvoice(input: JsonObject, settings: ClassifierSettings): Classification | null {
  const parsed = createInvoiceInput.safeParse(input);
  if (!parsed.success) return null;
  const { customer_id: customer, lines, due_date: due, bill_email: billEmail } = parsed.data;
  const amount = money(invoiceTotalMinor(lines), settings.currency);
  const total = formatMoney(amount);
  const facts: ApprovalFact[] = [
    { label: "Customer", value: customer },
    { label: "Total", value: total },
    { label: "Lines", value: countOf(lines.length, "line") },
  ];
  lines.slice(0, 5).forEach((line, index) => {
    const unit = formatMoney(money(line.unit_price_minor, settings.currency));
    const label =
      line.description === undefined ? `Line ${index + 1}` : preview(line.description, 60);
    facts.push({ label, value: `${line.quantity} x ${unit}` });
  });
  if (due !== undefined) facts.push({ label: "Due", value: due });
  if (parsed.data.doc_number !== undefined) {
    facts.push({ label: "Invoice number", value: parsed.data.doc_number });
  }
  if (billEmail !== undefined) facts.push({ label: "Bill to", value: billEmail });
  return {
    actionClass: "financial",
    operation: "quickbooks.invoices.create",
    title: "Create invoice in QuickBooks",
    details: {
      consequence: `Create a ${total} invoice for QuickBooks customer ${customer} (not sent)`,
      facts,
      amount,
      recordIds: [customer],
    },
  };
}

function sendInvoice(input: JsonObject): Classification | null {
  const parsed = sendInvoiceInput.safeParse(input);
  if (!parsed.success) return null;
  const { invoice_id: invoice, send_to: sendTo } = parsed.data;
  const recipient = sendTo ?? "the invoice's billing email";
  return {
    actionClass: "financial",
    operation: "quickbooks.invoices.send",
    title: "Send invoice from QuickBooks",
    details: {
      consequence: `Email QuickBooks invoice ${invoice} to ${recipient}`,
      facts: [
        { label: "Invoice", value: invoice },
        { label: "Recipient", value: recipient },
      ],
      ...(sendTo === undefined ? {} : { recipients: [sendTo] }),
      recordIds: [invoice],
    },
  };
}

function recordPayment(input: JsonObject, settings: ClassifierSettings): Classification | null {
  const parsed = recordPaymentInput.safeParse(input);
  if (!parsed.success) return null;
  const { customer_id: customer, invoice_id: invoice, amount_minor: amountMinor } = parsed.data;
  const amount = money(amountMinor, settings.currency);
  const formatted = formatMoney(amount);
  const facts: ApprovalFact[] = [
    { label: "Amount", value: formatted },
    { label: "Customer", value: customer },
    { label: "Applied to", value: invoice === undefined ? "Unapplied" : `Invoice ${invoice}` },
  ];
  if (parsed.data.payment_date !== undefined) {
    facts.push({ label: "Date received", value: parsed.data.payment_date });
  }
  if (parsed.data.reference !== undefined) {
    facts.push({ label: "Reference", value: parsed.data.reference });
  }
  const against = invoice === undefined ? "" : ` against invoice ${invoice}`;
  return {
    actionClass: "financial",
    operation: "quickbooks.payments.create",
    title: "Record payment in QuickBooks",
    details: {
      consequence: `Record a ${formatted} payment from QuickBooks customer ${customer}${against}`,
      facts,
      amount,
      recordIds: invoice === undefined ? [customer] : [customer, invoice],
    },
  };
}

function voidInvoice(input: JsonObject): Classification | null {
  const parsed = voidInvoiceInput.safeParse(input);
  if (!parsed.success) return null;
  const invoice = parsed.data.invoice_id;
  return {
    actionClass: "financial",
    operation: "quickbooks.invoices.void",
    title: "Void invoice in QuickBooks",
    details: {
      consequence: `Void QuickBooks invoice ${invoice}; its amounts become zero`,
      facts: [
        { label: "Invoice", value: invoice },
        { label: "Effect", value: "Amounts set to zero; cannot be undone" },
      ],
      recordIds: [invoice],
    },
  };
}

export function classifyQuickBooks(
  tool: string,
  input: JsonObject,
  settings: ClassifierSettings,
): Classification | null {
  const spec = specOf(QUICKBOOKS_PROFILE, tool);
  if (spec === undefined) return null;
  switch (spec.name) {
    case "create_customer":
      return createCustomer(input);
    case "create_invoice":
      return createInvoice(input, settings);
    case "send_invoice":
      return sendInvoice(input);
    case "record_payment":
      return recordPayment(input, settings);
    case "void_invoice":
      return voidInvoice(input);
    default:
      return fromSpec(spec);
  }
}
