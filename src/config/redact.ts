// The redactor (docs/ARCHITECTURE.md §0 "Secrets"): scrubs every configured
// secret value and well-known token shapes from text and JSON before it is
// logged, stored, streamed or printed.
//
// Token shapes: `Bearer <8+ token characters>` (the scheme is kept), Stripe `sk_`/`rk_` keys,
// Slack `xox?-` tokens, HubSpot `pat-` private-app tokens, Composio `ak_`
// project keys and Anthropic `sk-ant-` keys. Configured values are replaced wherever they occur, longest
// first; values shorter than MIN_SECRET_LENGTH are skipped, because replacing
// a very short string would destroy ordinary text (real keys are far longer).

import type { AgentEnv } from "../contracts/env.js";
import type { JsonValue } from "../contracts/json.js";
import { configuredSecrets } from "./env.js";
import { REDACTED } from "./secret.js";

export const MIN_SECRET_LENGTH = 8;

const TOKEN_PATTERNS: readonly RegExp[] = [
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{6,}/g,
  /\b[sr]k_[A-Za-z0-9]{16,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bxox[a-z]-[A-Za-z0-9-]{6,}/g,
  /\bpat-[a-z]{2,4}\d?-[A-Za-z0-9-]{8,}/g,
  /\bak_[A-Za-z0-9_-]{16,}/g,
];
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** A text redactor that can also walk JSON. */
export interface Redactor {
  (text: string): string;
  /** A copy of `value` with every string (keys included) redacted. */
  json(value: JsonValue): JsonValue;
}

/** A redactor for explicit secret values (tests, and callers without a snapshot). */
export function createRedactorFor(secrets: readonly string[]): Redactor {
  const values = [...new Set(secrets)]
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);

  const text = (input: string): string => {
    let output = input;
    for (const secret of values) {
      if (output.includes(secret)) output = output.split(secret).join(REDACTED);
    }
    output = output.replace(BEARER, (_match, scheme: string) => `${scheme} ${REDACTED}`);
    for (const pattern of TOKEN_PATTERNS) output = output.replace(pattern, REDACTED);
    return output;
  };

  const json = (value: JsonValue): JsonValue => {
    if (typeof value === "string") return text(value);
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(json);
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) out[text(key)] = json(child);
    return out;
  };

  return Object.assign(text, { json });
}

/** The redactor for a configuration snapshot: its secrets plus the token shapes. */
export function createRedactor(env: AgentEnv): Redactor {
  return createRedactorFor(configuredSecrets(env));
}
