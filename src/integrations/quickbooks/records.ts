// QuickBooks records as Composio's QuickBooks tools return them
// (test/fixtures/surfaces/composio-direct.json and each tool's output
// schema): Composio wraps the result as `{successful, data, error}`, and
// `data` holds QuickBooks' own JSON, whose shape differs by tool:
//   - QUICKBOOKS_QUERY_INVOICES: `data.Invoice[]`;
//   - QUICKBOOKS_QUERY_CUSTOMERS, QUICKBOOKS_QUERY_PAYMENTS:
//     `data.QueryResponse.Customer[]` / `.Payment[]`;
//   - QUICKBOOKS_CREATE_CUSTOMER: `data.Customer`;
//   - QUICKBOOKS_READ_CUSTOMER, QUICKBOOKS_READ_INVOICE,
//     QUICKBOOKS_CREATE_INVOICE, QUICKBOOKS_CREATE_PAYMENT: the record itself.
// The readers below accept each of these places, so a record is found
// wherever Composio puts it. Amounts are decimals in the company currency,
// given as numbers or, by the create tools, as numeric strings.

import type { JsonObject, JsonValue } from "../../contracts/json.js";
import { asObject, field, isObject, obj, objects, str } from "../shared/json.js";
import { decimalToMinor } from "../shared/money.js";

export type QuickBooksEntity = "Customer" | "Invoice" | "Payment" | "Item";

/** A customer as a QuickBooks result described it. */
export type KnownCustomer = {
  readonly id: string;
  readonly displayName: string | null;
  readonly email: string | null;
};

/** An invoice as a QuickBooks result described it. Amounts in minor units of `currency`. */
export type KnownInvoice = {
  readonly id: string;
  readonly docNumber: string | null;
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly billEmail: string | null;
  readonly totalMinor: number | null;
  readonly balanceMinor: number | null;
  readonly currency: string | null;
  readonly dueDate: string | null;
};

/** One application of a payment to an invoice, in minor units. */
export type AppliedPayment = { readonly invoiceId: string; readonly amountMinor: number };

/** A payment as a QuickBooks result described it. */
export type KnownPayment = {
  readonly id: string | null;
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly totalMinor: number | null;
  readonly currency: string | null;
  readonly applied: readonly AppliedPayment[];
};

/** A decimal QuickBooks gave (a number or a numeric string); undefined for anything else. */
export function decimal(value: JsonValue | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return undefined;
}

/** A QuickBooks id: a string of digits, or a number QuickBooks meant as one. */
export function qboId(value: JsonValue | undefined): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  return undefined;
}

/** `data` of a successful Composio result (or the bare result); undefined when it failed. */
export function resultData(output: JsonValue): JsonObject | undefined {
  const top = asObject(output);
  if (top === undefined || field(top, "successful") === false) return undefined;
  const data = field(top, "data");
  if (data === undefined) return top;
  return asObject(data);
}

function oneOrMany(value: JsonValue | undefined): JsonObject[] {
  if (Array.isArray(value)) return value.filter(isObject);
  return isObject(value) ? [value] : [];
}

/**
 * The records of one QuickBooks type in a Composio result, wherever the tool
 * put them. With `single`, a result whose data is itself the record (it has
 * an `Id` and no list of that type) counts as one.
 */
export function entitiesOf(
  output: JsonValue,
  type: QuickBooksEntity,
  options: { readonly single?: boolean } = {},
): JsonObject[] {
  const data = resultData(output);
  if (data === undefined) return [];
  for (const holder of [data, obj(data, "QueryResponse"), obj(data, "response_data")]) {
    const found = oneOrMany(field(holder, type));
    if (found.length > 0) return found;
  }
  return options.single === true && qboId(field(data, "Id")) !== undefined ? [data] : [];
}

/** The `{value, name}` reference QuickBooks uses for customers, items and currencies. */
function reference(record: JsonObject | undefined, key: string) {
  const ref = obj(record, key);
  return { id: qboId(field(ref, "value")) ?? null, name: str(ref, "name") ?? null };
}

