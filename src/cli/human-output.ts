// What a person sees while `revenue-desk ask` runs: the reply streams to
// stdout; connection notes, tool activity, retries and the final status line
// go to stderr. With --json the reply is left to the summary and only the
// stderr lines are written.

import { ASK_FLAGS, type RunSummary } from "../contracts/cli.js";
import type { AgentEvent, StatusData } from "../contracts/events.js";
import {
  type ActionClass,
  type ApprovalMode,
  type ConnectionKind,
  type ConnectionState,
  HEADLESS_ASK_DENIAL,
  INTEGRATIONS,
} from "../contracts/integration.js";
import type { OutputStream } from "./stdout-guard.js";

export type ProgressOptions = {
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  /** Applied to every text that did not originate in the CLI. */
  readonly redact: (text: string) => string;
  /** True in human mode: text deltas stream to stdout. */
  readonly streamReply: boolean;
};

const KIND_LABEL = {
  composio: "Composio",
  mcp: "MCP",
  api: "API",
} as const satisfies Record<ConnectionKind, string>;

const STATE_LABEL = {
  connected: "connected",
  needs_auth: "needs sign-in",
  expired: "sign-in expired",
  not_configured: "not configured",
  invalid: "invalid configuration",
  error: "error",
  unknown: "not checked",
} as const satisfies Record<ConnectionState, string>;

const DECISION_LABEL = {
  denied: "denied",
  policy_denied: "blocked by policy",
  timed_out: "approval timed out",
  stopped: "stopped",
  rejected: "rejected",
} as const;

type ToolLabel = { readonly title: string; readonly actionClass: ActionClass | null };

export class ProgressPrinter {
  readonly #options: ProgressOptions;
  readonly #tools = new Map<string, ToolLabel>();
  readonly #needsApproval: ToolLabel[] = [];
  #wroteReply = false;
  #stdoutMidLine = false;
  #stderrMidLine = false;

