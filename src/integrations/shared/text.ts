// Small text helpers for approval-card facts and probe details.

/** One line, whitespace collapsed, at most `max` characters with an ellipsis. */
export function preview(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** Ends a sentence with one period, even when the text already ends with one ("Inc."). */
export function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** "1 note", "3 notes"; irregular plurals pass `pluralForm`. */
export function countOf(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** "a", "a and b", "a, b and c", "a, b and 3 others". */
export function listOf(items: readonly string[], max = 3): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length <= max) return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
  const rest = items.length - max + 1;
  return `${items.slice(0, max - 1).join(", ")} and ${countOf(rest, "other")}`;
}

/** Masks an identifier for display: "ca_…c6M"; short values keep only their end. */
export function maskIdentifier(id: string): string {
  if (id.length > 8) return `${id.slice(0, 3)}…${id.slice(-3)}`;
  if (id.length > 3) return `…${id.slice(-3)}`;
  return "…";
}

/** Removes every occurrence of each secret from a message. */
export function scrub(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  return out;
}
