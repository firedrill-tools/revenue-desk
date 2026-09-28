/**
 * Scripted model turns for Revenue Desk's jobs, played by the scripted
 * Messages API (test/support/mock-anthropic.ts) to the real Claude Agent SDK.
 *
 * A scenario is a list of steps; step n answers the n-th model request of the
 * current prompt (stepIndex: stable across resumed sessions). A step sees
 * what the agent really did before it: the tools it offered and every tool
 * result, so a script reads ids the fakes generated (a draft id, a new
 * QuickBooks customer) and branches on approvals and failures, as a model
 * would.
 *
 * Drift is caught, not hidden: every scripted tool call is checked against
 * the tools and JSON schemas the agent actually offered in that request. A
 * call to a tool that is not offered, or with arguments its schema refuses,
 * is recorded as a problem (unless the scenario marks it as intended), and
 * tests assert `problems` is empty. When an integration's argument names
 * change, the scenario tests say exactly which call drifted.
 */
import type { JsonObject, JsonValue } from "../../src/contracts/json.js";
import { schemaIssues } from "../support/fakes/core/schema.js";
import type { Fakes } from "../support/fakes/index.js";
import type {
  MessagesBody,
  Responder,
  ScriptedBlock,
  ScriptedError,
  ScriptedHang,
} from "../support/mock-anthropic.js";
import { toolResults } from "../support/mock-anthropic.js";
import { offeredTools, stepIndex } from "../support/sdk-gate-support.js";

// ---------------------------------------------------------------------------
// Scripted blocks
// ---------------------------------------------------------------------------

/** A tool call a step makes. `id` is logical; the responder turns it into the tool_use id. */
export interface ScriptedCall {
  readonly type: "call";
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
  /** The call is meant to be refused before approval (schema-invalid input). */
  readonly expectInvalid?: boolean;
  /** The call names a tool the agent is not expected to offer. */
  readonly expectNotOffered?: boolean;
}

export type StepBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string }
  | ScriptedCall;

export type StepReply = readonly StepBlock[] | ScriptedError | ScriptedHang;

export const text = (value: string): StepBlock => ({ type: "text", text: value });
export const thinking = (value: string): StepBlock => ({ type: "thinking", thinking: value });

/** A tool call by its model-visible name, e.g. call("j2_refund", "mcp__stripe__create_refund", {...}). */
export function call(
  id: string,
  name: string,
  input: JsonObject,
  options: { readonly expectInvalid?: boolean; readonly expectNotOffered?: boolean } = {},
): ScriptedCall {
  return { type: "call", id, name, input, ...options };
}

/** A Messages API failure instead of a reply, e.g. 529 overloaded. */
export function apiError(
  httpStatus: number,
  errorType: string,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): ScriptedError {
  return { httpStatus, errorType, message, headers };
}

// ---------------------------------------------------------------------------
// What a step sees
// ---------------------------------------------------------------------------

/** One tool result the agent sent back, by logical call id. */
export interface ResultView {
  readonly text: string;
  readonly isError: boolean;
  /** The text parsed as JSON, or undefined. */
  json(): JsonValue | undefined;
  /** The first capture group (or whole match) of a pattern in the text, or undefined. */
  find(pattern: RegExp): string | undefined;
}

export interface StepContext {
  /** Model requests already answered for this prompt (0 for the first). */
  readonly step: number;
  /** Prompts in the session so far, this one included (1 for a new conversation). */
  readonly turn: number;
  /** The user's current prompt. */
  readonly prompt: string;
  /** Model-visible names of the tools offered in this request. */
  readonly offered: ReadonlySet<string>;
  offers(name: string): boolean;
  /** Whether any tool of an integration (`mcp__<integration>__…`) is offered. */
  offersIntegration(integration: string): boolean;
  /** The result of an earlier call of this prompt, by logical id. */
  result(id: string): ResultView | undefined;
  /** A value from an earlier result; records a problem and returns `fallback` when missing. */
  pick(id: string, pattern: RegExp, fallback: string): string;
  /** Records a script problem (an unexpected condition the test should fail on). */
  problem(message: string): void;
}

export type Step = (context: StepContext) => StepReply;

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export type Job = "J1" | "J2" | "J3" | "J4" | "J5" | "failure";

/** What a test or demo does with an approval: decide it, or stop the run while it is pending. */
export type ApprovalDecision = "approve" | "deny" | "stop";

