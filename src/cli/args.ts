// Parses `revenue-desk` arguments into a CliCommand (src/contracts/cli.ts).
// Pure: no I/O, no environment. Anything it refuses is a usage error (exit 2).

import { parseArgs } from "node:util";
import { ASK_FLAGS, type AskCommand, type CliCommand } from "../contracts/cli.js";
import { type AgentEffort, EFFORT_LEVELS } from "../contracts/env.js";
import {
  ACTION_CLASSES,
  type ActionClass,
  APPROVAL_MODES,
  type ApprovalMode,
} from "../contracts/integration.js";

export type ParseResult =
  | { readonly ok: true; readonly command: CliCommand }
  | { readonly ok: false; readonly message: string };

type AskFlag = keyof typeof ASK_FLAGS;
type OptionName<Flag extends string> = Flag extends `--${infer Name}` ? Name : never;

/** parseArgs option name (the flag without its leading dashes) of each ask flag. */
const FLAG_NAMES = {
  json: "json",
  conversation: "conversation",
  policy: "policy",
  model: "model",
  effort: "effort",
  maxTurns: "max-turns",
  maxBudgetUsd: "max-budget-usd",
  timeoutMs: "timeout-ms",
  stateDir: "state-dir",
} as const satisfies { readonly [F in AskFlag]: OptionName<(typeof ASK_FLAGS)[F]> };

const VALUE_FLAGS = [
  "conversation",
  "policy",
  "model",
  "effort",
  "maxTurns",
  "maxBudgetUsd",
  "timeoutMs",
  "stateDir",
] as const satisfies readonly Exclude<AskFlag, "json">[];

const STRING = { type: "string" } as const;

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
  [FLAG_NAMES.json]: { type: "boolean" },
  [FLAG_NAMES.conversation]: STRING,
  [FLAG_NAMES.policy]: STRING,
  [FLAG_NAMES.model]: STRING,
  [FLAG_NAMES.effort]: STRING,
  [FLAG_NAMES.maxTurns]: STRING,
  [FLAG_NAMES.maxBudgetUsd]: STRING,
  [FLAG_NAMES.timeoutMs]: STRING,
  [FLAG_NAMES.stateDir]: STRING,
} as const satisfies Record<string, { type: "boolean" | "string"; short?: string }>;

type Values = { readonly [name: string]: string | boolean | undefined };

class UsageError extends Error {}

export function parseCliArgs(argv: readonly string[]): ParseResult {
  try {
    return { ok: true, command: parseOrThrow(argv) };
  } catch (error) {
    if (error instanceof UsageError) return { ok: false, message: error.message };
    // node:util parseArgs reports unknown options and missing values as TypeErrors.
    if (error instanceof TypeError) return { ok: false, message: error.message };
    throw error;
  }
}

function parseOrThrow(argv: readonly string[]): CliCommand {
  const { values, positionals, tokens } = parseArgs({
    args: [...argv],
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
    tokens: true,
  });
  const flags: Values = values;

  if (flags.help === true) return { command: "help" };
  if (flags.version === true) return { command: "version" };

  const [command, ...rest] = positionals;
  if (command === undefined) throw new UsageError('Missing command. Try: ask "<prompt>"');
  if (command === "help" || command === "version") {
    rejectAskFlags(flags, command);
    if (rest.length > 0) throw new UsageError(`'${command}' takes no arguments.`);
    return { command };
  }
  if (command !== "ask") throw new UsageError(`Unknown command '${command}'.`);

  for (const flag of VALUE_FLAGS) {
    const name = FLAG_NAMES[flag];
    const count = tokens.filter((token) => token.kind === "option" && token.name === name).length;
    if (count > 1) throw new UsageError(`${ASK_FLAGS[flag]} was given more than once.`);
  }
  return parseAsk(flags, rest);
}

function rejectAskFlags(flags: Values, command: string): void {
  for (const flag of ["json", ...VALUE_FLAGS] as const) {
    if (flags[FLAG_NAMES[flag]] !== undefined) {
      throw new UsageError(`${ASK_FLAGS[flag]} is only valid with 'ask', not '${command}'.`);
    }
  }
}

