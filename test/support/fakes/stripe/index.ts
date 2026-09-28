/**
 * A stateful, contract-faithful local fake of the Stripe REST API (the
 * subset Revenue Desk's stripe-api profile uses), loaded from
 * test/fixtures/business/stripe.json. Test-only; never reachable from
 * product code paths (docs/ARCHITECTURE.md §11).
 *
 * Contract points it enforces, as Stripe does:
 * - Bearer authentication only (Basic, a missing or a wrong key: 401).
 * - Form encoding only: a JSON body is refused with 415. Bracket syntax for
 *   nested parameters; unknown parameters are a 400 `parameter_unknown`.
 * - `Idempotency-Key` on writes: the same key and parameters replay the first
 *   response (`Idempotent-Replayed: true`); the same key with other
 *   parameters is a 400 `idempotency_error`.
 * - The error envelope `{error:{type, code, message, param, decline_code}}`
 *   with a `Request-Id` header on every response.
 * - Cursor lists (`limit`, `starting_after`, `ending_before`), newest first,
 *   `created` range filters and `expand[]`.
 * Provider failures (402 declines, 429, 5xx, dropped connections) are
 * injected with `faults`, so tests choose exactly which request fails.
 *
 * Objects follow API version 2024-06-20 (the fixture account's default);
 * a `Stripe-Version` header is validated and echoed but does not change shapes.
 */
import type { JsonObject, JsonValue } from "../../../../src/contracts/json.js";
import type { FakeClock } from "../core/clock.js";
import {
  bearerToken,
  FakeHttpServer,
  type FakeRequest,
  type FakeResponse,
  type FaultHandle,
  header,
  mediaType,
  type RecordedHttpRequest,
  Router,
} from "../core/http.js";
import { IdSequence, requestIdFactory } from "../core/ids.js";
import type { StripeFixture } from "../fixtures.js";
import { canonical, type FormObject, type FormValue, parseStripeParams } from "./form.js";

export interface StripeFakeOptions {
  readonly fixture: StripeFixture;
  readonly clock: FakeClock;
  /** The only key the fake accepts (sk_test_… or rk_test_…). */
  readonly secretKey: string;
  /** Path prefix clients must keep, e.g. "/stripe". */
  readonly prefix?: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface Customer {
  readonly id: string;
  readonly created: number;
  email: string | null;
  name: string;
  description: string | null;
  delinquent: boolean;
  metadata: Record<string, string>;
}

interface Card {
  readonly brand: string;
  readonly last4: string;
  readonly exp_month: number;
  readonly exp_year: number;
}

interface Charge {
  readonly id: string;
  readonly created: number;
  readonly customer: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: "succeeded" | "failed" | "pending";
  readonly description: string | null;
  readonly invoice: string | null;
  readonly paymentIntent: string;
  readonly card: Card;
  readonly metadata: Record<string, string>;
  amountRefunded: number;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly declineCode: string | null;
}

interface Refund {
  readonly id: string;
  readonly created: number;
  readonly charge: string;
  readonly paymentIntent: string;
  readonly amount: number;
  readonly currency: string;
  readonly reason: "duplicate" | "fraudulent" | "requested_by_customer" | null;
  readonly status: "pending" | "succeeded" | "failed" | "canceled";
  readonly metadata: Record<string, string>;
}

type Invoice = StripeFixture["invoices"][number];

interface Subscription {
  readonly id: string;
  readonly created: number;
  readonly customer: string;
  status: StripeFixture["subscriptions"][number]["status"];
  readonly price: StripeFixture["subscriptions"][number]["price"];
  readonly quantity: number;
  readonly currentPeriodStart: number;
  readonly currentPeriodEnd: number;
  readonly latestInvoice: string | null;
  canceledAt: number | null;
  endedAt: number | null;
  cancellation: { comment: string | null; feedback: string | null; reason: string | null };
}

interface Balance {
  available: Map<string, number>;
  pending: Map<string, number>;
}

interface IdempotentResult {
  readonly fingerprint: string;
  readonly requestId: string;
  readonly status: number;
  readonly body: JsonValue;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

type StripeErrorType = "api_error" | "card_error" | "idempotency_error" | "invalid_request_error";

class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly type: StripeErrorType,
    message: string,
    readonly details: {
      readonly code?: string;
      readonly param?: string;
      readonly declineCode?: string;
      /** Whether an idempotent result is saved (false for parameter validation). */
      readonly saved?: boolean;
    } = {},
  ) {
    super(message);
  }

  envelope(): JsonObject {
    const { code, param, declineCode } = this.details;
    return {
      error: {
        ...(code === undefined ? {} : { code }),
        ...(declineCode === undefined ? {} : { decline_code: declineCode }),
        ...(code === undefined
          ? {}
          : { doc_url: `https://stripe.com/docs/error-codes/${code.replaceAll("_", "-")}` }),
        message: this.message,
        ...(param === undefined ? {} : { param }),
        type: this.type,
      },
    };
  }
}

const invalid = (message: string, details: StripeError["details"] = {}) =>
  new StripeError(400, "invalid_request_error", message, details);

const missing = (kind: string, id: string, param: string, status = 404) =>
  new StripeError(status, "invalid_request_error", `No such ${kind}: '${id}'`, {
    code: "resource_missing",
    param,
  });

// ---------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------

type Handler = (context: {
  readonly request: FakeRequest;
  readonly params: FormObject;
}) => JsonValue;

interface RouteSpec {
  readonly method: "GET" | "POST" | "DELETE";
  readonly pattern: string;
  /** Accepted top-level parameters besides `expand`. */
  readonly allowed: readonly string[];
  readonly handler: Handler;
}

