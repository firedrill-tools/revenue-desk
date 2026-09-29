// Helpers for IntegrationDefinition.resolve(env): turning raw configuration
// into configured / not_configured / invalid without ever echoing a value.

import type { ConfigProblem, EnvVarName, SecretValue } from "../../contracts/env.js";
import { type BaseUrlOptions, checkBaseUrl } from "./url.js";

export type CheckedUrl = {
  readonly url: string;
  readonly host: string;
};

/** A validated base URL, or a problem that names the variable (never its value). */
export function checkUrlVariable(
  variable: EnvVarName,
  raw: string,
  options: BaseUrlOptions = {},
):
  | { readonly ok: true; readonly value: CheckedUrl }
  | { readonly ok: false; readonly problem: ConfigProblem } {
  const checked = checkBaseUrl(raw, options);
  if (!checked.ok)
    return { ok: false, problem: { variable, message: `${variable} ${checked.message}` } };
  return { ok: true, value: { url: checked.url, host: checked.host } };
}

/** A problem when a secret has surrounding whitespace or control characters; null when usable. */
export function secretProblem(variable: EnvVarName, secret: SecretValue): ConfigProblem | null {
  const value = secret.reveal();
  if (value.trim() === "") return { variable, message: `${variable} is empty` };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects.
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    return { variable, message: `${variable} contains whitespace or control characters` };
  }
  return null;
}

/** True when a secret is present and not blank. */
export function hasSecret(secret: SecretValue | null): secret is SecretValue {
  return secret !== null && secret.reveal().trim() !== "";
}

/** True when a plain value is present and not blank. */
export function hasValue(value: string | null): value is string {
  return value !== null && value.trim() !== "";
}
