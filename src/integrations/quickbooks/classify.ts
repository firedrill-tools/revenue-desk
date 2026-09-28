// Classifies QuickBooks tool calls (docs/ARCHITECTURE.md §2, §7). Reads are
// read; creating a customer is internal_write; invoices and payments are
// financial and carry the amount, customer and recipients.
//
// The writes name records by QuickBooks id ("customer 63", "invoice 151"),
// which a person approving does not know: they know "Meridian Labs" and
// invoice number 1051. With what the run's earlier QuickBooks calls returned
// (QuickBooksRunMemory in run-memory.ts, `known` here), the card names the
// customer, the invoice number, its amount and, for sending, the billing
// email it goes to. Names come only from QuickBooks' own results, never from
// the model; a record the run has not seen keeps its id and says so.

import type {
  ApprovalFact,
  Classification,
  ClassifierSettings,
  Money,
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

/** A customer as an earlier QuickBooks result in this run described it. */
export type KnownCustomer = {
  readonly id: string;
  readonly displayName: string | null;
  readonly email: string | null;
};

/** An invoice as an earlier QuickBooks result in this run described it. */
export type KnownInvoice = {
  readonly id: string;
  readonly docNumber: string | null;
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly billEmail: string | null;
  readonly totalMinor: number | null;
  readonly balanceMinor: number | null;
  readonly currency: string | null;
};

/** A payment this run recorded against an invoice, or sent without QuickBooks' answer. */
export type RunPayment = {
  /** QuickBooks' payment id; null when the answer never came. */
  readonly id: string | null;
  readonly amountMinor: number;
  /** Sent, but QuickBooks' answer never arrived: it may have been recorded. */
  readonly uncertain: boolean;
};

/** Lookups into what the run's earlier QuickBooks calls returned. */
export interface QuickBooksKnown {
  customer(id: string): KnownCustomer | undefined;
  invoice(id: string): KnownInvoice | undefined;
  /** Payments this run recorded (or may have recorded) against an invoice. */
  paymentsInRun(invoiceId: string): readonly RunPayment[];
}

const NOTHING_KNOWN: QuickBooksKnown = {
  customer: () => undefined,
  invoice: () => undefined,
  paymentsInRun: () => [],
};

function customerName(id: string, known: QuickBooksKnown): string | null {
  const customer = known.customer(id);
  if (customer?.displayName !== null && customer?.displayName !== undefined) {
    return preview(customer.displayName, 80);
  }
  return null;
}

/** "Meridian Labs" when the run saw the customer, otherwise "QuickBooks customer 63". */
function customerLabel(id: string, known: QuickBooksKnown): string {
  return customerName(id, known) ?? `QuickBooks customer ${id}`;
}

/** The Customer fact: "Meridian Labs (QuickBooks customer 63)", or the id alone. */
function customerFact(id: string, known: QuickBooksKnown): ApprovalFact {
  const name = customerName(id, known);
  return { label: "Customer", value: name === null ? id : `${name} (QuickBooks customer ${id})` };
}

/** "invoice 1051" when the run saw its number, otherwise "QuickBooks invoice 151". */
function invoiceLabel(id: string, known: QuickBooksKnown): string {
  const docNumber = known.invoice(id)?.docNumber ?? null;
  return docNumber === null ? `QuickBooks invoice ${id}` : `invoice ${docNumber}`;
}

function invoiceMoney(invoice: KnownInvoice, minor: number | null, fallback: string): Money | null {
  return minor === null ? null : money(minor, invoice.currency ?? fallback);
}

/** Facts about an invoice the run saw: number, customer, total and open balance. */
function invoiceFacts(id: string, known: QuickBooksKnown, currency: string): ApprovalFact[] {
  const invoice = known.invoice(id);
  if (invoice === undefined) {
    return [{ label: "Invoice", value: `QuickBooks id ${id} (not read in this run)` }];
  }
  const facts: ApprovalFact[] = [
    {
      label: "Invoice",
      value:
        invoice.docNumber === null
          ? `QuickBooks id ${id}`
          : `${invoice.docNumber} (QuickBooks id ${id})`,
    },
  ];
  if (invoice.customerId !== null) {
    const name = customerName(invoice.customerId, known) ?? invoice.customerName;
    facts.push({
      label: "Customer",
      value:
        name === null
          ? invoice.customerId
          : `${preview(name, 80)} (QuickBooks customer ${invoice.customerId})`,
    });
  }
  const total = invoiceMoney(invoice, invoice.totalMinor, currency);
  if (total !== null) facts.push({ label: "Invoice total", value: formatMoney(total) });
  const balance = invoiceMoney(invoice, invoice.balanceMinor, currency);
  if (balance !== null) facts.push({ label: "Open balance", value: formatMoney(balance) });
  return facts;
}

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

function createInvoice(
  input: JsonObject,
  settings: ClassifierSettings,
  known: QuickBooksKnown,
): Classification | null {
  const parsed = createInvoiceInput.safeParse(input);
  if (!parsed.success) return null;
  const { customer_id: customer, lines, due_date: due, bill_email: billEmail } = parsed.data;
  const amount = money(invoiceTotalMinor(lines), settings.currency);
  const total = formatMoney(amount);
  const facts: ApprovalFact[] = [
    customerFact(customer, known),
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
      consequence: `Create a ${total} invoice for ${customerLabel(customer, known)} (not sent)`,
      facts,
      amount,
      recordIds: [customer],
    },
  };
}

