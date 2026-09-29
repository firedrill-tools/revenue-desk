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
 * - Customer search (`/v1/customers/search`) with the query language subset
 *   in search.ts, paged with `page` / `next_page`.
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
import { invalid, missing, StripeError } from "./errors.js";
import { canonical, type FormObject, parseStripeParams } from "./form.js";
import {
  boolParam,
  enumParam,
  expandParam,
  INVOICE_STATUSES,
  intParam,
  LIST_PARAMS,
  metadataParam,
  money,
  newestFirst,
  objectName,
  REFUND_REASONS,
  rangeParam,
  SUBSCRIPTION_STATUSES,
  stringParam,
  subscriptionStatusMatches,
} from "./params.js";
import {
  balanceJson,
  chargeJson,
  customerJson,
  invoiceJson,
  paymentIntentJson,
  refundJson,
  subscriptionJson,
} from "./render.js";
import { matchesSearch, parseSearchQuery } from "./search.js";
import { type Charge, type Refund, StripeState } from "./state.js";

export interface StripeFakeOptions {
  readonly fixture: StripeFixture;
  readonly clock: FakeClock;
  /** The only key the fake accepts (sk_test_… or rk_test_…). */
  readonly secretKey: string;
  /** Path prefix clients must keep, e.g. "/stripe". */
  readonly prefix?: string;
}

interface IdempotentResult {
  readonly fingerprint: string;
  readonly requestId: string;
  readonly status: number;
  readonly body: JsonValue;
}

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

const STRIPE_VERSION = /^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/;

