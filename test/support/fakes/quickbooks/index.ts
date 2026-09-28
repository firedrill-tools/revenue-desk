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
import { dateInZone, type FakeClock, isoInZone } from "../core/clock.js";
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
import { fieldValue, matches, parseQuery, QueryError, sortEntities } from "./query.js";

export interface QuickBooksFakeOptions {
  readonly fixture: QuickBooksFixture;
  readonly clock: FakeClock;
  /** The only access token the fake accepts. */
  readonly accessToken: string;
  readonly prefix?: string;
  /** Overrides the fixture's page cap (rows per query response). */
  readonly queryPageCap?: number;
}

type Entity = Record<string, JsonValue>;
type EntityName = "Customer" | "Invoice" | "Payment" | "Item" | "Term" | "CompanyInfo";

const QUERYABLE: Readonly<Record<EntityName, readonly string[]>> = {
  Customer: [
    "Id",
    "DisplayName",
    "CompanyName",
    "GivenName",
    "FamilyName",
    "PrimaryEmailAddr",
    "Balance",
    "Active",
    "MetaData.CreateTime",
    "MetaData.LastUpdatedTime",
  ],
  Invoice: [
    "Id",
    "DocNumber",
    "TxnDate",
    "DueDate",
    "CustomerRef",
    "Balance",
    "TotalAmt",
    "EmailStatus",
    "MetaData.CreateTime",
    "MetaData.LastUpdatedTime",
  ],
  Payment: [
    "Id",
    "TxnDate",
    "CustomerRef",
    "TotalAmt",
    "PaymentRefNum",
    "MetaData.CreateTime",
    "MetaData.LastUpdatedTime",
  ],
  Item: ["Id", "Name", "Type", "Active"],
  Term: ["Id", "Name", "Active"],
  CompanyInfo: [],
};

const CUSTOMER_FIELDS = new Set([
  "Id",
  "SyncToken",
  "sparse",
  "DisplayName",
  "CompanyName",
  "GivenName",
  "MiddleName",
  "FamilyName",
  "Title",
  "Suffix",
  "PrimaryEmailAddr",
  "PrimaryPhone",
  "Mobile",
  "WebAddr",
  "BillAddr",
  "ShipAddr",
  "Notes",
  "SalesTermRef",
  "PreferredDeliveryMethod",
  "Active",
  "CurrencyRef",
]);
const INVOICE_FIELDS = new Set([
  "Id",
  "SyncToken",
  "sparse",
  "CustomerRef",
  "Line",
  "TxnDate",
  "DueDate",
  "DocNumber",
  "BillEmail",
  "SalesTermRef",
  "CustomerMemo",
  "PrivateNote",
  "EmailStatus",
  "AllowOnlineCreditCardPayment",
  "AllowOnlineACHPayment",
  "CurrencyRef",
  "BillAddr",
]);
const PAYMENT_FIELDS = new Set([
  "CustomerRef",
  "TotalAmt",
  "Line",
  "TxnDate",
  "PaymentRefNum",
  "PrivateNote",
  "PaymentMethodRef",
  "DepositToAccountRef",
  "CurrencyRef",
]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A QuickBooks error the fake answers with (HTTP 400 unless given). */
class QboFault extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: string,
    readonly options: {
      readonly status?: number;
      readonly type?: string;
      readonly element?: string;
    } = {},
  ) {
    super(message);
  }
}

const notFound = () =>
  new QboFault(
    "610",
    "Object Not Found",
    "Object Not Found : Something you're trying to use has been made inactive. Check the fields with accounts, customers, items, vendors or employees.",
  );
const requiredMissing = (param: string) =>
  new QboFault(
    "2020",
    "Required param missing, need to supply the required value for the API",
    `Required parameter ${param} is missing in the request`,
    { element: param },
  );
const invalidReference = (what: string, id: string) =>
  new QboFault(
    "2500",
    "Invalid Reference Id",
    `Invalid Reference Id : ${what} ${id} does not exist`,
    {
      element: what,
    },
  );
const unsupportedProperty = (name: string) =>
  new QboFault(
    "2010",
    "Request has invalid or unsupported property",
    `Property Name:Unrecognized field "${name}" specified value is not supported`,
    { element: name },
  );