  constructor(options: ProgressOptions) {
    this.#options = options;
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case "run.started": {
        const unavailable = event.connections
          .filter((connection) => connection.availability === "unavailable")
          .map(
            (connection) =>
              `${INTEGRATIONS[connection.integration].label} (${STATE_LABEL[connection.state]})`,
          );
        if (unavailable.length > 0) this.#line(`Not available this run: ${unavailable.join(", ")}`);
        return;
      }
      case "status":
        this.#status(event.status);
        return;
      case "reasoning.start":
        this.#stderr("Thinking: ");
        return;
      case "reasoning.delta":
        this.#stderr(this.#clean(event.delta));
        return;
      case "reasoning.end":
        this.#endStderrLine();
        return;
      case "text.start":
        if (this.#options.streamReply && this.#wroteReply) {
          this.#stdout(this.#stdoutMidLine ? "\n\n" : "\n");
        }
        return;
      case "text.delta":
        if (this.#options.streamReply) {
          this.#stdout(event.delta);
          this.#wroteReply = true;
        }
        return;
      case "tool.input.available": {
        const label = {
          title: this.#clean(event.title),
          actionClass: event.tool?.actionClass ?? null,
        };
        this.#tools.set(event.toolCallId, label);
        const kind = event.tool === null ? "" : ` [${KIND_LABEL[event.tool.connectionKind]}]`;
        this.#line(`> ${label.title}${kind}`);
        return;
      }
      case "tool.output": {
        const title = this.#titleOf(event.toolCallId);
        if (event.isError) {
          const reason = event.error?.message ?? "the tool reported an error";
          this.#line(`  ${title}: failed: ${this.#clean(reason)}`);
        } else {
          this.#line(`  ${title}: done in ${formatDuration(event.durationMs)}`);
        }
        return;
      }
      case "tool.denied": {
        const label = this.#tools.get(event.toolCallId);
        const title = label?.title ?? event.toolCallId;
        this.#line(`  ${title}: ${DECISION_LABEL[event.decision]}: ${this.#clean(event.reason)}`);
        if (event.decision === "policy_denied" && event.reason === HEADLESS_ASK_DENIAL) {
          this.#needsApproval.push(label ?? { title, actionClass: null });
        }
        return;
      }
      default:
        return;
    }
  }

  /** The end of the output: the reply if nothing streamed, then the status line. */
  finish(summary: RunSummary): void {
    if (this.#options.streamReply) {
      if (!this.#wroteReply && summary.reply !== null && summary.reply !== "") {
        this.#stdout(summary.reply);
        this.#wroteReply = true;
      }
      if (this.#stdoutMidLine) this.#stdout("\n");
    }
    this.#line(statusLine(summary, this.#clean.bind(this)));
    const hint = approvalHint(this.#needsApproval);
    if (hint !== null) this.#line(hint);
  }

  #status(status: StatusData): void {
    if (status.phase === "compacting") this.#line("Compacting the conversation…");
    if (status.phase !== "retrying") return;
    const http = status.errorStatus === null ? "" : ` (HTTP ${status.errorStatus})`;
    this.#line(
      `Model busy${http}, retrying ${status.attempt}/${status.maxAttempts} in ${formatDuration(status.retryInMs)}`,
    );
  }

  #titleOf(toolCallId: string): string {
    return this.#tools.get(toolCallId)?.title ?? toolCallId;
  }

  #clean(text: string): string {
    return this.#options.redact(text);
  }

  #stdout(text: string): void {
    if (text === "") return;
    this.#options.stdout.write(text);
    this.#stdoutMidLine = !text.endsWith("\n");
  }

  #stderr(text: string): void {
    if (text === "") return;
    this.#breakSharedTerminalLine();
    this.#options.stderr.write(text);
    this.#stderrMidLine = !text.endsWith("\n");
  }

  #endStderrLine(): void {
    if (this.#stderrMidLine) this.#stderr("\n");
  }

  #line(text: string): void {
    this.#endStderrLine();
    this.#stderr(`${text}\n`);
  }

  /**
   * When stdout and stderr are one terminal, a status line written while the
   * reply is mid-line would be glued to it; start it on a fresh line instead.
   */
  #breakSharedTerminalLine(): void {
    const { stdout, stderr } = this.#options;
    if (!this.#stdoutMidLine || !stdout.isTTY || !stderr.isTTY) return;
    stderr.write("\n");
    this.#stdoutMidLine = false;
  }
}

function statusLine(summary: RunSummary, clean: (text: string) => string): string {
  const message = summary.error === null ? null : clean(summary.error.message);
  switch (summary.status) {
    case "completed": {
      const calls = summary.toolCalls.length;
      const parts = [
        `Done in ${formatDuration(runDuration(summary))}`,
        `${calls} tool call${calls === 1 ? "" : "s"}`,
      ];
      if (summary.usage !== null) parts.push(`$${summary.usage.costUsd.toFixed(4)}`);
      return parts.join(" · ");
    }
    case "failed":
      return `Failed (${summary.error?.code ?? "internal"}): ${message ?? "the run failed"}`;
    case "cancelled":
      return `Cancelled: ${message ?? "the run was stopped"}`;
    case "timed_out":
      return `Timed out: ${message ?? "the run reached its time limit"}`;
  }
}

function approvalHint(labels: readonly ToolLabel[]): string | null {
  if (labels.length === 0) return null;
  const classes = [...new Set(labels.flatMap((label) => label.actionClass ?? []))];
  const policy: { [C in ActionClass]?: ApprovalMode } = {};
  for (const actionClass of classes) policy[actionClass] = "auto";
  const titles = labels.map((label) => label.title).join("; ");
  const allow =
    classes.length === 0
      ? ""
      : ` To allow ${classes.join(" and ")} actions for one run, pass ${ASK_FLAGS.policy} '${JSON.stringify(policy)}'.`;
  return `Not run because they need approval, which the CLI cannot ask for: ${titles}.${allow}`;
}

function runDuration(summary: RunSummary): number {
  if (summary.usage !== null) return summary.usage.durationMs;
  return Math.max(0, Date.parse(summary.finishedAt) - Date.parse(summary.startedAt));
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1_000).toFixed(1)} s`;
}
