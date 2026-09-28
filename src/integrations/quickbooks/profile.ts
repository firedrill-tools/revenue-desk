// The quickbooks-api profile: the frozen §2 table of docs/ARCHITECTURE.md.

import type { ActionClass, ToolSpec } from "../../contracts/integration.js";
import { defineProfile } from "../shared/profile.js";

/** `route` is relative to /v3/company/{realmId}, e.g. "POST /invoice". */
const spec = (
  name: string,
  route: `${"GET" | "POST"} /${string}`,
  operation: ToolSpec["operation"],
  title: string,
  baseClass: ActionClass,
): ToolSpec => ({
  name,
  upstream: route.replace(" /", " /v3/company/{realmId}/"),
  operation,
  title,
  baseClass,
  readOnly: baseClass === "read",
});

export const QUICKBOOKS_PROFILE = defineProfile("quickbooks-api", "quickbooks", [
  spec(
    "get_company_info",
    "GET /companyinfo/{realmId}",
    "quickbooks.company_info.get",
    "Get company info from QuickBooks",
    "read",
  ),
  spec(
    "find_customers",
    "GET /query",
    "quickbooks.customers.query",
    "Find customers in QuickBooks",
    "read",
  ),
  spec(
    "get_customer",
    "GET /customer/{id}",
    "quickbooks.customers.get",
    "Get customer from QuickBooks",
    "read",
  ),
  spec(
    "list_invoices",
    "GET /query",
    "quickbooks.invoices.query",
    "List invoices in QuickBooks",
    "read",
  ),
  spec(
    "get_invoice",
    "GET /invoice/{id}",
    "quickbooks.invoices.get",
    "Get invoice from QuickBooks",
    "read",
  ),
  spec(
    "list_payments",
    "GET /query",
    "quickbooks.payments.query",
    "List payments in QuickBooks",
    "read",
  ),
  spec(
    "create_customer",
    "POST /customer",
    "quickbooks.customers.create",
    "Create customer in QuickBooks",
    "internal_write",
  ),
  spec(
    "create_invoice",
    "POST /invoice",
    "quickbooks.invoices.create",
    "Create invoice in QuickBooks",
    "financial",
  ),
  spec(
    "send_invoice",
    "POST /invoice/{id}/send",
    "quickbooks.invoices.send",
    "Send invoice from QuickBooks",
    "financial",
  ),
  spec(
    "record_payment",
    "POST /payment",
    "quickbooks.payments.create",
    "Record payment in QuickBooks",
    "financial",
  ),
  spec(
    "void_invoice",
    "POST /invoice?operation=void",
    "quickbooks.invoices.void",
    "Void invoice in QuickBooks",
    "financial",
  ),
]);
