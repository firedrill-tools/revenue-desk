import { describe, expect, it } from "vitest";
import { parseGmailQuery } from "../../support/fakes/composio/gmail.js";

describe("Gmail search syntax (Composio fake)", () => {
  it("splits operators, free text, quoted phrases and negation into ANDed clauses", () => {
    expect(
      parseGmailQuery('from:dana@harborpine.test subject:"charged twice" -label:spam refund'),
    ).toEqual([
      [{ key: "from", value: "dana@harborpine.test", negated: false }],
      [{ key: "subject", value: "charged twice", negated: false }],
      [{ key: "label", value: "spam", negated: true }],
      [{ key: "", value: "refund", negated: false }],
    ]);
  });

  it("groups OR alternatives into one clause", () => {
    expect(
      parseGmailQuery("from:omar@tidewater.test OR from:theo@copperleaf.test is:unread"),
    ).toEqual([
      [
        { key: "from", value: "omar@tidewater.test", negated: false },
        { key: "from", value: "theo@copperleaf.test", negated: false },
      ],
      [{ key: "is", value: "unread", negated: false }],
    ]);
  });

  it("treats unknown operators as text and handles an empty query", () => {
    expect(parseGmailQuery("invoice:1043")).toEqual([
      [{ key: "", value: "invoice:1043", negated: false }],
    ]);
    expect(parseGmailQuery("")).toEqual([]);
  });
});
