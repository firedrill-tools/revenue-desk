// The QuickBooks Online tools (docs/ARCHITECTURE.md §2).

import type { JsonObject } from "../../contracts/json.js";
import {
  type ApiTool,
  type ApiToolOptions,
  apiTool,
  requireIdempotencyKey,
} from "../shared/api-tool.js";
import { ApiToolError } from "../shared/errors.js";
import { compact, obj } from "../shared/json.js";
import { minorToDecimal } from "../shared/money.js";
import { QUICKBOOKS_PROVIDER, type QueryAllResult, type QuickBooksClient } from "./client.js";
import * as view from "./project.js";
import { type Condition, containsPattern, type SelectQuery } from "./query.js";
import { lineAmountMinor, QUICKBOOKS_INPUTS } from "./schemas.js";

function entityOf(body: JsonObject, entity: string): JsonObject {
  const found = obj(body, entity);
  if (found === undefined) {
    throw new ApiToolError(QUICKBOOKS_PROVIDER, `QuickBooks returned no ${entity}.`, {
      code: "invalid_response",
    });
  }
  return found;
}

function listResult(key: string, result: QueryAllResult, rows: readonly JsonObject[]): JsonObject {
  return {
    [key]: [...rows],
    count: rows.length,
    complete: result.complete,
    ...(result.complete
      ? {}
      : { note: "More rows may exist beyond this limit; narrow the filters or raise limit." }),
  };
}