export const UNCONFIRMED_BILL_EMAIL =
  "The invoice's billing email, which was not read in this run. Check it in QuickBooks before approving.";

function sendInvoice(
  input: JsonObject,
  settings: ClassifierSettings,
  known: QuickBooksKnown,
): Classification | null {
  const parsed = sendInvoiceInput.safeParse(input);
  if (!parsed.success) return null;
  const { invoice_id: invoice, send_to: sendTo } = parsed.data;
  const seen = known.invoice(invoice);
  // send_to overrides the invoice's billing email; without it, QuickBooks uses the one saved on
  // the invoice, which only a read in this run can confirm.
  const recipient = sendTo ?? seen?.billEmail ?? null;
  const facts = invoiceFacts(invoice, known, settings.currency);
  facts.push({ label: "Recipient", value: recipient ?? UNCONFIRMED_BILL_EMAIL });
  const total = seen === undefined ? null : invoiceMoney(seen, seen.totalMinor, settings.currency);
  const customer =
    seen?.customerId === null || seen?.customerId === undefined
      ? null
      : (customerName(seen.customerId, known) ?? seen.customerName);
  const about = [
    total === null ? null : formatMoney(total),
    customer === null ? null : preview(customer, 80),
  ]
    .filter((part) => part !== null)
    .join(", ");
  const what = `${invoiceLabel(invoice, known)}${about === "" ? "" : ` (${about})`}`;
  return {
    actionClass: "financial",
    operation: "quickbooks.invoices.send",
    title: "Send invoice from QuickBooks",
    details: {
      consequence:
        recipient === null
          ? `Email ${what} to its billing email, which could not be confirmed`
          : `Email ${what} to ${recipient}`,
      facts,
      ...(recipient === null ? {} : { recipients: [recipient] }),
      ...(total === null ? {} : { amount: total }),
      recordIds: [invoice],
    },
  };
}

