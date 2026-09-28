// A typed fetch client for the QuickBooks Online Accounting API v3
// (https://sandbox-quickbooks.api.intuit.com/v3/company/{realmId}/…).
//
// - Bearer access token; `minorversion` on every request when configured.
// - Writes carry `requestid` (the gateway's idempotency key for the tool
//   call), so QuickBooks returns the original result for a replay.
// - Queries page with STARTPOSITION/MAXRESULTS until a page comes back with
//   an empty QueryResponse. A page may hold fewer rows than asked for, so the
//   next page starts after the rows actually received.
// - Errors (the Fault envelope, in either letter case) become ApiToolError.

import type { SecretValue } from "../../contracts/env.js";
import type { JsonObject, JsonValue } from "../../contracts/json.js";
import { ApiToolError, transportFailure } from "../shared/errors.js";
import { type HttpDeps, type HttpMethod, sendHttp, TransportError } from "../shared/http.js";
import { asObject, obj, objects, str } from "../shared/json.js";
import { scrub } from "../shared/text.js";
import { joinUrl, type QueryValue } from "../shared/url.js";
import { MAX_PAGE_SIZE, type SelectQuery, selectStatement } from "./query.js";

export const QUICKBOOKS_PROVIDER = "quickbooks";

export type QuickBooksClientOptions = {
  readonly baseUrl: string;
  readonly accessToken: SecretValue;
  readonly realmId: string;
  readonly minorVersion: string | null;
  readonly http?: HttpDeps;
};

export type QuickBooksWriteOptions = {
  readonly idempotencyKey: string;
  readonly signal: AbortSignal | undefined;
  readonly query?: Readonly<Record<string, QueryValue>>;
};

export type QueryAllOptions = {
  /** Rows per request (at most 1000). */
  readonly pageSize: number;
  /** Stop after this many rows. */
  readonly maxRows: number;
  /** Stop after this many requests. */
  readonly maxPages?: number;
  readonly signal: AbortSignal | undefined;
};

export type QueryAllResult = {
  readonly rows: readonly JsonObject[];
  /** True when an empty page confirmed there are no more rows. */
  readonly complete: boolean;
  readonly pages: number;
};

function faultOf(body: JsonValue | undefined): JsonObject | undefined {
  const root = asObject(body);
  return obj(root, "Fault") ?? obj(root, "fault");
}

/** A QuickBooks Fault ({Fault:{Error:[{Message, Detail, code, element}], type}}) as an ApiToolError. */
export function quickBooksError(
  status: number,
  body: JsonValue | undefined,
  secrets: readonly string[] = [],
): ApiToolError {
  const fault = faultOf(body);
  const first = [...objects(fault, "Error"), ...objects(fault, "error")][0];
  const summary = str(first, "Message") ?? str(first, "message");
  const detail = str(first, "Detail") ?? str(first, "detail");
  const element = str(first, "element");
  const code = str(first, "code") ?? str(fault, "type") ?? `http_${status}`;
  let message =
    [summary, detail].filter((part) => part !== undefined).join(": ") ||
    `QuickBooks returned HTTP ${status}.`;
  if (element !== undefined) message += ` (field: ${element})`;
  return new ApiToolError(QUICKBOOKS_PROVIDER, scrub(message, secrets), { status, code });
}

export class QuickBooksClient {
  readonly #baseUrl: string;
  readonly #accessToken: SecretValue;
  readonly #realmId: string;
  readonly #minorVersion: string | null;
  readonly #http: HttpDeps;

  constructor(options: QuickBooksClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#accessToken = options.accessToken;
    this.#realmId = options.realmId;
    this.#minorVersion = options.minorVersion;
    this.#http = options.http ?? {};
  }

  get realmId(): string {
    return this.#realmId;
  }

  /** A read of `/v3/company/{realmId}/<path>`. Retried on 429 and pre-send network errors. */
  get(path: string, signal: AbortSignal | undefined): Promise<JsonObject> {
    return this.#request("GET", path, {}, null, undefined, signal);
  }

