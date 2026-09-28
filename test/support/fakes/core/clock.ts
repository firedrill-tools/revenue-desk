/**
 * The business clock shared by every fake. Fixtures are dated: the fakes
 * start at the fixture's `asOf` instant, so created records, Slack
 * timestamps and QuickBooks `time` fields agree across systems.
 *
 * - `fixed` (tests): time stands still unless a test calls set() or advance().
 * - `running` (the sandbox demo): time starts at the fixture instant and
 *   moves with the wall clock.
 */

export type ClockMode = "fixed" | "running";

export interface FakeClock {
  now(): Date;
  /** Unix seconds (Stripe, Slack). */
  unix(): number;
  set(iso: string): void;
  advance(ms: number): void;
}

export function createClock(startIso: string, mode: ClockMode = "fixed"): FakeClock {
  let base = parseInstant(startIso);
  let anchor = performance.now();
  const elapsed = () => (mode === "running" ? performance.now() - anchor : 0);
  const now = () => new Date(base + elapsed());
  return {
    now,
    unix: () => Math.floor(now().getTime() / 1000),
    set(iso) {
      base = parseInstant(iso);
      anchor = performance.now();
    },
    advance(ms) {
      base += ms;
    },
  };
}

function parseInstant(iso: string): number {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) throw new Error(`Not an ISO instant: ${iso}`);
  return value;
}

/** Unix seconds of an ISO instant. */
export function unixOf(iso: string): number {
  return Math.floor(parseInstant(iso) / 1000);
}

/**
 * The wall time of an instant in an IANA time zone as an ISO string with
 * its offset, e.g. `2026-09-28T09:00:00.000-04:00` (QuickBooks style).
 */
export function isoInZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "00";
  const wall = Date.UTC(
    Number(part("year")),
    Number(part("month")) - 1,
    Number(part("day")),
    Number(part("hour")),
    Number(part("minute")),
    Number(part("second")),
  );
  const offsetMinutes = Math.round(
    (wall - (instant.getTime() - instant.getMilliseconds())) / 60_000,
  );
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  const ms = String(instant.getMilliseconds()).padStart(3, "0");
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}.${ms}${offset}`;
}

/** The calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function dateInZone(instant: Date, timeZone: string): string {
  return isoInZone(instant, timeZone).slice(0, 10);
}

/**
 * An instant from a date-time string: one with `Z` or an offset is absolute;
 * a naive `YYYY-MM-DD[T ]HH:MM[:SS]` (or a bare date) is a wall time in
 * `timeZone`. Null when the text is neither.
 */
export function instantFromLocal(text: string, timeZone: string): Date | null {
  const value = text.trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(value) && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const absolute = Date.parse(value);
    return Number.isNaN(absolute) ? null : new Date(absolute);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/.exec(
    value,
  );
  if (match === null) return null;
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  const wall = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  // The zone's offset at the guessed instant, then once more at the corrected one (DST edges).
  let instant = wall - offsetMs(new Date(wall), timeZone);
  instant = wall - offsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/** The UTC offset of a time zone at an instant, in milliseconds. */
function offsetMs(instant: Date, timeZone: string): number {
  const text = isoInZone(instant, timeZone);
  const match = /([+-])(\d{2}):(\d{2})$/.exec(text);
  if (match === null) return 0;
  const [, sign, hours, minutes] = match;
  return (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60_000;
}
