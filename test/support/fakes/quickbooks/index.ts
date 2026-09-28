/**
 * A stateful, contract-faithful local fake of the QuickBooks Online
 * Accounting API v3 (the subset of the quickbooks-api profile), loaded from
 * test/fixtures/business/quickbooks.json. Test-only.
 *
 * Contract points it enforces, as QuickBooks does:
 * - `/v3/company/{realmId}/…` with a Bearer access token: a missing or wrong
 *   token is 401 AuthenticationFailed (3200); a realm the token does not
 *   belong to is 403 ApplicationAuthorizationFailed (3100).
 * - JSON only when the client sends `Accept: application/json`; otherwise
 *   QuickBooks answers XML, and so does the fake.
 * - The `Fault` envelope (`{Fault:{Error:[{Message, Detail, code, element}],
 *   type}, time}`) with HTTP 400 for validation, 610 Object Not Found, 5010
 *   Stale Object Error (SyncToken), 6240 Duplicate Name, 2020 Required param
 *   missing, 2500 Invalid Reference Id, 4000/4001 query errors.
 * - `requestid` on writes: a repeated requestid replays the first response.
 * - The query language (query.ts), with every page truncated to at most
 *   `queryPageCap` rows as QuickBooks truncates large responses: clients must
 *   page with STARTPOSITION until the QueryResponse is empty.
 * - `time` on every response and `intuit_tid` on every reply.
 * Amounts are decimal currency units, as in QuickBooks (not minor units).
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
import { requestIdFactory } from "../core/ids.js";
import type { QuickBooksFixture } from "../fixtures.js";
import { type Entity, QuickBooksCompany, type SentInvoice } from "./company.js";
import { notFound, QboFault } from "./fault.js";
import { QueryError } from "./query.js";

export interface QuickBooksFakeOptions {
  readonly fixture: QuickBooksFixture;
  readonly clock: FakeClock;
  /** The only access token the fake accepts. */
  readonly accessToken: string;
  readonly prefix?: string;
  /** Overrides the fixture's page cap (rows per query response). */
  readonly queryPageCap?: number;
}

export class QuickBooksFake {
  readonly http: FakeHttpServer;
  readonly company: QuickBooksCompany;
  private readonly accessToken: string;
  private readonly replays = new Map<string, FakeResponse>();
  private readonly tid = requestIdFactory("1-66f8c0de-rdfake");

  private constructor(options: QuickBooksFakeOptions) {
    this.accessToken = options.accessToken;
    this.company = new QuickBooksCompany(options.fixture, options.clock, options.queryPageCap);
    const router = new Router();
    const base = "/v3/company/:realm";
    const route = (method: string, path: string, handler: (request: FakeRequest) => FakeResponse) =>
      router.add(method, `${base}${path}`, (request) => this.dispatch(request, handler));
    route("GET", "/companyinfo/:id", (request) => {
      if (request.params.id !== this.company.realmId) throw notFound();
      return this.ok({ CompanyInfo: this.company.companyInfo });
    });
    for (const [path, name] of [
      ["customer", "Customer"],
      ["invoice", "Invoice"],
      ["payment", "Payment"],
      ["item", "Item"],
      ["term", "Term"],
    ] as const) {
      route("GET", `/${path}/:id`, (request) =>
        this.ok({ [name]: this.company.get(name, request.params.id) }),
      );
    }
    route("GET", "/query", (request) =>
      this.ok(this.company.query(request.query.get("query") ?? "")),
    );
    route("POST", "/query", (request) => {
      if (mediaType(request) !== "application/text" && mediaType(request) !== "text/plain") {
        throw new QboFault(
          "4000",
          "Error parsing query",
          "QueryParserError: the query body must be application/text",
          { status: 400 },
        );
      }
      return this.ok(this.company.query(request.rawBody));
    });
    route("POST", "/customer", (request) =>
      this.write(request, (body) => ({ Customer: this.company.saveCustomer(body) })),
    );
    route("POST", "/invoice", (request) =>
      this.write(request, (body) => {
        const operation = request.query.get("operation");
        if (operation === "void") return { Invoice: this.company.voidInvoice(body) };
        if (operation !== null)
          throw new QboFault(
            "2010",
            "Request has invalid or unsupported property",
            `Unsupported operation: ${operation}`,
          );
        return { Invoice: this.company.saveInvoice(body) };
      }),
    );
    route("POST", "/invoice/:id/send", (request) =>
      this.write(
        request,
        () => ({
          Invoice: this.company.sendInvoice(request.params.id ?? "", request.query.get("sendTo")),
        }),
        { bodyless: true },
      ),
    );
    route("POST", "/payment", (request) =>
      this.write(request, (body) => ({ Payment: this.company.createPayment(body) })),
    );

    this.http = new FakeHttpServer({
      name: "quickbooks",
      clock: options.clock,
      router,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      notFound: () => ({
        status: 404,
        headers: { intuit_tid: this.tid(), "content-type": "text/html" },
        body: "<html><body><h1>404 Not Found</h1></body></html>",
      }),
    });
  }
  static async start(options: QuickBooksFakeOptions): Promise<QuickBooksFake> {
    const fake = new QuickBooksFake(options);
    await fake.http.start();
    return fake;
  }

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

