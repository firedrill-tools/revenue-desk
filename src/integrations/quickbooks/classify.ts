// Classifies QuickBooks calls (Composio, docs/ARCHITECTURE.md §2, §7). Reads
// are read; creating a customer is internal_write, unless it books an
// opening balance, which is financial; invoices and payments are financial
// and carry the amount and the customer.
//
// The writes name records by QuickBooks id ("customer 63", invoice id
// "151"), which a person approving does not know: they know "Acme Inc"
// and invoice number 1051. With what the run's earlier QuickBooks calls
// returned (QuickBooksRunMemory in run-memory.ts, `known` here), the card
// names the customer, the invoice number and its open balance. Names come
// only from QuickBooks' own results, never from the model's input (the
// payment tool's `customer_name` is ignored); a record the run has not seen
// keeps its id and says so.
//
// Amounts in QuickBooks tools are decimals in the company currency; cards
// show them formatted, and Money carries them in minor units.
//
// Denied (null): a payment that would charge a card through QuickBooks
// Payments, and an invoice whose lines give no amounts (the input rules in
// input-rules.ts reject both first, with a message).

import type {
  ApprovalFact,
  Classification,
  ClassifierSettings,
  Money,
} from "../../contracts/integration.js";
import type { JsonObject } from "../../contracts/json.js";
import { arr, field, isObject, obj, objects, str } from "../shared/json.js";
import { decimalToMinor, formatMoney, money } from "../shared/money.js";
import { fromSpec, specOf } from "../shared/profile.js";
import { countOf, listOf, preview } from "../shared/text.js";
import { QUICKBOOKS_PROFILE } from "./profile.js";
import {
  type AppliedPayment,
  appliedFrom,
  decimal,
  type KnownCustomer,
  type KnownInvoice,
  type OtherApplication,
  otherAppliedFrom,
  qboId,
} from "./records.js";

export type { KnownCustomer, KnownInvoice } from "./records.js";

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
  const name = known.customer(id)?.displayName;
  return name === null || name === undefined ? null : preview(name, 80);
}

/** "Acme Inc" when the run saw the customer, otherwise "QuickBooks customer 63". */
function customerLabel(id: string, known: QuickBooksKnown): string {
  return customerName(id, known) ?? `QuickBooks customer ${id}`;
}

/** The Customer fact: "Acme Inc (QuickBooks customer 63)", or the id alone. */
function customerFact(id: string, known: QuickBooksKnown): ApprovalFact {
  const name = customerName(id, known);
  return {
    label: "Customer",
    value:
      name === null
        ? `QuickBooks customer ${id} (not read in this run)`
        : `${name} (QuickBooks customer ${id})`,
  };
}

/** "invoice 1051" when the run saw its number, otherwise "QuickBooks invoice 151". */
function invoiceLabel(id: string, known: QuickBooksKnown): string {
  const docNumber = known.invoice(id)?.docNumber ?? null;
  return docNumber === null ? `QuickBooks invoice ${id}` : `invoice ${docNumber}`;
}

function invoiceMoney(invoice: KnownInvoice, minor: number | null, fallback: string): Money | null {
  return minor === null ? null : money(minor, invoice.currency ?? fallback);
}

/** An email field QuickBooks takes as `{Address}` (or a bare string). */
function address(input: JsonObject, key: string): string | undefined {
  const value = field(input, key);
  if (typeof value === "string") return value.trim() === "" ? undefined : value.trim();
  return str(obj(input, key), "Address");
}

function currencyOf(code: string | undefined, settings: ClassifierSettings): string {
  return (code ?? settings.currency).toUpperCase();
}

// --- Customers ---------------------------------------------------------------

function nameOf(input: JsonObject): string | undefined {
  const person = ["title", "given_name", "middle_name", "family_name", "suffix"]
    .map((key) => str(input, key))
    .filter((part) => part !== undefined);
  return (
    str(input, "display_name") ??
    str(input, "CompanyName") ??
    (person.length > 0 ? person.join(" ") : undefined)
  );
}

function createCustomer(input: JsonObject, settings: ClassifierSettings): Classification {
  const name = nameOf(input);
  const facts: ApprovalFact[] = [{ label: "Customer", value: name ?? "(no name given)" }];
  const company = str(input, "CompanyName");
  if (company !== undefined && company !== name) facts.push({ label: "Company", value: company });
  const email = address(input, "PrimaryEmailAddr");
  if (email !== undefined) facts.push({ label: "Email", value: email });
  const label =
    name === undefined ? "a QuickBooks customer" : `QuickBooks customer "${preview(name, 80)}"`;
  const opening = decimal(field(input, "Balance"));
  if (opening !== undefined && opening !== 0) {
    // An opening balance books receivables the customer owes: money, not a contact record.
    const currency = currencyOf(str(obj(input, "CurrencyRef"), "value"), settings);
    const amount = money(decimalToMinor(opening, currency), currency);
    facts.push({ label: "Opening balance", value: formatMoney(amount) });
    const date = str(input, "OpenBalanceDate");
    if (date !== undefined) facts.push({ label: "As of", value: date });
    return {
      actionClass: "financial",
      operation: "quickbooks.customers.create",
      title: "Create customer in QuickBooks",
      details: {
        consequence: `Create ${label} with an opening balance of ${formatMoney(amount)}`,
        facts,
        amount,
      },
    };
  }
  return {
    actionClass: "internal_write",
    operation: "quickbooks.customers.create",
    title: "Create customer in QuickBooks",
    details: { consequence: `Create ${label}`, facts },
  };
}