const LIST_PARAMS = ["limit", "starting_after", "ending_before", "created"] as const;
const REFUND_REASONS = ["duplicate", "fraudulent", "requested_by_customer"] as const;
const SUBSCRIPTION_STATUSES = [
  "active",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "trialing",
  "paused",
  "all",
  "ended",
] as const;
const INVOICE_STATUSES = ["draft", "open", "paid", "uncollectible", "void"] as const;
const STRIPE_VERSION = /^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/;

export class StripeFake {
  readonly http: FakeHttpServer;
  private readonly customers = new Map<string, Customer>();
  private readonly charges = new Map<string, Charge>();
  private readonly invoicesById = new Map<string, Invoice>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly refundsById = new Map<string, Refund>();
  private readonly balance: Balance;
  private readonly idempotency = new Map<string, IdempotentResult>();
  private readonly ids = new IdSequence();
  private readonly requestId = requestIdFactory("req_RDstripe");
  private readonly clock: FakeClock;
  private readonly secretKey: string;
  private readonly defaultVersion: string;

  private constructor(options: StripeFakeOptions) {
    this.clock = options.clock;
    this.secretKey = options.secretKey;
    this.defaultVersion = options.fixture.account.apiVersion;
    const fixture = options.fixture;
    for (const customer of fixture.customers) {
      this.customers.set(customer.id, {
        id: customer.id,
        created: customer.created,
        email: customer.email,
        name: customer.name,
        description: customer.description ?? null,
        delinquent: customer.delinquent ?? false,
        metadata: { ...customer.metadata },
      });
    }
    for (const charge of fixture.charges) {
      this.charges.set(charge.id, {
        id: charge.id,
        created: charge.created,
        customer: charge.customer,
        amount: charge.amount,
        currency: charge.currency,
        status: charge.status,
        description: charge.description,
        invoice: charge.invoice,
        paymentIntent: charge.payment_intent,
        card: charge.card,
        metadata: { ...charge.metadata },
        amountRefunded: charge.amount_refunded ?? 0,
        failureCode: charge.failure_code ?? null,
        failureMessage: charge.failure_message ?? null,
        declineCode: charge.decline_code ?? null,
      });
    }
    for (const invoice of fixture.invoices)
      this.invoicesById.set(invoice.id, structuredClone(invoice));
    for (const subscription of fixture.subscriptions) {
      this.subscriptions.set(subscription.id, {
        id: subscription.id,
        created: subscription.created,
        customer: subscription.customer,
        status: subscription.status,
        price: subscription.price,
        quantity: subscription.quantity,
        currentPeriodStart: subscription.current_period_start,
        currentPeriodEnd: subscription.current_period_end,
        latestInvoice: subscription.latest_invoice,
        canceledAt: subscription.canceled_at ?? null,
        endedAt: subscription.ended_at ?? null,
        cancellation: {
          comment: null,
          feedback: null,
          reason: subscription.status === "canceled" ? "cancellation_requested" : null,
        },
      });
    }
    for (const refund of fixture.refunds) {
      const charge = this.charges.get(refund.charge);
      if (charge === undefined) throw new Error(`Refund ${refund.id} names unknown charge`);
      this.refundsById.set(refund.id, {
        id: refund.id,
        created: refund.created,
        charge: refund.charge,
        paymentIntent: charge.paymentIntent,
        amount: refund.amount,
        currency: charge.currency,
        reason: refund.reason,
        status: refund.status,
        metadata: { ...refund.metadata },
      });
    }
    this.balance = {
      available: new Map(fixture.balance.available.map((entry) => [entry.currency, entry.amount])),
      pending: new Map(fixture.balance.pending.map((entry) => [entry.currency, entry.amount])),
    };

    const router = new Router();
    for (const spec of this.routes()) {
      router.add(spec.method, spec.pattern, (request) => this.dispatch(spec, request));
    }
    this.http = new FakeHttpServer({
      name: "stripe",
      clock: options.clock,
      router,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      notFound: (request) =>
        this.reply(
          404,
          invalid(
            `Unrecognized request URL (${request.method}: ${request.path}). Please see https://stripe.com/docs or we can help at https://support.stripe.com/.`,
          ).envelope(),
        ),
    });
  }

  static async start(options: StripeFakeOptions): Promise<StripeFake> {
    const fake = new StripeFake(options);
    await fake.http.start();
    return fake;
  }

  /** The base URL for STRIPE_API_BASE_URL (origin plus prefix). */
  get baseUrl(): string {
    return this.http.baseUrl;
  }

  get requests(): readonly RecordedHttpRequest[] {
    return this.http.requests;
  }

  close(): Promise<void> {
    return this.http.close();
  }

  // --- Assertions -------------------------------------------------------------

  /** Every refund as the API would return it, newest first. */
  refunds(filter: { readonly charge?: string } = {}): JsonObject[] {
    return [...this.refundsById.values()]
      .filter((refund) => filter.charge === undefined || refund.charge === filter.charge)
      .sort(newestFirst)
      .map((refund) => this.refundJson(refund));
  }

  /** A charge as the API would return it, or undefined. */
  charge(id: string): JsonObject | undefined {
    const charge = this.charges.get(id);
    return charge === undefined ? undefined : this.chargeJson(charge);
  }

  subscription(id: string): JsonObject | undefined {
    const subscription = this.subscriptions.get(id);
    return subscription === undefined ? undefined : this.subscriptionJson(subscription);
  }

  /** Available balance in minor units for a currency. */
  availableBalance(currency = "usd"): number {
    return this.balance.available.get(currency) ?? 0;
  }

  /** Writes (POST, DELETE) that reached a route, in order, with their Idempotency-Key. */
  writes(): {
    readonly method: string;
    readonly path: string;
    readonly idempotencyKey: string | null;
    readonly status: number;
    readonly replayed: boolean;
  }[] {
    return this.http.requests
      .filter((entry) => entry.method !== "GET" && entry.fault === null)
      .map((entry) => ({
        method: entry.method,
        path: entry.path,
        idempotencyKey: entry.headers["idempotency-key"] ?? null,
        status: entry.status,
        replayed: entry.notes.replayed === true,
      }));
  }

