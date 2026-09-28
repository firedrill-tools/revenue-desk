import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../../src/contracts/json.js";
import { QuickBooksClient, quickBooksError } from "../../../src/integrations/quickbooks/client.js";
import {
  containsPattern,
  quote,
  selectStatement,
} from "../../../src/integrations/quickbooks/query.js";
import { mockFetch, networkError, paramsOf, type Reply, secret } from "./helpers.js";

const TOKEN = "qbo-access-token-0123456789";
const KEY = "b".repeat(64);

function client(
  reply: (request: { url: URL }, index: number) => Reply | Error,
  minorVersion: string | null = "75",
) {
  const mock = mockFetch(reply);
  return {
    mock,
    qbo: new QuickBooksClient({
      baseUrl: "http://127.0.0.1:4420/qbo",
      accessToken: secret(TOKEN),
      realmId: "9130000001",
      minorVersion,
      http: mock.http,
    }),
  };
}

describe("QuickBooks query builder", () => {
  it("builds a paged SELECT with quoted values and an order", () => {
    expect(
      selectStatement(
        {
          entity: "Invoice",
          where: [
            { field: "Balance", op: ">", value: "0" },
            { field: "DueDate", op: "<", value: "2026-08-01" },
            { field: "CustomerRef", op: "IN", values: ["58", "59"] },
            { field: "Active", op: "=", value: true },
          ],
          orderBy: { field: "DueDate", direction: "ASC" },
        },
        { startPosition: 101, maxResults: 100 },
      ),
    ).toBe(
      "SELECT * FROM Invoice WHERE Balance > '0' AND DueDate < '2026-08-01' AND CustomerRef IN ('58', '59') AND Active = true ORDERBY DueDate ASC STARTPOSITION 101 MAXRESULTS 100",
    );
    expect(selectStatement({ entity: "Customer" }, { startPosition: 1, maxResults: 1 })).toBe(
      "SELECT * FROM Customer STARTPOSITION 1 MAXRESULTS 1",
    );
  });

  it("escapes quotes and backslashes so input cannot change the statement", () => {
    expect(quote("O'Brien")).toBe("'O\\'Brien'");
    expect(quote("a\\' OR '1'='1")).toBe("'a\\\\\\' OR \\'1\\'=\\'1'");
    expect(containsPattern("50% Acme")).toBe("%50 Acme%");
    const statement = selectStatement(
      {
        entity: "Customer",
        where: [{ field: "DisplayName", op: "LIKE", pattern: containsPattern("x' OR Id > '0") }],
      },
      { startPosition: 1, maxResults: 10 },
    );
    expect(statement).toBe(
      "SELECT * FROM Customer WHERE DisplayName LIKE '%x\\' OR Id > \\'0%' STARTPOSITION 1 MAXRESULTS 10",
    );
  });

  it("rejects bad fields and page bounds", () => {
    expect(() =>
      selectStatement(
        { entity: "Invoice", where: [{ field: "Id; DROP", op: "=", value: "1" }] },
        { startPosition: 1, maxResults: 1 },
      ),
    ).toThrow();
    expect(() =>
      selectStatement({ entity: "Invoice" }, { startPosition: 0, maxResults: 1 }),
    ).toThrow();
    expect(() =>
      selectStatement({ entity: "Invoice" }, { startPosition: 1, maxResults: 1001 }),
    ).toThrow();
    expect(() =>
      selectStatement(
        { entity: "Invoice", where: [{ field: "Id", op: "IN", values: [] }] },
        { startPosition: 1, maxResults: 1 },
      ),
    ).toThrow();
  });
});