function currencyOf(record: JsonObject): string | null {
  const code = str(obj(record, "CurrencyRef"), "value");
  return code === undefined ? null : code.toUpperCase();
}

function minor(value: JsonValue | undefined, currency: string): number | null {
  const amount = decimal(value);
  return amount === undefined ? null : decimalToMinor(amount, currency);
}

export function customerFrom(record: JsonObject): KnownCustomer | null {
  const id = qboId(field(record, "Id"));
  if (id === undefined) return null;
  const given = [str(record, "GivenName"), str(record, "FamilyName")].filter(
    (part) => part !== undefined,
  );
  return {
    id,
    displayName:
      str(record, "DisplayName") ??
      str(record, "CompanyName") ??
      str(record, "FullyQualifiedName") ??
      (given.length > 0 ? given.join(" ") : null),
    email: str(obj(record, "PrimaryEmailAddr"), "Address") ?? null,
  };
}

/** An invoice record; amounts converted with its own currency, else `fallbackCurrency`. */
export function invoiceFrom(record: JsonObject, fallbackCurrency: string): KnownInvoice | null {
  const id = qboId(field(record, "Id"));
  if (id === undefined) return null;
  const own = currencyOf(record);
  const currency = own ?? fallbackCurrency;
  const customer = reference(record, "CustomerRef");
  return {
    id,
    docNumber: str(record, "DocNumber") ?? null,
    customerId: customer.id,
    customerName: customer.name,
    billEmail: str(obj(record, "BillEmail"), "Address") ?? null,
    totalMinor: minor(field(record, "TotalAmt"), currency),
    balanceMinor: minor(field(record, "Balance"), currency),
    currency: own,
    dueDate: str(record, "DueDate") ?? null,
  };
}

/** Which invoices a payment's lines settle, and by how much (minor units of `currency`). */
export function appliedFrom(lines: readonly JsonObject[], currency: string): AppliedPayment[] {
  const applied: AppliedPayment[] = [];
  for (const line of lines) {
    const amount = decimal(field(line, "Amount"));
    if (amount === undefined) continue;
    for (const linked of objects(line, "LinkedTxn")) {
      const invoiceId = qboId(field(linked, "TxnId"));
      if (invoiceId === undefined || str(linked, "TxnType") !== "Invoice") continue;
      applied.push({ invoiceId, amountMinor: decimalToMinor(amount, currency) });
    }
  }
  return applied;
}

/** One application of a payment to a transaction other than an invoice (a credit memo), in minor units. */
export type OtherApplication = {
  readonly txnType: string;
  readonly txnId: string;
  readonly amountMinor: number;
};

/** The payment lines linked to anything but an invoice, e.g. a credit memo. */
export function otherAppliedFrom(
  lines: readonly JsonObject[],
  currency: string,
): OtherApplication[] {
  const other: OtherApplication[] = [];
  for (const line of lines) {
    const amount = decimal(field(line, "Amount"));
    if (amount === undefined) continue;
    for (const linked of objects(line, "LinkedTxn")) {
      const txnType = str(linked, "TxnType");
      const txnId = str(linked, "TxnId")?.trim();
      if (txnType === "Invoice" || txnType === undefined || txnId === undefined || txnId === "") {
        continue;
      }
      other.push({ txnType, txnId, amountMinor: decimalToMinor(amount, currency) });
    }
  }
  return other;
}

export function paymentFrom(record: JsonObject, fallbackCurrency: string): KnownPayment | null {
  const id = qboId(field(record, "Id")) ?? null;
  const own = currencyOf(record);
  const currency = own ?? fallbackCurrency;
  const customer = reference(record, "CustomerRef");
  if (id === null && customer.id === null) return null;
  return {
    id,
    customerId: customer.id,
    customerName: customer.name,
    totalMinor: minor(field(record, "TotalAmt"), currency),
    currency: own,
    applied: appliedFrom(objects(record, "Line"), currency),
  };
}