  // --- Faults -----------------------------------------------------------------

  readonly faults = {
    /** 402 card_error for matching requests (a declined card). */
    decline: (
      path: string | RegExp,
      options: {
        readonly method?: string;
        readonly times?: number;
        readonly declineCode?: string;
      } = {},
    ): FaultHandle =>
      this.http.injectFault({
        name: "stripe-402-card-declined",
        path,
        ...(options.method === undefined ? {} : { method: options.method }),
        ...(options.times === undefined ? {} : { times: options.times }),
        respond: () =>
          this.reply(
            402,
            new StripeError(402, "card_error", "Your card was declined.", {
              code: "card_declined",
              declineCode: options.declineCode ?? "generic_decline",
            }).envelope(),
          ),
      }),
    /** 429 rate_limit for matching requests, optionally with Retry-After. */
    rateLimit: (
      path: string | RegExp,
      options: {
        readonly method?: string;
        readonly times?: number;
        readonly retryAfterSeconds?: number;
      } = {},
    ): FaultHandle =>
      this.http.injectFault({
        name: "stripe-429-rate-limit",
        path,
        ...(options.method === undefined ? {} : { method: options.method }),
        ...(options.times === undefined ? {} : { times: options.times }),
        respond: () =>
          this.reply(
            429,
            invalid(
              "Request rate limit exceeded. Learn more about rate limits here https://stripe.com/docs/rate-limits.",
              { code: "rate_limit" },
            ).envelope(),
            options.retryAfterSeconds === undefined
              ? {}
              : { "retry-after": String(options.retryAfterSeconds) },
          ),
      }),
    /** 500 api_error for matching requests. */
    serverError: (
      path: string | RegExp,
      options: { readonly method?: string; readonly times?: number } = {},
    ): FaultHandle =>
      this.http.injectFault({
        name: "stripe-500-api-error",
        path,
        ...(options.method === undefined ? {} : { method: options.method }),
        ...(options.times === undefined ? {} : { times: options.times }),
        respond: () =>
          this.reply(
            500,
            new StripeError(500, "api_error", "An unknown error occurred").envelope(),
          ),
      }),
    /** Drops the connection without a reply (a network error). */
    drop: (
      path: string | RegExp,
      options: { readonly method?: string; readonly times?: number } = {},
    ): FaultHandle =>
      this.http.injectFault({
        name: "stripe-connection-dropped",
        path,
        ...(options.method === undefined ? {} : { method: options.method }),
        ...(options.times === undefined ? {} : { times: options.times }),
        respond: "drop",
      }),
  };

  // --- Dispatch ---------------------------------------------------------------

  private dispatch(spec: RouteSpec, request: FakeRequest): FakeResponse {
    const requestId = this.requestId();
    const version = header(request, "stripe-version");
    const replyHeaders: Record<string, string> = {
      "request-id": requestId,
      "stripe-version": version ?? this.defaultVersion,
    };
    const fail = (error: StripeError) => this.reply(error.status, error.envelope(), replyHeaders);

    const auth = this.authenticate(request);
    if (auth !== null) return fail(auth);
    if (version !== undefined && !STRIPE_VERSION.test(version)) {
      return fail(
        invalid(`Invalid Stripe API version: ${version}`, { code: "api_version_invalid" }),
      );
    }

    const parsed = this.parameters(request);
    if (!parsed.ok) return fail(parsed.error);
    const params = parsed.params;
    for (const name of Object.keys(params)) {
      if (name !== "expand" && !spec.allowed.includes(name)) {
        return fail(
          invalid(`Received unknown parameter: ${name}`, {
            code: "parameter_unknown",
            param: name,
          }),
        );
      }
    }

    const key = request.method === "GET" ? undefined : header(request, "idempotency-key");
    let fingerprint = "";
    if (key !== undefined) {
      if (key.length > 255) {
        return fail(invalid("Idempotency keys must be at most 255 characters long."));
      }
      fingerprint = `${request.method} ${request.path} ${canonical(params)}`;
      const saved = this.idempotency.get(key);
      if (saved !== undefined) {
        if (saved.fingerprint !== fingerprint) {
          return fail(
            new StripeError(
              400,
              "idempotency_error",
              `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${key}' if you meant to execute a different request.`,
            ),
          );
        }
        request.note({ replayed: true });
        return this.reply(saved.status, saved.body, {
          ...replyHeaders,
          "idempotency-key": key,
          "idempotent-replayed": "true",
          "original-request": saved.requestId,
        });
      }
    }

    let status = 200;
    let body: JsonValue;
    let save = true;
    try {
      body = spec.handler({ request, params });
    } catch (error) {
      if (!(error instanceof StripeError)) throw error;
      status = error.status;
      body = error.envelope();
      save = error.details.saved !== false;
    }
    if (key !== undefined) {
      if (save) this.idempotency.set(key, { fingerprint, requestId, status, body });
      replyHeaders["idempotency-key"] = key;
    }
    return this.reply(status, body, replyHeaders);
  }

  private authenticate(request: FakeRequest): StripeError | null {
    const authorization = header(request, "authorization");
    if (authorization === undefined) {
      return new StripeError(
        401,
        "invalid_request_error",
        "You did not provide an API key. You need to provide your API key in the Authorization header, using Bearer auth (e.g. 'Authorization: Bearer YOUR_SECRET_KEY'). See https://stripe.com/docs/api#authentication for details, or we can help at https://support.stripe.com/.",
      );
    }
    const token = bearerToken(request);
    if (token === null) {
      return new StripeError(
        401,
        "invalid_request_error",
        "This local Stripe fake accepts Bearer authentication only ('Authorization: Bearer YOUR_SECRET_KEY').",
      );
    }
    if (token !== this.secretKey) {
      return new StripeError(
        401,
        "invalid_request_error",
        `Invalid API Key provided: ${token.slice(0, 8)}${"*".repeat(8)}${token.slice(-4)}`,
      );
    }
    return null;
  }

