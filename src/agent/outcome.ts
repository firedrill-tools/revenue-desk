// How a run finished: its status and sanitised error, from the stop reason,
// the SDK result message, a model error message and anything thrown.

import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  FinishedRunStatus,
  RunError,
  RunStopReason,
  SdkTerminalReason,
} from "../contracts/events.js";
import type { ModelErrorInfo } from "./sdk-mapper.js";

export type RunOutcome = {
  readonly status: FinishedRunStatus;
  readonly error: RunError | null;
  /** The RunStopReason when the run's signal stopped it, otherwise null. */
  readonly stopReason: RunStopReason | null;
  readonly terminalReason: SdkTerminalReason | null;
};

const STOP_REASONS: readonly RunStopReason[] = ["user", "timeout", "shutdown"];

/** The RunStopReason a caller passed to abort(); anything else counts as a user stop. */
export function stopReasonOf(reason: unknown): RunStopReason {
  return STOP_REASONS.find((candidate) => candidate === reason) ?? "user";
}

const STOP_ERRORS: { readonly [R in RunStopReason]: RunError } = {
  user: { code: "cancelled", message: "The run was stopped." },
  shutdown: { code: "cancelled", message: "The run was stopped because Revenue Desk shut down." },
  timeout: { code: "timeout", message: "The run reached its time limit and was stopped." },
};

function resultError(result: SDKResultMessage, redact: (text: string) => string): RunError | null {
  switch (result.subtype) {
    case "success":
      return result.is_error
        ? { code: "model_error", message: redact(result.result || "The model request failed.") }
        : null;
    case "error_max_turns":
      return { code: "max_turns", message: "The run reached its turn limit before finishing." };
    case "error_max_budget_usd":
      return {
        code: "budget_exceeded",
        message: "The run reached its spending limit before finishing.",
      };
    case "error_during_execution":
    case "error_max_structured_output_retries": {
      const detail = result.errors.filter((line) => !line.startsWith("[ede_diagnostic]")).join(" ");
      return {
        code: "internal",
        message: redact(detail === "" ? "The agent stopped with an error." : detail),
      };
    }
  }
}

export function runOutcome(input: {
  readonly stopReason: RunStopReason | null;
  readonly result: SDKResultMessage | null;
  readonly modelError: ModelErrorInfo | null;
  readonly thrown: unknown;
  readonly redact: (text: string) => string;
}): RunOutcome {
  const terminalReason = input.result?.terminal_reason ?? null;
  if (input.stopReason !== null) {
    return {
      status: input.stopReason === "timeout" ? "timed_out" : "cancelled",
      error: STOP_ERRORS[input.stopReason],
      stopReason: input.stopReason,
      terminalReason,
    };
  }
  if (input.modelError !== null) {
    return {
      status: "failed",
      error: { code: "model_error", message: input.modelError.message },
      stopReason: null,
      terminalReason,
    };
  }
  if (input.result !== null) {
    const error = resultError(input.result, input.redact);
    return {
      status: error === null ? "completed" : "failed",
      error,
      stopReason: null,
      terminalReason,
    };
  }
  const thrown = input.thrown;
  const message =
    thrown === undefined
      ? "The agent ended without a result."
      : input.redact(thrown instanceof Error ? thrown.message : String(thrown));
  return {
    status: "failed",
    error: { code: "internal", message },
    stopReason: null,
    terminalReason,
  };
}
