// Headless CLI contract (docs/ARCHITECTURE.md §10), workstream W6.
//
//   revenue-desk ask "Why was Kestrel charged twice?"          prints the reply
//   revenue-desk ask --json "…"                               prints a RunSummary
//   echo "…" | revenue-desk ask -                             reads the prompt from stdin
//
// The CLI runs one turn in headless mode against the same state directory as
// the server (AGENT_STATE_DIR), so CLI conversations and runs appear in the
// app with source "cli". `ask` never waits for a person: an action whose mode
// is `ask` is denied (policy_denied) unless --policy makes it auto.
//
// Shared by server, CLI and web: no Node-only globals, no implementation imports.

import type { AgentEffort } from "./env.js";
import type {
  AgentMode,
  RunConnection,
  RunError,
  RunStatus,
  RunUsage,
  SdkTerminalReason,
  ToolDecision,
} from "./events.js";
import type {
  ActionClass,
  ApprovalMode,
  ConnectionKind,
  IntegrationId,
  OperationName,
} from "./integration.js";

export const CLI_NAME = "revenue-desk";

/** Flags of `revenue-desk ask`. Unknown flags are a usage error (exit 2). */
export const ASK_FLAGS = {
  json: "--json",
  /** Continue an existing conversation (its SDK session is resumed). */
  conversation: "--conversation",
  /** JSON approval modes for this run, e.g. '{"financial":"auto"}'. Wins over AGENT_POLICY. */
  policy: "--policy",
  model: "--model",
  effort: "--effort",
  maxTurns: "--max-turns",
  maxBudgetUsd: "--max-budget-usd",
  /** Wall-clock limit; the run is stopped and ends timed_out. */
  timeoutMs: "--timeout-ms",
  /** Overrides AGENT_STATE_DIR for this invocation (isolated test runs). */
  stateDir: "--state-dir",
} as const;

/** The parsed `ask` command. Null means "not given"; the usual precedence applies. */
export type AskCommand = {
  readonly command: "ask";
  /** `-` reads the whole of stdin. */
  readonly prompt:
    | { readonly source: "argument"; readonly text: string }
    | { readonly source: "stdin" };
  readonly json: boolean;
  readonly conversationId: string | null;
  readonly policy: { readonly [C in ActionClass]?: ApprovalMode };
  readonly model: string | null;
  readonly effort: AgentEffort | null;
  readonly maxTurns: number | null;
  readonly maxBudgetUsd: number | null;
  readonly timeoutMs: number | null;
  readonly stateDir: string | null;
};

export type CliCommand =
  | AskCommand
  | { readonly command: "help" }
  | { readonly command: "version" };

/**
 * Exit codes. With --json the summary is printed for every outcome except a
 * usage error; the exit code still reports the outcome.
 */
export const CLI_EXIT_CODES = {
  completed: 0,
  /** The run failed (model error, turn or budget limit, internal error). */
  failed: 1,
  /** Bad arguments. Nothing ran; the message is on stderr. */
  usage: 2,
  /** ANTHROPIC_API_KEY missing or configuration invalid. Nothing ran. */
  config: 3,
  timedOut: 124,
  /** SIGINT or SIGTERM. */
  cancelled: 130,
} as const;

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];

/** One tool call in the summary. Inputs and outputs are left out; see the Runs screen. */
export type RunSummaryToolCall = {
  readonly toolCallId: string;
  readonly integration: IntegrationId | null;
  readonly connectionKind: ConnectionKind | null;
  /** As the model saw it. */
  readonly tool: string;
  readonly operation: OperationName | null;
  readonly actionClass: ActionClass | null;
  readonly decision: ToolDecision;
  readonly isError: boolean;
  readonly durationMs: number | null;
};

/**
 * `--json` output: exactly one JSON document on stdout, then a newline.
 * Everything else the process writes goes to stderr (stdout is guarded before
 * any module with side effects is imported).
 */
export type RunSummary = {
  readonly kind: "revenue-desk.run-summary";
  readonly version: 1;
  readonly runId: string;
  readonly conversationId: string;
  readonly mode: Extract<AgentMode, "headless">;
  readonly status: Exclude<RunStatus, "running">;
  /** The final assistant text, or null when the run produced none. */
  readonly reply: string | null;
  readonly model: string;
  readonly effort: AgentEffort;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly usage: RunUsage | null;
  readonly stopReason: string | null;
  readonly terminalReason: SdkTerminalReason | null;
  readonly error: RunError | null;
  readonly connections: readonly RunConnection[];
  readonly toolCalls: readonly RunSummaryToolCall[];
};