  private parameters(
    request: FakeRequest,
  ):
    | { readonly ok: true; readonly params: FormObject }
    | { readonly ok: false; readonly error: StripeError } {
    const pairs: [string, string][] = [...request.query];
    if (request.rawBody !== "") {
      const type = mediaType(request);
      if (type !== "application/x-www-form-urlencoded") {
        return {
          ok: false,
          error: new StripeError(
            415,
            "invalid_request_error",
            `Invalid request: Stripe accepts application/x-www-form-urlencoded request bodies only, not ${type || "an untyped body"}.`,
          ),
        };
      }
      pairs.push(...new URLSearchParams(request.rawBody));
    }
    const parsed = parseStripeParams(pairs);
    if (!parsed.ok) {
      return { ok: false, error: invalid(parsed.message, { param: parsed.param, saved: false }) };
    }
    return { ok: true, params: parsed.params };
  }

  private reply(
    status: number,
    body: JsonValue,
    headers: Readonly<Record<string, string>> = {},
  ): FakeResponse {
    return {
      status,
      headers: { "request-id": headers["request-id"] ?? this.requestId(), ...headers },
      body,
    };
  }

  // --- Routes -----------------------------------------------------------------

  private routes(): RouteSpec[] {
    return [
      {
        method: "GET",
        pattern: "/v1/customers",
        allowed: [...LIST_PARAMS, "email", "test_clock"],
        handler: ({ params }) => {
          const email = stringParam(params, "email");
          return this.list(
            "/v1/customers",
            params,
            [...this.customers.values()],
            (customer) => (email === undefined ? true : customer.email === email),
            (customer) => this.customerJson(customer),
          );
        },
      },
      {
        method: "GET",
        pattern: "/v1/customers/:id",
        allowed: [],
        handler: ({ request, params }) =>
          this.expand(
            this.customerJson(this.find(this.customers, "customer", request.params.id)),
            params,
          ),
      },
      {
        method: "GET",
        pattern: "/v1/charges",
        allowed: [...LIST_PARAMS, "customer", "payment_intent", "transfer_group"],
        handler: ({ params }) => {
          const customer = stringParam(params, "customer");
          const paymentIntent = stringParam(params, "payment_intent");
          return this.list(
            "/v1/charges",
            params,
            [...this.charges.values()],
            (charge) =>
              (customer === undefined || charge.customer === customer) &&
              (paymentIntent === undefined || charge.paymentIntent === paymentIntent),
            (charge) => this.chargeJson(charge),
          );
        },
      },
      {
        method: "GET",
        pattern: "/v1/charges/:id",
        allowed: [],
        handler: ({ request, params }) =>
          this.expand(
            this.chargeJson(this.find(this.charges, "charge", request.params.id)),
            params,
          ),
      },
      {
        method: "GET",
        pattern: "/v1/payment_intents",
        allowed: [...LIST_PARAMS, "customer"],
        handler: ({ params }) => {
          const customer = stringParam(params, "customer");
          const intents = [...this.charges.values()].map((charge) => ({
            id: charge.paymentIntent,
            created: charge.created,
            charge,
          }));
          return this.list(
            "/v1/payment_intents",
            params,
            intents,
            (intent) => customer === undefined || intent.charge.customer === customer,
            (intent) => this.paymentIntentJson(intent.charge),
          );
        },
      },
      {
        method: "GET",
        pattern: "/v1/payment_intents/:id",
        allowed: [],
        handler: ({ request, params }) => {
          const charge = [...this.charges.values()].find(
            (entry) => entry.paymentIntent === request.params.id,
          );
          if (charge === undefined)
            throw missing("payment_intent", request.params.id ?? "", "intent");
          return this.expand(this.paymentIntentJson(charge), params);
        },
      },
      {
        method: "GET",
        pattern: "/v1/invoices",
        allowed: [
          ...LIST_PARAMS,
          "customer",
          "status",
          "subscription",
          "collection_method",
          "due_date",
        ],
        handler: ({ params }) => {
          const customer = stringParam(params, "customer");
          const status = enumParam(params, "status", INVOICE_STATUSES);
          const subscription = stringParam(params, "subscription");
          return this.list(
            "/v1/invoices",
            params,
            [...this.invoicesById.values()],
            (invoice) =>
              (customer === undefined || invoice.customer === customer) &&
              (status === undefined || invoice.status === status) &&
              (subscription === undefined || invoice.subscription === subscription),
            (invoice) => this.invoiceJson(invoice),
          );
        },
      },
      {
        method: "GET",
        pattern: "/v1/invoices/:id",
        allowed: [],
        handler: ({ request, params }) =>
          this.expand(
            this.invoiceJson(this.find(this.invoicesById, "invoice", request.params.id)),
            params,
          ),
      },
      {
        method: "GET",
        pattern: "/v1/subscriptions",
        allowed: [
          ...LIST_PARAMS,
          "customer",
          "status",
          "price",
          "collection_method",
          "current_period_end",
          "current_period_start",
        ],
        handler: ({ params }) => {
          const customer = stringParam(params, "customer");
          const status = enumParam(params, "status", SUBSCRIPTION_STATUSES);
          const price = stringParam(params, "price");
          return this.list(
            "/v1/subscriptions",
            params,
            [...this.subscriptions.values()],
            (subscription) =>
              (customer === undefined || subscription.customer === customer) &&
              (price === undefined || subscription.price.id === price) &&
              subscriptionStatusMatches(subscription.status, status),
            (subscription) => this.subscriptionJson(subscription),
          );
        },
      },
      {
        method: "GET",
        pattern: "/v1/subscriptions/:id",
        allowed: [],
        handler: ({ request, params }) =>
          this.expand(
            this.subscriptionJson(this.find(this.subscriptions, "subscription", request.params.id)),
            params,
          ),
      },
      {
        method: "DELETE",
        pattern: "/v1/subscriptions/:id",
        allowed: ["invoice_now", "prorate", "cancellation_details"],
        handler: ({ request, params }) => this.cancelSubscription(request.params.id ?? "", params),
      },
      {
        method: "GET",
        pattern: "/v1/refunds",
        allowed: [...LIST_PARAMS, "charge", "payment_intent"],
        handler: ({ params }) => {
          const charge = stringParam(params, "charge");
          const paymentIntent = stringParam(params, "payment_intent");
          return this.list(
            "/v1/refunds",
            params,
            [...this.refundsById.values()],
            (refund) =>
              (charge === undefined || refund.charge === charge) &&
              (paymentIntent === undefined || refund.paymentIntent === paymentIntent),
            (refund) => this.refundJson(refund),
          );
        },
      },
      {
        method: "GET",
        pattern: "/v1/refunds/:id",
        allowed: [],
        handler: ({ request, params }) =>
          this.expand(
            this.refundJson(this.find(this.refundsById, "refund", request.params.id)),
            params,
          ),
      },
      {
        method: "POST",
        pattern: "/v1/refunds",
        allowed: [
          "charge",
          "payment_intent",
          "amount",
          "reason",
          "metadata",
          "currency",
          "customer",
          "instructions_email",
          "origin",
          "refund_application_fee",
          "reverse_transfer",
        ],
        handler: ({ params }) => this.createRefund(params),
      },
      {
        method: "GET",
        pattern: "/v1/balance",
        allowed: [],
        handler: () => this.balanceJson(),
      },
    ];
  }

