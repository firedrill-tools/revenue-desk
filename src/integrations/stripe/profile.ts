// The stripe-api profile: the frozen §2 table of docs/ARCHITECTURE.md.

import type { ToolSpec } from "../../contracts/integration.js";
import { defineProfile } from "../shared/profile.js";

const read = (
  name: string,
  upstream: string,
  operation: ToolSpec["operation"],
  title: string,
): ToolSpec => ({ name, upstream, operation, title, baseClass: "read", readOnly: true });

export const STRIPE_PROFILE = defineProfile("stripe-api", "stripe", [
  read("find_customers", "GET /v1/customers", "stripe.customers.list", "Find customers in Stripe"),
  read(
    "get_customer",
    "GET /v1/customers/{id}",
    "stripe.customers.retrieve",
    "Get customer from Stripe",
  ),
  read("list_charges", "GET /v1/charges", "stripe.charges.list", "List charges in Stripe"),
  read(
    "list_payment_intents",
    "GET /v1/payment_intents",
    "stripe.payment_intents.list",
    "List payment intents in Stripe",
  ),
  read("list_invoices", "GET /v1/invoices", "stripe.invoices.list", "List invoices in Stripe"),
  read(
    "get_invoice",
    "GET /v1/invoices/{id}",
    "stripe.invoices.retrieve",
    "Get invoice from Stripe",
  ),
  read(
    "list_subscriptions",
    "GET /v1/subscriptions",
    "stripe.subscriptions.list",
    "List subscriptions in Stripe",
  ),
  read("list_refunds", "GET /v1/refunds", "stripe.refunds.list", "List refunds in Stripe"),
  read("get_balance", "GET /v1/balance", "stripe.balance.retrieve", "Get balance from Stripe"),
  {
    name: "create_refund",
    upstream: "POST /v1/refunds",
    operation: "stripe.refunds.create",
    title: "Refund charge in Stripe",
    baseClass: "financial",
    readOnly: false,
  },
  {
    name: "cancel_subscription",
    upstream: "DELETE /v1/subscriptions/{id}",
    operation: "stripe.subscriptions.cancel",
    title: "Cancel subscription in Stripe",
    baseClass: "financial",
    readOnly: false,
  },
]);
