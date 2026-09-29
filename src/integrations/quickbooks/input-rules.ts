// QuickBooks rules the Composio schemas do not state (InputCheckSource,
// src/gateway/catalog.ts). They run before any policy, so a call that
// breaks one is rejected without reaching QuickBooks and the message says
// what to write instead.
//
// - An invoice's `lines` are open objects in QUICKBOOKS_CREATE_INVOICE's
//   schema, but QuickBooks needs each line's Amount, and the approval card
//   can show the total only from them: every line needs a decimal Amount.
// - Revenue Desk records payments that were received; it never charges a
//   card. QUICKBOOKS_CREATE_PAYMENT would charge one through QuickBooks
//   Payments with `process_payment: true` or `credit_card_payment`, so both
//   are refused.
// - Records are named by QuickBooks Id, a string of digits: `customer_id`
//   and each linked transaction's `TxnId` must be one (a name or an invoice
//   number is not), so the card can name the record and QuickBooks finds it.

import type { JsonObject } from "../../contracts/json.js";
import type { SchemaIssue } from "../../gateway/validate.js";
import { arr, field, isObject, objects } from "../shared/json.js";
import { decimal, qboId } from "./records.js";

function customerIdIssues(input: JsonObject): SchemaIssue[] {
  const value = field(input, "customer_id");
  if (value === undefined || qboId(value) !== undefined) return [];
  return [
    {
      path: "/customer_id",
      message:
        'is not a QuickBooks customer Id: use the Id (digits, e.g. "58") from a customer search or read, not the name',
    },
  ];
}

function linkedTxnIssues(input: JsonObject): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  objects(input, "lines").forEach((line, lineIndex) => {
    objects(line, "LinkedTxn").forEach((linked, index) => {
      if (qboId(field(linked, "TxnId")) !== undefined) return;
      issues.push({
        path: `/lines/${lineIndex}/LinkedTxn/${index}/TxnId`,
        message:
          "is not a QuickBooks transaction Id: use the invoice's Id (digits) from an invoice search or read, not its invoice number",
      });
    });
  });
  return issues;
}

function invoiceLineIssues(input: JsonObject): SchemaIssue[] {
  const lines = arr(input, "lines");
  if (lines === undefined) return [];
  if (lines.length === 0) {
    return [
      {
        path: "/lines",
        message:
          "is empty: give at least one line with DetailType, Amount and the item (SalesItemLineDetail.ItemRef.value from a products-and-services search)",
      },
    ];
  }
  const issues: SchemaIssue[] = [];
  lines.forEach((line, index) => {
    if (!isObject(line)) {
      issues.push({ path: `/lines/${index}`, message: "must be an object" });
      return;
    }
    const amount = decimal(field(line, "Amount"));
    if (amount === undefined || amount < 0) {
      issues.push({
        path: `/lines/${index}/Amount`,
        message:
          "is needed: the line total as a decimal in the company currency, e.g. 1800.00 (quantity times unit price)",
      });
    }
  });
  return issues;
}

function paymentIssues(input: JsonObject): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (field(input, "process_payment") === true) {
    issues.push({
      path: "/process_payment",
      message:
        "would charge the customer through QuickBooks Payments; Revenue Desk only records payments already received: leave process_payment out",
    });
  }
  const card = field(input, "credit_card_payment");
  if (card !== undefined && card !== null) {
    issues.push({
      path: "/credit_card_payment",
      message:
        "would charge a card through QuickBooks Payments; Revenue Desk only records payments already received: leave credit_card_payment out",
    });
  }
  return issues;
}

/** Issues of a QuickBooks call that satisfies its schema; empty when it may run. */
export function checkQuickBooksInput(tool: string, input: JsonObject): readonly SchemaIssue[] {
  if (tool === "QUICKBOOKS_CREATE_INVOICE") {
    return [...customerIdIssues(input), ...invoiceLineIssues(input)];
  }
  if (tool === "QUICKBOOKS_CREATE_PAYMENT") {
    return [...customerIdIssues(input), ...linkedTxnIssues(input), ...paymentIssues(input)];
  }
  return [];
}
