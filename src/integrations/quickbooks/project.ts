// Compact views of QuickBooks entities for the model: snake_case names,
// amounts converted from QuickBooks decimals to integer minor units with their
// currency, references as {id, name}. Absent fields stay absent.

import type { JsonObject, JsonValue } from "../../contracts/json.js";
import { bool, compact, num, obj, objects, str } from "../shared/json.js";
import { decimalToMinor } from "../shared/money.js";

export type ProjectionContext = {
  /** Used when an entity has no CurrencyRef (multicurrency off). */
  readonly currency: string;
};

function refOf(entity: JsonObject, key: string): JsonObject | undefined {
  const ref = obj(entity, key);
  const id = str(ref, "value");
  if (id === undefined) return undefined;
  return compact({ id, name: str(ref, "name") });
}

function currencyOf(entity: JsonObject, context: ProjectionContext): string {
  return (str(obj(entity, "CurrencyRef"), "value") ?? context.currency).toUpperCase();
}

function minor(entity: JsonObject, key: string, currency: string): number | undefined {
  const value = num(entity, key);
  return value === undefined ? undefined : decimalToMinor(value, currency);
}

function created(entity: JsonObject): string | undefined {
  return str(obj(entity, "MetaData"), "CreateTime");
}

export function companyInfo(body: JsonObject): JsonObject {
  const company = obj(body, "CompanyInfo");
  return compact({
    company_name: str(company, "CompanyName"),
    legal_name: str(company, "LegalName"),
    country: str(company, "Country"),
    email: str(obj(company, "Email"), "Address"),
    fiscal_year_start_month: str(company, "FiscalYearStartMonth"),
    company_start_date: str(company, "CompanyStartDate"),
    /** The QuickBooks server's clock at the time of the request. */
    server_time: str(body, "time"),
  });
}

export function customer(entity: JsonObject, context: ProjectionContext): JsonObject {
  const currency = currencyOf(entity, context);
  const address = obj(entity, "BillAddr");
  return compact({
    id: str(entity, "Id"),
    display_name: str(entity, "DisplayName"),
    company_name: str(entity, "CompanyName"),
    given_name: str(entity, "GivenName"),
    family_name: str(entity, "FamilyName"),
    email: str(obj(entity, "PrimaryEmailAddr"), "Address"),
    phone: str(obj(entity, "PrimaryPhone"), "FreeFormNumber"),
    balance_minor: minor(entity, "Balance", currency),
    currency,
    active: bool(entity, "Active"),
    billing_address:
      address === undefined
        ? undefined
        : compact({
            line1: str(address, "Line1"),
            city: str(address, "City"),
            region: str(address, "CountrySubDivisionCode"),
            postal_code: str(address, "PostalCode"),
            country: str(address, "Country"),
          }),
    notes: str(entity, "Notes"),
    created: created(entity),
    sync_token: str(entity, "SyncToken"),
  });
}

function daysBetween(fromDate: string, toDate: string): number {
  return Math.round(
    (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000,
  );
}

function invoiceLine(line: JsonObject, currency: string): JsonObject | undefined {
  if (str(line, "DetailType") !== "SalesItemLineDetail") return undefined;
  const detail = obj(line, "SalesItemLineDetail");
  const unitPrice = num(detail, "UnitPrice");
  return compact({
    description: str(line, "Description"),
    quantity: num(detail, "Qty"),
    unit_price_minor: unitPrice === undefined ? undefined : decimalToMinor(unitPrice, currency),
    amount_minor: minor(line, "Amount", currency),
    item: detail === undefined ? undefined : refOf(detail, "ItemRef"),
  });
}

export function invoice(
  entity: JsonObject,
  context: ProjectionContext & { readonly asOf?: string; readonly withLines?: boolean },
): JsonObject {
  const currency = currencyOf(entity, context);
  const balance = minor(entity, "Balance", currency);
  const due = str(entity, "DueDate");
  const overdue =
    context.asOf !== undefined && due !== undefined && balance !== undefined && balance > 0
      ? daysBetween(due, context.asOf)
      : undefined;
  const lines: JsonValue[] = [];
  if (context.withLines === true) {
    for (const line of objects(entity, "Line")) {
      const view = invoiceLine(line, currency);
      if (view !== undefined) lines.push(view);
    }
  }
  return compact({
    id: str(entity, "Id"),
    doc_number: str(entity, "DocNumber"),
    customer: refOf(entity, "CustomerRef"),
    invoice_date: str(entity, "TxnDate"),
    due_date: due,
    total_minor: minor(entity, "TotalAmt", currency),
    balance_minor: balance,
    currency,
    days_overdue: overdue !== undefined && overdue > 0 ? overdue : undefined,
    email_status: str(entity, "EmailStatus"),
    bill_email: str(obj(entity, "BillEmail"), "Address"),
    customer_memo: str(obj(entity, "CustomerMemo"), "value"),
    private_note: str(entity, "PrivateNote"),
    lines: context.withLines === true ? lines : undefined,
    sync_token: str(entity, "SyncToken"),
  });
}

export function payment(entity: JsonObject, context: ProjectionContext): JsonObject {
  const currency = currencyOf(entity, context);
  const appliedTo: JsonValue[] = [];
  for (const line of objects(entity, "Line")) {
    for (const linked of objects(line, "LinkedTxn")) {
      const id = str(linked, "TxnId");
      if (id === undefined || str(linked, "TxnType") !== "Invoice") continue;
      appliedTo.push(compact({ invoice_id: id, amount_minor: minor(line, "Amount", currency) }));
    }
  }
  return compact({
    id: str(entity, "Id"),
    customer: refOf(entity, "CustomerRef"),
    payment_date: str(entity, "TxnDate"),
    total_minor: minor(entity, "TotalAmt", currency),
    unapplied_minor: minor(entity, "UnappliedAmt", currency),
    currency,
    reference: str(entity, "PaymentRefNum"),
    memo: str(entity, "PrivateNote"),
    applied_to: appliedTo,
  });
}