const businessRule = (detail: string) =>
  new QboFault(
    "6000",
    "A business validation error has occurred while processing your request",
    `Business Validation Error: ${detail}`,
  );

export class QuickBooksFake {
  readonly http: FakeHttpServer;
  /** Invoices sent by email: which invoice, to whom, when. */
  readonly sentInvoices: {
    readonly invoiceId: string;
    readonly docNumber: string;
    readonly to: string;
    readonly at: string;
  }[] = [];
  private readonly realmId: string;
  private readonly timezone: string;
  private readonly clock: FakeClock;
  private readonly accessToken: string;
  private readonly pageCap: number;
  private readonly entities: Record<Exclude<EntityName, "CompanyInfo">, Map<string, Entity>> = {
    Customer: new Map(),
    Invoice: new Map(),
    Payment: new Map(),
    Item: new Map(),
    Term: new Map(),
  };
  private readonly companyInfo: Entity;
  private readonly replays = new Map<string, FakeResponse>();
  private readonly tid = requestIdFactory("1-66f8c0de-rdfake");
  private nextDocNumber: number;
  private readonly nextId: Record<"Customer" | "Invoice" | "Payment", number>;

  private constructor(options: QuickBooksFakeOptions) {
    const fixture = options.fixture;
    this.realmId = fixture.realmId;
    this.timezone = fixture.timezone;
    this.clock = options.clock;
    this.accessToken = options.accessToken;
    this.pageCap = options.queryPageCap ?? fixture.queryPageCap;
    this.nextDocNumber = fixture.nextDocNumber;

    const meta = (created: string) => ({ CreateTime: created, LastUpdatedTime: created });
    const created = isoInZone(new Date(Date.parse("2021-02-01T14:00:00Z")), this.timezone);
    this.companyInfo = {
      ...fixture.companyInfo,
      Id: "1",
      SyncToken: "0",
      domain: "QBO",
      sparse: false,
      MetaData: meta(created),
    };
    for (const term of fixture.terms) {
      this.entities.Term.set(term.Id, {
        ...term,
        Active: true,
        Type: "STANDARD",
        SyncToken: "0",
        domain: "QBO",
        sparse: false,
        MetaData: meta(created),
      });
    }
    for (const item of fixture.items) {
      this.entities.Item.set(item.Id, {
        ...item,
        Active: true,
        Type: "Service",
        FullyQualifiedName: item.Name,
        Taxable: false,
        IncomeAccountRef: { value: "79", name: "Sales of Product Income" },
        SyncToken: "0",
        domain: "QBO",
        sparse: false,
        MetaData: meta(created),
      });
    }
    for (const customer of fixture.customers) {
      const { CreateTime, ...rest } = customer;
      this.entities.Customer.set(customer.Id, {
        ...rest,
        FullyQualifiedName: customer.DisplayName,
        PrintOnCheckName: customer.CompanyName,
        Active: true,
        Job: false,
        BillWithParent: false,
        Taxable: false,
        Balance: 0,
        BalanceWithJobs: 0,
        CurrencyRef: { value: "USD", name: "United States Dollar" },
        PreferredDeliveryMethod: "Email",
        SyncToken: "0",
        domain: "QBO",
        sparse: false,
        MetaData: meta(CreateTime),
      });
    }
    for (const invoice of fixture.invoices) {
      const { CreateTime, Line, ...rest } = invoice;
      this.entities.Invoice.set(invoice.Id, {
        ...rest,
        Line: this.invoiceLines(Line.map((line) => ({ ...line }))),
        TotalAmt: round(Line.reduce((sum, line) => sum + line.Amount, 0)),
        Balance: round(Line.reduce((sum, line) => sum + line.Amount, 0)),
        LinkedTxn: [],
        CurrencyRef: { value: "USD", name: "United States Dollar" },
        PrintStatus: "NotSet",
        ApplyTaxAfterDiscount: false,
        Deposit: 0,
        AllowOnlineCreditCardPayment: true,
        AllowOnlineACHPayment: true,
        SyncToken: "0",
        domain: "QBO",
        sparse: false,
        MetaData: meta(CreateTime),
      });
    }
    for (const payment of fixture.payments) {
      const { CreateTime, ...rest } = payment;
      const applied = payment.Line.reduce((sum, line) => sum + line.Amount, 0);
      this.entities.Payment.set(payment.Id, {
        ...rest,
        UnappliedAmt: round(payment.TotalAmt - applied),
        ProcessPayment: false,
        CurrencyRef: { value: "USD", name: "United States Dollar" },
        SyncToken: "0",
        domain: "QBO",
        sparse: false,
        MetaData: meta(CreateTime),
      });
      for (const line of payment.Line) {
        for (const linked of line.LinkedTxn)
          this.applyPayment(linked.TxnId, payment.Id, line.Amount);
      }
    }
    this.refreshCustomerBalances();
    const maxId = (map: Map<string, Entity>) => Math.max(0, ...[...map.keys()].map(Number));
    this.nextId = {
      Customer: maxId(this.entities.Customer) + 1,
      Invoice: maxId(this.entities.Invoice) + 1,
      Payment: maxId(this.entities.Payment) + 1,
    };

    const router = new Router();
    const base = "/v3/company/:realm";
    const route = (method: string, path: string, handler: (request: FakeRequest) => FakeResponse) =>
      router.add(method, `${base}${path}`, (request) => this.dispatch(request, handler));
    route("GET", "/companyinfo/:id", (request) => {
      if (request.params.id !== this.realmId) throw notFound();
      return this.ok({ CompanyInfo: this.companyInfo });
    });
    for (const [path, name] of [
      ["customer", "Customer"],
      ["invoice", "Invoice"],
      ["payment", "Payment"],
      ["item", "Item"],
      ["term", "Term"],
    ] as const) {
      route("GET", `/${path}/:id`, (request) =>
        this.ok({ [name]: this.get(name, request.params.id) }),
      );
    }
    route("GET", "/query", (request) => this.ok(this.query(request.query.get("query") ?? "")));
    route("POST", "/query", (request) => {
      if (mediaType(request) !== "application/text" && mediaType(request) !== "text/plain") {
        throw new QboFault(
          "4000",
          "Error parsing query",
          "QueryParserError: the query body must be application/text",
          { status: 400 },
        );
      }
      return this.ok(this.query(request.rawBody));
    });
    route("POST", "/customer", (request) =>
      this.write(request, (body) => ({ Customer: this.saveCustomer(body) })),
    );
    route("POST", "/invoice", (request) =>
      this.write(request, (body) => {
        const operation = request.query.get("operation");
        if (operation === "void") return { Invoice: this.voidInvoice(body) };
        if (operation !== null)
          throw new QboFault(
            "2010",
            "Request has invalid or unsupported property",
            `Unsupported operation: ${operation}`,
          );
        return { Invoice: this.saveInvoice(body) };
      }),
    );
    route("POST", "/invoice/:id/send", (request) =>
      this.write(
        request,
        () => ({ Invoice: this.sendInvoice(request.params.id ?? "", request.query.get("sendTo")) }),
        { bodyless: true },
      ),
    );
    route("POST", "/payment", (request) =>
      this.write(request, (body) => ({ Payment: this.createPayment(body) })),
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

  customer(id: string): Entity | undefined {
    return copy(this.entities.Customer.get(id));
  }

  customerByName(displayName: string): Entity | undefined {
    return copy(
      [...this.entities.Customer.values()].find(
        (entity) => String(entity.DisplayName).toLowerCase() === displayName.toLowerCase(),
      ),
    );
  }

  invoice(id: string): Entity | undefined {
    return copy(this.entities.Invoice.get(id));
  }

  invoiceByNumber(docNumber: string): Entity | undefined {
    return copy(
      [...this.entities.Invoice.values()].find((entity) => entity.DocNumber === docNumber),
    );
  }

  invoicesFor(customerId: string): Entity[] {
    return [...this.entities.Invoice.values()]
      .filter((entity) => fieldValue(entity, "CustomerRef") === customerId)
      .map((entity) => structuredClone(entity));
  }

  payments(): Entity[] {
    return [...this.entities.Payment.values()].map((entity) => structuredClone(entity));
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
    if (request.params.realm !== this.realmId) return this.authFault(403);
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
    return { status: 200, body: { ...body, time: this.time() } };
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
      reply = { status: 200, body: { ...(action(body) as JsonObject), time: this.time() } };
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
        time: this.clock.now().getTime(),
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
        time: this.time(),
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
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><IntuitResponse xmlns="http://schema.intuit.com/finance/v3" time="${this.time()}">${inner}</IntuitResponse>`,
    };
  }

  private time(): string {
    return isoInZone(this.clock.now(), this.timezone);
  }

  private today(): string {
    return dateInZone(this.clock.now(), this.timezone);
  }

  // --- Reads ------------------------------------------------------------------

  private get(name: Exclude<EntityName, "CompanyInfo">, id: string | undefined): Entity {
    const entity = id === undefined ? undefined : this.entities[name].get(id);
    if (entity === undefined) throw notFound();
    return entity;
  }

  private query(text: string): JsonObject {
    if (text.trim() === "") throw requiredMissing("query");
    const parsed = parseQuery(text);
    const entityName = (Object.keys(QUERYABLE) as EntityName[]).find(
      (name) => name.toLowerCase() === parsed.entity.toLowerCase(),
    );
    if (entityName === undefined) {
      throw new QueryError("4001", `QueryValidationError: Invalid entity ${parsed.entity}`);
    }
    const queryable = QUERYABLE[entityName].map((field) => field.toLowerCase());
    for (const condition of parsed.where) {
      if (!queryable.includes(condition.field.toLowerCase())) {
        throw new QueryError(
          "4001",
          `QueryValidationError: property '${condition.field}' is not queryable`,
        );
      }
    }
    const all: Entity[] =
      entityName === "CompanyInfo" ? [this.companyInfo] : [...this.entities[entityName].values()];
    const selected = sortEntities(
      all.filter((entity) => matches(entity, parsed.where)),
      parsed.orderBy,
    );
    if (parsed.select === "count") return { QueryResponse: { totalCount: selected.length } };
    const page = selected
      .slice(parsed.startPosition - 1, parsed.startPosition - 1 + parsed.maxResults)
      .slice(0, this.pageCap);
    if (page.length === 0) return { QueryResponse: {} };
    const fields = parsed.select;
    const rows =
      fields === "*"
        ? page
        : page.map((entity) => {
            const out: Entity = { Id: entity.Id ?? null, sparse: true };
            for (const field of fields) {
              const key = Object.keys(entity).find(
                (name) => name.toLowerCase() === field.toLowerCase(),
              );
              if (key !== undefined) out[key] = entity[key] ?? null;
            }
            return out;
          });
    return {
      QueryResponse: {
        [entityName]: rows,
        startPosition: parsed.startPosition,
        maxResults: rows.length,
      },
    };
  }

  // --- Writes -----------------------------------------------------------------

  private saveCustomer(body: JsonObject): Entity {
    for (const key of Object.keys(body))
      if (!CUSTOMER_FIELDS.has(key)) throw unsupportedProperty(key);
    if (body.Id !== undefined) return this.updateCustomer(body);
    const displayName =
      stringField(body.DisplayName) ??
      [stringField(body.GivenName), stringField(body.FamilyName)].filter(Boolean).join(" ");
    if (displayName === "") throw requiredMissing("DisplayName");
    this.assertUniqueName(displayName, null);
    const email = addressOf(body.PrimaryEmailAddr);
    if (email !== undefined && !EMAIL.test(email)) {
      throw new QboFault(
        "2050",
        "Invalid Email Address format",
        `Email Address format is invalid: ${email}`,
        { element: "PrimaryEmailAddr" },
      );
    }
    const termRef = body.SalesTermRef;
    if (termRef !== undefined) this.reference("Term", termRef);
    const id = String(this.nextId.Customer++);
    const now = this.time();
    const customer: Entity = {
      ...stripUndefined(body),
      Id: id,
      DisplayName: displayName,
      FullyQualifiedName: displayName,
      PrintOnCheckName: stringField(body.CompanyName) ?? displayName,
      Active: true,
      Job: false,
      BillWithParent: false,
      Taxable: false,
      Balance: 0,
      BalanceWithJobs: 0,
      CurrencyRef: { value: "USD", name: "United States Dollar" },
      PreferredDeliveryMethod: stringField(body.PreferredDeliveryMethod) ?? "Email",
      SyncToken: "0",
      domain: "QBO",
      sparse: false,
      MetaData: { CreateTime: now, LastUpdatedTime: now },
    };
    this.entities.Customer.set(id, customer);
    return customer;
  }

  private updateCustomer(body: JsonObject): Entity {
    const existing = this.get("Customer", String(body.Id));
    this.assertSyncToken(existing, body);
    if (body.sparse !== true) {
      throw businessRule("Full updates are not supported by the local fake; send sparse: true");
    }
    const displayName = stringField(body.DisplayName);
    if (displayName !== undefined) this.assertUniqueName(displayName, String(existing.Id));
    const { Id: _id, SyncToken: _token, sparse: _sparse, ...changes } = body;
    Object.assign(existing, stripUndefined(changes));
    if (displayName !== undefined) existing.FullyQualifiedName = displayName;
    this.touch(existing);
    return existing;
  }

  private saveInvoice(body: JsonObject): Entity {
    for (const key of Object.keys(body))
      if (!INVOICE_FIELDS.has(key)) throw unsupportedProperty(key);
    if (body.Id !== undefined) return this.updateInvoice(body);
    if (body.CustomerRef === undefined) throw requiredMissing("CustomerRef");
    const customer = this.reference("Customer", body.CustomerRef);
    if (!Array.isArray(body.Line) || body.Line.length === 0) throw requiredMissing("Line");
    const lines = body.Line.map((line, index) => this.salesLine(line, index));
    const termRef = body.SalesTermRef ?? customer.SalesTermRef ?? { value: "3" };
    const term = this.reference("Term", termRef);
    const txnDate = stringField(body.TxnDate) ?? this.today();
    const dueDate = stringField(body.DueDate) ?? addDays(txnDate, Number(term.DueDays ?? 30));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(txnDate) || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      throw new QboFault(
        "2010",
        "Request has invalid or unsupported property",
        "TxnDate and DueDate must be YYYY-MM-DD",
      );
    }
    const docNumber = stringField(body.DocNumber) ?? String(this.nextDocNumber++);
    if ([...this.entities.Invoice.values()].some((entity) => entity.DocNumber === docNumber)) {
      throw new QboFault(
        "6140",
        "Duplicate Document Number Error",
        `Duplicate Document Number Error : You must specify a different number. This number has already been used. DocNumber=${docNumber}`,
      );
    }
    const billEmail = addressOf(body.BillEmail) ?? addressOf(customer.PrimaryEmailAddr);
    const total = round(lines.reduce((sum, line) => sum + Number(line.Amount), 0));
    const id = String(this.nextId.Invoice++);
    const now = this.time();
    const invoice: Entity = {
      Id: id,
      DocNumber: docNumber,
      TxnDate: txnDate,
      DueDate: dueDate,
      CustomerRef: { value: String(customer.Id), name: String(customer.DisplayName) },
      ...(billEmail === undefined ? {} : { BillEmail: { Address: billEmail } }),
      SalesTermRef: { value: String(term.Id), name: String(term.Name) },
      ...(body.CustomerMemo === undefined ? {} : { CustomerMemo: body.CustomerMemo }),
      ...(body.PrivateNote === undefined ? {} : { PrivateNote: body.PrivateNote }),
      EmailStatus: stringField(body.EmailStatus) ?? "NotSet",
      Line: this.invoiceLines(lines),
      TotalAmt: total,
      Balance: total,
      LinkedTxn: [],
      CurrencyRef: { value: "USD", name: "United States Dollar" },
      PrintStatus: "NotSet",
      ApplyTaxAfterDiscount: false,
      Deposit: 0,
      AllowOnlineCreditCardPayment: body.AllowOnlineCreditCardPayment ?? true,
      AllowOnlineACHPayment: body.AllowOnlineACHPayment ?? true,
      SyncToken: "0",
      domain: "QBO",
      sparse: false,
      MetaData: { CreateTime: now, LastUpdatedTime: now },
    };
    this.entities.Invoice.set(id, invoice);
    this.refreshCustomerBalances();
    return invoice;
  }

  private updateInvoice(body: JsonObject): Entity {
    const existing = this.get("Invoice", String(body.Id));
    this.assertSyncToken(existing, body);
    if (body.sparse !== true) {
      throw businessRule("Full updates are not supported by the local fake; send sparse: true");
    }
    for (const key of Object.keys(body)) {
      if (
        ![
          "Id",
          "SyncToken",
          "sparse",
          "DueDate",
          "PrivateNote",
          "CustomerMemo",
          "BillEmail",
          "EmailStatus",
        ].includes(key)
      ) {
        throw businessRule(`The local fake cannot update ${key} on an invoice`);
      }
    }
    const { Id: _id, SyncToken: _token, sparse: _sparse, ...changes } = body;
    Object.assign(existing, stripUndefined(changes));
    this.touch(existing);
    return existing;
  }

  private voidInvoice(body: JsonObject): Entity {
    if (body.Id === undefined) throw requiredMissing("Id");
    const invoice = this.get("Invoice", String(body.Id));
    this.assertSyncToken(invoice, body);
    const linked = Array.isArray(invoice.LinkedTxn) ? invoice.LinkedTxn : [];
    if (linked.length > 0) {
      throw businessRule(
        "You can't void an invoice that has payments applied. Remove the payments first.",
      );
    }
    const lines = Array.isArray(invoice.Line) ? (invoice.Line as JsonObject[]) : [];
    invoice.Line = lines.map((line) => ({
      ...line,
      Amount: 0,
      ...(line.SalesItemLineDetail === undefined
        ? {}
        : {
            SalesItemLineDetail: {
              ...(line.SalesItemLineDetail as JsonObject),
              Qty: 0,
              UnitPrice: 0,
            },
          }),
    }));
    invoice.TotalAmt = 0;
    invoice.Balance = 0;
    invoice.PrivateNote = "Voided";
    this.touch(invoice);
    this.refreshCustomerBalances();
    return invoice;
  }

  private sendInvoice(id: string, sendTo: string | null): Entity {
    const invoice = this.get("Invoice", id);
    const to = sendTo ?? addressOf(invoice.BillEmail);
    if (to === undefined || to === "") {
      throw businessRule(
        "An email address is required to send this invoice. Add one to the invoice or pass sendTo.",
      );
    }
    if (!EMAIL.test(to)) {
      throw new QboFault(
        "2050",
        "Invalid Email Address format",
        `Email Address format is invalid: ${to}`,
        { element: "sendTo" },
      );
    }
    const at = this.time();
    invoice.EmailStatus = "EmailSent";
    invoice.DeliveryInfo = { DeliveryType: "Email", DeliveryTime: at };
    if (sendTo !== null) invoice.BillEmail = { Address: sendTo };
    this.touch(invoice);
    this.sentInvoices.push({ invoiceId: id, docNumber: String(invoice.DocNumber), to, at });
    return invoice;
  }

  private createPayment(body: JsonObject): Entity {
    for (const key of Object.keys(body))
      if (!PAYMENT_FIELDS.has(key)) throw unsupportedProperty(key);
    if (body.CustomerRef === undefined) throw requiredMissing("CustomerRef");
    if (body.TotalAmt === undefined) throw requiredMissing("TotalAmt");
    const customer = this.reference("Customer", body.CustomerRef);
    const total = Number(body.TotalAmt);
    if (!Number.isFinite(total) || total < 0) {
      throw new QboFault(
        "2010",
        "Request has invalid or unsupported property",
        "TotalAmt must be a non-negative number",
        { element: "TotalAmt" },
      );
    }
    const lines = Array.isArray(body.Line) ? (body.Line as JsonValue[]) : [];
    const applications: { invoice: Entity; amount: number }[] = [];
    for (const [index, raw] of lines.entries()) {
      const line = asObject(raw, `Line[${index}]`);
      const amount = Number(line.Amount);
      if (!Number.isFinite(amount) || amount <= 0) throw requiredMissing(`Line[${index}].Amount`);
      const linked = Array.isArray(line.LinkedTxn) ? (line.LinkedTxn as JsonValue[]) : [];
      const target = linked
        .map((entry) => asObject(entry, `Line[${index}].LinkedTxn`))
        .find((entry) => entry.TxnType === "Invoice");
      if (target === undefined) throw requiredMissing(`Line[${index}].LinkedTxn`);
      const invoice = this.entities.Invoice.get(String(target.TxnId));
      if (invoice === undefined) throw invalidReference("Invoice", String(target.TxnId));
      if (fieldValue(invoice, "CustomerRef") !== customer.Id) {
        throw businessRule(
          `Invoice ${String(invoice.DocNumber)} does not belong to ${String(customer.DisplayName)}.`,
        );
      }
      if (amount > Number(invoice.Balance) + 0.001) {
        throw businessRule(
          `The payment applied to invoice ${String(invoice.DocNumber)} (${amount.toFixed(2)}) exceeds its open balance (${Number(invoice.Balance).toFixed(2)}).`,
        );
      }
      applications.push({ invoice, amount });
    }
    const applied = round(applications.reduce((sum, entry) => sum + entry.amount, 0));
    if (applied > total + 0.001) {
      throw businessRule("The amounts applied to invoices exceed the payment's TotalAmt.");
    }
    const id = String(this.nextId.Payment++);
    const now = this.time();
    const payment: Entity = {
      Id: id,
      TxnDate: stringField(body.TxnDate) ?? this.today(),
      CustomerRef: { value: String(customer.Id), name: String(customer.DisplayName) },
      TotalAmt: round(total),
      UnappliedAmt: round(total - applied),
      ...(body.PaymentRefNum === undefined ? {} : { PaymentRefNum: body.PaymentRefNum }),
      ...(body.PrivateNote === undefined ? {} : { PrivateNote: body.PrivateNote }),
      ...(body.PaymentMethodRef === undefined ? {} : { PaymentMethodRef: body.PaymentMethodRef }),
      ...(body.DepositToAccountRef === undefined
        ? {}
        : { DepositToAccountRef: body.DepositToAccountRef }),
      Line: applications.map(({ invoice, amount }) => ({
        Amount: amount,
        LinkedTxn: [{ TxnId: String(invoice.Id), TxnType: "Invoice" }],
      })),
      ProcessPayment: false,
      CurrencyRef: { value: "USD", name: "United States Dollar" },
      SyncToken: "0",
      domain: "QBO",
      sparse: false,
      MetaData: { CreateTime: now, LastUpdatedTime: now },
    };
    this.entities.Payment.set(id, payment);
    for (const { invoice, amount } of applications) {
      this.applyPayment(String(invoice.Id), id, amount);
      this.touch(invoice);
    }
    this.refreshCustomerBalances();
    return payment;
  }

  // --- Helpers ----------------------------------------------------------------

  private salesLine(raw: JsonValue, index: number): JsonObject {
    const line = asObject(raw, `Line[${index}]`);
    const detailType = line.DetailType ?? "SalesItemLineDetail";
    if (detailType !== "SalesItemLineDetail") {
      throw businessRule(
        `Line[${index}].DetailType ${String(detailType)} is not supported by the local fake`,
      );
    }
    if (line.Amount === undefined) throw requiredMissing(`Line[${index}].Amount`);
    const amount = Number(line.Amount);
    const detail =
      line.SalesItemLineDetail === undefined
        ? {}
        : asObject(line.SalesItemLineDetail, `Line[${index}].SalesItemLineDetail`);
    if (detail.ItemRef === undefined)
      throw requiredMissing(`Line[${index}].SalesItemLineDetail.ItemRef`);
    const item = this.reference("Item", detail.ItemRef);
    const qty = detail.Qty === undefined ? undefined : Number(detail.Qty);
    const unitPrice = detail.UnitPrice === undefined ? undefined : Number(detail.UnitPrice);
    if (
      !Number.isFinite(amount) ||
      (qty !== undefined && !Number.isFinite(qty)) ||
      (unitPrice !== undefined && !Number.isFinite(unitPrice))
    ) {
      throw new QboFault(
        "2010",
        "Request has invalid or unsupported property",
        `Line[${index}] has a non-numeric amount`,
      );
    }
    if (
      qty !== undefined &&
      unitPrice !== undefined &&
      Math.abs(round(qty * unitPrice) - round(amount)) > 0.001
    ) {
      throw new QboFault(
        "6070",
        "Amount is not equal to UnitPrice * Qty",
        `Amount is not equal to UnitPrice * Qty. Supplied value:${amount}`,
        { element: `Line[${index}].Amount` },
      );
    }
    return {
      Description: stringField(line.Description) ?? String(item.Description ?? item.Name),
      Amount: round(amount),
      ItemRef: { value: String(item.Id), name: String(item.Name) },
      Qty: qty ?? 1,
      UnitPrice: unitPrice ?? round(amount / (qty ?? 1)),
    };
  }

  /** Fixture-style lines to QuickBooks lines, plus the sub-total line. */
  private invoiceLines(lines: readonly JsonObject[]): JsonValue[] {
    const detailLines = lines.map((line, index) => ({
      Id: String(index + 1),
      LineNum: index + 1,
      Description: line.Description ?? null,
      Amount: line.Amount ?? 0,
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: {
        ItemRef: line.ItemRef ?? null,
        Qty: line.Qty ?? 1,
        UnitPrice: line.UnitPrice ?? line.Amount ?? 0,
        TaxCodeRef: { value: "NON" },
      },
    }));
    const subtotal = round(lines.reduce((sum, line) => sum + Number(line.Amount ?? 0), 0));
    return [
      ...detailLines,
      { Amount: subtotal, DetailType: "SubTotalLineDetail", SubTotalLineDetail: {} },
    ];
  }

  private applyPayment(invoiceId: string, paymentId: string, amount: number): void {
    const invoice = this.entities.Invoice.get(invoiceId);
    if (invoice === undefined)
      throw new Error(`Payment ${paymentId} names unknown invoice ${invoiceId}`);
    invoice.Balance = round(Number(invoice.Balance) - amount);
    const linked = Array.isArray(invoice.LinkedTxn) ? invoice.LinkedTxn : [];
    invoice.LinkedTxn = [...linked, { TxnId: paymentId, TxnType: "Payment" }];
  }

  private refreshCustomerBalances(): void {
    for (const customer of this.entities.Customer.values()) {
      const open = [...this.entities.Invoice.values()]
        .filter((invoice) => fieldValue(invoice, "CustomerRef") === customer.Id)
        .reduce((sum, invoice) => sum + Number(invoice.Balance), 0);
      customer.Balance = round(open);
      customer.BalanceWithJobs = round(open);
    }
  }

  private reference(name: "Customer" | "Item" | "Term", ref: JsonValue | undefined): Entity {
    const value =
      ref !== null && typeof ref === "object" && !Array.isArray(ref)
        ? (ref as JsonObject).value
        : undefined;
    if (typeof value !== "string" || value === "") throw requiredMissing(`${name}Ref`);
    const entity = this.entities[name].get(value);
    if (entity === undefined) throw invalidReference(name, value);
    return entity;
  }

  private assertUniqueName(displayName: string, exceptId: string | null): void {
    const taken = [...this.entities.Customer.values()].some(
      (entity) =>
        entity.Id !== exceptId &&
        String(entity.DisplayName).toLowerCase() === displayName.toLowerCase(),
    );
    if (taken) {
      throw new QboFault(
        "6240",
        "Duplicate Name Exists Error",
        "The name supplied already exists. : Another customer, vendor or employee is already using this name. Please use a different name.",
      );
    }
  }

  private assertSyncToken(entity: Entity, body: JsonObject): void {
    if (body.SyncToken === undefined) throw requiredMissing("SyncToken");
    if (String(body.SyncToken) !== entity.SyncToken) {
      throw new QboFault(
        "5010",
        "Stale Object Error",
        `Stale Object Error : You and ${"another user"} were working on the same thing. SyncToken ${String(body.SyncToken)} is not the current SyncToken ${String(entity.SyncToken)}.`,
      );
    }
  }

  private touch(entity: Entity): void {
    entity.SyncToken = String(Number(entity.SyncToken) + 1);
    const meta = entity.MetaData as JsonObject;
    entity.MetaData = { ...meta, LastUpdatedTime: this.time() };
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function copy(entity: Entity | undefined): Entity | undefined {
  return entity === undefined ? undefined : structuredClone(entity);
}

function stringField(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function addressOf(value: JsonValue | undefined): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const address = (value as JsonObject).Address;
  return typeof address === "string" ? address : undefined;
}

function asObject(value: JsonValue, element: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new QboFault(
      "2010",
      "Request has invalid or unsupported property",
      `${element} must be an object`,
      { element },
    );
  }
  return value as JsonObject;
}

function stripUndefined(object: JsonObject): Entity {
  const out: Entity = {};
  for (const [key, value] of Object.entries(object)) if (value !== undefined) out[key] = value;
  return out;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function xml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
