// Help text for `revenue-desk --help` (src/contracts/cli.ts).

import { ASK_FLAGS, CLI_EXIT_CODES, CLI_NAME } from "../contracts/cli.js";
import { EFFORT_LEVELS, ENV_DEFAULTS } from "../contracts/env.js";

const OPTIONS: readonly (readonly [flag: string, meaning: string])[] = [
  [ASK_FLAGS.json, "Print one run summary as JSON on stdout (progress goes to stderr)"],
  [`${ASK_FLAGS.conversation} <id>`, "Continue a conversation; its session is resumed"],
  [`${ASK_FLAGS.policy} <json>`, `Approval modes for this run, e.g. '{"financial":"auto"}'`],
  [
    `${ASK_FLAGS.model} <id>`,
    `Model id (default: Settings, AGENT_MODEL, ${ENV_DEFAULTS.AGENT_MODEL})`,
  ],
  [
    `${ASK_FLAGS.effort} <level>`,
    `${EFFORT_LEVELS.join(", ")} (default: Settings, AGENT_EFFORT, ${ENV_DEFAULTS.AGENT_EFFORT})`,
  ],
  [`${ASK_FLAGS.maxTurns} <n>`, "Turn limit for this run"],
  [`${ASK_FLAGS.maxBudgetUsd} <usd>`, "Spend limit for this run in USD"],
  [`${ASK_FLAGS.timeoutMs} <ms>`, "Stop the run after this many milliseconds"],
  [
    `${ASK_FLAGS.stateDir} <path>`,
    "State directory for this invocation (overrides AGENT_STATE_DIR)",
  ],
  ["-h, --help", "Show this help"],
  ["--version", "Print the version"],
];

function optionLines(): string {
  const width = Math.max(...OPTIONS.map(([flag]) => flag.length)) + 2;
  return OPTIONS.map(([flag, meaning]) => `  ${flag.padEnd(width)}${meaning}`).join("\n");
}

const EXIT_CODES: readonly (readonly [code: number, meaning: string])[] = [
  [CLI_EXIT_CODES.completed, "completed"],
  [CLI_EXIT_CODES.failed, "failed (model error, turn or budget limit, internal error)"],
  [CLI_EXIT_CODES.usage, "usage error; nothing ran"],
  [CLI_EXIT_CODES.config, "configuration error; nothing ran"],
  [CLI_EXIT_CODES.timedOut, "timed out (--timeout-ms)"],
  [CLI_EXIT_CODES.cancelled, "cancelled (SIGINT or SIGTERM)"],
];

function exitCodeLines(): string {
  return EXIT_CODES.map(([code, meaning]) => `  ${String(code).padEnd(5)}${meaning}`).join("\n");
}

export const HELP_TEXT = `Usage: ${CLI_NAME} ask [options] <prompt>
       ${CLI_NAME} ask [options] -        read the prompt from stdin
       ${CLI_NAME} --help | --version

Runs one turn of Revenue Desk without the app, against the same state
directory and database as the server. Nothing waits for a person: an action
whose approval mode is "ask" is denied unless --policy or AGENT_POLICY sets
its class to "auto". The reply streams to stdout; tool activity and the final
status go to stderr.

Options:
${optionLines()}

Exit codes:
${exitCodeLines()}
`;

export const USAGE_HINT = `Run '${CLI_NAME} --help' for usage.`;
