/**
 * The QuickBooks Online company behind the fake: entities hydrated from
 * test/fixtures/business/quickbooks.json (SyncToken, MetaData, sub-total
 * lines, balances from linked payments), the query language, and the writes
 * with QuickBooks' validation. HTTP framing lives in index.ts.
 */
import type { JsonObject, JsonValue } from "../../../../src/contracts/json.js";
import { dateInZone, type FakeClock, isoInZone } from "../core/clock.js";
import type { QuickBooksFixture } from "../fixtures.js";
import {
  businessRule,
  invalidReference,
  notFound,
  QboFault,
  requiredMissing,
  unsupportedProperty,
} from "./fault.js";
import { fieldValue, matches, parseQuery, QueryError, sortEntities } from "./query.js";

export type Entity = Record<string, JsonValue>;
export type EntityName = "Customer" | "Invoice" | "Payment" | "Item" | "Term" | "CompanyInfo";

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

/** An invoice e-mailed through POST /invoice/{id}/send. */
export interface SentInvoice {
  readonly invoiceId: string;
  readonly docNumber: string;
  readonly to: string;
  readonly at: string;
}

export class QuickBooksCompany {
  readonly realmId: string;
  readonly timezone: string;
  /** Invoices sent by email: which invoice, to whom, when. */
  readonly sentInvoices: SentInvoice[] = [];
  readonly companyInfo: Entity;
  private readonly clock: FakeClock;
  private readonly pageCap: number;
  private readonly entities: Record<Exclude<EntityName, "CompanyInfo">, Map<string, Entity>> = {
    Customer: new Map(),
    Invoice: new Map(),
    Payment: new Map(),
    Item: new Map(),
    Term: new Map(),
  };
  private nextDocNumber: number;
  private readonly nextId: Record<"Customer" | "Invoice" | "Payment", number>;

  constructor(fixture: QuickBooksFixture, clock: FakeClock, queryPageCap?: number) {
    this.realmId = fixture.realmId;
    this.timezone = fixture.timezone;
    this.clock = clock;
    this.pageCap = queryPageCap ?? fixture.queryPageCap;
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
  }

  /** The fake clock's current instant. */
  now(): Date {
    return this.clock.now();
  }

  /** Company time with its offset, as QuickBooks writes `time` and MetaData. */
  time(): string {
    return isoInZone(this.clock.now(), this.timezone);
  }

  today(): string {
    return dateInZone(this.clock.now(), this.timezone);
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

  // --- Reads ------------------------------------------------------------------

  get(name: Exclude<EntityName, "CompanyInfo">, id: string | undefined): Entity {
    const entity = id === undefined ? undefined : this.entities[name].get(id);
    if (entity === undefined) throw notFound();
    return entity;
  }

  query(text: string): JsonObject {
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

  saveCustomer(body: JsonObject): Entity {
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

  saveInvoice(body: JsonObject): Entity {
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

  voidInvoice(body: JsonObject): Entity {
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

  sendInvoice(id: string, sendTo: string | null): Entity {
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

  createPayment(body: JsonObject): Entity {
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
    // Without an ItemRef QuickBooks uses the company's default "Services" item.
    const item =
      detail.ItemRef === undefined
        ? this.defaultItem(index)
        : this.reference("Item", detail.ItemRef);
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

  private defaultItem(index: number): Entity {
    const item = [...this.entities.Item.values()].find((entity) => entity.Name === "Services");
    if (item === undefined) throw requiredMissing(`Line[${index}].SalesItemLineDetail.ItemRef`);
    return item;
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
