/**
 * Contract tests for the QuickBooks Online fake, independent of the agent:
 * auth and realm checks, JSON versus XML, the Fault envelope, query paging
 * with size-truncated pages, requestid replay, customers, invoices, sending,
 * payments and voids.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../../../src/contracts/json.js";
import { createClock } from "../../support/fakes/core/clock.js";
import { FAKE_CREDENTIALS } from "../../support/fakes/credentials.js";
import { loadBusinessFixtures } from "../../support/fakes/fixtures.js";
import { QuickBooksFake } from "../../support/fakes/quickbooks/index.js";

const TOKEN = FAKE_CREDENTIALS.quickbooksAccessToken;
const REALM = "9341455130166501";
let qbo: QuickBooksFake;

beforeEach(async () => {
  const fixtures = loadBusinessFixtures();
  qbo = await QuickBooksFake.start({
    fixture: fixtures.quickbooks,
    clock: createClock(fixtures.company.asOf),
    accessToken: TOKEN,
  });
});

afterEach(async () => {
  await qbo.close();
});

interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly body: JsonObject;
}

async function call(
  method: string,
  path: string,
  options: {
    readonly json?: unknown;
    readonly text?: string;
    readonly token?: string | null;
    readonly realm?: string;
    readonly accept?: string | null;
  } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const accept = options.accept === undefined ? "application/json" : options.accept;
  if (accept !== null) headers.accept = accept;
  let body: string | undefined;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.text !== undefined) {
    headers["content-type"] = "application/text";
    body = options.text;
  }
  const response = await fetch(`${qbo.baseUrl}/v3/company/${options.realm ?? REALM}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  let parsed: JsonObject = {};
  try {
    parsed = JSON.parse(text) as JsonObject;
  } catch {}
  return { status: response.status, headers: response.headers, text, body: parsed };
}

const query = (sql: string) =>
  call("GET", `/query?query=${encodeURIComponent(sql)}&minorversion=75`);
const faultOf = (reply: Reply) => ((reply.body.Fault as JsonObject).Error as JsonObject[])[0];

describe("QuickBooks fake: auth, realm and formats", () => {
  it("answers a missing or wrong token with 401 AuthenticationFailed", async () => {
    for (const token of [null, "wrong-token"]) {
      const reply = await call("GET", `/companyinfo/${REALM}`, { token });
      expect(reply.status).toBe(401);
      expect(reply.headers.get("www-authenticate")).toContain("invalid_token");
      expect(reply.body.fault).toMatchObject({ type: "AUTHENTICATION", error: [{ code: "3200" }] });
    }
  });

  it("answers another realm with 403 ApplicationAuthorizationFailed", async () => {
    const reply = await call("GET", "/companyinfo/1234", { realm: "1234" });
    expect(reply.status).toBe(403);
    expect(reply.body.fault).toMatchObject({ type: "AUTHORIZATION", error: [{ code: "3100" }] });
  });

  it("serves company info with a company-time `time` and an intuit_tid", async () => {
    const reply = await call("GET", `/companyinfo/${REALM}?minorversion=75`);
    expect(reply.status).toBe(200);
    expect(reply.body.CompanyInfo).toMatchObject({
      CompanyName: "Kestrel Analytics, Inc.",
      Id: "1",
    });
    expect(reply.body.time).toBe("2026-09-28T09:00:00.000-04:00");
    expect(reply.headers.get("intuit_tid")).toBeTruthy();
    expect(qbo.requests.at(-1)?.notes).toMatchObject({ minorversion: "75" });
  });

  it("answers XML when the client does not ask for JSON", async () => {
    const reply = await call("GET", `/companyinfo/${REALM}`, { accept: null });
    expect(reply.status).toBe(200);
    expect(reply.headers.get("content-type")).toContain("application/xml");
    expect(reply.text.startsWith("<?xml")).toBe(true);
    const fault = await call("GET", "/invoice/999", { accept: "*/*" });
    expect(fault.status).toBe(400);
    expect(fault.text).toContain('<Error code="610">');
  });

  it("answers a missing entity with the 610 Object Not Found Fault", async () => {
    const reply = await call("GET", "/invoice/999");
    expect(reply.status).toBe(400);
    expect(reply.body.Fault).toMatchObject({ type: "ValidationFault" });
    expect(faultOf(reply)).toMatchObject({ code: "610", Message: "Object Not Found" });
  });
});

