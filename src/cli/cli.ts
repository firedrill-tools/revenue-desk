// `revenue-desk` command dispatch: parse, then help, version or ask.

import { CLI_EXIT_CODES, CLI_NAME, type CliExitCode } from "../contracts/cli.js";
import { parseCliArgs } from "./args.js";
import { type AskContext, runAsk } from "./ask.js";
import { HELP_TEXT, USAGE_HINT } from "./usage.js";

export type CliContext = AskContext & {
  /** The package version, for --version. */
  readonly version: string;
};

export async function runCli(argv: readonly string[], context: CliContext): Promise<CliExitCode> {
  const parsed = parseCliArgs(argv);
  const { stdout, stderr } = context.io;
  if (!parsed.ok) {
    stderr.write(`${CLI_NAME}: ${parsed.message}\n${USAGE_HINT}\n`);
    return CLI_EXIT_CODES.usage;
  }
  switch (parsed.command.command) {
    case "help":
      stdout.write(HELP_TEXT);
      return CLI_EXIT_CODES.completed;
    case "version":
      stdout.write(`${context.version}\n`);
      return CLI_EXIT_CODES.completed;
    case "ask":
      return runAsk(parsed.command, context);
  }
}