function parseAsk(flags: Values, rest: readonly string[]): AskCommand {
  if (rest.length === 0)
    throw new UsageError("'ask' needs a prompt, or '-' to read it from stdin.");
  if (rest.length > 1) {
    throw new UsageError(`'ask' takes one prompt; quote it (got ${rest.length} arguments).`);
  }
  const text = rest[0] ?? "";
  if (text !== "-" && text.trim() === "") throw new UsageError("The prompt is empty.");

  return {
    command: "ask",
    prompt: text === "-" ? { source: "stdin" } : { source: "argument", text },
    json: flags[FLAG_NAMES.json] === true,
    conversationId: nonEmpty(flags, "conversation"),
    policy: parsePolicy(stringFlag(flags, "policy")),
    model: nonEmpty(flags, "model"),
    effort: parseEffort(stringFlag(flags, "effort")),
    maxTurns: parseInteger(flags, "maxTurns"),
    maxBudgetUsd: parseUsd(stringFlag(flags, "maxBudgetUsd")),
    timeoutMs: parseInteger(flags, "timeoutMs"),
    stateDir: nonEmpty(flags, "stateDir"),
  };
}

function stringFlag(flags: Values, flag: (typeof VALUE_FLAGS)[number]): string | null {
  const value = flags[FLAG_NAMES[flag]];
  return typeof value === "string" ? value : null;
}

function nonEmpty(flags: Values, flag: (typeof VALUE_FLAGS)[number]): string | null {
  const value = stringFlag(flags, flag);
  if (value === null) return null;
  if (value.trim() === "") throw new UsageError(`${ASK_FLAGS[flag]} needs a non-empty value.`);
  return value;
}

function parseEffort(value: string | null): AgentEffort | null {
  if (value === null) return null;
  const effort = EFFORT_LEVELS.find((level) => level === value);
  if (effort === undefined) {
    throw new UsageError(`${ASK_FLAGS.effort} must be one of ${EFFORT_LEVELS.join(", ")}.`);
  }
  return effort;
}

/** The longest delay a Node timer holds; a longer one fires at once. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

function parseInteger(flags: Values, flag: "maxTurns" | "timeoutMs"): number | null {
  const value = stringFlag(flags, flag);
  if (value === null) return null;
  const number = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new UsageError(`${ASK_FLAGS[flag]} must be a whole number of at least 1.`);
  }
  if (flag === "timeoutMs" && number > MAX_TIMEOUT_MS) {
    throw new UsageError(
      `${ASK_FLAGS.timeoutMs} must be at most ${MAX_TIMEOUT_MS} (about 24.8 days).`,
    );
  }
  return number;
}

function parseUsd(value: string | null): number | null {
  if (value === null) return null;
  const number = /^\d+(\.\d+)?$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isFinite(number) || number <= 0) {
    throw new UsageError(`${ASK_FLAGS.maxBudgetUsd} must be a positive amount in USD, e.g. 0.50.`);
  }
  return number;
}

function parsePolicy(value: string | null): AskCommand["policy"] {
  if (value === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new UsageError(`${ASK_FLAGS.policy} must be JSON, e.g. '{"financial":"auto"}'.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`${ASK_FLAGS.policy} must be a JSON object of action class to mode.`);
  }
  const policy: { [C in ActionClass]?: ApprovalMode } = {};
  for (const [key, mode] of Object.entries(parsed)) {
    const actionClass = ACTION_CLASSES.find((known) => known === key);
    if (actionClass === undefined) {
      throw new UsageError(
        `Unknown action class '${key}' in ${ASK_FLAGS.policy}; expected ${ACTION_CLASSES.join(", ")}.`,
      );
    }
    const approvalMode = APPROVAL_MODES.find((known) => known === mode);
    if (approvalMode === undefined) {
      throw new UsageError(
        `${ASK_FLAGS.policy}: '${key}' must be one of ${APPROVAL_MODES.join(", ")}.`,
      );
    }
    policy[actionClass] = approvalMode;
  }
  return policy;
}