  /** Invoices sent by email: which invoice, to whom, when. */
  get sentInvoices(): readonly SentInvoice[] {
    return this.company.sentInvoices;
  }

  customer(id: string): Entity | undefined {
    return this.company.customer(id);
  }

  customerByName(displayName: string): Entity | undefined {
    return this.company.customerByName(displayName);
  }

  invoice(id: string): Entity | undefined {
    return this.company.invoice(id);
  }

  invoiceByNumber(docNumber: string): Entity | undefined {
    return this.company.invoiceByNumber(docNumber);
  }

  invoicesFor(customerId: string): Entity[] {
    return this.company.invoicesFor(customerId);
  }

  payments(): Entity[] {
    return this.company.payments();
  }

  /** Writes that reached a route, with their requestid. */
  writes(): {
    readonly path: string;
    readonly requestId: string | null;
    readonly status: number;
    readonly replayed: boolean;
  }[] {
    return this.http.requests
      .filter(
        (entry) =>
          entry.method === "POST" && !entry.path.endsWith("/query") && entry.fault === null,
      )
      .map((entry) => ({
        path: entry.path,
        requestId: entry.query.requestid?.[0] ?? null,
        status: entry.status,
        replayed: entry.notes.replayed === true,
      }));
  }

  // --- Faults -----------------------------------------------------------------

  readonly faults = {
    /** A Fault envelope (400 ValidationFault unless status/type given) for matching requests. */
    fault: (
      path: string | RegExp,
      fault: {
        readonly code: string;
        readonly message: string;
        readonly detail: string;
        readonly status?: number;
        readonly type?: string;
      },
      options: { readonly method?: string; readonly times?: number } = {},
    ): FaultHandle =>
      this.http.injectFault({
        name: `quickbooks-fault-${fault.code}`,
        path,
        ...(options.method === undefined ? {} : { method: options.method }),
        ...(options.times === undefined ? {} : { times: options.times }),
        respond: () =>
          this.faultReply(
            new QboFault(fault.code, fault.message, fault.detail, {
              ...(fault.status === undefined ? {} : { status: fault.status }),
              ...(fault.type === undefined ? {} : { type: fault.type }),
            }),
          ),
      }),
    /** 429 ThrottleExceeded (3001). */
    throttle: (
      path: string | RegExp,
      options: { readonly method?: string; readonly times?: number } = {},
    ): FaultHandle =>
      this.faults.fault(
        path,
        {
          code: "3001",
          message: "message=ThrottleExceeded; errorCode=003001; statusCode=429",
          detail: "The request limit was reached.",
          status: 429,
          type: "SERVICE",
        },
        options,
      ),
    /** 500 SystemFault (10000). */
    serverError: (
      path: string | RegExp,
      options: { readonly method?: string; readonly times?: number } = {},
    ): FaultHandle =>
      this.faults.fault(
        path,
        {
          code: "10000",
          message: "An application error has occurred while processing your request",
          detail:
            "System Failure Error: An unexpected error occurred while accessing or saving your data.",
          status: 500,
          type: "SystemFault",
        },
        options,
      ),
    /** 401 as for an expired access token (they expire hourly). */
    expiredToken: (
      path: string | RegExp = /.*/,
      options: { readonly times?: number } = {},
    ): FaultHandle =>
      this.http.injectFault({
        name: "quickbooks-401-expired",
        path,
        ...(options.times === undefined ? {} : { times: options.times }),
        respond: () => this.authFault(401),
      }),
  };

  // --- Dispatch ---------------------------------------------------------------

  private dispatch(
    request: FakeRequest,
    handler: (request: FakeRequest) => FakeResponse,
  ): FakeResponse {
    const token = bearerToken(request);
    if (token !== this.accessToken) return this.authFault(401);
    if (request.params.realm !== this.company.realmId) return this.authFault(403);
    const minor = request.query.get("minorversion");
    if (minor !== null) request.note({ minorversion: minor });
    const json = (header(request, "accept") ?? "").toLowerCase().includes("application/json");
    let reply: FakeResponse;
    try {
      reply = handler(request);
    } catch (error) {
      if (error instanceof QueryError) {
        reply = this.faultReply(
          new QboFault(
            error.code,
            error.code === "4000" ? "Error parsing query" : "Invalid query",
            error.message,
          ),
        );
      } else if (error instanceof QboFault) {
        reply = this.faultReply(error);
      } else {
        throw error;
      }
    }
    return json ? this.withTid(reply) : this.asXml(reply);
  }

