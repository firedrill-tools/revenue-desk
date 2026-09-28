import { describe, expect, it } from "vitest";
import type { QuickBooksConnection } from "../../../src/contracts/integration.js";
import type { JsonObject, JsonValue } from "../../../src/contracts/json.js";
import {
  createQuickBooksIntegration,
  probeQuickBooks,
} from "../../../src/integrations/quickbooks/definition.js";
import { QUICKBOOKS_PROFILE } from "../../../src/integrations/quickbooks/profile.js";
import { resolveQuickBooks } from "../../../src/integrations/quickbooks/resolve.js";
import type { ApiTool } from "../../../src/integrations/shared/api-tool.js";
import { at, callContext, mockFetch, paramsOf, type Reply, secret, testEnv } from "./helpers.js";

const connection: QuickBooksConnection = {
  integration: "quickbooks",
  kind: "api",
  profile: "quickbooks-api",
  endpointLabel: "127.0.0.1:4420",
  api: {
    baseUrl: "http://127.0.0.1:4420",
    accessToken: secret("qbo-token"),
    realmId: "9130000001",
    minorVersion: null,
  },
};

function setup(reply: (index: number) => Reply, currency = "USD", timezone?: string) {
  const mock = mockFetch((_, index) => reply(index));
  const definition = createQuickBooksIntegration({ http: mock.http });
  const options = timezone === undefined ? { currency } : { currency, timezone };
  const tools = new Map(definition.tools(connection, options).map((tool) => [tool.name, tool]));
  const run = (name: string, args: JsonObject, context = callContext()): Promise<JsonValue> => {
    const tool: ApiTool | undefined = tools.get(name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool.run(args, context);
  };
  const query = (index = 0) => mock.requests[index]?.url.searchParams.get("query");
  return { mock, tools, run, query };
}

const INVOICE: JsonObject = {
  Id: "130",
  DocNumber: "1037",
  SyncToken: "3",
  CustomerRef: { value: "58", name: "Acme Logistics" },
  TxnDate: "2026-06-01",
  DueDate: "2026-07-01",
  TotalAmt: 1200.5,
  Balance: 1200.5,
  EmailStatus: "EmailSent",
  BillEmail: { Address: "ap@acme.test" },
  Line: [
    {
      DetailType: "SalesItemLineDetail",
      Amount: 1200.5,
      Description: "Annual plan",
      SalesItemLineDetail: { ItemRef: { value: "1", name: "Services" }, Qty: 1, UnitPrice: 1200.5 },
    },
    { DetailType: "SubTotalLineDetail", Amount: 1200.5 },
  ],
};

describe("QuickBooks tools", () => {
  it("are exactly the quickbooks-api profile", () => {
    const { tools } = setup(() => ({ json: {} }));
    expect([...tools.keys()].sort()).toEqual(Object.keys(QUICKBOOKS_PROFILE.tools).sort());
    for (const [name, tool] of tools)
      expect(tool.readOnly).toBe(QUICKBOOKS_PROFILE.tools[name]?.readOnly);
  });

  it("list_invoices filters open overdue invoices, reads every page and adds days_overdue", async () => {
    const pages: Reply[] = [
      { json: { QueryResponse: { Invoice: [INVOICE] } } },
      { json: { QueryResponse: {} } },
    ];
    const { run, query, mock } = setup((index) => pages[index] ?? { json: { QueryResponse: {} } });
    const result = await run("list_invoices", {
      customer_id: "58",
      status: "open",
      due_before: "2026-08-01",
      as_of: "2026-09-28",
      limit: 200,
    });
    expect(query(0)).toBe(
      "SELECT * FROM Invoice WHERE CustomerRef = '58' AND Balance > '0' AND DueDate < '2026-08-01' ORDERBY DueDate ASC STARTPOSITION 1 MAXRESULTS 100",
    );
    expect(query(1)).toContain("STARTPOSITION 2 MAXRESULTS 100");
    expect(mock.requests).toHaveLength(2);
    expect(result).toEqual({
      invoices: [
        {
          id: "130",
          doc_number: "1037",
          customer: { id: "58", name: "Acme Logistics" },
          invoice_date: "2026-06-01",
          due_date: "2026-07-01",
          total_minor: 120_050,
          balance_minor: 120_050,
          currency: "USD",
          days_overdue: 89,
          email_status: "EmailSent",
          bill_email: "ap@acme.test",
          sync_token: "3",
        },
      ],
      count: 1,
      complete: true,
    });
  });

  it("find_customers matches names, email and active customers", async () => {
    const { run, query } = setup(() => ({ json: { QueryResponse: {} } }));
    const result = await run("find_customers", {
      name: "Acme",
      email: "ap@acme.test",
      include_inactive: false,
      limit: 20,
    });
    expect(query()).toBe(
      "SELECT * FROM Customer WHERE DisplayName LIKE '%Acme%' AND PrimaryEmailAddr = 'ap@acme.test' AND Active = true ORDERBY DisplayName ASC STARTPOSITION 1 MAXRESULTS 20",
    );
    expect(result).toEqual({ customers: [], count: 0, complete: true });
  });

  it("list_payments shows what each payment was applied to, in minor units", async () => {
    const payment = {
      Id: "77",
      CustomerRef: { value: "58" },
      TxnDate: "2026-09-02",
      TotalAmt: 49,
      UnappliedAmt: 0,
      PaymentRefNum: "ch_2",
      CurrencyRef: { value: "EUR" },
      Line: [
        {
          Amount: 49,
          LinkedTxn: [
            { TxnId: "130", TxnType: "Invoice" },
            { TxnId: "9", TxnType: "CreditMemo" },
          ],
        },
      ],
    };
    const pages: Reply[] = [
      { json: { QueryResponse: { Payment: [payment] } } },
      { json: { QueryResponse: {} } },
    ];
    const { run, query } = setup((index) => pages[index] ?? { json: { QueryResponse: {} } });
    const result = await run("list_payments", {
      customer_id: "58",
      received_from: "2026-09-01",
      limit: 100,
    });
    expect(query()).toBe(
      "SELECT * FROM Payment WHERE CustomerRef = '58' AND TxnDate >= '2026-09-01' ORDERBY TxnDate DESC STARTPOSITION 1 MAXRESULTS 100",
    );
    expect(at(result, "payments", 0)).toEqual({
      id: "77",
      customer: { id: "58" },
      payment_date: "2026-09-02",
      total_minor: 4900,
      unapplied_minor: 0,
      currency: "EUR",
      reference: "ch_2",
      applied_to: [{ invoice_id: "130", amount_minor: 4900 }],
    });
  });

  it("get_company_info reads companyinfo and returns the server time", async () => {
    const { run, mock } = setup(() => ({
      json: {
        CompanyInfo: { CompanyName: "Kestrel Analytics", Country: "US" },
        time: "2026-09-28T09:00:00.000-07:00",
      },
    }));
    await expect(run("get_company_info", {})).resolves.toEqual({
      company_name: "Kestrel Analytics",
      country: "US",
      server_time: "2026-09-28T09:00:00.000-07:00",
    });
    expect(mock.requests[0]?.url.pathname).toBe("/v3/company/9130000001/companyinfo/9130000001");
  });

  it("writes the server time and record creation times in the workspace time zone", async () => {
    const { run } = setup(
      (index): Reply =>
        index === 0
          ? {
              json: {
                CompanyInfo: { CompanyName: "Kestrel Analytics" },
                time: "2026-09-28T06:00:00.000-07:00",
              },
            }
          : {
              json: {
                Customer: {
                  Id: "58",
                  DisplayName: "Acme",
                  MetaData: { CreateTime: "2026-03-22T07:00:00-07:00" },
                },
              },
            },
      "USD",
      "America/New_York",
    );
    await expect(run("get_company_info", {})).resolves.toMatchObject({
      server_time: "2026-09-28T09:00:00-04:00",
    });
    await expect(run("get_customer", { customer_id: "58" })).resolves.toMatchObject({
      created: "2026-03-22T10:00:00-04:00",
    });
  });

  it("get_invoice keeps sales lines only, in minor units", async () => {
    const { run } = setup(() => ({ json: { Invoice: INVOICE } }));
    const result = await run("get_invoice", { invoice_id: "130" });
    expect(at(result, "lines")).toEqual([
      {
        description: "Annual plan",
        quantity: 1,
        unit_price_minor: 120_050,
        amount_minor: 120_050,
        item: { id: "1", name: "Services" },
      },
    ]);
  });

  it("create_invoice converts minor units to QuickBooks decimals and sends requestid", async () => {
    const { run, mock } = setup(() => ({ json: { Invoice: INVOICE } }));
    await run(
      "create_invoice",
      {
        customer_id: "58",
        lines: [
          { description: "Seats", quantity: 3, unit_price_minor: 40_000, item_id: "1" },
          { description: "Onboarding", quantity: 1.5, unit_price_minor: 999 },
        ],
        due_date: "2026-10-28",
        bill_email: "ap@acme.test",
        customer_memo: "Thank you",
      },
      callContext({ idempotencyKey: "c".repeat(64) }),
    );
    const request = mock.requests[0];
    expect(request?.url.pathname).toBe("/v3/company/9130000001/invoice");
    expect(paramsOf(request?.url.search ?? "")).toEqual({ requestid: "c".repeat(64) });
    expect(JSON.parse(request?.body ?? "")).toEqual({
      CustomerRef: { value: "58" },
      Line: [
        {
          DetailType: "SalesItemLineDetail",
          Amount: 1200,
          Description: "Seats",
          SalesItemLineDetail: { ItemRef: { value: "1" }, Qty: 3, UnitPrice: 400 },
        },
        {
          DetailType: "SalesItemLineDetail",
          Amount: 14.99,
          Description: "Onboarding",
          SalesItemLineDetail: { Qty: 1.5, UnitPrice: 9.99 },
        },
      ],
      DueDate: "2026-10-28",
      BillEmail: { Address: "ap@acme.test" },
      CustomerMemo: { value: "Thank you" },
    });
  });

  it("send_invoice, record_payment, void_invoice and create_customer hit their routes", async () => {
    const cases: Array<
      [string, JsonObject, string, Record<string, string>, JsonValue | undefined, string]
    > = [
      [
        "send_invoice",
        { invoice_id: "130", send_to: "ap@acme.test" },
        "/v3/company/9130000001/invoice/130/send",
        { sendTo: "ap@acme.test" },
        undefined,
        "Invoice",
      ],
      [
        "record_payment",
        {
          customer_id: "58",
          amount_minor: 4900,
          invoice_id: "130",
          payment_date: "2026-09-02",
          reference: "ch_2",
        },
        "/v3/company/9130000001/payment",
        {},
        {
          CustomerRef: { value: "58" },
          TotalAmt: 49,
          TxnDate: "2026-09-02",
          PaymentRefNum: "ch_2",
          Line: [{ Amount: 49, LinkedTxn: [{ TxnId: "130", TxnType: "Invoice" }] }],
        },
        "Payment",
      ],
      [
        "void_invoice",
        { invoice_id: "130", sync_token: "3" },
        "/v3/company/9130000001/invoice",
        { operation: "void" },
        { Id: "130", SyncToken: "3" },
        "Invoice",
      ],
      [
        "create_customer",
        {
          display_name: "Acme Logistics",
          email: "ap@acme.test",
          billing_address: { line1: "1 Main St", city: "Springfield" },
        },
        "/v3/company/9130000001/customer",
        {},
        {
          DisplayName: "Acme Logistics",
          PrimaryEmailAddr: { Address: "ap@acme.test" },
          BillAddr: { Line1: "1 Main St", City: "Springfield" },
        },
        "Customer",
      ],
    ];
    for (const [name, args, path, query, body, entity] of cases) {
      const { run, mock } = setup(() => ({ json: { [entity]: { Id: "1" } } }));
      await run(name, args);
      const request = mock.requests[0];
      expect(mock.requests).toHaveLength(1);
      expect(request?.method).toBe("POST");
      expect(request?.url.pathname).toBe(path);
      expect(paramsOf(request?.url.search ?? "")).toEqual({ ...query, requestid: "a".repeat(64) });
      if (body === undefined) expect(request?.body).toBe("");
      else expect(JSON.parse(request?.body ?? "")).toEqual(body);
    }
  });

  it("uses the workspace currency for amounts when multicurrency is off", async () => {
    const { run } = setup(
      () => ({ json: { Invoice: { Id: "1", TotalAmt: 5000, Balance: 0 } } }),
      "JPY",
    );
    await expect(run("get_invoice", { invoice_id: "1" })).resolves.toMatchObject({
      total_minor: 5000,
      balance_minor: 0,
      currency: "JPY",
    });
  });

  it("refuses writes without an idempotency key", async () => {
    const { run, mock } = setup(() => ({ json: {} }));
    await expect(
      run(
        "void_invoice",
        { invoice_id: "1", sync_token: "0" },
        callContext({ idempotencyKey: "" }),
      ),
    ).rejects.toMatchObject({ code: "idempotency_key_missing" });
    expect(mock.requests).toHaveLength(0);
  });
});

describe("QuickBooks resolution and probe", () => {
  it("resolves, lists missing names, and refuses bad values", () => {
    expect(resolveQuickBooks(testEnv())).toEqual({
      status: "not_configured",
      missing: ["QBO_ACCESS_TOKEN", "QBO_REALM_ID"],
    });
    expect(resolveQuickBooks(testEnv({ quickbooks: { accessToken: secret("t") } }))).toEqual({
      status: "not_configured",
      missing: ["QBO_REALM_ID"],
    });
    const ok = resolveQuickBooks(
      testEnv({
        quickbooks: { accessToken: secret("t"), realmId: "9130000001", minorVersion: "75" },
      }),
    );
    expect(ok).toMatchObject({
      status: "configured",
      connection: {
        endpointLabel: "sandbox-quickbooks.api.intuit.com",
        api: { realmId: "9130000001", minorVersion: "75" },
      },
    });
    expect(
      resolveQuickBooks(testEnv({ quickbooks: { accessToken: secret("t"), realmId: "../x" } })),
    ).toMatchObject({ status: "invalid", problems: [{ variable: "QBO_REALM_ID" }] });
    expect(
      resolveQuickBooks(
        testEnv({ quickbooks: { accessToken: secret("t"), realmId: "1", minorVersion: "v75" } }),
      ),
    ).toMatchObject({ status: "invalid", problems: [{ variable: "QBO_MINOR_VERSION" }] });
  });

  it("probes companyinfo; a 401 means the hourly token expired", async () => {
    const ok = mockFetch(() => ({ json: { CompanyInfo: { CompanyName: "Kestrel Analytics" } } }));
    await expect(
      probeQuickBooks(connection, new AbortController().signal, ok.http),
    ).resolves.toEqual({
      state: "connected",
      detail: "Connected to Kestrel Analytics.",
      accountHint: "913…001",
    });
    const expired = mockFetch(() => ({
      status: 401,
      json: {
        fault: {
          error: [{ message: "AuthenticationFailed", code: "3200" }],
          type: "AUTHENTICATION",
        },
      },
    }));
    await expect(
      probeQuickBooks(connection, new AbortController().signal, expired.http),
    ).resolves.toMatchObject({ state: "expired" });
    const forbidden = mockFetch(() => ({
      status: 403,
      json: { Fault: { Error: [{ Message: "Forbidden", code: "403" }] } },
    }));
    await expect(
      probeQuickBooks(connection, new AbortController().signal, forbidden.http),
    ).resolves.toMatchObject({ state: "needs_auth" });
  });
});
