// Timestamps for the model, in the workspace's time zone.
//
// Stripe returns Unix seconds, in UTC. A model that reads "2026-09-22T13:00:12Z" tends to
// tell a reader in New York "1:00 PM", or "13:00 ET". So every timestamp a
// projection returns is written in the workspace time zone with its offset,
// "2026-09-22T09:00:12-04:00": still exact ISO 8601, and its clock time is
// the one the reader expects. Without a zone, or with one Intl does not know,
// timestamps stay UTC ISO strings.

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  if (formatters.has(timeZone)) return formatters.get(timeZone) ?? null;
  let format: Intl.DateTimeFormat | null;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    format = null;
  }
  formatters.set(timeZone, format);
  return format;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * An instant (milliseconds since the epoch) as ISO 8601 in `timeZone` with
 * its UTC offset, e.g. "2026-09-22T09:00:12-04:00". Milliseconds are kept
 * only when the instant has them. UTC (`…Z`) without a usable zone.
 */
export function zonedIso(ms: number, timeZone: string | undefined): string {
  const date = new Date(ms);
  if (timeZone === undefined || timeZone.trim() === "") return date.toISOString();
  const format = formatterFor(timeZone.trim());
  if (format === null) return date.toISOString();
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const { year, month, day, hour, minute, second } = parts;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return date.toISOString();
  }
  const millis = ((ms % 1000) + 1000) % 1000;
  const wholeSeconds = ms - millis;
  const offset = Math.round(
    (Date.UTC(year, month - 1, day, hour, minute, second) - wholeSeconds) / 60_000,
  );
  const sign = offset < 0 ? "-" : "+";
  const absolute = Math.abs(offset);
  const fraction = millis === 0 ? "" : `.${pad(millis, 3)}`;
  return (
    `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}` +
    `${fraction}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

/** Unix seconds in `timeZone`; undefined when absent. */
export function zonedFromUnix(
  seconds: number | undefined,
  timeZone: string | undefined,
): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
  return zonedIso(seconds * 1000, timeZone);
}

/**
 * An ISO 8601 date-time for an approval card: "2026-09-22 09:04 UTC-04:00"
 * (or "… UTC" for Z). Anything else is returned as it is.
 */
export function cardTime(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i.exec(
    value,
  );
  if (match === null) return value;
  const [, date, time, zone] = match as unknown as [string, string, string, string];
  return `${date} ${time} ${zone.toUpperCase() === "Z" ? "UTC" : `UTC${zone}`}`;
}