function recordPayment(
  input: JsonObject,
  settings: ClassifierSettings,
  known: QuickBooksKnown,
): Classification | null {
  const parsed = recordPaymentInput.safeParse(input);
  if (!parsed.success) return null;
  const { customer_id: customer, invoice_id: invoice, amount_minor: amountMinor } = parsed.data;
  const amount = money(amountMinor, settings.currency);
  const formatted = formatMoney(amount);
  const facts: ApprovalFact[] = [
    { label: "Amount", value: formatted },
    customerFact(customer, known),
  ];
  if (invoice === undefined) {
    facts.push({ label: "Applied to", value: "Unapplied" });
  } else {
    const seen = known.invoice(invoice);
    const balance =
      seen === undefined ? null : invoiceMoney(seen, seen.balanceMinor, settings.currency);
    const number = seen?.docNumber ?? null;
    facts.push({
      label: "Applied to",
      value:
        (number === null
          ? `QuickBooks invoice ${invoice}`
          : `Invoice ${number} (QuickBooks id ${invoice})`) +
        (balance === null ? "" : `, open balance ${formatMoney(balance)}`),
    });
    if (
      seen?.customerId !== null &&
      seen?.customerId !== undefined &&
      seen.customerId !== customer
    ) {
      facts.push({
        label: "Mismatch",
        value: `The invoice belongs to ${customerLabel(seen.customerId, known)}, not this customer`,
      });
    }
    const payments = known.paymentsInRun(invoice);
    const recorded = payments.filter((payment) => !payment.uncertain);
    if (recorded.length > 0) {
      facts.push({
        label: "Payment recorded in this run",
        value: recorded
          .map(
            (payment) =>
              `${formatMoney(money(payment.amountMinor, seen?.currency ?? settings.currency))}${payment.id === null ? "" : ` (payment ${payment.id})`}`,
          )
          .join(", "),
      });
    }
    const unanswered = payments.filter((payment) => payment.uncertain);
    if (unanswered.length > 0) {
      facts.push({
        label: "May already be applied",
        value: `${unanswered
          .map((payment) =>
            formatMoney(money(payment.amountMinor, seen?.currency ?? settings.currency)),
          )
          .join(
            ", ",
          )} sent in this run got no answer from QuickBooks. Check the invoice's payments before approving another.`,
      });
    }
    if (balance !== null && amountMinor > balance.amountMinor) {
      facts.unshift({
        label: "Check",
        value:
          balance.amountMinor === 0
            ? "The invoice has no open balance; this payment would be left unapplied or refused."
            : `The payment is more than the invoice's open balance of ${formatMoney(balance)}.`,
      });
    }
  }
  if (parsed.data.payment_date !== undefined) {
    facts.push({ label: "Date received", value: parsed.data.payment_date });
  }
  if (parsed.data.reference !== undefined) {
    facts.push({ label: "Reference", value: parsed.data.reference });
  }
  const against = invoice === undefined ? "" : ` against ${invoiceLabel(invoice, known)}`;
  return {
    actionClass: "financial",
    operation: "quickbooks.payments.create",
    title: "Record payment in QuickBooks",
    details: {
      consequence: `Record a ${formatted} payment from ${customerLabel(customer, known)}${against}`,
      facts,
      amount,
      recordIds: invoice === undefined ? [customer] : [customer, invoice],
    },
  };
}

function voidInvoice(
  input: JsonObject,
  settings: ClassifierSettings,
  known: QuickBooksKnown,
): Classification | null {
  const parsed = voidInvoiceInput.safeParse(input);
  if (!parsed.success) return null;
  const invoice = parsed.data.invoice_id;
  return {
    actionClass: "financial",
    operation: "quickbooks.invoices.void",
    title: "Void invoice in QuickBooks",
    details: {
      consequence: `Void ${invoiceLabel(invoice, known)}; its amounts become zero`,
      facts: [
        ...invoiceFacts(invoice, known, settings.currency),
        { label: "Effect", value: "Amounts set to zero; cannot be undone" },
      ],
      recordIds: [invoice],
    },
  };
}

/**
 * The classification of a QuickBooks call. `known` holds what the run's
 * earlier QuickBooks calls returned (QuickBooksRunMemory); without it, cards
 * name records by id.
 */
export function classifyQuickBooks(
  tool: string,
  input: JsonObject,
  settings: ClassifierSettings,
  known: QuickBooksKnown = NOTHING_KNOWN,
): Classification | null {
  const spec = specOf(QUICKBOOKS_PROFILE, tool);
  if (spec === undefined) return null;
  switch (spec.name) {
    case "create_customer":
      return createCustomer(input);
    case "create_invoice":
      return createInvoice(input, settings, known);
    case "send_invoice":
      return sendInvoice(input, settings, known);
    case "record_payment":
      return recordPayment(input, settings, known);
    case "void_invoice":
      return voidInvoice(input, settings, known);
    default:
      return fromSpec(spec);
  }
}