  // --- Writes -----------------------------------------------------------------

  private createRefund(params: FormObject): JsonValue {
    const chargeId = stringParam(params, "charge");
    const intentId = stringParam(params, "payment_intent");
    if (chargeId === undefined && intentId === undefined) {
      throw invalid(
        "One of the following params should be provided for this request: payment_intent or charge.",
        { code: "parameter_missing", saved: false },
      );
    }
    let charge: Charge | undefined;
    if (chargeId !== undefined) {
      charge = this.charges.get(chargeId);
      if (charge === undefined) throw missing("charge", chargeId, "charge", 400);
      if (intentId !== undefined && charge.paymentIntent !== intentId) {
        throw invalid(`Charge ${chargeId} does not belong to PaymentIntent ${intentId}.`, {
          param: "payment_intent",
        });
      }
    } else if (intentId !== undefined) {
      charge = [...this.charges.values()].find((entry) => entry.paymentIntent === intentId);
      if (charge === undefined) throw missing("payment_intent", intentId, "payment_intent", 400);
    }
    if (charge === undefined) throw invalid("No charge to refund.");
    const amount = intParam(params, "amount", { min: 1 });
    const reason = enumParam(params, "reason", REFUND_REASONS);
    const metadata = metadataParam(params);

    if (charge.status !== "succeeded") {
      throw invalid(`Charge ${charge.id} has not succeeded and cannot be refunded.`, {
        code: "charge_not_refundable",
        param: "charge",
      });
    }
    const remaining = charge.amount - charge.amountRefunded;
    if (remaining <= 0) {
      throw invalid(`Charge ${charge.id} has already been refunded.`, {
        code: "charge_already_refunded",
      });
    }
    const refundAmount = amount ?? remaining;
    if (refundAmount > remaining) {
      throw invalid(
        `Refund amount (${money(refundAmount, charge.currency)}) is greater than unrefunded amount on charge (${money(remaining, charge.currency)})`,
        { code: "amount_too_large", param: "amount" },
      );
    }

    const refund: Refund = {
      id: this.ids.next("re_"),
      created: this.clock.unix(),
      charge: charge.id,
      paymentIntent: charge.paymentIntent,
      amount: refundAmount,
      currency: charge.currency,
      reason: reason ?? null,
      status: "succeeded",
      metadata,
    };
    this.refundsById.set(refund.id, refund);
    charge.amountRefunded += refundAmount;
    this.balance.available.set(
      charge.currency,
      (this.balance.available.get(charge.currency) ?? 0) - refundAmount,
    );
    return this.refundJson(refund);
  }

  private cancelSubscription(id: string, params: FormObject): JsonValue {
    const subscription = this.find(this.subscriptions, "subscription", id);
    boolParam(params, "invoice_now");
    boolParam(params, "prorate");
    const details = params.cancellation_details;
    if (details !== undefined && (typeof details === "string" || Array.isArray(details))) {
      throw invalid("Invalid object", { param: "cancellation_details", saved: false });
    }
    if (subscription.status === "canceled") {
      throw invalid(
        "A canceled subscription can only update its cancellation_details and metadata.",
        { param: "id" },
      );
    }
    const now = this.clock.unix();
    subscription.status = "canceled";
    subscription.canceledAt = now;
    subscription.endedAt = now;
    subscription.cancellation = {
      comment: typeof details?.comment === "string" ? details.comment : null,
      feedback: typeof details?.feedback === "string" ? details.feedback : null,
      reason: "cancellation_requested",
    };
    return this.subscriptionJson(subscription);
  }

  // --- Lists and expansion ------------------------------------------------------