describe("QuickBooks fake: queries", () => {
  const overdue = (start: number) =>
    `SELECT * FROM Invoice WHERE Balance > '0' AND DueDate < '2026-09-28' ORDERBY DueDate STARTPOSITION ${start} MAXRESULTS 100`;

  it("truncates pages to the cap; clients page until an empty QueryResponse", async () => {
    const first = await query(overdue(1));
    const firstRows = (first.body.QueryResponse as JsonObject).Invoice as JsonObject[];
    expect(first.body.QueryResponse).toMatchObject({ startPosition: 1, maxResults: 2 });
    expect(firstRows.map((row) => row.DocNumber)).toEqual(["1043", "1048"]);
    const second = await query(overdue(3));
    expect(
      ((second.body.QueryResponse as JsonObject).Invoice as JsonObject[]).map(
        (row) => row.DocNumber,
      ),
    ).toEqual(["1051", "1055"]);
    const third = await query(overdue(5));
    expect(third.body.QueryResponse).toEqual({});
    const count = await query(
      "SELECT COUNT(*) FROM Invoice WHERE Balance > '0' AND DueDate < '2026-09-28'",
    );
    expect(count.body.QueryResponse).toEqual({ totalCount: 4 });
  });

  it("computes balances from payments: 1055 is half paid, 1049 is paid", async () => {
    const invoices = await query("SELECT * FROM Invoice WHERE DocNumber IN ('1049', '1055')");
    const rows = (invoices.body.QueryResponse as JsonObject).Invoice as JsonObject[];
    expect(rows.map((row) => [row.DocNumber, row.TotalAmt, row.Balance])).toEqual([
      ["1049", 490, 0],
      ["1055", 1500, 750],
    ]);
    expect(rows[1]?.LinkedTxn).toEqual([{ TxnId: "219", TxnType: "Payment" }]);
  });

  it("finds customers by name or email, with a field list", async () => {
    const reply = await query(
      "SELECT Id, DisplayName FROM Customer WHERE PrimaryEmailAddr = 'irene@meridianlabs.test'",
    );
    expect((reply.body.QueryResponse as JsonObject).Customer).toEqual([
      { Id: "63", sparse: true, DisplayName: "Meridian Labs" },
    ]);
    const none = await query(
      "SELECT * FROM Customer WHERE DisplayName = 'Solstice Energy Cooperative'",
    );
    expect(none.body.QueryResponse).toEqual({});
  });

  it("accepts POST /query with application/text", async () => {
    const reply = await call("POST", "/query", { text: "SELECT * FROM Term" });
    expect(((reply.body.QueryResponse as JsonObject).Term as JsonObject[]).length).toBe(2);
  });

  it("answers bad queries with 4000 and 4001 Faults", async () => {
    const parse = await query("SELEC * FROM Invoice");
    expect(parse.status).toBe(400);
    expect(faultOf(parse)).toMatchObject({ code: "4000", Message: "Error parsing query" });
    const field = await query("SELECT * FROM Invoice WHERE Colour = 'red'");
    expect(faultOf(field)).toMatchObject({ code: "4001" });
    expect(String(faultOf(field)?.Detail)).toContain("Colour");
  });
});

