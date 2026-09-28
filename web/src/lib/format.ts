// Number, time and size formatting for the UI. Money in the approval facts is
// already formatted by the server; these helpers cover model cost, tokens,
// durations and timestamps. All output uses tabular-friendly forms.
//
// Alias-free and DOM-free so the Node test suite can import it.

const LOCALE = "en-US";

/** 842 ms, 4.2 s, 1 min 04 s, 1 h 02 min. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.floor(ms / 1_000)} s`;
  const totalSeconds = Math.floor(ms / 1_000);
  if (totalSeconds < 3_600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes} min ${String(seconds).padStart(2, "0")} s`;
  }
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  return `${hours} h ${String(minutes).padStart(2, "0")} min`;
}

/** Live elapsed time for running work: whole seconds, then minutes. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Model cost in USD: $0.042 → "$0.04"; tiny non-zero costs → "<$0.01". */
export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return "";
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(usd);
}

/** 950 → "950", 12_400 → "12.4k", 1_250_000 → "1.3M". */
export function formatTokens(count: number | null | undefined): string {
  if (count === null || count === undefined || !Number.isFinite(count)) return "";
  if (count < 1_000) return String(Math.round(count));
  return new Intl.NumberFormat(LOCALE, {
    notation: "compact",
    maximumFractionDigits: 1,
  })
    .format(count)
    .toLowerCase()
    .replace("m", "M");
}

/** Exact integer with grouping, for tables: 12,408. */
export function formatCount(count: number): string {
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(count);
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "just now", "4 min ago", "3 h ago", "Yesterday", "Sep 12", "Sep 12, 2025". */
export function formatRelativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const then = new Date(iso);
  const time = then.getTime();
  if (Number.isNaN(time)) return "";
  const diff = now.getTime() - time;
  if (diff < 45_000) return "just now";
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} min ago`;
  const dayDiff = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
  if (dayDiff === 0) return `${Math.round(diff / 3_600_000)} h ago`;
  if (dayDiff === 1) return "Yesterday";
  const sameYear = then.getFullYear() === now.getFullYear();
  return then.toLocaleDateString(LOCALE, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** "Sep 28, 2026, 14:05:09" in the viewer's time zone. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(LOCALE, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Milliseconds until `iso`, never negative; null when unparseable. */
export function msUntil(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return null;
  return Math.max(0, time - now);
}

/** "14:52" for a countdown. */
export function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The start of an id for dense tables: "run_8f2c1a…". */
export function shortId(id: string, length = 8): string {
  return id.length <= length + 1 ? id : `${id.slice(0, length)}…`;
}

/** Joins with commas and "and": "Gmail, Stripe and HubSpot". */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

const RECORD_ID = /^[A-Za-z][A-Za-z0-9]{0,7}_[A-Za-z0-9_]{6,}$/;

/** A record id or a comma-separated list of them ("ch_3Q8h…", "in_1Q…, re_…"): shown in mono. */
export function looksLikeRecordIds(value: string): boolean {
  const parts = value.split(/,\s*/);
  return parts.length > 0 && parts.every((part) => RECORD_ID.test(part.trim()));
}
