// SecretValue (src/contracts/env.ts): a configured secret that never prints.
//
// String conversion, JSON serialisation and util.inspect all yield
// "[redacted]"; only reveal() returns the value, at the point of use (an
// HTTP header, the Claude CLI child's environment, an upstream transport).

import { inspect } from "node:util";
import type { SecretValue } from "../contracts/env.js";

export const REDACTED = "[redacted]";

class Secret implements SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
    Object.freeze(this);
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

/** Wraps a secret value. Empty values are refused: an unset secret is null, not "". */
export function secretValue(value: string): SecretValue {
  if (value.length === 0) throw new TypeError("A secret value cannot be empty.");
  return new Secret(value);
}

export function isSecretValue(value: unknown): value is SecretValue {
  return value instanceof Secret;
}
