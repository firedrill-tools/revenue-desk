// The environment the CLI hands to the configuration layer (docs/ARCHITECTURE.md §3).
//
// process.env is never mutated. When DOTENV_PATH names a file, its variables
// fill in whatever the environment leaves unset or empty; a non-empty value
// in the environment always wins. --state-dir becomes AGENT_STATE_DIR.
// Values are never printed: problems name the variable or the path only.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import type { EnvironmentRecord } from "./ports.js";

export type EnvironmentResult =
  | { readonly ok: true; readonly environment: EnvironmentRecord }
  | { readonly ok: false; readonly message: string };

export type EnvironmentOptions = {
  readonly cwd: string;
  /** --state-dir, resolved against cwd. */
  readonly stateDir: string | null;
  readonly readFile?: (path: string) => string;
};

export function buildEnvironment(
  base: EnvironmentRecord,
  options: EnvironmentOptions,
): EnvironmentResult {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const merged: Record<string, string | undefined> = {};

  const dotenvPath = nonEmpty(base.DOTENV_PATH);
  if (dotenvPath !== null) {
    const path = resolve(options.cwd, dotenvPath);
    let content: string;
    try {
      content = readFile(path);
    } catch (error) {
      return {
        ok: false,
        message: `DOTENV_PATH names ${path}, which could not be read (${errorCode(error)}).`,
      };
    }
    for (const [name, value] of Object.entries(parseEnv(content))) {
      if (name === "DOTENV_PATH") continue;
      merged[name] = value;
    }
  }

  for (const [name, value] of Object.entries(base)) {
    if (nonEmpty(value) !== null || merged[name] === undefined) merged[name] = value;
  }
  if (options.stateDir !== null) merged.AGENT_STATE_DIR = resolve(options.cwd, options.stateDir);
  return { ok: true, environment: merged };
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value.trim() === "" ? null : value;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    if (typeof code === "string") return code;
  }
  return "unreadable";
}