export function createQuickBooksTools(
  client: QuickBooksClient,
  options: ApiToolOptions,
): readonly ApiTool[] {
  const context: view.ProjectionContext =
    options.timezone === undefined
      ? { currency: options.currency }
      : { currency: options.currency, timezone: options.timezone };
  const decimal = (amountMinor: number) => minorToDecimal(amountMinor, options.currency);
  const path = (entity: string, id: string) => `${entity}/${encodeURIComponent(id)}`;

  return [
    apiTool({
      name: "get_company_info",
      description:
        "Get the QuickBooks company's name, country and fiscal year, and the QuickBooks " +
        "server's current time (server_time).",
      input: QUICKBOOKS_INPUTS.get_company_info,
      readOnly: true,
      async run(_args, call) {
        const body = await client.get(
          `companyinfo/${encodeURIComponent(client.realmId)}`,
          call.signal,
        );
        return view.companyInfo(body, context);
      },
    }),
    apiTool({
      name: "find_customers",
      description:
        "Find QuickBooks customers by display name, company name or email. Give at least " +
        "one filter for a precise match; with none, lists active customers.",
      input: QUICKBOOKS_INPUTS.find_customers,
      readOnly: true,
      async run(args, call) {
        const where: Condition[] = [];
        if (args.name !== undefined) {
          where.push({ field: "DisplayName", op: "LIKE", pattern: containsPattern(args.name) });
        }
        if (args.company !== undefined) {
          where.push({ field: "CompanyName", op: "LIKE", pattern: containsPattern(args.company) });
        }
        if (args.email !== undefined) {
          where.push({ field: "PrimaryEmailAddr", op: "=", value: args.email });
        }
        if (!args.include_inactive) where.push({ field: "Active", op: "=", value: true });
        const query: SelectQuery = {
          entity: "Customer",
          where,
          orderBy: { field: "DisplayName", direction: "ASC" },
        };
        const result = await client.queryAll(query, {
          pageSize: args.limit,
          maxRows: args.limit,
          signal: call.signal,
        });
        return listResult(
          "customers",
          result,
          result.rows.map((row) => view.customer(row, context)),
        );
      },
    }),
    apiTool({
      name: "get_customer",
      description: "Get one QuickBooks customer by id, including open balance and billing email.",
      input: QUICKBOOKS_INPUTS.get_customer,
      readOnly: true,
      async run(args, call) {
        const body = await client.get(path("customer", args.customer_id), call.signal);
        return view.customer(entityOf(body, "Customer"), context);
      },
    }),
    apiTool({
      name: "list_invoices",
      description:
        "List QuickBooks invoices, by default the open ones (balance above zero), oldest due " +
        "date first. Filter by customer, due date, invoice date or number. Pass as_of (the " +
        "business date) to get days_overdue. Reads every page up to limit.",
      input: QUICKBOOKS_INPUTS.list_invoices,
      readOnly: true,
      async run(args, call) {
        const where: Condition[] = [];
        if (args.customer_id !== undefined) {
          where.push({ field: "CustomerRef", op: "=", value: args.customer_id });
        }
        if (args.status === "open") where.push({ field: "Balance", op: ">", value: "0" });
        if (args.status === "paid") where.push({ field: "Balance", op: "=", value: "0" });
        if (args.due_before !== undefined) {
          where.push({ field: "DueDate", op: "<", value: args.due_before });
        }
        if (args.due_on_or_after !== undefined) {
          where.push({ field: "DueDate", op: ">=", value: args.due_on_or_after });
        }
        if (args.issued_from !== undefined) {
          where.push({ field: "TxnDate", op: ">=", value: args.issued_from });
        }
        if (args.issued_to !== undefined) {
          where.push({ field: "TxnDate", op: "<=", value: args.issued_to });
        }
        if (args.doc_number !== undefined) {
          where.push({ field: "DocNumber", op: "=", value: args.doc_number });
        }
        const result = await client.queryAll(
          { entity: "Invoice", where, orderBy: { field: "DueDate", direction: "ASC" } },
          { pageSize: Math.min(args.limit, 100), maxRows: args.limit, signal: call.signal },
        );
        const asOf = args.as_of === undefined ? {} : { asOf: args.as_of };
        return listResult(
          "invoices",
          result,
          result.rows.map((row) => view.invoice(row, { ...context, ...asOf })),
        );
      },
    }),
    apiTool({
      name: "get_invoice",
      description:
        "Get one QuickBooks invoice by id with its lines, balance, billing email and " +
        "sync_token (needed to void it).",
      input: QUICKBOOKS_INPUTS.get_invoice,
      readOnly: true,
      async run(args, call) {
        const body = await client.get(path("invoice", args.invoice_id), call.signal);
        return view.invoice(entityOf(body, "Invoice"), { ...context, withLines: true });
      },
    }),
    apiTool({
      name: "list_payments",
      description:
        "List payments recorded in QuickBooks, newest first, optionally for one customer and " +
        "a date range, with the invoices each payment was applied to. Use it to spot payments " +
        "that were received elsewhere (e.g. Stripe) but never recorded.",
      input: QUICKBOOKS_INPUTS.list_payments,
      readOnly: true,
      async run(args, call) {
        const where: Condition[] = [];
        if (args.customer_id !== undefined) {
          where.push({ field: "CustomerRef", op: "=", value: args.customer_id });
        }
        if (args.received_from !== undefined) {
          where.push({ field: "TxnDate", op: ">=", value: args.received_from });
        }
        if (args.received_to !== undefined) {
          where.push({ field: "TxnDate", op: "<=", value: args.received_to });
        }
        const result = await client.queryAll(
          { entity: "Payment", where, orderBy: { field: "TxnDate", direction: "DESC" } },
          { pageSize: Math.min(args.limit, 100), maxRows: args.limit, signal: call.signal },
        );
        return listResult(
          "payments",
          result,
          result.rows.map((row) => view.payment(row, context)),
        );
      },
    }),
    apiTool({
      name: "create_customer",
      description:
        "Create a QuickBooks customer. Search with find_customers first so no duplicate is " +
        "created.",
      input: QUICKBOOKS_INPUTS.create_customer,
      readOnly: false,
      async run(args, call) {
        const idempotencyKey = requireIdempotencyKey(QUICKBOOKS_PROVIDER, call);
        const address = args.billing_address;
        const body = compact({
          DisplayName: args.display_name,
          CompanyName: args.company_name,
          GivenName: args.given_name,
          FamilyName: args.family_name,
          PrimaryEmailAddr: args.email === undefined ? undefined : { Address: args.email },
          PrimaryPhone: args.phone === undefined ? undefined : { FreeFormNumber: args.phone },
          BillAddr:
            address === undefined
              ? undefined
              : compact({
                  Line1: address.line1,
                  City: address.city,
                  CountrySubDivisionCode: address.region,
                  PostalCode: address.postal_code,
                  Country: address.country,
                }),
          Notes: args.notes,
        });
        const created = await client.post("customer", body, {
          idempotencyKey,
          signal: call.signal,
        });
        return view.customer(entityOf(created, "Customer"), context);
      },
    }),
    apiTool({
      name: "create_invoice",
      description:
        "Create a QuickBooks invoice for a customer. Creating it does not send it. Needs the " +
        "user's approval; amounts are minor units.",
      input: QUICKBOOKS_INPUTS.create_invoice,
      readOnly: false,
      async run(args, call) {
        const idempotencyKey = requireIdempotencyKey(QUICKBOOKS_PROVIDER, call);
        const body = compact({
          CustomerRef: { value: args.customer_id },
          Line: args.lines.map((line) =>
            compact({
              DetailType: "SalesItemLineDetail",
              Amount: decimal(lineAmountMinor(line)),
              Description: line.description,
              SalesItemLineDetail: compact({
                ItemRef: line.item_id === undefined ? undefined : { value: line.item_id },
                Qty: line.quantity,
                UnitPrice: decimal(line.unit_price_minor),
              }),
            }),
          ),
          DueDate: args.due_date,
          TxnDate: args.invoice_date,
          DocNumber: args.doc_number,
          BillEmail: args.bill_email === undefined ? undefined : { Address: args.bill_email },
          CustomerMemo:
            args.customer_memo === undefined ? undefined : { value: args.customer_memo },
          PrivateNote: args.private_note,
        });
        const created = await client.post("invoice", body, { idempotencyKey, signal: call.signal });
        return view.invoice(entityOf(created, "Invoice"), { ...context, withLines: true });
      },
    }),
    apiTool({
      name: "send_invoice",
      description:
        "Email a QuickBooks invoice to the customer (its billing email, or send_to). Needs the " +
        "user's approval.",
      input: QUICKBOOKS_INPUTS.send_invoice,
      readOnly: false,
      async run(args, call) {
        const idempotencyKey = requireIdempotencyKey(QUICKBOOKS_PROVIDER, call);
        const sent = await client.postEmpty(`${path("invoice", args.invoice_id)}/send`, {
          idempotencyKey,
          signal: call.signal,
          query: { sendTo: args.send_to },
        });
        return view.invoice(entityOf(sent, "Invoice"), context);
      },
    }),
    apiTool({
      name: "record_payment",
      description:
        "Record a customer payment in QuickBooks, applied to one invoice or unapplied. Needs " +
        "the user's approval; the amount is minor units.",
      input: QUICKBOOKS_INPUTS.record_payment,
      readOnly: false,
      async run(args, call) {
        const idempotencyKey = requireIdempotencyKey(QUICKBOOKS_PROVIDER, call);
        const total = decimal(args.amount_minor);
        const body = compact({
          CustomerRef: { value: args.customer_id },
          TotalAmt: total,
          TxnDate: args.payment_date,
          PaymentRefNum: args.reference,
          PrivateNote: args.memo,
          Line:
            args.invoice_id === undefined
              ? undefined
              : [{ Amount: total, LinkedTxn: [{ TxnId: args.invoice_id, TxnType: "Invoice" }] }],
        });
        const created = await client.post("payment", body, { idempotencyKey, signal: call.signal });
        return view.payment(entityOf(created, "Payment"), context);
      },
    }),
    apiTool({
      name: "void_invoice",
      description:
        "Void a QuickBooks invoice: its amounts become zero and it stays on record. Cannot be " +
        "undone; needs the user's approval. Get the current sync_token with get_invoice.",
      input: QUICKBOOKS_INPUTS.void_invoice,
      readOnly: false,
      async run(args, call) {
        const idempotencyKey = requireIdempotencyKey(QUICKBOOKS_PROVIDER, call);
        const voided = await client.post(
          "invoice",
          { Id: args.invoice_id, SyncToken: args.sync_token },
          { idempotencyKey, signal: call.signal, query: { operation: "void" } },
        );
        return view.invoice(entityOf(voided, "Invoice"), context);
      },
    }),
  ];
}
