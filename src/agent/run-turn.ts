// runTurn: one turn of the agent as an ordered AgentEvent stream
// (src/contracts/events.ts, docs/ARCHITECTURE.md §5 "Agent core").
//
// It opens the run's gateway (connections, registry, in-process servers),
// emits run.started, runs query() with the gateway's servers, the PreToolUse
// hook and canUseTool, maps SDK messages to events, and always ends with
// usage (when the SDK reported a result) and exactly one run.finished.
//
// Stop: when the input signal aborts (with a RunStopReason), the core calls
// query.interrupt(); pending approvals settle as stopped through the gate
// (canUseTool then denies with interrupt:true); the SDK process is aborted
// only if the query is still running 3 seconds later. The core is
// database-free: callers persist from the events.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Query, query } from "@anthropic-ai/claude-agent-sdk";
import { createRedactor } from "../config/redact.js";
import type {
  AgentEvent,
  RunConnection,
  RunStopReason,
  RunTurn,
  RunTurnInput,
} from "../contracts/events.js";
import { INTEGRATION_IDS, INTEGRATIONS } from "../contracts/integration.js";
import type { IntegrationCatalog } from "../gateway/catalog.js";
import type { UpstreamConnector } from "../gateway/mcp-proxy.js";
import { baseMetadata, classifiedMetadata, type ToolRegistry } from "../gateway/registry.js";
import { openRunGateway, type RunGateway } from "../gateway/run-gateway.js";
import type { GatewayCall, GatewayObserver } from "../gateway/types.js";
import { createCanUseTool, createPreToolUseHook } from "./decisions.js";
import { EventChannel } from "./event-channel.js";
import { WRITE_DRAIN_MS } from "./executing-writes.js";
import { runOutcome, stopReasonOf } from "./outcome.js";
import { buildSystemPrompt } from "./prompt.js";
import { SdkMessageMapper, type ToolView } from "./sdk-mapper.js";
import { buildQueryOptions, prepareStateDirectories } from "./sdk-options.js";
import { ToolCallLedger } from "./tool-calls.js";
import {
  fileUsageBaselineStore,
  runUsage,
  sessionTotals,
  type UsageBaselineStore,
  usageBaseline,
} from "./usage.js";

export type RunTurnDependencies = {
  /** The integrations (W2): definitions and API tool factories. */
  readonly catalog: IntegrationCatalog;
  /** Reported as CLAUDE_AGENT_SDK_CLIENT_APP=revenue-desk/<version>. Default: package.json. */
  readonly version?: string;
  /** PATH for the Claude CLI child. Default: this process's PATH. */
  readonly hostPath?: string;
  readonly connectUpstream?: UpstreamConnector;
  /**
   * Where a resumed session's usage baseline comes from. The server and the
   * CLI pass the database's (src/db/usage-baseline.ts). Default: files under
   * <state>/claude/revenue-desk/usage.
   */
  readonly usageStore?: (stateDir: string) => UsageBaselineStore;
  /** How long a stop waits after interrupt() before aborting the SDK process. Default 3000. */
  readonly stopGraceMs?: number;
  /** How long the end of a run waits for reads still executing. Default 5000. */
  readonly drainMs?: number;
  /**
   * How long the end of a run waits for writes still executing (a started
   * write is never cancelled; its result is the record of what happened).
   * Default WRITE_DRAIN_MS.
   */
  readonly writeDrainMs?: number;
  readonly progressIntervalMs?: number;
  readonly connectTimeoutMs?: number;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** The Claude CLI's stderr, redacted, line by line (diagnostics). */
  readonly onStderr?: (line: string) => void;
};

const DEFAULT_STOP_GRACE_MS = 3_000;
const DEFAULT_DRAIN_MS = 5_000;

let packageVersion: string | undefined;

function readPackageVersion(): string {
  if (packageVersion !== undefined) return packageVersion;
  try {
    // src/agent/run-turn.ts and dist/agent/run-turn.js are both two levels below package.json.
    const pkg: unknown = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const version = (pkg as { version?: unknown }).version;
    packageVersion = typeof version === "string" ? version : "0.0.0";
  } catch {
    packageVersion = "0.0.0";
  }
  return packageVersion;
}

