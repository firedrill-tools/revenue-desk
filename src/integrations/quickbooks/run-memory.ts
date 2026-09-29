// What a run remembers about the QuickBooks records it read (the gateway's
// RunMemory, src/gateway/catalog.ts). The writes name records by QuickBooks
// id, so their approval cards take the customer's name, the invoice number
// and its open balance from this run's earlier QuickBooks results
// (classify.ts), as Composio returned them (records.ts). The run's own
// payments count: a second payment on an invoice must not show the balance
// from before the first. Only QuickBooks' own results are remembered, never
// the model's inputs, and a failed call teaches nothing, except a payment
// sent without an answer (outcome_unknown), which is remembered as possibly
// applied.

import type {
  Classification,
  ClassifierSettings,
  ToolFailure,
} from "../../contracts/integration.js";
import type { JsonObject, JsonValue } from "../../contracts/json.js";
import type { RunMemory } from "../../gateway/catalog.js";
import { OUTCOME_UNKNOWN } from "../../gateway/types.js";
import { asObject, obj, objects, str } from "../shared/json.js";
import { classifyQuickBooks, type QuickBooksKnown, type RunPayment } from "./classify.js";
import {
  appliedFrom,
  customerFrom,
  entitiesOf,
  invoiceFrom,
  type KnownCustomer,
  type KnownInvoice,
  paymentFrom,
} from "./records.js";

const CUSTOMER_RESULTS = new Set([
  "QUICKBOOKS_QUERY_CUSTOMERS",
  "QUICKBOOKS_READ_CUSTOMER",
  "QUICKBOOKS_CREATE_CUSTOMER",
]);
const INVOICE_RESULTS = new Set([
  "QUICKBOOKS_QUERY_INVOICES",
  "QUICKBOOKS_READ_INVOICE",
  "QUICKBOOKS_CREATE_INVOICE",
]);

/** Whether a failed call was sent without an answer (the gateway's outcome_unknown). */
function outcomeUnknown(output: JsonValue, failure: ToolFailure | null | undefined): boolean {
  return (
    failure?.code === OUTCOME_UNKNOWN ||
    str(obj(asObject(output), "error"), "code") === OUTCOME_UNKNOWN
  );
}

export class QuickBooksRunMemory implements RunMemory, QuickBooksKnown {
  readonly #settings: ClassifierSettings;
  readonly #customers = new Map<string, KnownCustomer>();
  readonly #invoices = new Map<string, KnownInvoice>();
  /** This run's payments, by the invoice they were applied to. */
  readonly #payments = new Map<string, RunPayment[]>();

  constructor(settings: ClassifierSettings) {
    this.#settings = settings;
  }

  customer(id: string): KnownCustomer | undefined {
    return this.#customers.get(id);
  }

  invoice(id: string): KnownInvoice | undefined {
    return this.#invoices.get(id);
  }

  paymentsInRun(invoiceId: string): readonly RunPayment[] {
    return this.#payments.get(invoiceId) ?? [];
  }

  record(
    tool: string,
    input: JsonObject,
    output: JsonValue,
    isError: boolean,
    failure?: ToolFailure | null,
  ): void {
    if (isError) {
      if (tool === "QUICKBOOKS_CREATE_PAYMENT" && outcomeUnknown(output, failure)) {
        this.#uncertain(input);
      }
      return;
    }
    const single = !tool.startsWith("QUICKBOOKS_QUERY_");
    if (CUSTOMER_RESULTS.has(tool)) {
      for (const record of entitiesOf(output, "Customer", { single })) this.#learnCustomer(record);
    } else if (INVOICE_RESULTS.has(tool)) {
      for (const record of entitiesOf(output, "Invoice", { single })) this.#learnInvoice(record);
    } else if (tool === "QUICKBOOKS_QUERY_PAYMENTS") {
      for (const record of entitiesOf(output, "Payment")) this.#learnPaymentCustomer(record);
    } else if (tool === "QUICKBOOKS_CREATE_PAYMENT") {
      for (const record of entitiesOf(output, "Payment", { single: true })) {
        this.#learnOwnPayment(record);
      }
    }
  }

  refine(tool: string, input: JsonObject, classification: Classification): Classification {
    return classifyQuickBooks(tool, input, this.#settings, this) ?? classification;
  }

  /**
   * A payment sent without an answer may have been applied to the invoices
   * its input names (a payment without lines names none a card could show).
   */
  #uncertain(input: JsonObject): void {
    const currency = (str(input, "currency_ref_value") ?? this.#settings.currency).toUpperCase();
    for (const entry of appliedFrom(objects(input, "lines"), currency)) {
      this.#addPayment(entry.invoiceId, {
        id: null,
        amountMinor: entry.amountMinor,
        uncertain: true,
      });
    }
  }

  /** A payment this run recorded lowers each invoice it was applied to. */
  #learnOwnPayment(record: JsonObject): void {
    const payment = paymentFrom(record, this.#settings.currency);
    if (payment === null) return;
    this.#learnReference(payment.customerId, payment.customerName);
    for (const entry of payment.applied) {
      this.#addPayment(entry.invoiceId, {
        id: payment.id,
        amountMinor: entry.amountMinor,
        uncertain: false,
      });
      const known = this.#invoices.get(entry.invoiceId);
      if (known?.balanceMinor !== null && known?.balanceMinor !== undefined) {
        this.#invoices.set(entry.invoiceId, {
          ...known,
          balanceMinor: Math.max(0, known.balanceMinor - entry.amountMinor),
        });
      }
    }
  }

  #addPayment(invoice: string, payment: RunPayment): void {
    this.#payments.set(invoice, [...(this.#payments.get(invoice) ?? []), payment]);
  }

  #learnCustomer(record: JsonObject): void {
    const customer = customerFrom(record);
    if (customer === null) return;
    const previous = this.#customers.get(customer.id);
    this.#customers.set(customer.id, {
      id: customer.id,
      displayName: customer.displayName ?? previous?.displayName ?? null,
      email: customer.email ?? previous?.email ?? null,
    });
  }

  /** A `CustomerRef` {value, name}; a full customer record already known wins. */
  #learnReference(id: string | null, name: string | null): void {
    if (id === null || name === null || this.#customers.has(id)) return;
    this.#customers.set(id, { id, displayName: name, email: null });
  }

  #learnPaymentCustomer(record: JsonObject): void {
    const payment = paymentFrom(record, this.#settings.currency);
    if (payment !== null) this.#learnReference(payment.customerId, payment.customerName);
  }

  #learnInvoice(record: JsonObject): void {
    const invoice = invoiceFrom(record, this.#settings.currency);
    if (invoice === null) return;
    this.#learnReference(invoice.customerId, invoice.customerName);
    const previous = this.#invoices.get(invoice.id);
    this.#invoices.set(invoice.id, {
      id: invoice.id,
      docNumber: invoice.docNumber ?? previous?.docNumber ?? null,
      customerId: invoice.customerId ?? previous?.customerId ?? null,
      customerName: invoice.customerName ?? previous?.customerName ?? null,
      billEmail: invoice.billEmail ?? previous?.billEmail ?? null,
      totalMinor: invoice.totalMinor ?? previous?.totalMinor ?? null,
      balanceMinor: invoice.balanceMinor ?? previous?.balanceMinor ?? null,
      currency: invoice.currency ?? previous?.currency ?? null,
      dueDate: invoice.dueDate ?? previous?.dueDate ?? null,
    });
  }
}