export class StripeFake {
  readonly http: FakeHttpServer;
  private readonly state: StripeState;
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
    this.state = new StripeState(options.fixture);

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
    return [...this.state.refunds.values()]
      .filter((refund) => filter.charge === undefined || refund.charge === filter.charge)
      .sort(newestFirst)
      .map((refund) => refundJson(refund));
  }

  /** A charge as the API would return it, or undefined. */
  charge(id: string): JsonObject | undefined {
    const charge = this.state.charges.get(id);
    return charge === undefined ? undefined : chargeJson(this.state, charge);
  }

  subscription(id: string): JsonObject | undefined {
    const subscription = this.state.subscriptions.get(id);
    return subscription === undefined ? undefined : subscriptionJson(subscription);
  }

  /** Available balance in minor units for a currency. */
  availableBalance(currency = "usd"): number {
    return this.state.balance.available.get(currency) ?? 0;
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
    /** 401 for matching requests: the key was rolled or revoked after the boot check. */
    revokedKey: (
      path: string | RegExp,
      options: { readonly method?: string; readonly times?: number } = {},
    ): FaultHandle =>
      this.http.injectFault({
        name: "stripe-401-key-revoked",
        path,
        ...(options.method === undefined ? {} : { method: options.method }),
        ...(options.times === undefined ? {} : { times: options.times }),
        respond: () =>
          this.reply(
            401,
            new StripeError(
              401,
              "invalid_request_error",
              "Expired API Key provided: sk_test_***0000. Roll the key in your Dashboard.",
            ).envelope(),
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
            [...this.state.customers.values()],
            (customer) => (email === undefined ? true : customer.email === email),
            (customer) => customerJson(customer),
          );
        },
      },
      {
        method: "GET",
        pattern: "/v1/customers/search",
        allowed: ["query", "limit", "page"],
        handler: ({ params }) => {
          const text = stringParam(params, "query");
          if (text === undefined) {
            throw invalid("Missing required param: query.", {
              code: "parameter_missing",
              param: "query",
              saved: false,
            });
          }
          const query = parseSearchQuery(text);
          const limit = intParam(params, "limit", { min: 1, max: 100 }) ?? 10;
          const page = stringParam(params, "page");
          const offset = page === undefined ? 0 : Number(/^page_(\d+)$/.exec(page)?.[1] ?? NaN);
          if (!Number.isInteger(offset)) {
            throw invalid(`Invalid page: ${page}`, { param: "page", saved: false });
          }
          const found = [...this.state.customers.values()]
            .filter((customer) =>
              matchesSearch(query, (field) => {
                if (field === "name") return customer.name;
                if (field === "email") return customer.email;
                if (field === "phone") return null;
                const key = /^metadata\["(.+)"\]$/.exec(field)?.[1];
                return key === undefined ? null : (customer.metadata[key] ?? null);
              }),
            )
            .sort(newestFirst);
          const window = found.slice(offset, offset + limit);
          const hasMore = found.length > offset + limit;
          return {
            object: "search_result",
            data: window.map((customer) => customerJson(customer)),
            has_more: hasMore,
            next_page: hasMore ? `page_${offset + limit}` : null,
            url: "/v1/customers/search",
          };
        },
      },
      {
        method: "GET",
        pattern: "/v1/customers/:id",
        allowed: [],
        handler: ({ request, params }) =>
          this.expand(
            customerJson(this.find(this.state.customers, "customer", request.params.id)),
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
            [...this.state.charges.values()],
            (charge) =>
              (customer === undefined || charge.customer === customer) &&
              (paymentIntent === undefined || charge.paymentIntent === paymentIntent),
            (charge) => chargeJson(this.state, charge),
          );
        },
      },
      {
        method: "GET",
        pattern: "/v1/charges/:id",
        allowed: [],
        handler: ({ request, params }) =>
          this.expand(
            chargeJson(this.state, this.find(this.state.charges, "charge", request.params.id)),
            params,
          ),
      },
      {
        method: "GET",
        pattern: "/v1/payment_intents",
        allowed: [...LIST_PARAMS, "customer"],
        handler: ({ params }) => {
          const customer = stringParam(params, "customer");
          const intents = [...this.state.charges.values()].map((charge) => ({
            id: charge.paymentIntent,
            created: charge.created,
            charge,
          }));
          return this.list(
            "/v1/payment_intents",
            params,
            intents,
            (intent) => customer === undefined || intent.charge.customer === customer,
            (intent) => paymentIntentJson(intent.charge),
          );
        },
      },
      {
        method: "GET",
        pattern: "/v1/payment_intents/:id",
        allowed: [],
        handler: ({ request, params }) => {
          const id = request.params.id ?? "";
          const charge = this.state.chargeOfIntent(id);
          if (charge === undefined) throw missing("payment_intent", id, "intent");
          return this.expand(paymentIntentJson(charge), params);
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
            [...this.state.invoices.values()],
            (invoice) =>
              (customer === undefined || invoice.customer === customer) &&
              (status === undefined || invoice.status === status) &&
              (subscription === undefined || invoice.subscription === subscription),
            (invoice) => invoiceJson(this.state, invoice),
          );
        },
      },
      {
        method: "GET",
        pattern: "/v1/invoices/:id",
        allowed: [],
        handler: ({ request, params }) =>
          this.expand(
            invoiceJson(this.state, this.find(this.state.invoices, "invoice", request.params.id)),
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
            [...this.state.subscriptions.values()],
            (subscription) =>
              (customer === undefined || subscription.customer === customer) &&
              (price === undefined || subscription.price.id === price) &&
              subscriptionStatusMatches(subscription.status, status),
            (subscription) => subscriptionJson(subscription),
          );
        },
      },
      {
        method: "GET",
        pattern: "/v1/subscriptions/:id",
        allowed: [],
        handler: ({ request, params }) =>
          this.expand(
            subscriptionJson(
              this.find(this.state.subscriptions, "subscription", request.params.id),
            ),
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
            [...this.state.refunds.values()],
            (refund) =>
              (charge === undefined || refund.charge === charge) &&
              (paymentIntent === undefined || refund.paymentIntent === paymentIntent),
            (refund) => refundJson(refund),
          );
        },
      },
      {
        method: "GET",
        pattern: "/v1/refunds/:id",
        allowed: [],
        handler: ({ request, params }) =>
          this.expand(
            refundJson(this.find(this.state.refunds, "refund", request.params.id)),
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
        handler: () => balanceJson(this.state),
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
      charge = this.state.charges.get(chargeId);
      if (charge === undefined) throw missing("charge", chargeId, "charge", 400);
      if (intentId !== undefined && charge.paymentIntent !== intentId) {
        throw invalid(`Charge ${chargeId} does not belong to PaymentIntent ${intentId}.`, {
          param: "payment_intent",
        });
      }
    } else if (intentId !== undefined) {
      charge = this.state.chargeOfIntent(intentId);
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
    this.state.refunds.set(refund.id, refund);
    charge.amountRefunded += refundAmount;
    this.state.balance.available.set(
      charge.currency,
      (this.state.balance.available.get(charge.currency) ?? 0) - refundAmount,
    );
    return refundJson(refund);
  }

  private cancelSubscription(id: string, params: FormObject): JsonValue {
    const subscription = this.find(this.state.subscriptions, "subscription", id);
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
    return subscriptionJson(subscription);
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
      const customer = this.state.customers.get(id);
      return customer && customerJson(customer);
    }
    if (id.startsWith("ch_")) {
      const charge = this.state.charges.get(id);
      return charge && chargeJson(this.state, charge);
    }
    if (id.startsWith("pi_")) {
      const charge = this.state.chargeOfIntent(id);
      return charge && paymentIntentJson(charge);
    }
    if (id.startsWith("in_")) {
      const invoice = this.state.invoices.get(id);
      return invoice && invoiceJson(this.state, invoice);
    }
    if (id.startsWith("sub_")) {
      const subscription = this.state.subscriptions.get(id);
      return subscription && subscriptionJson(subscription);
    }
    return undefined;
  }

  private find<T>(map: ReadonlyMap<string, T>, kind: string, id: string | undefined): T {
    const value = id === undefined ? undefined : map.get(id);
    if (value === undefined) throw missing(kind, id ?? "", "id");
    return value;
  }

  // --- Renderers ----------------------------------------------------------------
}
