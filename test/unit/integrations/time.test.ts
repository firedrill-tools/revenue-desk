import { describe, expect, it } from "vitest";
import { cardTime, zonedFromUnix, zonedIso } from "../../../src/integrations/shared/time.js";

// 2026-09-22T13:00:12Z, as Stripe returns it (Unix seconds).
const SECONDS = 1_790_082_012;

describe("timestamps in the workspace time zone", () => {
  it("writes an instant with the zone's offset, across daylight saving", () => {
    expect(zonedFromUnix(SECONDS, "America/New_York")).toBe("2026-09-22T09:00:12-04:00");
    expect(zonedIso(Date.UTC(2026, 11, 1, 13, 0, 0), "America/New_York")).toBe(
      "2026-12-01T08:00:00-05:00",
    );
    expect(zonedFromUnix(SECONDS, "Asia/Kolkata")).toBe("2026-09-22T18:30:12+05:30");
    expect(zonedFromUnix(SECONDS, "UTC")).toBe("2026-09-22T13:00:12+00:00");
    // The local date is the business date: 02:00Z is still the evening before in New York.
    expect(zonedIso(Date.UTC(2026, 8, 1, 2, 0, 0), "America/New_York")).toBe(
      "2026-08-31T22:00:00-04:00",
    );
  });

  it("keeps milliseconds when an instant has them, and midnight as 00", () => {
    expect(zonedIso(Date.UTC(2026, 8, 22, 4, 0, 0, 250), "America/New_York")).toBe(
      "2026-09-22T00:00:00.250-04:00",
    );
  });

  it("stays UTC without a usable zone", () => {
    expect(zonedFromUnix(SECONDS, undefined)).toBe("2026-09-22T13:00:12.000Z");
    expect(zonedFromUnix(SECONDS, "Not/AZone")).toBe("2026-09-22T13:00:12.000Z");
    expect(zonedFromUnix(undefined, "America/New_York")).toBeUndefined();
  });

  it("shows a card time as date, clock time and zone", () => {
    expect(cardTime("2026-09-22T09:04:37-04:00")).toBe("2026-09-22 09:04 UTC-04:00");
    expect(cardTime("2026-09-22T13:04:37.000Z")).toBe("2026-09-22 13:04 UTC");
    expect(cardTime("yesterday")).toBe("yesterday");
  });
});
