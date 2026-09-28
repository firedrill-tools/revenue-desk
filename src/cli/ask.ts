// `revenue-desk ask`: one headless turn against the shared state directory
// (docs/ARCHITECTURE.md §10, src/contracts/cli.ts).
//
// Order of work, so that nothing is written before it can succeed:
//   prompt -> services -> environment and configuration (exit 3 when refused)
//   -> database -> conversation (exit 2 when unknown or busy) -> policy,
//   model and connections -> conversation row -> run row -> runTurn.
// The run's events are applied to the summary, printed and recorded in
// stream order. The run always ends with exactly one run.finished: the
// core's, or one the CLI synthesises when the core fails, ends early, or
// does not finish within the grace period after a stop.

import { ExecutingWrites, WRITE_DRAIN_MS } from "../agent/executing-writes.js";
import {
  type AskCommand,
  CLI_EXIT_CODES,
  CLI_NAME,
  type CliExitCode,
  type RunSummary,
} from "../contracts/cli.js";
import {
  type AgentEffort,
  type AgentEnv,
  ENV_DEFAULTS,
  type ModelSettings,
} from "../contracts/env.js";
import type {
  AgentEvent,
  FinishedRunStatus,
  RunConnection,
  RunError,
  RunErrorCode,
  RunTurnInput,
} from "../contracts/events.js";
import { buildEnvironment } from "./environment.js";
import { isActiveRunError } from "./errors.js";
import { ProgressPrinter } from "./human-output.js";
import type { CliIo } from "./io.js";
import type { AskServices, CliWorkspace, ConversationRecord, RunRecorder } from "./ports.js";
import {
  conversationTitle,
  dateInTimeZone,
  effectivePolicy,
  modelSettings,
  plannedConnections,
} from "./run-settings.js";
import { SIGNAL_STOP_REASON, StopController } from "./stop.js";
import { exitCodeFor, type RunFinished, RunSummaryBuilder, type SummarySeed } from "./summary.js";

export type AskContext = {
  readonly io: CliIo;
  /** Loads the real (or, in tests, fake) agent core, integrations and database. */
  loadServices(): Promise<AskServices>;
  /** How long a stopped run may take to deliver its own run.finished. */
  readonly stopGraceMs: number;
  /** How long the core may take to clean up after run.finished. */
  readonly cleanupMs: number;
  readonly now: () => Date;
  readonly newId: () => string;
};

const HEADLESS_MODE = "headless";
const SOURCE = "cli";
const DEFAULT_MODEL: string = ENV_DEFAULTS.AGENT_MODEL;
const DEFAULT_EFFORT: AgentEffort = ENV_DEFAULTS.AGENT_EFFORT;

export async function runAsk(command: AskCommand, context: AskContext): Promise<CliExitCode> {
  const stopper = new StopController({ graceMs: context.stopGraceMs });
  const unsubscribe = context.io.onSignal((signal) =>
    stopper.stop({ reason: SIGNAL_STOP_REASON[signal], cause: signal }),
  );
  if (command.timeoutMs !== null) stopper.limitTo(command.timeoutMs);
  try {
    return await new AskInvocation(command, context, stopper).run();
  } finally {
    unsubscribe();
    stopper.dispose();
  }
}

/** Where a failure came from, for the synthesised run.finished. */
type Failure = { readonly source: "core" | "recorder"; readonly error: RunError };

type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

class AskInvocation {
  readonly #command: AskCommand;
  readonly #context: AskContext;
  readonly #stopper: StopController;
  readonly #runId: string;
  readonly #startedAt: string;
  #conversationId: string;
  #env: AgentEnv | null = null;
  #model: ModelSettings | null = null;
  #connections: readonly RunConnection[] = [];
  #redact: (text: string) => string = (text) => text;

  constructor(command: AskCommand, context: AskContext, stopper: StopController) {
    this.#command = command;
    this.#context = context;
    this.#stopper = stopper;
    this.#runId = context.newId();
    // The ids this invocation reserves. They exist in the database only once
    // the conversation and the run are written.
    this.#conversationId = command.conversationId ?? context.newId();
    this.#startedAt = context.now().toISOString();
  }