/** RunConnections from the plans alone, for a run that ends before its gateway opens. */
function plannedConnections(input: RunTurnInput): RunConnection[] {
  return INTEGRATION_IDS.map((integration) => {
    const { kind, profile } = INTEGRATIONS[integration];
    const plan = input.connections.find((candidate) => candidate.integration === integration);
    if (plan?.status === "available") {
      return {
        integration,
        kind,
        profile,
        availability: "unavailable",
        state: "unknown",
        detail: "Not connected: the run ended before its tools were set up.",
        endpointLabel: plan.connection.endpointLabel,
      };
    }
    return {
      integration,
      kind,
      profile,
      availability: "unavailable",
      state: plan?.state ?? "unknown",
      detail: plan?.detail ?? "Not planned.",
      endpointLabel: null,
    };
  });
}

function toolView(registry: ToolRegistry): ToolView {
  return {
    describe(toolName) {
      const tool = registry.get(toolName);
      if (tool === undefined) return { title: toolName, tool: null };
      return { title: tool.descriptor.title, tool: baseMetadata(tool.descriptor) };
    },
    classify(toolName, input) {
      const tool = registry.get(toolName);
      if (tool === undefined) return { title: toolName, tool: null };
      const classification = tool.classify(input);
      if (classification === null) return { title: tool.descriptor.title, tool: null };
      return {
        title: classification.title,
        tool: classifiedMetadata(tool.descriptor, classification),
      };
    },
  };
}

/** Counts calls the gateway is executing, so the end of a run can wait for them. */
class InFlight {
  #all = 0;
  #writes = 0;
  readonly #waiters = new Set<() => void>();

  start(write: boolean): void {
    this.#all += 1;
    if (write) this.#writes += 1;
  }

  finish(write: boolean): void {
    this.#all = Math.max(0, this.#all - 1);
    if (write) this.#writes = Math.max(0, this.#writes - 1);
    for (const waiter of [...this.#waiters]) waiter();
  }

  /** Resolves when no write is executing, or after `timeoutMs`. */
  writesIdle(timeoutMs: number): Promise<void> {
    return this.#until(() => this.#writes === 0, timeoutMs);
  }

  /** Resolves when no call is executing, or after `timeoutMs`. */
  idle(timeoutMs: number): Promise<void> {
    return this.#until(() => this.#all === 0, timeoutMs);
  }

  #until(done: () => boolean, timeoutMs: number): Promise<void> {
    if (done()) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.#waiters.delete(check);
        resolve();
      };
      const check = () => {
        if (done()) finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref();
      this.#waiters.add(check);
    });
  }
}

