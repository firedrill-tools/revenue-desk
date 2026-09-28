import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../../../src/cli/args.js";
import { ASK_FLAGS, type AskCommand } from "../../../src/contracts/cli.js";

const DEFAULTS: AskCommand = {
  command: "ask",
  prompt: { source: "argument", text: "Why was Kestrel charged twice?" },
  json: false,
  conversationId: null,
  policy: {},
  model: null,
  effort: null,
  maxTurns: null,
  maxBudgetUsd: null,
  timeoutMs: null,
  stateDir: null,
};

function command(argv: readonly string[]) {
  const result = parseCliArgs(argv);
  if (!result.ok) throw new Error(`expected a command, got: ${result.message}`);
  return result.command;
}

function usageError(argv: readonly string[]): string {
  const result = parseCliArgs(argv);
  if (result.ok) throw new Error(`expected a usage error for ${JSON.stringify(argv)}`);
  return result.message;
}

describe("parseCliArgs: ask", () => {
  it("takes the prompt as one argument and leaves every flag unset", () => {
    expect(command(["ask", "Why was Kestrel charged twice?"])).toEqual(DEFAULTS);
  });

  it("reads the prompt from stdin for '-'", () => {
    expect(command(["ask", "-"])).toEqual({ ...DEFAULTS, prompt: { source: "stdin" } });
  });

  it("parses every flag, in both --flag value and --flag=value forms", () => {
    const argv = [
      "ask",
      ASK_FLAGS.json,
      `${ASK_FLAGS.conversation}=conv-1`,
      ASK_FLAGS.policy,
      '{"financial":"auto","outbound":"deny"}',
      `${ASK_FLAGS.model}=claude-opus-5`,
      ASK_FLAGS.effort,
      "high",
      ASK_FLAGS.maxTurns,
      "12",
      `${ASK_FLAGS.maxBudgetUsd}=0.50`,
      ASK_FLAGS.timeoutMs,
      "60000",
      ASK_FLAGS.stateDir,
      "/tmp/rd-state",
      "Refund the duplicate charge",
    ];
    expect(command(argv)).toEqual({
      command: "ask",
      prompt: { source: "argument", text: "Refund the duplicate charge" },
      json: true,
      conversationId: "conv-1",
      policy: { financial: "auto", outbound: "deny" },
      model: "claude-opus-5",
      effort: "high",
      maxTurns: 12,
      maxBudgetUsd: 0.5,
      timeoutMs: 60_000,
      stateDir: "/tmp/rd-state",
    } satisfies AskCommand);
  });

  it("accepts flags after the prompt and a prompt that starts with a dash after --", () => {
    expect(command(["ask", "hello", "--json"])).toMatchObject({ json: true });
    expect(command(["ask", "--", "-5% refund?"])).toMatchObject({
      prompt: { source: "argument", text: "-5% refund?" },
    });
  });

  it("accepts every effort level", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(command(["ask", "--effort", effort, "x"])).toMatchObject({ effort });
    }
  });
});

describe("parseCliArgs: help and version", () => {
  it.each([[["--help"]], [["-h"]], [["help"]], [["ask", "--help"]]])("%j is help", (argv) => {
    expect(command(argv)).toEqual({ command: "help" });
  });

  it.each([[["--version"]], [["version"]]])("%j is version", (argv) => {
    expect(command(argv)).toEqual({ command: "version" });
  });
});

describe("parseCliArgs: usage errors", () => {
  it.each([
    [[], /Missing command/],
    [["run", "x"], /Unknown command 'run'/],
    [["ask"], /needs a prompt/],
    [["ask", "one", "two"], /takes one prompt; quote it/],
    [["ask", "   "], /prompt is empty/],
    [["ask", "--bogus", "x"], /Unknown option '--bogus'/],
    [["ask", "x", "--policy"], /argument missing/],
    [["ask", "--json=yes", "x"], /does not take an argument/],
    [["ask", "--model", "a", "--model", "b", "x"], /--model was given more than once/],
    [["ask", "--model", " ", "x"], /--model needs a non-empty value/],
    [["ask", "--effort", "extreme", "x"], /--effort must be one of low, medium, high, xhigh, max/],
    [["ask", "--max-turns", "0", "x"], /--max-turns must be a whole number/],
    [["ask", "--max-turns", "1.5", "x"], /--max-turns must be a whole number/],
    [["ask", "--max-turns=-3", "x"], /--max-turns must be a whole number/],
    [["ask", "--timeout-ms", "soon", "x"], /--timeout-ms must be a whole number/],
    [["ask", "--max-budget-usd", "0", "x"], /--max-budget-usd must be a positive amount/],
    [["ask", "--max-budget-usd", "1e3", "x"], /--max-budget-usd must be a positive amount/],
    [["ask", "--policy", "financial=auto", "x"], /--policy must be JSON/],
    [["ask", "--policy", '["auto"]', "x"], /must be a JSON object/],
    [["ask", "--policy", '{"refunds":"auto"}', "x"], /Unknown action class 'refunds'/],
    [["ask", "--policy", '{"financial":"yes"}', "x"], /'financial' must be one of auto, ask, deny/],
    [["version", "--json"], /--json is only valid with 'ask'/],
    [["help", "extra"], /'help' takes no arguments/],
  ] as const)("%j", (argv, message) => {
    expect(usageError(argv)).toMatch(message);
  });
});
