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

import type { JsonObject } from "../../contracts/json.js";
import type { SchemaIssue } from "../../gateway/validate.js";
import { arr, field, isObject } from "../shared/json.js";
import { decimal } from "./records.js";

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
  if (tool === "QUICKBOOKS_CREATE_INVOICE") return invoiceLineIssues(input);
  if (tool === "QUICKBOOKS_CREATE_PAYMENT") return paymentIssues(input);
  return [];
}
