// The Stripe tools (docs/ARCHITECTURE.md §2): each is one REST operation.

import type { JsonObject } from "../../contracts/json.js";
import { type ApiTool, apiTool, requireIdempotencyKey } from "../shared/api-tool.js";
import { ApiToolError } from "../shared/errors.js";
import { unixSeconds } from "../shared/schema.js";
import type { StripeClient } from "./client.js";
import { STRIPE_PROVIDER } from "./client.js";
import type { FormParams } from "./form.js";
import * as view from "./project.js";
import { refundTarget, STRIPE_INPUTS } from "./schemas.js";

function createdRange(after: string | undefined, before: string | undefined): FormParams {
  if (after === undefined && before === undefined) return {};
  return {
    created: {
      gte: after === undefined ? undefined : unixSeconds(after),
      lt: before === undefined ? undefined : unixSeconds(before),
    },
  };
}

const path = (template: string, id: string) => template.replace("{id}", encodeURIComponent(id));

export function createStripeTools(client: StripeClient): readonly ApiTool[] {
  const tools = [
    apiTool({
      name: "find_customers",
      description:
        "Find Stripe customers, usually by exact email address. Returns compact customer " +
        "records (id, name, email, balance in minor units, created). Page with starting_after.",
      input: STRIPE_INPUTS.find_customers,
      readOnly: true,
      async run(args, context) {
        const body = await client.get(
          "/v1/customers",
          { email: args.email, limit: args.limit, starting_after: args.starting_after },
          context.signal,
        );
        return view.list(body, view.customer);
      },
    }),
    apiTool({
      name: "get_customer",
      description: "Get one Stripe customer by id (cus_…).",
      input: STRIPE_INPUTS.get_customer,
      readOnly: true,
      async run(args, context) {
        const body = await client.get(
          path("/v1/customers/{id}", args.customer),
          {},
          context.signal,
        );
        return view.customer(body);
      },
    }),
    apiTool({
      name: "list_charges",
      description:
        "List Stripe charges, newest first, optionally for one customer or payment intent and " +
        "a creation window. Amounts are minor units. Use it to find duplicate or failed charges " +
        "and what was already refunded (amount_refunded).",
      input: STRIPE_INPUTS.list_charges,
      readOnly: true,
      async run(args, context) {
        const body = await client.get(
          "/v1/charges",
          {
            customer: args.customer,
            payment_intent: args.payment_intent,
            ...createdRange(args.created_after, args.created_before),
            limit: args.limit,
            starting_after: args.starting_after,
          },
          context.signal,
        );
        return view.list(body, view.charge);
      },
    }),
    apiTool({
      name: "list_payment_intents",
      description:
        "List Stripe payment intents, newest first, optionally for one customer and a " +
        "creation window. Shows status and the last payment error (e.g. a declined card).",
      input: STRIPE_INPUTS.list_payment_intents,
      readOnly: true,
      async run(args, context) {
        const body = await client.get(
          "/v1/payment_intents",
          {
            customer: args.customer,
            ...createdRange(args.created_after, args.created_before),
            limit: args.limit,
            starting_after: args.starting_after,
          },
          context.signal,
        );
        return view.list(body, view.paymentIntent);
      },
    }),
    apiTool({
      name: "list_invoices",
      description:
        "List Stripe invoices, newest first, optionally by customer, status or subscription. " +
        "Shows totals, amount due and paid (minor units) and due dates.",
      input: STRIPE_INPUTS.list_invoices,
      readOnly: true,
      async run(args, context) {
        const body = await client.get(
          "/v1/invoices",
          {
            customer: args.customer,
            status: args.status,
            subscription: args.subscription,
            ...createdRange(args.created_after, args.created_before),
            limit: args.limit,
            starting_after: args.starting_after,
          },
          context.signal,
        );
        return view.list(body, (item) => view.invoice(item, false));
      },
    }),
    apiTool({
      name: "get_invoice",
      description: "Get one Stripe invoice by id (in_…), including its line items.",
      input: STRIPE_INPUTS.get_invoice,
      readOnly: true,
      async run(args, context) {
        const body = await client.get(path("/v1/invoices/{id}", args.invoice), {}, context.signal);
        return view.invoice(body, true);
      },
    }),
    apiTool({
      name: "list_subscriptions",
      description:
        "List Stripe subscriptions, optionally by customer and status, with their prices, " +
        "quantities and billing periods.",
      input: STRIPE_INPUTS.list_subscriptions,
      readOnly: true,
      async run(args, context) {
        const body = await client.get(
          "/v1/subscriptions",
          {
            customer: args.customer,
            status: args.status,
            limit: args.limit,
            starting_after: args.starting_after,
          },
          context.signal,
        );
        return view.list(body, view.subscription);
      },
    }),
    apiTool({
      name: "list_refunds",
      description:
        "List Stripe refunds, newest first, optionally for one charge or payment intent. " +
        "Check it before refunding so a charge is never refunded twice.",
      input: STRIPE_INPUTS.list_refunds,
      readOnly: true,
      async run(args, context) {
        const body = await client.get(
          "/v1/refunds",
          {
            charge: args.charge,
            payment_intent: args.payment_intent,
            ...createdRange(args.created_after, args.created_before),
            limit: args.limit,
            starting_after: args.starting_after,
          },
          context.signal,
        );
        return view.list(body, view.refund);
      },
    }),
    apiTool({
      name: "get_balance",
      description: "Get the Stripe account balance: available and pending funds per currency.",
      input: STRIPE_INPUTS.get_balance,
      readOnly: true,
      async run(_args, context) {
        return view.balance(await client.get("/v1/balance", {}, context.signal));
      },
    }),
    apiTool({
      name: "create_refund",
      description:
        "Refund a Stripe charge or payment intent, fully or partly. Moves money back to the " +
        "customer and needs the user's approval. Look up the charge and its existing refunds " +
        "first, then state the exact amount in minor units.",
      input: STRIPE_INPUTS.create_refund,
      readOnly: false,
      async run(args, context) {
        const target = refundTarget(args);
        if (target === null) {
          throw new ApiToolError(STRIPE_PROVIDER, "Give exactly one of charge or payment_intent.", {
            code: "invalid_request",
          });
        }
        const idempotencyKey = requireIdempotencyKey(STRIPE_PROVIDER, context);
        const body = await client.post(
          "/v1/refunds",
          {
            [target.kind]: target.id,
            amount: args.amount,
            reason: args.reason,
            metadata: args.metadata,
          },
          { idempotencyKey, signal: context.signal },
        );
        return view.refund(body);
      },
    }),
    apiTool({
      name: "cancel_subscription",
      description:
        "Cancel a Stripe subscription immediately. The customer stops being billed; this " +
        "cannot be undone and needs the user's approval.",
      input: STRIPE_INPUTS.cancel_subscription,
      readOnly: false,
      async run(args, context) {
        const idempotencyKey = requireIdempotencyKey(STRIPE_PROVIDER, context);
        const params: FormParams = {
          invoice_now: args.invoice_now,
          prorate: args.prorate,
          cancellation_details: args.comment === undefined ? undefined : { comment: args.comment },
        };
        const body: JsonObject = await client.delete(
          path("/v1/subscriptions/{id}", args.subscription),
          params,
          { idempotencyKey, signal: context.signal },
        );
        return view.subscription(body);
      },
    }),
  ];
  return tools;
}
