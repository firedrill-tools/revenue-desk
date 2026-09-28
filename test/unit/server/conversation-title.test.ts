// Conversation titles (src/server/conversation-title.ts): a client's title is
// kept with its whitespace collapsed; otherwise the first user message gives
// its first sentence, at most about 60 characters, cut after a whole word.

import { describe, expect, it } from "vitest";
import {
  MAX_DERIVED_TITLE,
  normalizeTitle,
  titleFromMessage,
} from "../../../src/server/conversation-title.js";

describe("titleFromMessage", () => {
  it("takes the first sentence of the first line with words, whitespace collapsed", () => {
    expect(titleFromMessage("\n\n  Why was   Kestrel\tcharged twice?\nMore context")).toBe(
      "Why was Kestrel charged twice?",
    );
    expect(titleFromMessage("Chase overdue invoices. Then post to #billing.")).toBe(
      "Chase overdue invoices",
    );
    expect(titleFromMessage("Hello!! What now")).toBe("Hello!!");
    expect(titleFromMessage("## Weekly digest\nPost it to Slack")).toBe("Weekly digest");
    expect(titleFromMessage("- Refund the duplicate")).toBe("Refund the duplicate");
  });

  it("does not end a sentence at an abbreviation or inside an amount", () => {
    expect(titleFromMessage("Refund Acme Inc. for the duplicate $490.00 charge. Then post.")).toBe(
      "Refund Acme Inc. for the duplicate $490.00 charge",
    );
    expect(titleFromMessage("Check e.g. the invoices from last week")).toBe(
      "Check e.g. the invoices from last week",
    );
  });

  it("shortens after the last whole word within about 60 characters", () => {
    const title = titleFromMessage(
      "Dana Whitfield from Harbor & Pine says they were charged twice in September. Look into it.",
    );
    expect(title).toBe("Dana Whitfield from Harbor & Pine says they were charged…");
    expect([...title].length).toBeLessThanOrEqual(MAX_DERIVED_TITLE);
    // A word that ends exactly at the limit is kept whole.
    const words = "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm";
    expect(titleFromMessage(words)).toBe(
      "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll…",
    );
    // No dangling punctuation before the ellipsis.
    expect(
      titleFromMessage(
        "List overdue QuickBooks invoices, check Stripe for payments that were never recorded, and draft reminders",
      ),
    ).toBe("List overdue QuickBooks invoices, check Stripe for payments…");
  });

  it("cuts a single word longer than the limit, and is empty without words", () => {
    const url = `https://example.test/${"x".repeat(80)}`;
    const title = titleFromMessage(url);
    expect([...title]).toHaveLength(MAX_DERIVED_TITLE);
    expect(title.endsWith("…")).toBe(true);
    expect(titleFromMessage(" \n\t ")).toBe("");
  });

  it("counts characters, not UTF-16 units", () => {
    const title = titleFromMessage(`${"Überweisung 💶 ".repeat(8)}prüfen`);
    expect([...title].length).toBeLessThanOrEqual(MAX_DERIVED_TITLE);
    expect(title).not.toMatch(/\uD83D$/);
  });
});

describe("normalizeTitle", () => {
  it("collapses whitespace and newlines of a client's title", () => {
    expect(normalizeTitle("  Answer a\nbilling   inquiry ")).toBe("Answer a billing inquiry");
  });
});