describe("QuickBooksClient requests", () => {
  it("reads under /v3/company/{realm} with Bearer auth and minorversion, keeping the prefix", async () => {
    const { mock, qbo } = client(() => ({
      json: { CompanyInfo: { CompanyName: "Kestrel" }, time: "t" },
    }));
    await qbo.get("companyinfo/9130000001", undefined);
    const [request] = mock.requests;
    expect(request?.method).toBe("GET");
    expect(request?.url.pathname).toBe("/qbo/v3/company/9130000001/companyinfo/9130000001");
    expect(paramsOf(request?.url.search ?? "")).toEqual({ minorversion: "75" });
    expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request?.headers.accept).toBe("application/json");
  });

  it("omits minorversion when not configured", async () => {
    const { mock, qbo } = client(() => ({ json: {} }), null);
    await qbo.get("customer/1", undefined);
    expect(mock.requests[0]?.url.search).toBe("");
  });

  it("sends writes as JSON with requestid set to the idempotency key", async () => {
    const { mock, qbo } = client(() => ({ json: { Invoice: { Id: "130" } } }));
    await qbo.post(
      "invoice",
      { Id: "130", SyncToken: "2" },
      { idempotencyKey: KEY, signal: undefined, query: { operation: "void" } },
    );
    const [request] = mock.requests;
    expect(request?.method).toBe("POST");
    expect(request?.url.pathname).toBe("/qbo/v3/company/9130000001/invoice");
    expect(paramsOf(request?.url.search ?? "")).toEqual({
      operation: "void",
      minorversion: "75",
      requestid: KEY,
    });
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(request?.body ?? "")).toEqual({ Id: "130", SyncToken: "2" });
  });

  it("sends an empty-bodied write as octet-stream", async () => {
    const { mock, qbo } = client(() => ({ json: { Invoice: { Id: "130" } } }));
    await qbo.postEmpty("invoice/130/send", {
      idempotencyKey: KEY,
      signal: undefined,
      query: { sendTo: "ap@acme.test" },
    });
    expect(mock.requests[0]?.headers["content-type"]).toBe("application/octet-stream");
    expect(paramsOf(mock.requests[0]?.url.search ?? "")).toMatchObject({
      sendTo: "ap@acme.test",
      requestid: KEY,
    });
  });

  it("refuses a write without an idempotency key", async () => {
    const { mock, qbo } = client(() => ({ json: {} }));
    await expect(
      qbo.post("payment", {}, { idempotencyKey: "", signal: undefined }),
    ).rejects.toMatchObject({
      code: "idempotency_key_missing",
    });
    expect(mock.requests).toHaveLength(0);
  });

  it("retries reads on 429 and pre-send network errors, never writes", async () => {
    const reads = client((_, index) =>
      index === 0
        ? { status: 429, headers: { "retry-after": "1" } }
        : index === 1
          ? networkError("ECONNREFUSED")
          : { json: { Customer: {} } },
    );
    await expect(reads.qbo.get("customer/1", undefined)).resolves.toEqual({ Customer: {} });
    expect(reads.mock.requests).toHaveLength(3);
    const writes = client(() => ({ status: 429 }));
    await expect(
      writes.qbo.post("customer", {}, { idempotencyKey: KEY, signal: undefined }),
    ).rejects.toMatchObject({ status: 429 });
    expect(writes.mock.requests).toHaveLength(1);
  });
});

describe("QuickBooks errors", () => {
  it("normalises the Fault envelope", () => {
    const body = {
      Fault: {
        Error: [
          {
            Message: "Stale Object Error",
            Detail: "You and root were working on this at the same time.",
            code: "5010",
            element: "SyncToken",
          },
        ],
        type: "ValidationFault",
      },
      time: "2026-09-28T10:00:00.000-07:00",
    };
    expect(quickBooksError(400, body).toJSON()).toEqual({
      provider: "quickbooks",
      status: 400,
      code: "5010",
      message:
        "Stale Object Error: You and root were working on this at the same time. (field: SyncToken)",
    });
  });

  it("reads the lower-case fault of an authentication failure and scrubs the token", () => {
    const body = {
      fault: {
        error: [
          {
            message: "message=AuthenticationFailed; errorCode=003200; statusCode=401",
            detail: `Token expired: ${TOKEN}`,
            code: "3200",
          },
        ],
        type: "AUTHENTICATION",
      },
    };
    expect(quickBooksError(401, body, [TOKEN]).toJSON()).toEqual({
      provider: "quickbooks",
      status: 401,
      code: "3200",
      message:
        "message=AuthenticationFailed; errorCode=003200; statusCode=401: Token expired: [redacted]",
    });
    expect(quickBooksError(500, undefined).toJSON()).toMatchObject({
      code: "http_500",
      message: "QuickBooks returned HTTP 500.",
    });
  });

  it("treats a Fault in a 200 response as an error", async () => {
    const { qbo } = client(() => ({
      json: {
        Fault: {
          Error: [{ Message: "Invalid Reference Id", code: "2500" }],
          type: "ValidationFault",
        },
      },
    }));
    await expect(qbo.get("invoice/9", undefined)).rejects.toMatchObject({
      status: 200,
      code: "2500",
    });
  });
});