  async run(): Promise<CliExitCode> {
    const prompt = await this.#readPrompt();
    if (prompt === "stopped") return this.#stoppedBeforeRun();
    if (!prompt.ok) {
      return this.#failBeforeRun(
        "internal",
        `Could not read the prompt from stdin: ${messageOf(prompt.error)}`,
      );
    }
    if (prompt.value === "") return this.#usageError("The prompt is empty.");

    let services: AskServices;
    try {
      services = await this.#context.loadServices();
    } catch (error) {
      return this.#failBeforeRun(
        "internal",
        `Could not load the agent runtime: ${messageOf(error)}`,
      );
    }

    const environment = buildEnvironment(this.#context.io.environment, {
      cwd: this.#context.io.cwd,
      stateDir: this.#command.stateDir,
    });
    if (!environment.ok) return this.#configError(environment.message);

    const config = services.loadConfig(environment.environment, { cwd: this.#context.io.cwd });
    if (!config.ok) {
      const problems = config.problems.map((problem) => `${problem.variable}: ${problem.message}`);
      return this.#configError(`Invalid configuration. ${problems.join("; ")}`);
    }
    const env = config.env;
    this.#env = env;
    this.#redact = services.createRedactor(env);
    if (env.model.apiKey === null) {
      return this.#configError(
        "ANTHROPIC_API_KEY is not set. Set it in the environment or in the file named by DOTENV_PATH.",
      );
    }
    if (this.#stopper.request !== null) return this.#stoppedBeforeRun();

    let workspace: CliWorkspace;
    try {
      workspace = services.openWorkspace(env);
    } catch (error) {
      return this.#failBeforeRun(
        "internal",
        `Could not open the database in ${env.runtime.stateDir}: ${this.#messageOf(error)}`,
      );
    }
    try {
      return await this.#runIn(workspace, services, env, prompt.value);
    } finally {
      workspace.close();
    }
  }

  async #runIn(
    workspace: CliWorkspace,
    services: AskServices,
    env: AgentEnv,
    prompt: string,
  ): Promise<CliExitCode> {
    const command = this.#command;
    let conversation: ConversationRecord | null = null;
    if (command.conversationId !== null) {
      conversation = workspace.findConversation(command.conversationId);
      if (conversation === null) {
        return this.#usageError(
          `No conversation ${command.conversationId} in ${env.runtime.stateDir}.`,
        );
      }
      if (conversation.status === "running" || conversation.status === "awaiting_approval") {
        return this.#usageError(
          `Conversation ${conversation.id} already has an active run; wait for it to finish or stop it.`,
        );
      }
    }

    const settings = workspace.settings();
    const policy = effectivePolicy(
      workspace.savedPolicy(),
      env.runtime.policyOverrides,
      command.policy,
    );
    const model = modelSettings(command, settings, env);
    this.#model = model;
    const businessDate = env.runtime.businessDate ?? this.#today(settings.timezone);

    const plans = await this.#untilStopped(
      services.planConnections({ env, policy, signal: this.#stopper.signal }),
    );
    if (plans === "stopped") return this.#stoppedBeforeRun();
    if (!plans.ok) {
      return this.#failBeforeRun(
        "internal",
        `Could not check the connections: ${this.#messageOf(plans.error)}`,
      );
    }
    this.#connections = plannedConnections(plans.value);

    const now = this.#context.now().toISOString();
    conversation ??= workspace.createConversation({
      id: this.#conversationId,
      title: conversationTitle(prompt),
      createdAt: now,
    });
    this.#conversationId = conversation.id;

    const input: RunTurnInput = {
      mode: HEADLESS_MODE,
      runId: this.#runId,
      conversationId: conversation.id,
      source: SOURCE,
      prompt,
      resumeSessionId: conversation.sdkSessionId,
      env,
      model,
      settings,
      policy,
      businessDate,
      connections: plans.value,
      signal: this.#stopper.signal,
    };
    let recorder: RunRecorder;
    try {
      recorder = await workspace.beginRun(input);
    } catch (error) {
      // Another run of this conversation started first (the app, another CLI): nothing ran.
      if (isActiveRunError(error)) return this.#usageError(error.message);
      return this.#failBeforeRun("internal", `Could not start the run: ${this.#messageOf(error)}`);
    }

    const seed: SummarySeed = {
      runId: this.#runId,
      conversationId: conversation.id,
      model: model.model,
      effort: model.effort,
      startedAt: now,
      connections: this.#connections,
    };
    return this.#consume(services.runTurn(input), recorder, seed);
  }

  async #consume(
    events: AsyncIterable<AgentEvent>,
    recorder: RunRecorder,
    seed: SummarySeed,
  ): Promise<CliExitCode> {
    const { io } = this.#context;
    const builder = new RunSummaryBuilder(seed);
    const printer = new ProgressPrinter({
      stdout: io.stdout,
      stderr: io.stderr,
      redact: this.#redact,
      streamReply: !this.#command.json,
    });
    const iterator = events[Symbol.asyncIterator]();
    // A stop waits for a write that is executing: its answer is the record of what happened.
    const writes = new ExecutingWrites();
    this.#stopper.holdWhile(
      () => writes.count > 0,
      WRITE_DRAIN_MS,
      () =>
        this.#note(
          `Waiting for ${writes.titles().join(", ")} to finish: it was already sent and may be applied. Press Ctrl-C again to stop waiting.`,
        ),
    );
    const forced = this.#stopper.forced.then(() => "forced" as const);
    let failure: Failure | null = null;

    for (;;) {
      let step: IteratorResult<AgentEvent> | "forced";
      try {
        const next = iterator.next();
        // Abandoned when the stop is forced; its later rejection must not surface.
        next.catch(() => undefined);
        step = await Promise.race([next, forced]);
      } catch (error) {
        failure = { source: "core", error: this.#internal("The agent failed", error) };
        break;
      }
      if (step === "forced" || step.done === true) break;

      const event = step.value;
      writes.apply(event);
      builder.apply(event);
      printer.handle(event);
      try {
        await recorder.record(event);
      } catch (error) {
        failure = { source: "recorder", error: this.#internal("Could not record the run", error) };
        // Stop the core's work too; the run ends failed, not cancelled.
        this.#stopper.stop({ reason: "shutdown", cause: "a recording failure" });
        break;
      }
      if (event.type === "run.finished") break;
    }

    if (builder.finished === null) {
      const finished = this.#synthesisedFinish(failure);
      builder.apply(finished);
      printer.handle(finished);
      if (failure?.source !== "recorder") {
        try {
          await recorder.record(finished);
        } catch (error) {
          this.#note(`Could not record the end of the run: ${this.#messageOf(error)}`);
        }
      }
      void closeQuietly(iterator);
    } else {
      await withinMs(closeQuietly(iterator), this.#context.cleanupMs);
    }

    const summary = builder.build();
    if (this.#command.json) this.#printSummary(summary);
    printer.finish(summary);
    return exitCodeFor(summary);
  }

  /** The run.finished for a run the core did not finish. */
  #synthesisedFinish(failure: Failure | null): RunFinished {
    const request = this.#stopper.request;
    // A recording failure always fails the run; a core failure after a stop
    // request is the stop taking effect.
    if (failure !== null && (failure.source === "recorder" || request === null)) {
      return this.#finished("failed", failure.error);
    }
    if (request !== null) {
      const timedOut = request.reason === "timeout";
      return this.#finished(timedOut ? "timed_out" : "cancelled", {
        code: timedOut ? "timeout" : "cancelled",
        message: `Stopped by ${request.cause}; the agent did not confirm the stop in time.`,
      });
    }
    return this.#finished("failed", {
      code: "internal",
      message: "The agent ended without a result.",
    });
  }

  #finished(status: FinishedRunStatus, error: RunError): RunFinished {
    return {
      type: "run.finished",
      status,
      finishedAt: this.#context.now().toISOString(),
      stopReason: null,
      terminalReason: null,
      reply: null,
      error: { code: error.code, message: this.#redact(error.message) },
    };
  }

  // -------------------------------------------------------------------------
  // Endings before the run starts. Nothing was recorded; with --json the
  // summary still describes the outcome (a usage error prints none).
  // -------------------------------------------------------------------------

  #usageError(message: string): CliExitCode {
    this.#note(message);
    return CLI_EXIT_CODES.usage;
  }

  #configError(message: string): CliExitCode {
    return this.#endBeforeRun("failed", { code: "config_missing", message });
  }

  #failBeforeRun(code: RunErrorCode, message: string): CliExitCode {
    return this.#endBeforeRun("failed", { code, message });
  }

  #stoppedBeforeRun(): CliExitCode {
    const request = this.#stopper.request;
    const timedOut = request?.reason === "timeout";
    return this.#endBeforeRun(timedOut ? "timed_out" : "cancelled", {
      code: timedOut ? "timeout" : "cancelled",
      message: `Stopped by ${request?.cause ?? "a signal"} before the run started.`,
    });
  }

  #endBeforeRun(status: FinishedRunStatus, error: RunError): CliExitCode {
    const finished = this.#finished(status, error);
    this.#note(finished.error?.message ?? status);
    if (this.#command.json) {
      const builder = new RunSummaryBuilder({
        runId: this.#runId,
        conversationId: this.#conversationId,
        model: this.#model?.model ?? this.#command.model ?? this.#env?.model.model ?? DEFAULT_MODEL,
        effort:
          this.#model?.effort ?? this.#command.effort ?? this.#env?.model.effort ?? DEFAULT_EFFORT,
        startedAt: this.#startedAt,
        connections: this.#connections,
      });
      builder.apply(finished);
      this.#printSummary(builder.build());
    }
    return exitCodeFor(finished);
  }

  // -------------------------------------------------------------------------

  /** The prompt without surrounding whitespace. */
  async #readPrompt(): Promise<Settled<string> | "stopped"> {
    const { prompt } = this.#command;
    if (prompt.source === "argument") return { ok: true, value: prompt.text.trim() };
    const read = await this.#untilStopped(this.#context.io.readStdin());
    return read === "stopped" || !read.ok ? read : { ok: true, value: read.value.trim() };
  }

  /** Races a step before the run against a stop request. */
  async #untilStopped<T>(promise: Promise<T>): Promise<Settled<T> | "stopped"> {
    const signal = this.#stopper.signal;
    const settled = promise.then(
      (value): Settled<T> => ({ ok: true, value }),
      (error: unknown): Settled<T> => ({ ok: false, error }),
    );
    if (signal.aborted) return "stopped";
    const stopped = new Promise<"stopped">((resolve) =>
      signal.addEventListener("abort", () => resolve("stopped"), { once: true }),
    );
    return Promise.race([settled, stopped]);
  }

  #today(timeZone: string): string {
    const now = this.#context.now();
    try {
      return dateInTimeZone(now, timeZone);
    } catch {
      this.#note(`The Settings time zone "${timeZone}" is not valid; using UTC for today's date.`);
      return dateInTimeZone(now, "UTC");
    }
  }

  #printSummary(summary: RunSummary): void {
    this.#context.io.stdout.write(`${JSON.stringify(summary)}\n`);
  }

  #internal(prefix: string, error: unknown): RunError {
    return { code: "internal", message: `${prefix}: ${this.#messageOf(error)}` };
  }

  #messageOf(error: unknown): string {
    return this.#redact(messageOf(error));
  }

  #note(message: string): void {
    this.#context.io.stderr.write(`${CLI_NAME}: ${message}\n`);
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return typeof error === "string" && error !== "" ? error : "unknown error";
}

/** Lets an async iterator run its cleanup (finally blocks). Never rejects. */
async function closeQuietly(iterator: AsyncIterator<AgentEvent>): Promise<void> {
  try {
    await iterator.return?.();
  } catch {
    // The run is already finished; a failing cleanup changes nothing we report.
  }
}

async function withinMs(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([promise, elapsed]);
  } finally {
    clearTimeout(timer);
  }
}