  private ok(body: JsonObject): FakeResponse {
    return { status: 200, body: { ...body, time: this.company.time() } };
  }

  private write(
    request: FakeRequest,
    action: (body: JsonObject) => JsonValue,
    options: { readonly bodyless?: boolean } = {},
  ): FakeResponse {
    const requestId = request.query.get("requestid");
    if (requestId !== null) {
      const saved = this.replays.get(requestId);
      if (saved !== undefined) {
        request.note({ replayed: true });
        return saved;
      }
    }
    let body: JsonObject = {};
    if (options.bodyless !== true) {
      if (mediaType(request) !== "application/json") {
        throw new QboFault(
          "2010",
          "Request has invalid or unsupported property",
          "Content-Type must be application/json",
          { status: 400 },
        );
      }
      try {
        const parsed: unknown = JSON.parse(request.rawBody);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("not an object");
        body = parsed as JsonObject;
      } catch {
        throw new QboFault(
          "2010",
          "Request has invalid or unsupported property",
          "Request body is not a valid JSON object",
        );
      }
    }
    let reply: FakeResponse;
    try {
      reply = { status: 200, body: { ...(action(body) as JsonObject), time: this.company.time() } };
    } catch (error) {
      if (!(error instanceof QboFault)) throw error;
      reply = this.faultReply(error);
    }
    if (requestId !== null) this.replays.set(requestId, reply);
    return reply;
  }

  private authFault(status: 401 | 403): FakeResponse {
    const code = status === 401 ? "3200" : "3100";
    const name = status === 401 ? "AuthenticationFailed" : "ApplicationAuthorizationFailed";
    return {
      status,
      headers: {
        intuit_tid: this.tid(),
        ...(status === 401
          ? { "www-authenticate": 'Bearer realm="Intuit", error="invalid_token"' }
          : {}),
      },
      body: {
        warnings: null,
        intuitObject: null,
        fault: {
          error: [
            {
              message: `message=${name}; errorCode=00${code}; statusCode=${status}`,
              detail: null,
              code,
              element: null,
            },
          ],
          type: status === 401 ? "AUTHENTICATION" : "AUTHORIZATION",
        },
        report: null,
        queryResponse: null,
        batchItemResponse: [],
        attachableResponse: [],
        syncErrorResponse: null,
        requestId: null,
        time: this.company.now().getTime(),
        status: null,
        cdcresponse: [],
      },
    };
  }

  private faultReply(fault: QboFault): FakeResponse {
    return {
      status: fault.options.status ?? 400,
      body: {
        Fault: {
          Error: [
            {
              Message: fault.message,
              Detail: fault.detail,
              code: fault.code,
              ...(fault.options.element === undefined ? {} : { element: fault.options.element }),
            },
          ],
          type: fault.options.type ?? "ValidationFault",
        },
        time: this.company.time(),
      },
    };
  }

  private withTid(reply: FakeResponse): FakeResponse {
    return {
      ...reply,
      headers: {
        "content-type": "application/json;charset=UTF-8",
        ...reply.headers,
        intuit_tid: this.tid(),
      },
    };
  }

  /** What a client that did not ask for JSON gets: XML, which a JSON parser cannot read. */
  private asXml(reply: FakeResponse): FakeResponse {
    const body =
      typeof reply.body === "object" && reply.body !== null && !Array.isArray(reply.body)
        ? reply.body
        : {};
    const fault = (body as JsonObject).Fault as JsonObject | undefined;
    const errors = (fault?.Error as JsonObject[] | undefined) ?? [];
    const inner = fault
      ? `<Fault type="${xml(String(fault.type))}">${errors.map((error) => `<Error code="${xml(String(error.code))}"><Message>${xml(String(error.Message))}</Message><Detail>${xml(String(error.Detail))}</Detail></Error>`).join("")}</Fault>`
      : "<!-- The local QuickBooks fake renders entities as JSON only: send Accept: application/json -->";
    return {
      status: reply.status,
      headers: { "content-type": "application/xml", intuit_tid: this.tid() },
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><IntuitResponse xmlns="http://schema.intuit.com/finance/v3" time="${this.company.time()}">${inner}</IntuitResponse>`,
    };
  }
}

function xml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
