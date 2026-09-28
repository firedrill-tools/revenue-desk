// A typed fetch client for the Stripe REST API (https://api.stripe.com/v1).
//
// - Bearer secret key; live keys (sk_live_/rk_live_) are refused unless the
//   connection was resolved with ALLOW_LIVE_STRIPE=1.
// - Form bodies and query strings use Stripe's bracket syntax (form.ts); GET
//   and DELETE carry their parameters in the query string, as Stripe's own
//   clients send them.
// - Every write carries `Idempotency-Key`: the gateway's key for the tool
//   call, so a replayed call never creates a second refund.
// - Reads retry on 429 and pre-send network errors only; writes never retry.
// - Errors become ApiToolError {provider:"stripe", status, code, message}.

import type { SecretValue } from "../../contracts/env.js";
import type { JsonObject, JsonValue } from "../../contracts/json.js";
import { ApiToolError, transportFailure } from "../shared/errors.js";
import { type HttpDeps, type HttpMethod, sendHttp, TransportError } from "../shared/http.js";
import { asObject, obj, str } from "../shared/json.js";
import { scrub } from "../shared/text.js";
import { joinUrl } from "../shared/url.js";
import { encodeForm, type FormParams } from "./form.js";

export const STRIPE_PROVIDER = "stripe";

const LIVE_KEY = /^(sk|rk)_live_/;

export function isLiveStripeKey(key: string): boolean {
  return LIVE_KEY.test(key);
}

export type StripeClientOptions = {
  readonly baseUrl: string;
  readonly secretKey: SecretValue;
  /** Stripe-Version header; null uses the account default. */
  readonly apiVersion: string | null;
  /** True only when the connection resolved a live key with ALLOW_LIVE_STRIPE=1. */
  readonly allowLive: boolean;
  readonly http?: HttpDeps;
};

export type StripeWriteOptions = {
  readonly idempotencyKey: string;
  readonly signal: AbortSignal | undefined;
};

/** A Stripe error envelope ({error:{type, code, decline_code, message, param}}) as an ApiToolError. */
export function stripeError(
  status: number,
  body: JsonValue | undefined,
  secrets: readonly string[] = [],
): ApiToolError {
  const error = obj(asObject(body), "error");
  const type = str(error, "type");
  const code = str(error, "code") ?? type ?? `http_${status}`;
  let message = str(error, "message") ?? `Stripe returned HTTP ${status}.`;
  const declineCode = str(error, "decline_code");
  if (declineCode !== undefined) message += ` (decline code: ${declineCode})`;
  const param = str(error, "param");
  if (param !== undefined) message += ` (parameter: ${param})`;
  return new ApiToolError(STRIPE_PROVIDER, scrub(message, secrets), { status, code });
}

export class StripeClient {
  readonly #baseUrl: string;
  readonly #secretKey: SecretValue;
  readonly #apiVersion: string | null;
  readonly #http: HttpDeps;

  constructor(options: StripeClientOptions) {
    if (isLiveStripeKey(options.secretKey.reveal()) && !options.allowLive) {
      throw new ApiToolError(
        STRIPE_PROVIDER,
        "Refusing a live Stripe key; set ALLOW_LIVE_STRIPE=1 to use one.",
        { code: "live_key_refused" },
      );
    }
    this.#baseUrl = options.baseUrl;
    this.#secretKey = options.secretKey;
    this.#apiVersion = options.apiVersion;
    this.#http = options.http ?? {};
  }

  /** A read. Retried on 429 and pre-send network errors. */
  get(path: string, params: FormParams, signal: AbortSignal | undefined): Promise<JsonObject> {
    return this.#request("GET", path, params, null, signal);
  }

  /** A write with a form body. Never retried. */
  post(path: string, params: FormParams, options: StripeWriteOptions): Promise<JsonObject> {
    return this.#request("POST", path, params, options.idempotencyKey, options.signal);
  }

  /** A DELETE write (e.g. cancelling a subscription). Never retried. */
  delete(path: string, params: FormParams, options: StripeWriteOptions): Promise<JsonObject> {
    return this.#request("DELETE", path, params, options.idempotencyKey, options.signal);
  }

  async #request(
    method: HttpMethod,
    path: string,
    params: FormParams,
    idempotencyKey: string | null,
    signal: AbortSignal | undefined,
  ): Promise<JsonObject> {
    const write = method !== "GET";
    if (write && (idempotencyKey === null || idempotencyKey.trim() === "")) {
      throw new ApiToolError(STRIPE_PROVIDER, "Refusing a write without an idempotency key.", {
        code: "idempotency_key_missing",
      });
    }
    const encoded = encodeForm(params);
    const inQuery = method !== "POST";
    const base = joinUrl(this.#baseUrl, path);
    const url = inQuery && encoded !== "" ? `${base}?${encoded}` : base;
    const secret = this.#secretKey.reveal();
    const headers: Record<string, string> = {
      authorization: `Bearer ${secret}`,
      accept: "application/json",
    };
    if (this.#apiVersion !== null) headers["stripe-version"] = this.#apiVersion;
    if (write && idempotencyKey !== null) headers["idempotency-key"] = idempotencyKey;
    if (!inQuery) headers["content-type"] = "application/x-www-form-urlencoded";

    let response: Awaited<ReturnType<typeof sendHttp>>;
    try {
      response = await sendHttp(
        {
          method,
          url,
          headers,
          ...(inQuery ? {} : { body: encoded }),
          retryable: !write,
          signal,
          idempotencyKey: write ? idempotencyKey : null,
        },
        this.#http,
      );
    } catch (error) {
      if (error instanceof TransportError) throw transportFailure(STRIPE_PROVIDER, error);
      throw error;
    }
    if (response.status < 200 || response.status >= 300) {
      throw stripeError(response.status, response.json, [secret]);
    }
    const body = asObject(response.json);
    if (body === undefined) {
      throw new ApiToolError(
        STRIPE_PROVIDER,
        "Stripe returned a response that is not a JSON object.",
        {
          status: response.status,
          code: "invalid_response",
        },
      );
    }
    return body;
  }
}
