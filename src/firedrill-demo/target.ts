#!/usr/bin/env node
/** Firedrill command-target adapter. Its input is one isolated case on stdin. */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WorldAccess } from "./catalog.js";

type Scope = "core" | "stripe";
type Invocation = {
  schemaVersion: 1;
  runId: string;
  interactionId: string;
  actorId: string;
  instruction: string;
};

function caseAccess(scope: Scope, source: NodeJS.ProcessEnv): WorldAccess {
  const worldHttpUrl = source.FIREDRILL_HTTP_URL;
  const credential = source.FIREDRILL_HTTP_TOKEN;
  if (!worldHttpUrl || !credential)
    throw new Error("Firedrill did not issue the HTTP case binding");
  const worldMcpUrl = source.FIREDRILL_MCP_URL ?? `${worldHttpUrl}/v1/mcp`;
  if (scope === "core") {
    if (!source.FIREDRILL_MCP_URL || !source.FIREDRILL_MCP_TOKEN) {
      throw new Error("Firedrill did not issue the MCP case binding");
    }
    if (source.FIREDRILL_MCP_TOKEN !== credential) {
      throw new Error("The MCP and HTTP case credentials must match");
    }
  }
  return {
    worldHttpUrl,
    worldMcpUrl,
    worldWireHttpUrl: `${worldHttpUrl}/v1/wire`,
    worldWireAuthorizationHeader: "X-Firedrill-World-Authorization",
    credential,
  };
}

function parseInvocation(value: unknown): Invocation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The case invocation is not an object");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.runId !== "string" ||
    typeof candidate.interactionId !== "string" ||
    typeof candidate.actorId !== "string" ||
    typeof candidate.instruction !== "string" ||
    candidate.instruction.trim().length === 0
  ) {
    throw new Error("The case invocation is missing its task or identity");
  }
  return candidate as Invocation;
}

async function readInvocation(): Promise<Invocation> {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > 100_000) throw new Error("The case invocation exceeds 100 KB");
  }
  return parseInvocation(JSON.parse(input));
}

function targetError(message: string) {
  return {
    schemaVersion: 1 as const,
    status: "failed" as const,
    attachments: [],
    error: {
      schemaVersion: 1 as const,
      code: "target.AGENT_RUN_FAILED",
      source: "target" as const,
      message,
      retryable: false,
      issues: [],
    },
  };
}

async function run(scope: Scope, invocation: Invocation) {
  const access = caseAccess(scope, process.env);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Set ANTHROPIC_API_KEY in the runner environment");
  const stateDir = await mkdtemp(join(tmpdir(), "revenue-desk-firedrill-case-"));
  try {
    const forwarded = ["PATH", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM"];
    const env = Object.fromEntries(
      forwarded.flatMap((name) =>
        process.env[name] === undefined ? [] : [[name, process.env[name]]],
      ),
    );
    Object.assign(env, {
      HOME: stateDir,
      ANTHROPIC_API_KEY: key,
      AGENT_STATE_DIR: stateDir,
      REVENUE_DESK_FIREDRILL_CASE_BINDING: JSON.stringify({ scope, access }),
    });
    const child = spawn(
      process.execPath,
      [
        resolve("dist/firedrill-demo/cli.js"),
        "ask",
        "--json",
        "--policy",
        JSON.stringify({
          internal_write: "deny",
          outbound: "deny",
          financial: "deny",
          destructive: "deny",
        }),
        invocation.instruction,
      ],
      { cwd: process.cwd(), env, shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let excessOutput = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 2_000_000) {
        excessOutput = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => process.stderr.write(chunk));
    const exit = await new Promise<number>((complete, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => complete(code ?? 1));
    });
    if (excessOutput) throw new Error("The agent summary exceeded the output limit");
    let summary: Record<string, unknown>;
    try {
      summary = JSON.parse(output) as Record<string, unknown>;
    } catch {
      throw new Error("The agent did not return a valid run summary");
    }
    if (exit !== 0 || summary.status !== "completed") {
      throw new Error(`The agent ended with ${String(summary.status ?? "an error")}`);
    }
    return {
      schemaVersion: 1 as const,
      status: "completed" as const,
      output: {
        reply: typeof summary.reply === "string" ? summary.reply : "",
        agentRunId: typeof summary.runId === "string" ? summary.runId : null,
        toolCalls: Array.isArray(summary.toolCalls) ? summary.toolCalls : [],
      },
      attachments: [],
    };
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

const scope = process.argv[2];
try {
  if (scope !== "core" && scope !== "stripe") throw new Error("Choose core or stripe test scope");
  const invocation = await readInvocation();
  // Bindings are injected by Firedrill for this exact case, not borrowed from
  // a reusable demo session. Firedrill records the Tool calls and decides checks.
  process.stdout.write(`${JSON.stringify(await run(scope, invocation))}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Agent execution failed";
  process.stdout.write(`${JSON.stringify(targetError(message))}\n`);
}