  private list<T extends { readonly id: string; readonly created: number }>(
    url: string,
    params: FormObject,
    items: readonly T[],
    keep: (item: T) => boolean,
    render: (item: T) => JsonObject,
  ): JsonObject {
    const limit = intParam(params, "limit", { min: 1, max: 100 }) ?? 10;
    const created = rangeParam(params, "created");
    const startingAfter = stringParam(params, "starting_after");
    const endingBefore = stringParam(params, "ending_before");
    const sorted = [...items]
      .filter((item) => keep(item) && created(item.created))
      .sort(newestFirst);
    let window = sorted;
    if (startingAfter !== undefined) {
      const index = sorted.findIndex((item) => item.id === startingAfter);
      if (index < 0) throw missing(objectName(url), startingAfter, "starting_after", 400);
      window = sorted.slice(index + 1);
    } else if (endingBefore !== undefined) {
      const index = sorted.findIndex((item) => item.id === endingBefore);
      if (index < 0) throw missing(objectName(url), endingBefore, "ending_before", 400);
      window = sorted.slice(Math.max(0, index - limit), index);
    }
    const page = window.slice(0, limit);
    const hasMore =
      endingBefore === undefined
        ? window.length > limit
        : sorted.findIndex((item) => item.id === page[0]?.id) > 0;
    const listObject: JsonObject = {
      object: "list",
      data: page.map(render),
      has_more: hasMore,
      url,
    };
    return this.expand(listObject, params, "data.");
  }

  /** Applies `expand[]` to an object, or to each item of a list with prefix "data.". */
  private expand(object: JsonObject, params: FormObject, prefix = ""): JsonObject {
    const paths = expandParam(params);
    if (paths.length === 0) return object;
    const expandOne = (target: JsonObject, field: string): JsonObject => {
      const value = target[field];
      if (typeof value !== "string") {
        if (value === null || value === undefined) return target;
        throw invalid(`This property cannot be expanded (${field}).`, {
          param: "expand",
          saved: false,
        });
      }
      const expanded = this.lookup(value);
      if (expanded === undefined) {
        throw invalid(`This property cannot be expanded (${field}).`, {
          param: "expand",
          saved: false,
        });
      }
      return { ...target, [field]: expanded };
    };
    let result = object;
    for (const path of paths) {
      if (prefix !== "") {
        if (!path.startsWith(prefix)) {
          throw invalid(
            `This property cannot be expanded (${path}). You may want to try expanding '${prefix}${path}' instead.`,
            {
              param: "expand",
              saved: false,
            },
          );
        }
        const field = path.slice(prefix.length);
        const data = result.data;
        if (!Array.isArray(data)) return result;
        result = {
          ...result,
          data: data.map((item) => expandOne(item as JsonObject, field)),
        };
      } else {
        result = expandOne(result, path);
      }
    }
    return result;
  }

  private lookup(id: string): JsonObject | undefined {
    if (id.startsWith("cus_")) {
      const customer = this.customers.get(id);
      return customer && this.customerJson(customer);
    }
    if (id.startsWith("ch_")) {
      const charge = this.charges.get(id);
      return charge && this.chargeJson(charge);
    }
    if (id.startsWith("pi_")) {
      const charge = [...this.charges.values()].find((entry) => entry.paymentIntent === id);
      return charge && this.paymentIntentJson(charge);
    }
    if (id.startsWith("in_")) {
      const invoice = this.invoicesById.get(id);
      return invoice && this.invoiceJson(invoice);
    }
    if (id.startsWith("sub_")) {
      const subscription = this.subscriptions.get(id);
      return subscription && this.subscriptionJson(subscription);
    }
    return undefined;
  }

  private find<T>(map: ReadonlyMap<string, T>, kind: string, id: string | undefined): T {
    const value = id === undefined ? undefined : map.get(id);
    if (value === undefined) throw missing(kind, id ?? "", "id");
    return value;
  }

  // --- Renderers ----------------------------------------------------------------

  private customerJson(customer: Customer): JsonObject {
    return {
      id: customer.id,
      object: "customer",
      address: null,
      balance: 0,
      created: customer.created,
      currency: "usd",
      default_source: null,
      delinquent: customer.delinquent,
      description: customer.description,
      discount: null,
      email: customer.email,
      invoice_prefix: customer.id.slice(4, 12).toUpperCase(),
      invoice_settings: { custom_fields: null, default_payment_method: null, footer: null },
      livemode: false,
      metadata: customer.metadata,
      name: customer.name,
      phone: null,
      preferred_locales: [],
      shipping: null,
      tax_exempt: "none",
      test_clock: null,
    };
  }

  private chargeJson(charge: Charge): JsonObject {
    const succeeded = charge.status === "succeeded";
    const customer = this.customers.get(charge.customer);
    return {
      id: charge.id,
      object: "charge",
      amount: charge.amount,
      amount_captured: succeeded ? charge.amount : 0,
      amount_refunded: charge.amountRefunded,
      application: null,
      application_fee: null,
      application_fee_amount: null,
      balance_transaction: succeeded ? `txn_${charge.id.slice(3)}` : null,
      billing_details: {
        address: null,
        email: customer?.email ?? null,
        name: customer?.name ?? null,
        phone: null,
      },
      calculated_statement_descriptor: "KESTREL ANALYTICS",
      captured: succeeded,
      created: charge.created,
      currency: charge.currency,
      customer: charge.customer,
      description: charge.description,
      disputed: false,
      failure_balance_transaction: null,
      failure_code: charge.failureCode,
      failure_message: charge.failureMessage,
      fraud_details: {},
      invoice: charge.invoice,
      livemode: false,
      metadata: charge.metadata,
      on_behalf_of: null,
      outcome: succeeded
        ? {
            network_status: "approved_by_network",
            reason: null,
            risk_level: "normal",
            seller_message: "Payment complete.",
            type: "authorized",
          }
        : {
            network_status: "declined_by_network",
            reason: charge.declineCode ?? "generic_decline",
            risk_level: "normal",
            seller_message: "The bank did not return any further details with this decline.",
            type: "issuer_declined",
          },
      paid: succeeded,
      payment_intent: charge.paymentIntent,
      payment_method: `pm_${charge.id.slice(3)}`,
      payment_method_details: {
        card: { ...charge.card, country: "US", funding: "credit", network: charge.card.brand },
        type: "card",
      },
      receipt_email: customer?.email ?? null,
      receipt_number: null,
      refunded: charge.amountRefunded >= charge.amount,
      review: null,
      shipping: null,
      source: null,
      statement_descriptor: null,
      status: charge.status,
    };
  }