describe("QuickBooks paging", () => {
  const invoice = (id: number): JsonObject => ({ Id: String(id) });
  const page = (ids: number[]): Reply => ({
    json: {
      QueryResponse:
        ids.length === 0
          ? {}
          : { Invoice: ids.map(invoice), startPosition: ids[0] ?? 1, maxResults: ids.length },
      time: "t",
    },
  });
  const statements = (mock: ReturnType<typeof mockFetch>) =>
    mock.requests.map((request) => request.url.searchParams.get("query"));

  it("reads until an empty QueryResponse and continues after a size-truncated page", async () => {
    // Asked for 3 per page; the second page is cut to 1 row by the server.
    const pages = [page([1, 2, 3]), page([4]), page([5, 6, 7]), page([])];
    const { mock, qbo } = client((_, index) => pages[index] ?? page([]));
    const result = await qbo.queryAll(
      { entity: "Invoice", where: [{ field: "Balance", op: ">", value: "0" }] },
      { pageSize: 3, maxRows: 100, signal: undefined },
    );
    expect(result.rows.map((row) => row.Id)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(result.complete).toBe(true);
    expect(result.pages).toBe(4);
    expect(statements(mock)).toEqual([
      "SELECT * FROM Invoice WHERE Balance > '0' STARTPOSITION 1 MAXRESULTS 3",
      "SELECT * FROM Invoice WHERE Balance > '0' STARTPOSITION 4 MAXRESULTS 3",
      "SELECT * FROM Invoice WHERE Balance > '0' STARTPOSITION 5 MAXRESULTS 3",
      "SELECT * FROM Invoice WHERE Balance > '0' STARTPOSITION 8 MAXRESULTS 3",
    ]);
    expect(mock.requests[0]?.url.pathname).toBe("/qbo/v3/company/9130000001/query");
  });

  it("stops at maxRows without claiming completeness", async () => {
    const { mock, qbo } = client((_, index) => page([index * 2 + 1, index * 2 + 2]));
    const result = await qbo.queryAll(
      { entity: "Invoice" },
      { pageSize: 2, maxRows: 3, signal: undefined },
    );
    expect(result.rows).toHaveLength(3);
    expect(result.complete).toBe(false);
    expect(statements(mock)).toEqual([
      "SELECT * FROM Invoice STARTPOSITION 1 MAXRESULTS 2",
      "SELECT * FROM Invoice STARTPOSITION 3 MAXRESULTS 1",
    ]);
  });

  it("stops at maxPages without claiming completeness", async () => {
    const { mock, qbo } = client((_, index) => page([index + 1]));
    const result = await qbo.queryAll(
      { entity: "Invoice" },
      { pageSize: 1, maxRows: 100, maxPages: 3, signal: undefined },
    );
    expect(result).toMatchObject({ complete: false, pages: 3 });
    expect(mock.requests).toHaveLength(3);
  });

  it("fails on a response without QueryResponse", async () => {
    const { qbo } = client(() => ({ json: { time: "t" } }));
    await expect(
      qbo.queryAll({ entity: "Invoice" }, { pageSize: 10, maxRows: 10, signal: undefined }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});
