#!/usr/bin/env node
// Execute the Revenue Desk agent as a case-scoped Firedrill command target.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const selection = process.argv[2] ?? "all";
const recoveryPath = selection === "resume" ? process.argv[3] : undefined;
if (
  !["all", "core", "stripe", "resume"].includes(selection) ||
  (selection === "resume" &&
    !/^\.firedrill\/cloud\/simulation-[a-f0-9-]+\.json$/.test(recoveryPath ?? ""))
) {
  process.stderr.write("Usage: pnpm demo:firedrill:test [all|core|stripe|resume RECOVERY_FILE]\n");
  process.exit(2);
}
const project = process.env.FIREDRILL_DEMO_PROJECT_ID;
const coreSetup = process.env.FIREDRILL_DEMO_CORE_TEST_SETUP_ID;
const stripeSetup = process.env.FIREDRILL_DEMO_STRIPE_TEST_SETUP_ID;
if (!/^prj_[a-z0-9]+$/.test(project ?? "")) {
  throw new Error("Set FIREDRILL_DEMO_PROJECT_ID");
}
if (
  ((selection === "all" || selection === "core") && !/^setup_[a-z0-9]+$/.test(coreSetup ?? "")) ||
  ((selection === "all" || selection === "stripe") && !/^setup_[a-z0-9]+$/.test(stripeSetup ?? ""))
) {
  throw new Error("Set the selected FIREDRILL_DEMO_*_TEST_SETUP_ID value(s)");
}
const modelKey =
  process.env.ANTHROPIC_API_KEY ||
  (process.env.REVENUE_DESK_MODEL_ENV_PATH
    ? parseEnv(readFileSync(resolve(process.env.REVENUE_DESK_MODEL_ENV_PATH), "utf8"))
        .ANTHROPIC_API_KEY
    : undefined);
if (!modelKey) throw new Error("Set ANTHROPIC_API_KEY or REVENUE_DESK_MODEL_ENV_PATH");

const forwarded = [
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
  "FIREDRILL_CREDENTIAL",
];
const env = Object.fromEntries(
  forwarded.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
);
env.ANTHROPIC_API_KEY = modelKey;

async function execute(command, arguments_, title) {
  process.stderr.write(`${title}\n`);
  const child = spawn(command, arguments_, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
    shell: false,
  });
  const code = await new Promise((complete, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => complete(exitCode ?? 1));
  });
  if (code !== 0) {
    process.stderr.write(
      `${title} exited with status ${code}. Use the recovery command above if one was printed.\n`,
    );
    process.exit(code);
  }
}

await execute("pnpm", ["build"], "Building the local agent and test adapter…");
const cli = resolve("node_modules/@firedrill-run/cloud/dist/bin.js");
if (selection === "resume") {
  await execute(
    process.execPath,
    [cli, "run", "--project", project, "--resume", resolve(recoveryPath)],
    "Resuming the exact saved Firedrill test request…",
  );
  process.exit(0);
}
for (const [scope, setup, config] of [
  ["core", coreSetup, "firedrill.core.config.json"],
  ["stripe", stripeSetup, "firedrill.stripe.config.json"],
]) {
  if (selection !== "all" && selection !== scope) continue;
  await execute(
    process.execPath,
    [cli, "run", "--project", project, "--setup", setup, "--config", config],
    `Running isolated ${scope} tests against Firedrill…`,
  );
}