async function execute(
  input: RunTurnInput,
  deps: RunTurnDependencies,
  emit: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const redact = createRedactor(input.env);
  const startedAt = now().toISOString();
  const stopReason = (): RunStopReason | null =>
    signal.aborted ? stopReasonOf(signal.reason) : null;
  const started = (connections: readonly RunConnection[]) =>
    emit({
      type: "run.started",
      runId: input.runId,
      conversationId: input.conversationId,
      source: input.source,
      mode: input.mode,
      model: input.model.model,
      effort: input.model.effort,
      startedAt,
      connections,
    });
  const finished = (outcome: ReturnType<typeof runOutcome>, reply: string | null) =>
    emit({
      type: "run.finished",
      status: outcome.status,
      finishedAt: now().toISOString(),
      stopReason: outcome.stopReason,
      terminalReason: outcome.terminalReason,
      reply: reply === null ? null : redact(reply),
      error: outcome.error,
    });

  if (input.env.model.apiKey === null) {
    started(plannedConnections(input));
    emit({
      type: "run.finished",
      status: "failed",
      finishedAt: now().toISOString(),
      stopReason: null,
      terminalReason: null,
      reply: null,
      error: { code: "config_missing", message: "ANTHROPIC_API_KEY is not set." },
    });
    return;
  }

  const ledger = new ToolCallLedger(emit);
  const inFlight = new InFlight();
  const executing = new WeakSet<GatewayCall>();
  const observer: GatewayObserver = {
    callStarted(call) {
      executing.add(call);
      inFlight.start(!call.readOnly);
      const id = call.toolUseId;
      if (id === null) return;
      ledger.setExecuting(id, true, {
        upstreamTool: call.upstreamTool,
        idempotencyKey: call.idempotencyKey,
        readOnly: call.readOnly,
        apiKind: call.connectionKind === "api",
      });
      // Consumers learn at once that the call is executing (ExecutingWrites, the action log).
      if (!ledger.isSettled(id)) {
        ledger.emitFor(id, { type: "tool.progress", toolCallId: id, elapsedMs: 0 });
      }
    },
    callProgress(call, elapsedMs) {
      const id = call.toolUseId;
      if (id === null || ledger.isSettled(id)) return;
      ledger.emitFor(id, { type: "tool.progress", toolCallId: id, elapsedMs });
    },
    callFinished(result) {
      const id = result.call.toolUseId;
      if (id !== null) {
        ledger.setExecuting(id, false);
        if (ledger.settle(id, ledger.decisionOf(id) ?? "auto")) {
          ledger.emitFor(id, {
            type: "tool.output",
            toolCallId: id,
            output: result.output,
            truncated: result.truncated,
            isError: result.isError,
            error: result.error,
            durationMs: result.durationMs,
            execution: {
              upstreamTool: result.call.upstreamTool,
              httpStatus: result.httpStatus,
              // Only a write that sent its key to the provider records it.
              idempotencyKey: result.idempotencyKey,
            },
          });
        }
      }
      // A write the gateway refused before starting it (no tool-use id) never started.
      if (executing.delete(result.call)) inFlight.finish(!result.call.readOnly);
    },
  };

  let gateway: RunGateway;
  try {
    gateway = await openRunGateway({
      runId: input.runId,
      plans: input.connections,
      catalog: deps.catalog,
      settings: input.settings,
      policy: input.policy,
      signal,
      observer,
      redact,
      ...(deps.connectUpstream === undefined ? {} : { connectUpstream: deps.connectUpstream }),
      ...(deps.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: deps.connectTimeoutMs }),
      ...(deps.progressIntervalMs === undefined
        ? {}
        : { progressIntervalMs: deps.progressIntervalMs }),
    });
  } catch (error) {
    started(plannedConnections(input));
    finished(
      runOutcome({
        stopReason: stopReason(),
        result: null,
        modelError: null,
        thrown: error,
        redact,
      }),
      null,
    );
    return;
  }

  try {
    started(gateway.connections);
    if (signal.aborted) {
      finished(
        runOutcome({
          stopReason: stopReason(),
          result: null,
          modelError: null,
          thrown: undefined,
          redact,
        }),
        null,
      );
      return;
    }

    const mapper = new SdkMessageMapper({
      emit,
      ledger,
      tools: toolView(gateway.registry),
      redact,
      isStopping: () => signal.aborted,
    });
    const decisionContext = {
      runId: input.runId,
      conversationId: input.conversationId,
      registry: gateway.registry,
      policy: input.policy,
      mode: input.mode,
      approvals: input.mode === "interactive" ? input.approvals : null,
      approvalTimeoutMs: input.env.runtime.approvalTimeoutMs,
      runSignal: signal,
      ledger,
      redact,
      now,
      newId,
    };
    const directories = prepareStateDirectories(input.env.runtime.stateDir);
    const abortController = new AbortController();
    const stderr = deps.onStderr;
    const q: Query = query({
      prompt: input.prompt,
      options: buildQueryOptions({
        env: input.env,
        model: input.model,
        directories,
        systemPrompt: buildSystemPrompt({
          settings: input.settings,
          businessDate: input.businessDate,
          connections: gateway.connections,
          mode: input.mode,
        }),
        mcpServers: gateway.mcpServers(),
        canUseTool: createCanUseTool(decisionContext),
        preToolUse: createPreToolUseHook(decisionContext),
        resumeSessionId: input.resumeSessionId,
        abortController,
        hostPath: deps.hostPath ?? process.env.PATH ?? "/usr/bin:/bin",
        clientApp: `revenue-desk/${deps.version ?? readPackageVersion()}`,
        ...(stderr === undefined ? {} : { stderr: (data: string) => stderr(redact(data)) }),
      }),
    });

    let hardStop: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      q.interrupt().catch(() => {});
      hardStop = setTimeout(
        () => abortController.abort(stopReason() ?? "user"),
        deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
      );
      hardStop.unref();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    let thrown: unknown;
    try {
      for await (const message of q) mapper.handle(message);
    } catch (error) {
      // The SDK throws after an error result it already delivered; the result decides then.
      thrown = error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (hardStop !== undefined) clearTimeout(hardStop);
      q.close();
    }

    // A stop that arrives after the SDK finished does not change how the run ended.
    const stoppedBy = stopReason();
    // Writes were not cancelled with the query: their results are what happened.
    await inFlight.writesIdle(deps.writeDrainMs ?? WRITE_DRAIN_MS);
    await inFlight.idle(deps.drainMs ?? DEFAULT_DRAIN_MS);
    mapper.finish();

    const result = mapper.result;
    if (result !== null) {
      const store = (deps.usageStore ?? defaultUsageStore)(input.env.runtime.stateDir);
      const sessionId = mapper.sessionId ?? result.session_id;
      const baseline = usageBaseline({
        resumeSessionId: input.resumeSessionId,
        sessionId,
        runId: input.runId,
        store,
      });
      emit({
        type: "usage",
        ...runUsage({
          result,
          baseline,
          stream: mapper.streamTokens,
          modelRequests: mapper.modelRequests,
        }),
      });
      try {
        store.write({ sessionId, runId: input.runId }, sessionTotals(result));
      } catch {
        // A missing baseline only makes the next resumed run's usage an estimate.
      }
    }

    const outcome = runOutcome({
      stopReason: stoppedBy,
      result,
      modelError: mapper.modelError,
      thrown,
      redact,
    });
    const reply =
      outcome.status === "completed" && result?.subtype === "success" && result.result !== ""
        ? result.result
        : mapper.lastText;
    finished(outcome, reply);
  } catch (error) {
    ledger.releaseAll();
    finished(
      runOutcome({
        stopReason: stopReason(),
        result: null,
        modelError: null,
        thrown: error,
        redact,
      }),
      null,
    );
  } finally {
    await gateway.close();
  }
}