// --- Invoices ----------------------------------------------------------------

type InvoiceLine = {
  readonly label: string;
  readonly value: string;
  /** Signed contribution to the total: discounts subtract, subtotals add nothing. */
  readonly totalMinor: number;
};

function invoiceLines(
  input: JsonObject,
  currency: string,
): { readonly lines: InvoiceLine[]; readonly totalMinor: number } | null {
  const raw = arr(input, "lines");
  if (raw === undefined || raw.length === 0) return null;
  const lines: InvoiceLine[] = [];
  let totalMinor = 0;
  for (const [index, entry] of raw.entries()) {
    if (!isObject(entry)) return null;
    const amount = decimal(field(entry, "Amount"));
    if (amount === undefined || amount < 0) return null;
    const amountMinor = decimalToMinor(amount, currency);
    const type = str(entry, "DetailType");
    const detail = obj(entry, "SalesItemLineDetail");
    const item = str(obj(detail, "ItemRef"), "name");
    const description = str(entry, "Description");
    const label = preview(description ?? item ?? `Line ${index + 1}`, 60);
    if (type === "SubTotalLineDetail") continue;
    if (type === "DiscountLineDetail") {
      totalMinor -= amountMinor;
      lines.push({
        label,
        value: `Discount −${formatMoney(money(amountMinor, currency))}`,
        totalMinor: -amountMinor,
      });
      continue;
    }
    totalMinor += amountMinor;
    const quantity = decimal(field(detail, "Qty"));
    const unit = decimal(field(detail, "UnitPrice"));
    lines.push({
      label,
      value:
        quantity !== undefined && unit !== undefined
          ? `${quantity} x ${formatMoney(money(decimalToMinor(unit, currency), currency))}`
          : formatMoney(money(amountMinor, currency)),
      totalMinor: amountMinor,
    });
  }
  return { lines, totalMinor };
}