  private paymentIntentJson(charge: Charge): JsonObject {
    const succeeded = charge.status === "succeeded";
    return {
      id: charge.paymentIntent,
      object: "payment_intent",
      amount: charge.amount,
      amount_capturable: 0,
      amount_received: succeeded ? charge.amount : 0,
      canceled_at: null,
      cancellation_reason: null,
      capture_method: "automatic",
      client_secret: `${charge.paymentIntent}_secret_RDfake`,
      confirmation_method: "automatic",
      created: charge.created,
      currency: charge.currency,
      customer: charge.customer,
      description: charge.description,
      invoice: charge.invoice,
      last_payment_error: succeeded
        ? null
        : {
            charge: charge.id,
            code: charge.failureCode ?? "card_declined",
            decline_code: charge.declineCode ?? "generic_decline",
            message: charge.failureMessage ?? "Your card was declined.",
            type: "card_error",
          },
      latest_charge: charge.id,
      livemode: false,
      metadata: charge.metadata,
      payment_method: succeeded ? `pm_${charge.id.slice(3)}` : null,
      payment_method_types: ["card"],
      status: succeeded ? "succeeded" : "requires_payment_method",
    };
  }

  private invoiceJson(invoice: Invoice): JsonObject {
    const customer = this.customers.get(invoice.customer);
    const subtotal = invoice.lines.reduce((sum, line) => sum + line.amount, 0);
    const paid = invoice.status === "paid";
    return {
      id: invoice.id,
      object: "invoice",
      account_country: "US",
      account_name: "Kestrel Analytics, Inc.",
      amount_due: invoice.amount_due,
      amount_paid: invoice.amount_paid,
      amount_remaining: invoice.amount_due - invoice.amount_paid,
      attempt_count: invoice.attempt_count ?? (paid ? 1 : 0),
      attempted: (invoice.attempt_count ?? (paid ? 1 : 0)) > 0,
      auto_advance: !paid,
      billing_reason: "subscription_cycle",
      charge: invoice.charge,
      collection_method: "charge_automatically",
      created: invoice.created,
      currency: invoice.currency,
      customer: invoice.customer,
      customer_email: customer?.email ?? null,
      customer_name: customer?.name ?? null,
      description: null,
      due_date: null,
      ending_balance: 0,
      hosted_invoice_url: null,
      invoice_pdf: null,
      lines: {
        object: "list",
        data: invoice.lines.map((line, index) => ({
          id: `il_${invoice.id.slice(3)}_${index + 1}`,
          object: "line_item",
          amount: line.amount,
          currency: invoice.currency,
          description: line.description,
          period: { start: invoice.period_start, end: invoice.period_end },
          price: line.price,
          quantity: line.quantity,
          type: "subscription",
        })),
        has_more: false,
        total_count: invoice.lines.length,
        url: `/v1/invoices/${invoice.id}/lines`,
      },
      livemode: false,
      metadata: {},
      next_payment_attempt: invoice.next_payment_attempt ?? null,
      number: invoice.number,
      paid,
      payment_intent: invoice.payment_intent,
      period_end: invoice.period_end,
      period_start: invoice.period_start,
      status: invoice.status,
      status_transitions: {
        finalized_at: invoice.created,
        marked_uncollectible_at: null,
        paid_at: paid ? (this.charges.get(invoice.charge ?? "")?.created ?? invoice.created) : null,
        voided_at: null,
      },
      subscription: invoice.subscription,
      subtotal,
      total: subtotal,
    };
  }

  private subscriptionJson(subscription: Subscription): JsonObject {
    const price = {
      id: subscription.price.id,
      object: "price",
      active: true,
      currency: subscription.price.currency,
      nickname: subscription.price.nickname,
      product: subscription.price.product,
      recurring: { interval: subscription.price.interval, interval_count: 1 },
      type: "recurring",
      unit_amount: subscription.price.unit_amount,
    };
    return {
      id: subscription.id,
      object: "subscription",
      billing_cycle_anchor: subscription.created,
      cancel_at: null,
      cancel_at_period_end: false,
      canceled_at: subscription.canceledAt,
      cancellation_details: subscription.cancellation,
      collection_method: "charge_automatically",
      created: subscription.created,
      currency: subscription.price.currency,
      current_period_end: subscription.currentPeriodEnd,
      current_period_start: subscription.currentPeriodStart,
      customer: subscription.customer,
      days_until_due: null,
      default_payment_method: null,
      ended_at: subscription.endedAt,
      items: {
        object: "list",
        data: [
          {
            id: `si_${subscription.id.slice(4)}`,
            object: "subscription_item",
            price,
            quantity: subscription.quantity,
            subscription: subscription.id,
          },
        ],
        has_more: false,
        total_count: 1,
        url: `/v1/subscription_items?subscription=${subscription.id}`,
      },
      latest_invoice: subscription.latestInvoice,
      livemode: false,
      metadata: {},
      quantity: subscription.quantity,
      start_date: subscription.created,
      status: subscription.status,
      trial_end: null,
      trial_start: null,
    };
  }

  private refundJson(refund: Refund): JsonObject {
    return {
      id: refund.id,
      object: "refund",
      amount: refund.amount,
      balance_transaction: `txn_${refund.id.slice(3)}`,
      charge: refund.charge,
      created: refund.created,
      currency: refund.currency,
      metadata: refund.metadata,
      payment_intent: refund.paymentIntent,
      reason: refund.reason,
      receipt_number: null,
      source_transfer_reversal: null,
      status: refund.status,
      transfer_reversal: null,
    };
  }

