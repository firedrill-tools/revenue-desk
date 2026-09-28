// Conversation titles (docs/ARCHITECTURE.md §9): the rail shows one short
// line per conversation.
//
// - A title the client sends (a chat started from a suggestion sends the
//   suggestion's title with POST /api/conversations) is kept as given, with
//   its whitespace collapsed.
// - Otherwise the first user message names the conversation: its first
//   sentence, at most about 60 characters, shortened at a word boundary with
//   an ellipsis after the last whole word, never inside a word.
// The server and the CLI name conversations the same way.

/** The longest title derived from a message, ellipsis included. */
export const MAX_DERIVED_TITLE = 60;

/** A client's title with runs of whitespace (newlines included) collapsed to one space. */
export function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

/** Leading Markdown that is not part of the words: headings, quotes, list markers. */
const LEADING_MARKUP = /^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/;

/**
 * The end of the first sentence: . ! or ? followed by the end of the text,
 * or by a space and a capital, digit or quote. "Inc. for", "e.g. the" and
 * "$490.00" do not end a sentence.
 */
const SENTENCE_END = /[.!?](?=$|\s+["'“‘(]?[\p{Lu}\p{N}])/u;

/** A concise title from the first user message; "" when it has no words. */
export function titleFromMessage(message: string): string {
  const firstLine =
    message
      .split(/\r?\n/)
      .map((line) => normalizeTitle(line.replace(LEADING_MARKUP, "")))
      .find((line) => line !== "") ?? "";
  const end = SENTENCE_END.exec(firstLine);
  let sentence = end === null ? firstLine : firstLine.slice(0, end.index + 1);
  // A statement drops its full stop; a question or exclamation keeps its mark.
  if (sentence.endsWith(".") && !sentence.endsWith("...")) sentence = sentence.slice(0, -1);
  return shorten(sentence.trim(), MAX_DERIVED_TITLE);
}

/** At most `max` characters: whole words, then "…". */
function shorten(text: string, max: number): string {
  const characters = [...text];
  if (characters.length <= max) return text;
  const room = characters.slice(0, max - 1).join("");
  const endsOnWord = /\s/.test(characters[max - 1] ?? " ");
  const boundary = room.search(/\s\S*$/);
  // One word longer than the limit (a URL, an id) can only be cut.
  const kept = endsOnWord || boundary <= 0 ? room : room.slice(0, boundary);
  return `${kept.replace(/[\s,;:.!?\-–—(]+$/u, "")}…`;
}