  /** One page of a query; the whole response, including QueryResponse and time. */
  query(statement: string, signal: AbortSignal | undefined): Promise<JsonObject> {
    return this.#request("GET", "query", { query: statement }, null, undefined, signal);
  }

  /** Every row of a query, page by page, until an empty page or a limit. */
  async queryAll(query: SelectQuery, options: QueryAllOptions): Promise<QueryAllResult> {
    const pageSize = Math.min(Math.max(1, Math.floor(options.pageSize)), MAX_PAGE_SIZE);
    const maxPages = options.maxPages ?? 20;
    const rows: JsonObject[] = [];
    let startPosition = 1;
    for (let pages = 0; pages < maxPages; pages += 1) {
      const remaining = options.maxRows - rows.length;
      if (remaining <= 0) return { rows, complete: false, pages };
      const statement = selectStatement(query, {
        startPosition,
        maxResults: Math.min(pageSize, remaining),
      });
      const body = await this.query(statement, options.signal);
      const response = obj(body, "QueryResponse");
      if (response === undefined) {
        throw new ApiToolError(QUICKBOOKS_PROVIDER, "QuickBooks returned no QueryResponse.", {
          code: "invalid_response",
        });
      }
      const page = objects(response, query.entity);
      if (page.length === 0) return { rows, complete: true, pages: pages + 1 };
      // Never trust a page to respect MAXRESULTS: keep at most what is left.
      rows.push(...page.slice(0, remaining));
      startPosition += page.length;
    }
    return { rows, complete: false, pages: maxPages };
  }

  /** A write with a JSON body. Carries requestid; never retried. */
  post(path: string, body: JsonObject, options: QuickBooksWriteOptions): Promise<JsonObject> {
    return this.#request(
      "POST",
      path,
      options.query ?? {},
      options.idempotencyKey,
      JSON.stringify(body),
      options.signal,
    );
  }

  /** A write without a body (e.g. sending an invoice). Carries requestid; never retried. */
  postEmpty(path: string, options: QuickBooksWriteOptions): Promise<JsonObject> {
    return this.#request(
      "POST",
      path,
      options.query ?? {},
      options.idempotencyKey,
      "",
      options.signal,
    );
  }

  async #request(
    method: HttpMethod,
    path: string,
    query: Readonly<Record<string, QueryValue>>,
    idempotencyKey: string | null,
    body: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<JsonObject> {
    const write = method !== "GET";
    if (write && (idempotencyKey === null || idempotencyKey.trim() === "")) {
      throw new ApiToolError(QUICKBOOKS_PROVIDER, "Refusing a write without an idempotency key.", {
        code: "idempotency_key_missing",
      });
    }
    const url = joinUrl(this.#baseUrl, `v3/company/${encodeURIComponent(this.#realmId)}/${path}`, {
      ...query,
      minorversion: this.#minorVersion,
      requestid: write ? idempotencyKey : null,
    });
    const token = this.#accessToken.reveal();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    };
    if (body !== undefined) {
      headers["content-type"] = body === "" ? "application/octet-stream" : "application/json";
    }

    let response: Awaited<ReturnType<typeof sendHttp>>;
    try {
      response = await sendHttp(
        {
          method,
          url,
          headers,
          ...(body === undefined ? {} : { body }),
          retryable: !write,
          signal,
        },
        this.#http,
      );
    } catch (error) {
      if (error instanceof TransportError) throw transportFailure(QUICKBOOKS_PROVIDER, error);
      throw error;
    }
    if (response.status < 200 || response.status >= 300 || faultOf(response.json) !== undefined) {
      throw quickBooksError(response.status, response.json, [token]);
    }
    const parsed = asObject(response.json);
    if (parsed === undefined) {
      throw new ApiToolError(
        QUICKBOOKS_PROVIDER,
        "QuickBooks returned a response that is not a JSON object.",
        { status: response.status, code: "invalid_response" },
      );
    }
    return parsed;
  }
}
