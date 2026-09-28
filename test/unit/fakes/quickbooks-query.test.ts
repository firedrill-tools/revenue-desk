import { describe, expect, it } from "vitest";
import {
  fieldValue,
  matches,
  parseQuery,
  QueryError,
  sortEntities,
} from "../../support/fakes/quickbooks/query.js";

describe("QuickBooks query language", () => {
  it("parses SELECT with conditions, ordering and paging", () => {
    expect(
      parseQuery(
        "select * from Invoice where Balance > '0' and DueDate < '2026-09-28' orderby DueDate desc, DocNumber startposition 3 maxresults 50",
      ),
    ).toEqual({
      entity: "Invoice",
      select: "*",
      where: [
        { field: "Balance", operator: ">", values: ["0"] },
        { field: "DueDate", operator: "<", values: ["2026-09-28"] },
      ],
      orderBy: [
        { field: "DueDate", descending: true },
        { field: "DocNumber", descending: false },
      ],
      startPosition: 3,
      maxResults: 50,
    });
  });

  it("parses COUNT(*), field lists, IN, LIKE, numbers, booleans and escaped quotes", () => {
    expect(parseQuery("SELECT COUNT(*) FROM Customer").select).toBe("count");
    expect(parseQuery("SELECT Id, DisplayName FROM Customer").select).toEqual([
      "Id",
      "DisplayName",
    ]);
    expect(
      parseQuery(
        "SELECT * FROM Customer WHERE Id IN ('58', '61') AND Active = true AND Balance >= 10.5",
      ).where,
    ).toEqual([
      { field: "Id", operator: "IN", values: ["58", "61"] },
      { field: "Active", operator: "=", values: [true] },
      { field: "Balance", operator: ">=", values: [10.5] },
    ]);
    expect(
      parseQuery("SELECT * FROM Customer WHERE DisplayName LIKE 'Harbor\\'s%'").where[0],
    ).toEqual({
      field: "DisplayName",
      operator: "LIKE",
      values: ["Harbor's%"],
    });
  });

  it("reports parse errors as 4000 and refuses OR and oversized pages", () => {
    const expectCode = (query: string, code: "4000" | "4001") => {
      try {
        parseQuery(query);
        expect.fail(`parsed: ${query}`);
      } catch (error) {
        expect(error).toBeInstanceOf(QueryError);
        expect((error as QueryError).code).toBe(code);
      }
    };
    expectCode("SELECT FROM Invoice", "4000");
    expectCode("SELECT * FROM Invoice WHERE Balance >", "4000");
    expectCode("SELECT * FROM Invoice WHERE Balance > '0' OR DocNumber = '1'", "4000");
    expectCode("SELECT * FROM Invoice WHERE DocNumber = 'open", "4000");
    expectCode("SELECT * FROM Invoice MAXRESULTS 1001", "4001");
  });

  it("evaluates refs by value, emails by Address, text case-insensitively", () => {
    const invoice = {
      Id: "143",
      DocNumber: "1043",
      Balance: 3600,
      DueDate: "2026-07-20",
      CustomerRef: { value: "61", name: "Copperleaf Studios" },
    };
    const customer = {
      Id: "58",
      DisplayName: "Harbor & Pine Outfitters",
      PrimaryEmailAddr: { Address: "dana@harborpine.test" },
    };
    expect(fieldValue(invoice, "customerref")).toBe("61");
    expect(fieldValue(customer, "PrimaryEmailAddr")).toBe("dana@harborpine.test");
    expect(
      matches(
        invoice,
        parseQuery(
          "SELECT * FROM Invoice WHERE CustomerRef = '61' AND Balance > '0' AND DueDate < '2026-09-28'",
        ).where,
      ),
    ).toBe(true);
    expect(
      matches(invoice, parseQuery("SELECT * FROM Invoice WHERE DueDate > '2026-09-28'").where),
    ).toBe(false);
    expect(
      matches(
        customer,
        parseQuery("SELECT * FROM Customer WHERE DisplayName = 'harbor & pine outfitters'").where,
      ),
    ).toBe(true);
    expect(
      matches(customer, parseQuery("SELECT * FROM Customer WHERE DisplayName LIKE '%pine%'").where),
    ).toBe(true);
  });

  it("sorts by fields, then by numeric Id", () => {
    const rows = [
      { Id: "10", DueDate: "2026-08-25" },
      { Id: "9", DueDate: "2026-07-20" },
      { Id: "2", DueDate: "2026-08-25" },
    ];
    expect(
      sortEntities(rows, [{ field: "DueDate", descending: false }]).map((row) => row.Id),
    ).toEqual(["9", "2", "10"]);
    expect(sortEntities(rows, []).map((row) => row.Id)).toEqual(["2", "9", "10"]);
  });
});