/** Facts about the run a scenario's checks need. */
export interface RunFacts {
  readonly runId: string;
  /** The scenario's turn in its conversation (1 for a new conversation). */
  readonly turn: number;
}

/** How a scenario's run should end (the checks a runner makes on events or a RunSummary). */
export interface ExpectedOutcome {
  readonly status: "completed" | "failed" | "cancelled" | "timed_out";
  /** RunError code for a failed run. */
  readonly errorCode?: string;
  /** Substrings the final reply contains. */
  readonly replyIncludes?: readonly string[];
}

export interface Scenario {
  /** Stable slug, e.g. "j2-refund-duplicate". */
  readonly id: string;
  readonly job: Job;
  readonly title: string;
  /** The user's message. */
  readonly prompt: string;
  readonly steps: readonly Step[];
  /**
   * The decision a test or demo gives each approval, by logical call id.
   * An approval for any other call is a scenario error.
   */
  readonly approvals: Readonly<Record<string, ApprovalDecision>>;
  /** The HubSpot transport this scenario needs (default: the harness's). */
  readonly hubspot?: "stdio" | "http";
  /** Prepares the fakes (faults, connection states) before the run. */
  arrange?(fakes: Fakes): void;
  readonly expected: ExpectedOutcome;
  /** Checks the fakes after the run; returns problems (empty when all is well). */
  verify?(fakes: Fakes, run: RunFacts): string[];
}

/** The tool_use id of a logical call in a given turn (turn 1 needs no suffix). */
export function toolUseId(logicalId: string, turn = 1): string {
  return turn === 1 ? `toolu_${logicalId}` : `toolu_${logicalId}_t${turn}`;
}