describe("QuickBooks fake: writes", () => {
  it("creates a customer once per requestid and refuses duplicate names (6240)", async () => {
    const body = {
      DisplayName: "Solstice Energy Cooperative",
      CompanyName: "Solstice Energy Cooperative",
      PrimaryEmailAddr: { Address: "marco@solstice.test" },
    };
    const first = await call("POST", "/customer?requestid=req-1&minorversion=75", { json: body });
    expect(first.status).toBe(200);
    expect(first.body.Customer).toMatchObject({
      Id: "68",
      DisplayName: "Solstice Energy Cooperative",
      SyncToken: "0",
      Balance: 0,
    });
    const replay = await call("POST", "/customer?requestid=req-1", { json: body });
    expect(replay.body).toEqual(first.body);
    const duplicate = await call("POST", "/customer?requestid=req-2", { json: body });
    expect(duplicate.status).toBe(400);
    expect(faultOf(duplicate)).toMatchObject({
      code: "6240",
      Message: "Duplicate Name Exists Error",
    });
    expect(qbo.writes()).toEqual([
      { path: `/v3/company/${REALM}/customer`, requestId: "req-1", status: 200, replayed: false },
      { path: `/v3/company/${REALM}/customer`, requestId: "req-1", status: 200, replayed: true },
      { path: `/v3/company/${REALM}/customer`, requestId: "req-2", status: 400, replayed: false },
    ]);
  });

  it("refuses unknown properties (2010) and missing required ones (2020)", async () => {
    const unknown = await call("POST", "/customer", { json: { DisplayName: "X", Colour: "red" } });
    expect(faultOf(unknown)).toMatchObject({ code: "2010" });
    const noLine = await call("POST", "/invoice", { json: { CustomerRef: { value: "61" } } });
    expect(faultOf(noLine)).toMatchObject({ code: "2020" });
    expect(String(faultOf(noLine)?.Detail)).toContain("Line");
    const badRef = await call("POST", "/invoice", {
      json: {
        CustomerRef: { value: "999" },
        Line: [
          {
            Amount: 1,
            DetailType: "SalesItemLineDetail",
            SalesItemLineDetail: { ItemRef: { value: "1" } },
          },
        ],
      },
    });
    expect(faultOf(badRef)).toMatchObject({ code: "2500" });
  });

  it("creates an invoice with defaults from the customer and terms, then sends it", async () => {
    const created = await call("POST", "/invoice?requestid=inv-1", {
      json: {
        CustomerRef: { value: "61" },
        Line: [
          {
            Amount: 18000,
            DetailType: "SalesItemLineDetail",
            Description: "Enterprise plan (annual)",
            SalesItemLineDetail: { ItemRef: { value: "3" }, Qty: 1, UnitPrice: 18000 },
          },
        ],
      },
    });
    expect(created.status).toBe(200);
    const invoice = created.body.Invoice as JsonObject;
    expect(invoice).toMatchObject({
      Id: "158",
      DocNumber: "1058",
      TxnDate: "2026-09-28",
      DueDate: "2026-10-28",
      TotalAmt: 18000,
      Balance: 18000,
      EmailStatus: "NotSet",
      BillEmail: { Address: "theo@copperleaf.test" },
      SalesTermRef: { value: "3", name: "Net 30" },
    });
    expect((invoice.Line as JsonObject[]).at(-1)).toMatchObject({
      DetailType: "SubTotalLineDetail",
      Amount: 18000,
    });

    const sent = await call("POST", "/invoice/158/send?sendTo=ap@copperleaf.test&requestid=send-1");
    expect(sent.body.Invoice).toMatchObject({
      EmailStatus: "EmailSent",
      BillEmail: { Address: "ap@copperleaf.test" },
      DeliveryInfo: { DeliveryType: "Email" },
      SyncToken: "1",
    });
    await call("POST", "/invoice/158/send?sendTo=ap@copperleaf.test&requestid=send-1");
    expect(qbo.sentInvoices).toEqual([
      {
        invoiceId: "158",
        docNumber: "1058",
        to: "ap@copperleaf.test",
        at: "2026-09-28T09:00:00.000-04:00",
      },
    ]);
  });

  it("checks Amount = Qty × UnitPrice (6070)", async () => {
    const reply = await call("POST", "/invoice", {
      json: {
        CustomerRef: { value: "61" },
        Line: [
          {
            Amount: 100,
            DetailType: "SalesItemLineDetail",
            SalesItemLineDetail: { ItemRef: { value: "5" }, Qty: 2, UnitPrice: 240 },
          },
        ],
      },
    });
    expect(faultOf(reply)).toMatchObject({ code: "6070" });
  });

  it("records a payment against an invoice and updates balances", async () => {
    const reply = await call("POST", "/payment?requestid=pay-1", {
      json: {
        CustomerRef: { value: "63" },
        TotalAmt: 1980,
        PaymentRefNum: "ch_KAmer_0910",
        Line: [{ Amount: 1980, LinkedTxn: [{ TxnId: "151", TxnType: "Invoice" }] }],
      },
    });
    expect(reply.body.Payment).toMatchObject({ Id: "220", TotalAmt: 1980, UnappliedAmt: 0 });
    expect(qbo.invoice("151")).toMatchObject({
      Balance: 0,
      LinkedTxn: [{ TxnId: "220", TxnType: "Payment" }],
    });
    expect(qbo.customer("63")).toMatchObject({ Balance: 0 });
    const over = await call("POST", "/payment", {
      json: {
        CustomerRef: { value: "66" },
        TotalAmt: 800,
        Line: [{ Amount: 800, LinkedTxn: [{ TxnId: "155", TxnType: "Invoice" }] }],
      },
    });
    expect(faultOf(over)).toMatchObject({ code: "6000" });
    const wrongCustomer = await call("POST", "/payment", {
      json: {
        CustomerRef: { value: "58" },
        TotalAmt: 10,
        Line: [{ Amount: 10, LinkedTxn: [{ TxnId: "155", TxnType: "Invoice" }] }],
      },
    });
    expect(faultOf(wrongCustomer)).toMatchObject({ code: "6000" });
  });

  it("voids an invoice with the current SyncToken only, and never one with payments", async () => {
    const stale = await call("POST", "/invoice?operation=void", {
      json: { Id: "148", SyncToken: "7" },
    });
    expect(faultOf(stale)).toMatchObject({ code: "5010", Message: "Stale Object Error" });
    const voided = await call("POST", "/invoice?operation=void", {
      json: { Id: "148", SyncToken: "0" },
    });
    expect(voided.body.Invoice).toMatchObject({
      TotalAmt: 0,
      Balance: 0,
      PrivateNote: "Voided",
      SyncToken: "1",
    });
    const paid = await call("POST", "/invoice?operation=void", {
      json: { Id: "149", SyncToken: "0" },
    });
    expect(faultOf(paid)).toMatchObject({ code: "6000" });
  });
});

describe("QuickBooks fake: injected failures", () => {
  it("injects a Fault, a 429 throttle, a 500 and an expired token", async () => {
    qbo.faults.fault(
      /\/invoice$/,
      {
        code: "6000",
        message: "A business validation error has occurred while processing your request",
        detail: "Business Validation Error: injected",
      },
      { method: "POST" },
    );
    const fault = await call("POST", "/invoice", { json: {} });
    expect(fault.status).toBe(400);
    expect(faultOf(fault)).toMatchObject({
      code: "6000",
      Detail: "Business Validation Error: injected",
    });

    qbo.faults.throttle(/\/query$/);
    const throttled = await query("SELECT * FROM Term");
    expect(throttled.status).toBe(429);
    expect(throttled.body.Fault).toMatchObject({ type: "SERVICE" });

    qbo.faults.serverError(/\/query$/);
    expect((await query("SELECT * FROM Term")).status).toBe(500);

    qbo.faults.expiredToken();
    expect((await query("SELECT * FROM Term")).status).toBe(401);
    expect((await query("SELECT * FROM Term")).status).toBe(200);
  });
});