  private balanceJson(): JsonObject {
    const entries = (map: ReadonlyMap<string, number>) =>
      [...map.entries()].map(([currency, amount]) => ({
        amount,
        currency,
        source_types: { card: amount },
      }));
    return {
      object: "balance",
      available: entries(this.balance.available),
      connect_reserved: [...this.balance.available.keys()].map((currency) => ({
        amount: 0,
        currency,
      })),
      livemode: false,
      pending: entries(this.balance.pending),
    };
  }
}

// ---------------------------------------------------------------------------
// Parameter helpers
// ---------------------------------------------------------------------------

function newestFirst(
  a: { readonly created: number; readonly id: string },
  b: { readonly created: number; readonly id: string },
): number {
  return b.created - a.created || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

function objectName(url: string): string {
  const resource = url.split("/").at(-1) ?? "object";
  return resource.endsWith("s") ? resource.slice(0, -1) : resource;
}

function stringParam(params: FormObject, name: string): string | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw invalid(`Invalid string: ${name}`, { param: name, saved: false });
  return value;
}

function intParam(
  params: FormObject,
  name: string,
  bounds: { readonly min?: number; readonly max?: number } = {},
): number | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    throw invalid(`Invalid integer: ${typeof value === "string" ? value : "[object]"}`, {
      code: "parameter_invalid_integer",
      param: name,
      saved: false,
    });
  }
  const number = Number(value);
  if (
    (bounds.min !== undefined && number < bounds.min) ||
    (bounds.max !== undefined && number > bounds.max)
  ) {
    const range =
      bounds.max === undefined
        ? `greater than or equal to ${bounds.min}`
        : `between ${bounds.min ?? 0} and ${bounds.max}`;
    throw invalid(`This value must be ${range}.`, {
      code: "parameter_invalid_integer",
      param: name,
      saved: false,
    });
  }
  return number;
}

function boolParam(params: FormObject, name: string): boolean | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalid(`Invalid boolean: ${typeof value === "string" ? value : "[object]"}`, {
    param: name,
    saved: false,
  });
}

function enumParam<const T extends readonly string[]>(
  params: FormObject,
  name: string,
  values: T,
): T[number] | undefined {
  const value = stringParam(params, name);
  if (value === undefined) return undefined;
  if (!values.includes(value)) {
    const list =
      values.length > 1 ? `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}` : values[0];
    throw invalid(`Invalid ${name}: must be one of ${list}`, { param: name, saved: false });
  }
  return value;
}

function metadataParam(params: FormObject): Record<string, string> {
  const value = params.metadata;
  if (value === undefined || value === "") return {};
  if (typeof value === "string" || Array.isArray(value)) {
    throw invalid("Invalid object", { param: "metadata", saved: false });
  }
  const out: Record<string, string> = {};
  const entries = Object.entries(value);
  if (entries.length > 50)
    throw invalid("You can specify up to 50 metadata keys.", { param: "metadata", saved: false });
  for (const [key, entry] of entries) {
    if (typeof entry !== "string")
      throw invalid("Invalid object", { param: `metadata[${key}]`, saved: false });
    if (key.length > 40)
      throw invalid("Metadata keys can be up to 40 characters long.", {
        param: `metadata[${key}]`,
        saved: false,
      });
    if (entry.length > 500)
      throw invalid("Metadata values can be up to 500 characters long.", {
        param: `metadata[${key}]`,
        saved: false,
      });
    out[key] = entry;
  }
  return out;
}

/** `created=123` or `created[gte]=…&created[lt]=…` as a predicate. */
function rangeParam(params: FormObject, name: string): (value: number) => boolean {
  const value = params[name];
  if (value === undefined) return () => true;
  const asInt = (raw: FormValue | undefined, param: string): number | undefined => {
    if (raw === undefined) return undefined;
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
      throw invalid(`Invalid integer: ${typeof raw === "string" ? raw : "[object]"}`, {
        code: "parameter_invalid_integer",
        param,
        saved: false,
      });
    }
    return Number(raw);
  };
  if (typeof value === "string") {
    const exact = asInt(value, name);
    return (candidate) => candidate === exact;
  }
  if (Array.isArray(value)) throw invalid("Invalid hash", { param: name, saved: false });
  for (const key of Object.keys(value)) {
    if (!["gt", "gte", "lt", "lte"].includes(key)) {
      throw invalid(`Received unknown parameter: ${name}[${key}]`, {
        code: "parameter_unknown",
        param: `${name}[${key}]`,
        saved: false,
      });
    }
  }
  const gt = asInt(value.gt, `${name}[gt]`);
  const gte = asInt(value.gte, `${name}[gte]`);
  const lt = asInt(value.lt, `${name}[lt]`);
  const lte = asInt(value.lte, `${name}[lte]`);
  return (candidate) =>
    (gt === undefined || candidate > gt) &&
    (gte === undefined || candidate >= gte) &&
    (lt === undefined || candidate < lt) &&
    (lte === undefined || candidate <= lte);
}

function expandParam(params: FormObject): string[] {
  const value = params.expand;
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) throw invalid("Invalid array", { param: "expand", saved: false });
  return value.map((entry) => {
    if (typeof entry !== "string")
      throw invalid("Invalid array", { param: "expand", saved: false });
    return entry;
  });
}

function subscriptionStatusMatches(
  status: Subscription["status"],
  filter: (typeof SUBSCRIPTION_STATUSES)[number] | undefined,
): boolean {
  if (filter === undefined) return status !== "canceled";
  if (filter === "all") return true;
  if (filter === "ended") return status === "canceled";
  return status === filter;
}

function money(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}
