#!/usr/bin/env node
// One-command, explicit synthetic-only launcher. It obtains two short-lived
// actor bindings and never passes a real provider credential to Revenue Desk.
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv, promisify } from "node:util";

const execute = promisify(execFile);
const projectId = process.env.FIREDRILL_DEMO_PROJECT_ID;
const coreEnvironmentId = process.env.FIREDRILL_DEMO_CORE_ENVIRONMENT_ID;
const stripeEnvironmentId = process.env.FIREDRILL_DEMO_STRIPE_ENVIRONMENT_ID;
const modelEnvPath = process.env.REVENUE_DESK_MODEL_ENV_PATH;
const cliArguments = process.argv.slice(2);
if (cliArguments.length > 0 && cliArguments[0] !== "ask") {
  process.stderr.write('Run without arguments for the web app, or pass: ask [options] "prompt".\n');
  process.exit(2);
}
if (
  !/^prj_[a-z0-9]+$/.test(projectId ?? "") ||
  !/^env_[a-z0-9]+$/.test(coreEnvironmentId ?? "") ||
  !/^env_[a-z0-9]+$/.test(stripeEnvironmentId ?? "") ||
  !(process.env.ANTHROPIC_API_KEY || modelEnvPath)
) {
  process.stderr.write(
    "Set FIREDRILL_DEMO_PROJECT_ID, FIREDRILL_DEMO_CORE_ENVIRONMENT_ID, " +
      "FIREDRILL_DEMO_STRIPE_ENVIRONMENT_ID and either ANTHROPIC_API_KEY " +
      "or REVENUE_DESK_MODEL_ENV_PATH.\n",
  );
  process.exit(2);
}
if (coreEnvironmentId === stripeEnvironmentId)
  throw new Error("The two Tool environments must differ");
const modelKey =
  process.env.ANTHROPIC_API_KEY ||
  parseEnv(readFileSync(resolve(modelEnvPath), "utf8")).ANTHROPIC_API_KEY;
if (!modelKey) throw new Error("The model key file has no ANTHROPIC_API_KEY");

const cli = resolve("node_modules/@firedrill-run/cloud/dist/bin.js");
async function firedrill(args) {
  let stdout;
  try {
    ({ stdout } = await execute(process.execPath, [cli, ...args], {
      cwd: process.cwd(),
      maxBuffer: 2_000_000,
      timeout: 360_000,
    }));
  } catch (error) {
    // The CLI emits structured JSON even on nonzero exit. Never echo its raw
    // stdout or stderr here: they may contain a short-lived connection value.
    let reply;
    try {
      reply = JSON.parse(error.stdout ?? "");
    } catch {}
    if (reply?.error?.code)
      throw new Error(`Firedrill ${reply.error.code}: ${reply.error.message}`);
    throw new Error(
      `Firedrill ${args[0]} ${args[1] ?? ""} failed. Inspect the CLI recovery request before retrying.`,
    );
  }
  const result = JSON.parse(stdout);
  if (result.error) throw new Error(`Firedrill ${result.error.code}: ${result.error.message}`);
  return result;
}

async function ready(environmentId) {
  const base = ["--project", projectId, "--environment", environmentId, "--json"];
  let current = await firedrill(["environment", "get", ...base]);
  if (current.runtime?.state === "suspended") {
    process.stderr.write(`Resuming synthetic Tools in ${environmentId}…\n`);
    await firedrill([
      "environment",
      "wake",
      ...base,
      "--ttl-ms",
      "7200000",
      "--wait",
      "--timeout-ms",
      "300000",
    ]);
  } else if (current.runtime?.state !== "ready" && current.runtime?.state !== "waking") {
    throw new Error(
      `${environmentId} is ${current.runtime?.state ?? "unknown"}; choose a ready or suspended Tool setup`,
    );
  }
  for (let i = 0; i < 45; i += 1) {
    current = await firedrill(["environment", "get", ...base]);
    if (current.runtime?.state === "ready") return;
    if (!["waking", "suspending"].includes(current.runtime?.state))
      throw new Error(`${environmentId} could not become ready: ${current.runtime?.state}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 4_000));
  }
  throw new Error(`${environmentId} did not become ready within three minutes`);
}

async function binding(environmentId) {
  const reply = await firedrill([
    "connect",
    "--project",
    projectId,
    "--environment",
    environmentId,
    "--actor",
    "local-dev",
    "--ttl-ms",
    "3600000",
    "--format",
    "json",
  ]);
  if (!reply.result?.credential)
    throw new Error(`${environmentId} did not issue a world credential`);
  return { ...reply.result, projectId };
}

try {
  for (const id of [coreEnvironmentId, stripeEnvironmentId]) await ready(id);
  const core = await binding(coreEnvironmentId);
  const stripe = await binding(stripeEnvironmentId);

  // The build is local only. It produces the UI and this opt-in composition.
  process.stderr.write("Building Revenue Desk locally…\n");
  await execute("pnpm", ["build"], {
    cwd: process.cwd(),
    maxBuffer: 4_000_000,
    timeout: 180_000,
  });

  const permitted = [
    "HOME",
    "PATH",
    "TMPDIR",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TERM",
    "XDG_CONFIG_HOME",
  ];
  const env = Object.fromEntries(
    permitted.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
  );
  Object.assign(env, {
    ANTHROPIC_API_KEY: modelKey,
    AGENT_STATE_DIR: resolve("data/firedrill-demo"),
    PORT: process.env.REVENUE_DESK_DEMO_PORT ?? "4321",
    REVENUE_DESK_FIREDRILL_BINDINGS: JSON.stringify({ core, stripe }),
  });
  const child = spawn(
    process.execPath,
    [
      cliArguments.length === 0 ? "dist/firedrill-demo/main.js" : "dist/firedrill-demo/cli.js",
      ...cliArguments,
    ],
    {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
      shell: false,
    },
  );
  child.on("error", (error) => process.stderr.write(`Could not start demo: ${error.message}\n`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
