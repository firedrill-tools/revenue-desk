// What a run remembers about the QuickBooks records it read (the gateway's
// RunMemory, src/gateway/catalog.ts). The writes name records by QuickBooks
// id, so their approval cards take the customer's name, the invoice number,
// its amounts and its billing email from this run's earlier QuickBooks
// results (classify.ts). The run's own payments and voids count: a second
// payment on an invoice must not show the balance from before the first.
// Only QuickBooks' own results are remembered, never the model's inputs,
// and a failed call teaches nothing, except a payment sent without an
// answer (outcome_unknown), which is remembered as possibly applied.

import type { Classification, ClassifierSettings } from "../../contracts/integration.js";
import type { JsonObject, JsonValue } from "../../contracts/json.js";
import type { RunMemory } from "../../gateway/catalog.js";
import { OUTCOME_UNKNOWN } from "../../gateway/types.js";
import { asObject, num, obj, objects, str } from "../shared/json.js";
import {
  classifyQuickBooks,
  type KnownCustomer,
  type KnownInvoice,
  type QuickBooksKnown,
  type RunPayment,
} from "./classify.js";

const CUSTOMER_RESULTS = new Set(["get_customer", "create_customer"]);
const INVOICE_RESULTS = new Set(["get_invoice", "create_invoice", "send_invoice"]);

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

  record(tool: string, input: JsonObject, output: JsonValue, isError: boolean): void {
    const result = asObject(output);
    if (isError) {
      if (tool === "record_payment" && str(obj(result, "error"), "code") === OUTCOME_UNKNOWN) {
        const invoice = str(input, "invoice_id");
        const amount = num(input, "amount_minor");
        if (invoice !== undefined && amount !== undefined) {
          this.#addPayment(invoice, { id: null, amountMinor: amount, uncertain: true });
        }
      }
      return;
    }
    if (result === undefined) return;
    if (tool === "record_payment") {
      this.#learnOwnPayment(result);
      return;
    }
    if (tool === "void_invoice") {
      this.#learnInvoice(result);
      const id = str(result, "id");
      const voided = id === undefined ? undefined : this.#invoices.get(id);
      // A voided invoice has nothing left to pay, whatever the result carried.
      if (id !== undefined && voided !== undefined) {
        this.#invoices.set(id, { ...voided, balanceMinor: 0 });
      }
      return;
    }
    if (tool === "find_customers") {
      for (const customer of objects(result, "customers")) this.#learnCustomer(customer);
    } else if (CUSTOMER_RESULTS.has(tool)) {
      this.#learnCustomer(result);
    } else if (tool === "list_invoices") {
      for (const invoice of objects(result, "invoices")) this.#learnInvoice(invoice);
    } else if (INVOICE_RESULTS.has(tool)) {
      this.#learnInvoice(result);
    } else if (tool === "list_payments") {
      for (const payment of objects(result, "payments"))
        this.#learnReference(obj(payment, "customer"));
    }
  }

  refine(tool: string, input: JsonObject, classification: Classification): Classification {
    return classifyQuickBooks(tool, input, this.#settings, this) ?? classification;
  }

  /** A payment this run recorded lowers each invoice it was applied to. */
  #learnOwnPayment(payment: JsonObject): void {
    this.#learnReference(obj(payment, "customer"));
    const id = str(payment, "id") ?? null;
    for (const applied of objects(payment, "applied_to")) {
      const invoice = str(applied, "invoice_id");
      const amount = num(applied, "amount_minor");
      if (invoice === undefined || amount === undefined) continue;
      this.#addPayment(invoice, { id, amountMinor: amount, uncertain: false });
      const known = this.#invoices.get(invoice);
      if (known?.balanceMinor !== null && known?.balanceMinor !== undefined) {
        this.#invoices.set(invoice, {
          ...known,
          balanceMinor: Math.max(0, known.balanceMinor - amount),
        });
      }
    }
  }

  #addPayment(invoice: string, payment: RunPayment): void {
    this.#payments.set(invoice, [...(this.#payments.get(invoice) ?? []), payment]);
  }

  #learnCustomer(customer: JsonObject): void {
    const id = str(customer, "id");
    if (id === undefined) return;
    this.#customers.set(id, {
      id,
      displayName: str(customer, "display_name") ?? str(customer, "company_name") ?? null,
      email: str(customer, "email") ?? null,
    });
  }

  /** A {id, name} customer reference; a full customer record already known wins. */
  #learnReference(reference: JsonObject | undefined): void {
    const id = str(reference, "id");
    const name = str(reference, "name");
    if (id === undefined || name === undefined || this.#customers.has(id)) return;
    this.#customers.set(id, { id, displayName: name, email: null });
  }

  #learnInvoice(invoice: JsonObject): void {
    const id = str(invoice, "id");
    if (id === undefined) return;
    const customer = obj(invoice, "customer");
    this.#learnReference(customer);
    const previous = this.#invoices.get(id);
    this.#invoices.set(id, {
      id,
      docNumber: str(invoice, "doc_number") ?? previous?.docNumber ?? null,
      customerId: str(customer, "id") ?? previous?.customerId ?? null,
      customerName: str(customer, "name") ?? previous?.customerName ?? null,
      billEmail: str(invoice, "bill_email") ?? previous?.billEmail ?? null,
      totalMinor: num(invoice, "total_minor") ?? previous?.totalMinor ?? null,
      balanceMinor: num(invoice, "balance_minor") ?? previous?.balanceMinor ?? null,
      currency: str(invoice, "currency") ?? previous?.currency ?? null,
    });
  }
}
