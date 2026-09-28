// What a run remembers about the QuickBooks records it read (the gateway's
// RunMemory, src/gateway/catalog.ts). The writes name records by QuickBooks
// id, so their approval cards take the customer's name, the invoice number,
// its amounts and its billing email from this run's earlier QuickBooks
// results (classify.ts). Only QuickBooks' own results are remembered, never
// the model's inputs, and a failed call teaches nothing.

import type { Classification, ClassifierSettings } from "../../contracts/integration.js";
import type { JsonObject, JsonValue } from "../../contracts/json.js";
import type { RunMemory } from "../../gateway/catalog.js";
import { asObject, num, obj, objects, str } from "../shared/json.js";
import {
  classifyQuickBooks,
  type KnownCustomer,
  type KnownInvoice,
  type QuickBooksKnown,
} from "./classify.js";

const CUSTOMER_RESULTS = new Set(["get_customer", "create_customer"]);
const INVOICE_RESULTS = new Set(["get_invoice", "create_invoice", "send_invoice", "void_invoice"]);

export class QuickBooksRunMemory implements RunMemory, QuickBooksKnown {
  readonly #settings: ClassifierSettings;
  readonly #customers = new Map<string, KnownCustomer>();
  readonly #invoices = new Map<string, KnownInvoice>();

  constructor(settings: ClassifierSettings) {
    this.#settings = settings;
  }

  customer(id: string): KnownCustomer | undefined {
    return this.#customers.get(id);
  }

  invoice(id: string): KnownInvoice | undefined {
    return this.#invoices.get(id);
  }

  record(tool: string, _input: JsonObject, output: JsonValue, isError: boolean): void {
    const result = asObject(output);
    if (isError || result === undefined) return;
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