function createInvoice(
  input: JsonObject,
  settings: ClassifierSettings,
  known: QuickBooksKnown,
): Classification | null {
  const customer = qboId(field(input, "customer_id"));
  if (customer === undefined) return null;
  const currency = currencyOf(str(obj(input, "currency_ref"), "value"), settings);
  const parsed = invoiceLines(input, currency);
  if (parsed === null) return null;
  const amount = money(parsed.totalMinor, currency);
  const total = formatMoney(amount);
  const facts: ApprovalFact[] = [
    customerFact(customer, known),
    { label: "Total before tax", value: total },
    { label: "Lines", value: countOf(parsed.lines.length, "line") },
  ];
  for (const line of parsed.lines.slice(0, 5)) facts.push({ label: line.label, value: line.value });
  const due = str(input, "due_date");
  if (due !== undefined) facts.push({ label: "Due", value: due });
  const date = str(input, "txn_date");
  if (date !== undefined) facts.push({ label: "Invoice date", value: date });
  const number = str(input, "doc_number");
  if (number !== undefined) facts.push({ label: "Invoice number", value: number });
  const billTo = address(input, "bill_email");
  if (billTo !== undefined) facts.push({ label: "Billing email", value: billTo });
  const cc = address(input, "bill_email_cc");
  if (cc !== undefined) facts.push({ label: "Billing Cc", value: cc });
  const bcc = address(input, "bill_email_bcc");
  if (bcc !== undefined) facts.push({ label: "Billing Bcc", value: bcc });
  const memo = str(obj(input, "customer_memo"), "value");
  if (memo !== undefined) facts.push({ label: "Message on invoice", value: preview(memo, 200) });
  facts.push({ label: "Sent", value: "No: QuickBooks does not email it" });
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

// --- Payments ----------------------------------------------------------------

/** "QuickBooks credit memo 12" for a payment line linked to anything but an invoice. */
function otherLabel(other: OtherApplication): string {
  const type = other.txnType === "CreditMemo" ? "credit memo" : preview(other.txnType, 40);
  return `QuickBooks ${type} ${preview(other.txnId, 40)}`;
}

function appliedFact(
  applied: AppliedPayment,
  currency: string,
  known: QuickBooksKnown,
): ApprovalFact {
  const seen = known.invoice(applied.invoiceId);
  const number = seen?.docNumber ?? null;
  const balance = seen === undefined ? null : invoiceMoney(seen, seen.balanceMinor, currency);
  return {
    label: "Applied to",
    value:
      `${formatMoney(money(applied.amountMinor, currency))} to ` +
      (number === null
        ? `QuickBooks invoice ${applied.invoiceId}${seen === undefined ? " (not read in this run)" : ""}`
        : `invoice ${number} (QuickBooks id ${applied.invoiceId})`) +
      (balance === null ? "" : `, open balance ${formatMoney(balance)}`),
  };
}

function createPayment(
  input: JsonObject,
  settings: ClassifierSettings,
  known: QuickBooksKnown,
): Classification | null {
  if (field(input, "process_payment") === true) return null;
  const card = field(input, "credit_card_payment");
  if (card !== undefined && card !== null) return null;
  const customer = qboId(field(input, "customer_id"));
  const totalDecimal = decimal(field(input, "total_amt"));
  if (customer === undefined || totalDecimal === undefined) return null;
  const currency = currencyOf(str(input, "currency_ref_value"), settings);
  const amount = money(decimalToMinor(totalDecimal, currency), currency);
  const formatted = formatMoney(amount);
  const lines = objects(input, "lines");
  const applied = appliedFrom(lines, currency);
  const others = otherAppliedFrom(lines, currency);
  const checks: ApprovalFact[] = [];
  const facts: ApprovalFact[] = [
    { label: "Amount", value: formatted },
    customerFact(customer, known),
  ];
  if (applied.length === 0 && others.length === 0) {
    facts.push({ label: "Applied to", value: "Unapplied" });
  }
  for (const other of others) {
    facts.push({
      label: "Applied to",
      value: `${formatMoney(money(other.amountMinor, currency))} to ${otherLabel(other)}`,
    });
  }
  for (const entry of applied) {
    facts.push(appliedFact(entry, currency, known));
    const seen = known.invoice(entry.invoiceId);
    if (
      seen?.customerId !== null &&
      seen?.customerId !== undefined &&
      seen.customerId !== customer
    ) {
      checks.push({
        label: "Mismatch",
        value: `${invoiceLabel(entry.invoiceId, known)} belongs to ${customerLabel(seen.customerId, known)}, not this customer`,
      });
    }
    const balance = seen === undefined ? null : invoiceMoney(seen, seen.balanceMinor, currency);
    if (balance !== null && entry.amountMinor > balance.amountMinor) {
      checks.push({
        label: "Check",
        value:
          balance.amountMinor === 0
            ? `${invoiceLabel(entry.invoiceId, known)} has no open balance; this payment would be left unapplied or refused.`
            : `The payment to ${invoiceLabel(entry.invoiceId, known)} is more than its open balance of ${formatMoney(balance)}.`,
      });
    }
    const payments = known.paymentsInRun(entry.invoiceId);
    const recorded = payments.filter((payment) => !payment.uncertain);
    if (recorded.length > 0) {
      facts.push({
        label: "Payment recorded in this run",
        value: recorded
          .map(
            (payment) =>
              `${formatMoney(money(payment.amountMinor, seen?.currency ?? currency))}${payment.id === null ? "" : ` (payment ${payment.id})`} to ${invoiceLabel(entry.invoiceId, known)}`,
          )
          .join(", "),
      });
    }
    const unanswered = payments.filter((payment) => payment.uncertain);
    if (unanswered.length > 0) {
      facts.push({
        label: "May already be applied",
        value: `${unanswered
          .map((payment) => formatMoney(money(payment.amountMinor, seen?.currency ?? currency)))
          .join(
            ", ",
          )} sent in this run to ${invoiceLabel(entry.invoiceId, known)} got no answer from QuickBooks. Check its payments before approving another.`,
      });
    }
  }
  const appliedMinor = [...applied, ...others].reduce((sum, entry) => sum + entry.amountMinor, 0);
  if (applied.length + others.length > 0 && appliedMinor < amount.amountMinor) {
    facts.push({
      label: "Unapplied",
      value: formatMoney(money(amount.amountMinor - appliedMinor, currency)),
    });
  }
  const date = str(input, "txn_date");
  if (date !== undefined) facts.push({ label: "Date received", value: date });
  const reference = str(input, "payment_ref_num");
  if (reference !== undefined) facts.push({ label: "Reference", value: reference });
  const invoices = [...new Set(applied.map((entry) => entry.invoiceId))];
  const targets = [
    ...invoices.map((id) => invoiceLabel(id, known)),
    ...new Set(others.map(otherLabel)),
  ];
  const against = targets.length === 0 ? "" : ` against ${listOf(targets)}`;
  return {
    actionClass: "financial",
    operation: "quickbooks.payments.create",
    title: "Record payment in QuickBooks",
    details: {
      consequence: `Record a ${formatted} payment from ${customerLabel(customer, known)}${against}`,
      facts: [...checks, ...facts],
      amount,
      recordIds: [customer, ...invoices],
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
    case "QUICKBOOKS_CREATE_CUSTOMER":
      return createCustomer(input, settings);
    case "QUICKBOOKS_CREATE_INVOICE":
      return createInvoice(input, settings, known);
    case "QUICKBOOKS_CREATE_PAYMENT":
      return createPayment(input, settings, known);
    default:
      return fromSpec(spec);
  }
}