/** The logical call id of a tool_use id made by toolUseId(), or null. */
export function logicalCallId(id: string): string | null {
  const match = /^toolu_(.+?)(?:_t\d+)?$/.exec(id);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// The responder
// ---------------------------------------------------------------------------

export interface ScriptProblem {
  readonly scenario: string;
  readonly step: number;
  readonly message: string;
}

export interface ScenarioResponder {
  readonly respond: Responder;
  /** Drift and script errors found while playing; tests assert it is empty. */
  readonly problems: ScriptProblem[];
  /** Model requests answered per scenario id. */
  readonly played: Map<string, number>;
}

export interface ScenarioResponderOptions {
  /**
   * Chooses the scenario for a prompt when several are loaded (the sandbox).
   * Default: the scenario whose prompt equals the user's text.
   */
  readonly choose?: (prompt: string, scenarios: readonly Scenario[]) => Scenario | undefined;
  /** Blocks for a prompt no scenario matches. Default: a short explanation. */
  readonly unmatched?: (prompt: string) => readonly ScriptedBlock[];
  /** Also report problems on stderr as they happen (the sandbox). */
  readonly logProblems?: boolean;
}

/** Plays one or more scenarios. Side requests (no tools field) get a plain "ok". */
export function scenarioResponder(
  scenarios: Scenario | readonly Scenario[],
  options: ScenarioResponderOptions = {},
): ScenarioResponder {
  const list = Array.isArray(scenarios)
    ? (scenarios as readonly Scenario[])
    : [scenarios as Scenario];
  const problems: ScriptProblem[] = [];
  const played = new Map<string, number>();
  const choose =
    options.choose ??
    ((prompt: string, candidates: readonly Scenario[]) =>
      candidates.length === 1
        ? candidates[0]
        : candidates.find((scenario) => scenario.prompt === prompt.trim()));

  const respond: Responder = (body) => {
    if (!Array.isArray(body.tools)) return undefined;
    const prompt = currentPrompt(body);
    const scenario = choose(prompt, list);
    if (scenario === undefined) {
      return (
        options.unmatched?.(prompt) ?? [
          { type: "text", text: "No scripted scenario matches this message." },
        ]
      );
    }
    const step = stepIndex(body);
    const turn = promptCount(body);
    played.set(scenario.id, (played.get(scenario.id) ?? 0) + 1);
    const problem = (message: string) => {
      const entry = { scenario: scenario.id, step, message };
      problems.push(entry);
      if (options.logProblems === true)
        process.stderr.write(`[scripted model] ${scenario.id} step ${step}: ${message}\n`);
    };
    const script = scenario.steps[step];
    if (script === undefined) {
      problem(
        `the script has ${scenario.steps.length} steps but the agent asked for step ${step + 1}`,
      );
      return [{ type: "text", text: "(The scripted scenario has no further steps.)" }];
    }
    const context = stepContext(body, step, turn, prompt, problem);
    const reply = script(context);
    if (!Array.isArray(reply)) return reply as ScriptedError | ScriptedHang;
    return (reply as readonly StepBlock[]).map((block): ScriptedBlock => {
      if (block.type !== "call") return block;
      checkCall(body, block, problem);
      return {
        type: "tool_use",
        id: toolUseId(block.id, turn),
        name: block.name,
        input: block.input,
      };
    });
  };
  return { respond, problems, played };
}

function checkCall(
  body: MessagesBody,
  block: ScriptedCall,
  problem: (message: string) => void,
): void {
  const offered = (body.tools ?? []).find((tool) => tool.name === block.name);
  if (offered === undefined) {
    if (block.expectNotOffered !== true) problem(`${block.id}: ${block.name} is not offered`);
    return;
  }
  if (block.expectNotOffered === true)
    problem(`${block.id}: ${block.name} is offered but the script expected it not to be`);
  const schema = offered.input_schema;
  if (schema === null || typeof schema !== "object") {
    problem(`${block.id}: ${block.name} has no input schema`);
    return;
  }
  const issues = schemaIssues(schema, block.input);
  if (issues.length > 0 && block.expectInvalid !== true) {
    problem(
      `${block.id}: ${block.name} input does not match the offered schema: ${issues.join("; ")}`,
    );
  }
  if (issues.length === 0 && block.expectInvalid === true) {
    problem(`${block.id}: ${block.name} input was meant to be invalid but matches the schema`);
  }
}

function stepContext(
  body: MessagesBody,
  step: number,
  turn: number,
  prompt: string,
  problem: (message: string) => void,
): StepContext {
  const offered = new Set(offeredTools(body));
  const results = new Map<string, ResultView>();
  for (const entry of toolResults(body)) {
    const logical = logicalCallId(entry.id);
    if (logical === null || entry.id !== toolUseId(logical, turn)) continue;
    results.set(logical, view(entry.text, entry.isError));
  }
  return {
    step,
    turn,
    prompt,
    offered,
    offers: (name) => offered.has(name),
    offersIntegration: (integration) =>
      [...offered].some((name) => name.startsWith(`mcp__${integration}__`)),
    result: (id) => results.get(id),
    problem,
    pick: (id, pattern, fallback) => {
      const result = results.get(id);
      const found = result?.find(pattern);
      if (found === undefined) {
        problem(
          `${id}: ${pattern} not found in ${result === undefined ? "a missing result" : `"${result.text.slice(0, 200)}"`}`,
        );
        return fallback;
      }
      return found;
    },
  };
}

function view(text: string, isError: boolean): ResultView {
  return {
    text,
    isError,
    json: () => {
      try {
        return JSON.parse(text) as JsonValue;
      } catch {
        return undefined;
      }
    },
    find: (pattern) => {
      const match = pattern.exec(text);
      return match === null ? undefined : (match[1] ?? match[0]);
    },
  };
}

function isPrompt(entry: { readonly role: string; readonly content: unknown }): boolean {
  if (entry.role !== "user") return false;
  if (typeof entry.content === "string") return true;
  if (!Array.isArray(entry.content)) return false;
  const blocks = entry.content as { type?: unknown }[];
  return (
    blocks.some((block) => block.type === "text") &&
    !blocks.some((block) => block.type === "tool_result")
  );
}

function promptText(entry: { readonly content: unknown }): string {
  if (typeof entry.content === "string") return entry.content;
  return (
    (entry.content as { type?: unknown; text?: unknown }[])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => String(block.text))
      // The CLI adds system reminders as text blocks; the user's text is the one that is not one.
      .filter((value) => !value.trimStart().startsWith("<system-reminder>"))
      .join("\n")
      .trim()
  );
}

/** The user's latest prompt in a request. */
export function currentPrompt(body: MessagesBody): string {
  const prompts = (body.messages ?? []).filter(isPrompt);
  const last = prompts.at(-1);
  return last === undefined ? "" : promptText(last);
}

/** How many prompts the session holds (1 for a new conversation). */
export function promptCount(body: MessagesBody): number {
  return Math.max(1, (body.messages ?? []).filter(isPrompt).length);
}
