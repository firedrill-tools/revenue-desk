// How a tool's input or output is shown: JSON pretty-printed (and
// highlighted), anything else as text. MCP results arrive as
// {content:[{type:"text", text}]}, usually with JSON inside the text.
//
// Alias-free and DOM-free so the Node test suite can import it.

export type PresentedValue = { readonly language: "json" | "text"; readonly code: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fromText(text: string): PresentedValue {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { language: "json", code: JSON.stringify(JSON.parse(trimmed), null, 2) };
    } catch {
      // Not JSON after all; show it as text.
    }
  }
  return { language: "text", code: text };
}

/** The text items of an MCP CallToolResult, or null when the value is not one. */
function mcpTexts(value: Record<string, unknown>): string[] | null {
  const content = value.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const texts: string[] = [];
  for (const item of content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return null;
    texts.push(item.text);
  }
  return texts;
}

export function presentValue(value: unknown): PresentedValue | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value === "" ? null : fromText(value);
  if (isRecord(value)) {
    const texts = mcpTexts(value);
    if (texts !== null) {
      if (texts.length === 1 && texts[0] !== undefined) return fromText(texts[0]);
      const parts = texts.map(fromText);
      if (parts.every((part) => part.language === "json")) {
        return { language: "json", code: `[\n${parts.map((part) => part.code).join(",\n")}\n]` };
      }
      return { language: "text", code: texts.join("\n\n") };
    }
  }
  const json = JSON.stringify(value, null, 2);
  return json === undefined ? null : { language: "json", code: json };
}
