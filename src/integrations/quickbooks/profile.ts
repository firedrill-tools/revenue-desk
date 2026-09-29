// The QuickBooks tools of the composio profile (docs/ARCHITECTURE.md §2).
// Slugs and access levels equal COMPOSIO_ALLOWLISTS.quickbooks in
// composio/session.ts; their schemas are captured in
// test/fixtures/surfaces/composio-direct.json.
//
// Composio's QuickBooks toolkit has no tool that emails or voids an invoice,
// so neither is offered: an invoice reaches its customer through Gmail.

import type { ActionClass, ToolSpec } from "../../contracts/integration.js";
import { defineProfile } from "../shared/profile.js";

const spec = (
  name: string,
  operation: ToolSpec["operation"],
  title: string,
  baseClass: ActionClass,
): ToolSpec => ({
  name,
  upstream: name,
  operation,
  title,
  baseClass,
  readOnly: baseClass === "read",
});

export const QUICKBOOKS_PROFILE = defineProfile("composio", "quickbooks", [
  spec(
    "QUICKBOOKS_GET_COMPANY_INFO",
    "quickbooks.company_info.get",
    "Get company info from QuickBooks",
    "read",
  ),
  spec(
    "QUICKBOOKS_QUERY_CUSTOMERS",
    "quickbooks.customers.query",
    "Find customers in QuickBooks",
    "read",
  ),
  spec(
    "QUICKBOOKS_READ_CUSTOMER",
    "quickbooks.customers.get",
    "Get customer from QuickBooks",
    "read",
  ),
  spec(
    "QUICKBOOKS_QUERY_INVOICES",
    "quickbooks.invoices.query",
    "Find invoices in QuickBooks",
    "read",
  ),
  spec("QUICKBOOKS_READ_INVOICE", "quickbooks.invoices.get", "Get invoice from QuickBooks", "read"),
  spec(
    "QUICKBOOKS_QUERY_PAYMENTS",
    "quickbooks.payments.query",
    "Find payments in QuickBooks",
    "read",
  ),
  spec(
    "QUICKBOOKS_QUERY_ITEMS",
    "quickbooks.items.query",
    "Find products and services in QuickBooks",
    "read",
  ),
  spec(
    "QUICKBOOKS_GET_AGED_RECEIVABLES_REPORT",
    "quickbooks.reports.aged_receivables",
    "Get the AR aging report from QuickBooks",
    "read",
  ),
  spec(
    "QUICKBOOKS_CREATE_CUSTOMER",
    "quickbooks.customers.create",
    "Create customer in QuickBooks",
    "internal_write",
  ),
  spec(
    "QUICKBOOKS_CREATE_INVOICE",
    "quickbooks.invoices.create",
    "Create invoice in QuickBooks",
    "financial",
  ),
  spec(
    "QUICKBOOKS_CREATE_PAYMENT",
    "quickbooks.payments.create",
    "Record payment in QuickBooks",
    "financial",
  ),
]);
