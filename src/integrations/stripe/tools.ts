// The Stripe tools (docs/ARCHITECTURE.md §2): each is one REST operation.

import type { JsonObject } from "../../contracts/json.js";
import {
  type ApiTool,
  type ApiToolOptions,
  apiTool,
  requireIdempotencyKey,
} from "../shared/api-tool.js";
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

/** A value in Stripe's search query language: double-quoted, with quotes and backslashes escaped. */
export function searchValue(value: string): string {
  return `"${value.replace(/[\\"]/g, (character) => `\\${character}`)}"`;
}

/** The customer search query for a name (contains) and, optionally, an exact email. */
export function customerSearchQuery(name: string, email: string | undefined): string {
  const clauses = [`name~${searchValue(name.trim())}`];
  if (email !== undefined) clauses.push(`email:${searchValue(email)}`);
  return clauses.join(" AND ");
}

export function createStripeTools(
  client: StripeClient,
  options: Pick<ApiToolOptions, "timezone"> = {},
): readonly ApiTool[] {
  const context: view.ViewContext =
    options.timezone === undefined ? {} : { timezone: options.timezone };
  const tools = [
    apiTool({
      name: "find_customers",
      description:
        "Find Stripe customers by exact email address or by name (text contained in the " +
        "customer's name, such as the company name). Use an email only when a system or the " +
        "user gave it to you; otherwise search by name. With neither, lists customers. " +
        "Returns compact customer records (id, name, email, balance in minor units, created). " +
        "Page an email lookup with starting_after and a name search with page.",
      input: STRIPE_INPUTS.find_customers,
      readOnly: true,
      async run(args, call) {
        if (args.name !== undefined) {
          if (args.starting_after !== undefined) {
            throw new ApiToolError(
              STRIPE_PROVIDER,
              "A name search pages with page (next_page), not starting_after.",
              { code: "invalid_request" },
            );
          }
          const body = await client.get(
            "/v1/customers/search",
            {
              query: customerSearchQuery(args.name, args.email),
              limit: args.limit,
              page: args.page,
            },
            call.signal,
          );
          return view.searchList(body, (item) => view.customer(item, context));
        }
        if (args.page !== undefined) {
          throw new ApiToolError(
            STRIPE_PROVIDER,
            "page continues a name search; give the same name with it.",
            { code: "invalid_request" },
          );
        }
        const body = await client.get(
          "/v1/customers",
          { email: args.email, limit: args.limit, starting_after: args.starting_after },
          call.signal,
        );
        return view.list(body, (item) => view.customer(item, context));
      },
    }),
    apiTool({
      name: "get_customer",
      description: "Get one Stripe customer by id (cus_…).",
      input: STRIPE_INPUTS.get_customer,
      readOnly: true,
      async run(args, call) {
        const body = await client.get(path("/v1/customers/{id}", args.customer), {}, call.signal);
        return view.customer(body, context);
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
      async run(args, call) {
        const body = await client.get(
          "/v1/charges",
          {
            customer: args.customer,
            payment_intent: args.payment_intent,
            ...createdRange(args.created_after, args.created_before),
            limit: args.limit,
            starting_after: args.starting_after,
          },
          call.signal,
        );
        return view.list(body, (item) => view.charge(item, context));
      },
    }),
    apiTool({
      name: "list_payment_intents",
      description:
        "List Stripe payment intents, newest first, optionally for one customer and a " +
        "creation window. Shows status and the last payment error (e.g. a declined card).",
      input: STRIPE_INPUTS.list_payment_intents,
      readOnly: true,
      async run(args, call) {
        const body = await client.get(
          "/v1/payment_intents",
          {
            customer: args.customer,
            ...createdRange(args.created_after, args.created_before),
            limit: args.limit,
            starting_after: args.starting_after,
          },
          call.signal,
        );
        return view.list(body, (item) => view.paymentIntent(item, context));
      },
    }),
    apiTool({
      name: "list_invoices",
      description:
        "List Stripe invoices, newest first, optionally by customer, status or subscription. " +
        "Shows totals, amount due and paid (minor units) and due dates.",
      input: STRIPE_INPUTS.list_invoices,
      readOnly: true,
      async run(args, call) {
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
          call.signal,
        );
        return view.list(body, (item) => view.invoice(item, false, context));
      },
    }),
    apiTool({
      name: "get_invoice",
      description: "Get one Stripe invoice by id (in_…), including its line items.",
      input: STRIPE_INPUTS.get_invoice,
      readOnly: true,
      async run(args, call) {
        const body = await client.get(path("/v1/invoices/{id}", args.invoice), {}, call.signal);
        return view.invoice(body, true, context);
      },
    }),
    apiTool({
      name: "list_subscriptions",
      description:
        "List Stripe subscriptions, optionally by customer and status, with their prices, " +
        "quantities and billing periods.",
      input: STRIPE_INPUTS.list_subscriptions,
      readOnly: true,
      async run(args, call) {
        const body = await client.get(
          "/v1/subscriptions",
          {
            customer: args.customer,
            status: args.status,
            limit: args.limit,
            starting_after: args.starting_after,
          },
          call.signal,
        );
        return view.list(body, (item) => view.subscription(item, context));
      },
    }),
    apiTool({
      name: "list_refunds",
      description:
        "List Stripe refunds, newest first, optionally for one charge or payment intent. " +
        "Check it before refunding so a charge is never refunded twice.",
      input: STRIPE_INPUTS.list_refunds,
      readOnly: true,
      async run(args, call) {
        const body = await client.get(
          "/v1/refunds",
          {
            charge: args.charge,
            payment_intent: args.payment_intent,
            ...createdRange(args.created_after, args.created_before),
            limit: args.limit,
            starting_after: args.starting_after,
          },
          call.signal,
        );
        return view.list(body, (item) => view.refund(item, context));
      },
    }),
    apiTool({
      name: "get_balance",
      description: "Get the Stripe account balance: available and pending funds per currency.",
      input: STRIPE_INPUTS.get_balance,
      readOnly: true,
      async run(_args, call) {
        return view.balance(await client.get("/v1/balance", {}, call.signal));
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
      async run(args, call) {
        const target = refundTarget(args);
        if (target === null) {
          throw new ApiToolError(STRIPE_PROVIDER, "Give exactly one of charge or payment_intent.", {
            code: "invalid_request",
          });
        }
        const idempotencyKey = requireIdempotencyKey(STRIPE_PROVIDER, call);
        const body = await client.post(
          "/v1/refunds",
          {
            [target.kind]: target.id,
            amount: args.amount,
            reason: args.reason,
            metadata: args.metadata,
          },
          { idempotencyKey, signal: call.signal },
        );
        return view.refund(body, context);
      },
    }),
    apiTool({
      name: "cancel_subscription",
      description:
        "Cancel a Stripe subscription immediately. The customer stops being billed; this " +
        "cannot be undone and needs the user's approval.",
      input: STRIPE_INPUTS.cancel_subscription,
      readOnly: false,
      async run(args, call) {
        const idempotencyKey = requireIdempotencyKey(STRIPE_PROVIDER, call);
        const params: FormParams = {
          invoice_now: args.invoice_now,
          prorate: args.prorate,
          cancellation_details: args.comment === undefined ? undefined : { comment: args.comment },
        };
        const body: JsonObject = await client.delete(
          path("/v1/subscriptions/{id}", args.subscription),
          params,
          { idempotencyKey, signal: call.signal },
        );
        return view.subscription(body, context);
      },
    }),
  ];
  return tools;
}