function defaultUsageStore(stateDir: string): UsageBaselineStore {
  return fileUsageBaselineStore(join(stateDir, "claude", "revenue-desk", "usage"));
}

/**
 * Builds the core's RunTurn. The returned function is lazy: the run starts
 * when its stream is iterated. Ending the iteration early stops the run
 * (reason "shutdown") and waits for it to finish.
 */
export function createRunTurn(deps: RunTurnDependencies): RunTurn {
  return (input) => ({
    async *[Symbol.asyncIterator]() {
      const channel = new EventChannel<AgentEvent>();
      const controller = new AbortController();
      const forward = () => controller.abort(input.signal.reason);
      if (input.signal.aborted) forward();
      else input.signal.addEventListener("abort", forward, { once: true });
      let finishedEmitted = false;
      const push = (event: AgentEvent) => {
        if (finishedEmitted) return;
        if (event.type === "run.finished") finishedEmitted = true;
        channel.push(event);
      };
      const task = execute(input, deps, push, controller.signal)
        .catch((error: unknown) => {
          // execute() reports its own failures; this is a last resort for a bug in it.
          if (!finishedEmitted) {
            channel.push({
              type: "run.finished",
              status: "failed",
              finishedAt: new Date().toISOString(),
              stopReason: null,
              terminalReason: null,
              reply: null,
              error: {
                code: "internal",
                message: createRedactor(input.env)(
                  error instanceof Error ? error.message : String(error),
                ),
              },
            });
          }
        })
        .finally(() => channel.close());
      let completed = false;
      try {
        for await (const event of channel) yield event;
        completed = true;
      } finally {
        input.signal.removeEventListener("abort", forward);
        if (!completed) controller.abort("shutdown");
        await task;
      }
    },
  });
}
