#!/usr/bin/env node
/**
 * Customer-owned SDK runner for the Revenue Desk demo.
 *
 * Commands execute the existing real agent target with a case-scoped binding.
 * Browser mode selects saved, service-managed browser tests: their native Tool
 * screenshots come from Firedrill, not from this script or an unrelated session.
 * Neither path creates datasets, publishes source, changes policy, or loads .env.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FiredrillClient, runSimulation, SimulationRecoveryError } from "@firedrill-run/cloud";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputLimit = 2_000_000;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** @param {unknown} value */
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** @param {string} name @param {number} fallback @param {number} maximum */
function numberOption(name, fallback, maximum) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

/** @param {string} name @param {string[]} fallback @returns {string[]} */
function listOption(name, fallback) {
  const values = process.env[name] === undefined ? fallback : JSON.parse(process.env[name]);
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > 100 ||
    values.some((value) => typeof value !== "string" || !identifier.test(value)) ||
    new Set(values).size !== values.length
  ) {
    throw new Error(`${name} must be a JSON array of unique test or seed identifiers`);
  }
  return values;
}

function seedOption() {
  const values =
    process.env.FIREDRILL_DEMO_SEEDS === undefined
      ? ["42"]
      : JSON.parse(process.env.FIREDRILL_DEMO_SEEDS);
  const maximum = (1n << 64n) - 1n;
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > 100 ||
    values.some(
      (value) =>
        typeof value !== "string" ||
        !/^(0|[1-9]\d*)$/.test(value) ||
        value.length > 20 ||
        BigInt(value) > maximum,
    ) ||
    new Set(values).size !== values.length
  ) {
    throw new Error("FIREDRILL_DEMO_SEEDS must be a JSON array of unique uint64 decimal strings");
  }
  return values;
}

/** JSON-only recursive credential filtering. @param {any} value @param {string[]} secrets @returns {any} */
function redact(value, secrets) {
  if (typeof value === "string") {
    return secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (object(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [redact(key, secrets), redact(child, secrets)]),
    );
  }
  return value;
}

/** @param {string} path @param {unknown} value */
async function privateJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

/** @param {string} code @param {string} message @returns {import('@firedrill-run/cloud').HostedTargetResult} */
function failed(code, message) {
  return {
    schemaVersion: 1,
    status: "failed",
    attachments: [],
    error: {
      schemaVersion: 1,
      source: "target",
      code: `target.${code}`,
      message,
      retryable: false,
      issues: [],
    },
  };
}

/**
 * No control credential or live vendor credential is passed to the agent.
 * @param {string} scope @param {string} artifactRoot @param {string} controlCredential
 * @param {string} modelKey @returns {import('@firedrill-run/cloud').SimulationTarget}
 */
function agentTarget(scope, artifactRoot, controlCredential, modelKey) {
  return async (context) => {
    context.signal.throwIfAborted();
    if (
      context.interaction.actorId !== "local-dev" ||
      context.binding.actorId !== context.interaction.actorId ||
      context.binding.sessionId !== context.run.sessionId ||
      context.binding.buildHash !== context.run.buildHash ||
      context.binding.hostedRunId !== context.run.hostedRunId ||
      context.binding.interactionId !== context.interaction.id
    ) {
      throw new Error("The assigned case identity does not match its agent binding");
    }
    const http = new URL(context.binding.worldHttpUrl);
    if (
      http.protocol !== "https:" ||
      http.hostname !== "world.firedrill.run" ||
      http.port ||
      http.search ||
      http.hash ||
      http.username ||
      http.password
    ) {
      throw new Error("The case did not receive a production Firedrill Tool endpoint");
    }
    const env = Object.fromEntries(
      ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM"].flatMap(
        (name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]]),
      ),
    );
    Object.assign(env, {
      ANTHROPIC_API_KEY: modelKey,
      FIREDRILL_HTTP_URL: context.binding.worldHttpUrl,
      FIREDRILL_HTTP_TOKEN: context.binding.credential,
    });
    if (scope === "core") {
      if (!context.binding.worldMcpUrl) throw new Error("The core case needs an MCP binding");
      env.FIREDRILL_MCP_URL = context.binding.worldMcpUrl;
      env.FIREDRILL_MCP_TOKEN = context.binding.credential;
    }
    const secrets = [controlCredential, modelKey, context.binding.credential]
      .filter((value) => typeof value === "string" && value.length > 0)
      .sort((left, right) => right.length - left.length);
    context.capture.log(`Revenue Desk ${scope} agent started for this isolated case.`);
    const child = spawn(process.execPath, [resolve(repo, "dist/firedrill-demo/target.js"), scope], {
      cwd: repo,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    /** @type {NodeJS.Timeout | undefined} */
    let forceKill;
    let startFailed = false;
    let exceeded = false;
    /** @param {NodeJS.Signals} signal */
    const kill = (signal) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (
          error === null ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "ESRCH"
        )
          child.kill(signal);
      }
    };
    const stop = () => {
      kill("SIGTERM");
      forceKill ??= setTimeout(() => kill("SIGKILL"), 2000);
      forceKill.unref();
    };
    /** @type {Record<'stdout' | 'stderr', Buffer[]>} */
    const chunks = { stdout: [], stderr: [] };
    const bytes = { stdout: 0, stderr: 0 };
    for (const stream of /** @type {const} */ (["stdout", "stderr"])) {
      child[stream].on("data", (chunk) => {
        bytes[stream] += chunk.length;
        if (bytes[stream] > outputLimit) {
          exceeded = true;
          stop();
        } else chunks[stream].push(chunk);
      });
    }
    child.stdin.on("error", () => {});
    context.signal.addEventListener("abort", stop, { once: true });
    const outcome = await new Promise(
      /** @param {(value: {code: number | null, signal: NodeJS.Signals | null}) => void} complete */ (
        complete,
      ) => {
        child.once("error", () => {
          startFailed = true;
        });
        child.once("close", (code, signal) => complete({ code, signal }));
        child.stdin.end(
          JSON.stringify({
            schemaVersion: 1,
            runId: context.run.request.runId,
            interactionId: context.interaction.id,
            actorId: context.interaction.actorId,
            instruction: context.interaction.task.instruction,
            ...(context.interaction.task.input === undefined
              ? {}
              : { input: context.interaction.task.input }),
          }),
        );
        if (context.signal.aborted) stop();
      },
    ).finally(() => {
      context.signal.removeEventListener("abort", stop);
      // A closed leader does not prove all its child processes have stopped.
      kill("SIGKILL");
      if (forceKill) clearTimeout(forceKill);
    });
    const log = redact(Buffer.concat(chunks.stderr).toString("utf8"), secrets);
    const points = Array.from(log);
    for (let offset = 0; offset < points.length; offset += 4096) {
      context.capture.log(points.slice(offset, offset + 4096).join(""));
    }
    context.signal.throwIfAborted();
    if (startFailed)
      return failed("COMMAND_START_FAILED", "The Revenue Desk agent target could not start.");
    if (exceeded)
      return failed("COMMAND_OUTPUT_LIMIT", "Agent output exceeded the bounded capture limit.");
    if (outcome.code !== 0)
      return failed("COMMAND_EXIT_FAILED", "The Revenue Desk target process did not complete.");
    let result;
    try {
      result = redact(JSON.parse(Buffer.concat(chunks.stdout).toString("utf8")), secrets);
    } catch {
      return failed(
        "COMMAND_RESULT_INVALID",
        "The agent did not return one valid TargetResult JSON value.",
      );
    }
    if (
      !object(result) ||
      result.schemaVersion !== 1 ||
      !["completed", "failed"].includes(result.status) ||
      !Array.isArray(result.attachments) ||
      result.attachments.length !== 0
    ) {
      return failed(
        "COMMAND_RESULT_INVALID",
        "The agent target result did not match its versioned contract.",
      );
    }
    const caseName = `${scope}-${context.run.hostedRunId.slice(0, 60)}-${randomUUID()}`;
    if (!identifier.test(context.run.hostedRunId) || !identifier.test(context.interaction.id)) {
      throw new Error("The assigned case contains an invalid capture identifier");
    }
    const file = join(artifactRoot, `${caseName}.json`);
    await privateJson(file, {
      schemaVersion: 1,
      provenance: "customer-agent-runner",
      projectId: context.run.projectId,
      environmentId: context.run.environmentId,
      hostedRunId: context.run.hostedRunId,
      interactionId: context.interaction.id,
      targetResult: result,
    });
    context.capture.file({
      path: relative(repo, file),
      name: `${caseName}.json`,
      mediaType: "application/json",
      redaction: {
        status: "applied_by_caller",
        note: "Control, model and case credentials were removed before capture.",
      },
    });
    context.capture.log(
      `Revenue Desk returned ${result.status}. Firedrill evaluates the saved world checks.`,
    );
    return result;
  };
}

async function main() {
  const args = process.argv.slice(2);
  const scope = args.shift();
  const browser = args.includes("--browser");
  const check = args.includes("--check");
  const resumeIndex = args.indexOf("--resume");
  const resumePath = resumeIndex < 0 ? undefined : args[resumeIndex + 1];
  const allowed = new Set(["--browser", "--check", "--resume", resumePath]);
  if (
    (scope !== "core" && scope !== "stripe") ||
    args.some((arg) => !allowed.has(arg)) ||
    (resumeIndex >= 0 && (!resumePath || check))
  ) {
    throw new Error(
      "Usage: node scripts/demo-cto-sdk.mjs core|stripe [--browser] [--check] [--resume CHECKPOINT_FILE]",
    );
  }
  const projectId = process.env.FIREDRILL_DEMO_PROJECT_ID;
  const toolSetupId = process.env[`FIREDRILL_DEMO_${scope.toUpperCase()}_TEST_SETUP_ID`];
  if (typeof projectId !== "string" || !/^prj_[a-z0-9]+$/.test(projectId))
    throw new Error("Set FIREDRILL_DEMO_PROJECT_ID");
  if (typeof toolSetupId !== "string" || !/^setup_[a-z0-9]+$/.test(toolSetupId)) {
    throw new Error(`Set FIREDRILL_DEMO_${scope.toUpperCase()}_TEST_SETUP_ID`);
  }
  const config = JSON.parse(
    await readFile(resolve(repo, `firedrill.${scope}.config.json`), "utf8"),
  );
  const drillIds = listOption("FIREDRILL_DEMO_DRILL_IDS", config.drillIds);
  const seeds = seedOption();
  const repetitions = numberOption("FIREDRILL_DEMO_REPETITIONS", 1, 100);
  const concurrency = numberOption("FIREDRILL_DEMO_CONCURRENCY", 1, 32);
  const waitTimeoutMs = numberOption("FIREDRILL_DEMO_WAIT_TIMEOUT_MS", 1_800_000, 86_400_000);
  /** @type {import('@firedrill-run/cloud').SimulationBrowserInvocation[] | undefined} */
  let browserInvocations;
  if (browser) {
    const inline = process.env.FIREDRILL_DEMO_BROWSER_INVOCATIONS;
    const file = process.env.FIREDRILL_DEMO_BROWSER_INVOCATIONS_FILE;
    if ((inline !== undefined) === (file !== undefined)) {
      throw new Error(
        "Set exactly one FIREDRILL_DEMO_BROWSER_INVOCATIONS or FIREDRILL_DEMO_BROWSER_INVOCATIONS_FILE",
      );
    }
    browserInvocations = JSON.parse(inline ?? (await readFile(resolve(file ?? ""), "utf8")));
    if (
      !Array.isArray(browserInvocations) ||
      browserInvocations.length === 0 ||
      browserInvocations.length > 100 ||
      browserInvocations.some((item) => !object(item))
    ) {
      throw new Error(
        "Browser invocations must be a nonempty bounded JSON array of saved browser-test selections",
      );
    }
    for (const item of browserInvocations) {
      if (
        !identifier.test(item.targetId) ||
        !identifier.test(item.testId) ||
        !Number.isSafeInteger(item.expectedTestVersion) ||
        item.expectedTestVersion < 1 ||
        item.role?.kind !== "tool_ui" ||
        !identifier.test(item.role.packageId) ||
        (item.mode !== undefined && item.mode !== "replay")
      ) {
        throw new Error(
          "Browser mode needs exact saved replay tests, versions, targets and Tool UI roles",
        );
      }
      if (item.captureConsent !== "include-sensitive-content" && !item.captureMask?.length) {
        throw new Error(
          "Browser capture needs explicit captureConsent or captureMask in its saved-test selection",
        );
      }
    }
    browserInvocations = browserInvocations.map((item) => ({
      ...item,
      mode: "replay",
      timeoutMs: item.timeoutMs ?? 90_000,
      maxActions: item.maxActions ?? 20,
      capture: { screenshot: "always", trace: "always", video: "off", ...item.capture },
    }));
  } else {
    await access(resolve(repo, "dist/firedrill-demo/target.js"));
    await access(resolve(repo, "dist/firedrill-demo/cli.js"));
  }
  const targetId = process.env.FIREDRILL_DEMO_TARGET_ID ?? `revenue-desk-${scope}`;
  if (!identifier.test(targetId))
    throw new Error("FIREDRILL_DEMO_TARGET_ID must be a test target identifier");
  const selection = {
    toolSetupId,
    drillIds,
    seeds,
    repetitions,
    concurrency,
    retries: 0,
    ...(browser ? { browserInvocations } : {}),
  };
  if (check) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          checked: true,
          mode: browser ? "managed-browser" : "customer-agent",
          scope,
          projectId,
          selection,
          targetId: browser ? null : targetId,
          productionRequestsMade: 0,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const credential = process.env.FIREDRILL_CREDENTIAL;
  const modelKey = process.env.ANTHROPIC_API_KEY;
  if (!credential?.trim()) throw new Error("Set FIREDRILL_CREDENTIAL in the runner environment");
  if (!browser && !modelKey?.trim())
    throw new Error("Set ANTHROPIC_API_KEY for the customer-owned Revenue Desk agent");
  const apiOrigin = "https://api.firedrill.run";
  const client = new FiredrillClient({
    baseUrl: apiOrigin,
    token: credential,
    maxRetries: 0,
    timeoutInSeconds: 60,
  });
  /** @type {import('@firedrill-run/cloud').SimulationCheckpoint | undefined} */
  let resume;
  if (resumePath) {
    resume = JSON.parse(await readFile(resolve(resumePath), "utf8"));
    if (
      resume?.schemaVersion !== 1 ||
      resume.projectId !== projectId ||
      resume.apiOrigin !== apiOrigin ||
      resume.selection?.toolSetupId !== toolSetupId ||
      !Array.isArray(resume.targetIds) ||
      (!browser && (resume.targetIds.length !== 1 || resume.targetIds[0] !== targetId))
    ) {
      throw new Error("The checkpoint is not for this production project, setup and target");
    }
  }
  const artifactRoot = resolve(repo, ".firedrill", "cto-sdk", randomUUID());
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const checkpointPath = resolve(artifactRoot, "checkpoint.json");
  let checkpointWrites = Promise.resolve();
  /** @param {import('@firedrill-run/cloud').SimulationCheckpoint} checkpoint */
  const persistCheckpoint = (checkpoint) => {
    checkpointWrites = checkpointWrites.then(() => privateJson(checkpointPath, checkpoint));
    return checkpointWrites;
  };
  const abort = new AbortController();
  const stop = () => abort.abort(new Error("Customer runner stopped"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stderr.write(
    `Running ${scope} ${browser ? "saved browser tests" : "Revenue Desk tests"} through the SDK.\n`,
  );
  process.stderr.write(`Private recovery checkpoint: ${relative(repo, checkpointPath)}\n`);
  try {
    const batch = await runSimulation(client, {
      projectId,
      ...(resume ? { resume } : { selection }),
      ...(browser
        ? {}
        : {
            targets: { [targetId]: agentTarget(scope, artifactRoot, credential, modelKey ?? "") },
          }),
      capacity: concurrency,
      bindingMode: "per-case",
      signal: abort.signal,
      waitTimeoutMs,
      pollIntervalMs: 1000,
      root: repo,
      capture: {
        logs: "always",
        files: "always",
        screenshots: "always",
        video: "off",
        driverTimeoutMs: 30_000,
      },
      onCheckpoint: persistCheckpoint,
    });
    const receipt = {
      schemaVersion: 1,
      scope,
      mode: browser ? "managed-browser" : "customer-agent",
      projectId: batch.projectId,
      environmentId: batch.environmentId,
      batchId: batch.batchId,
      state: batch.state,
      conclusion: batch.conclusion ?? null,
      counts: batch.counts,
      resultsUrl: batch.resultsUrl,
      checkpointPath: relative(repo, checkpointPath),
      evidence: browser
        ? "Screenshots are produced by the saved managed browser tests."
        : "Actual agent replies and runner logs are attached; no Tool-app screenshot is claimed.",
    };
    await privateJson(resolve(artifactRoot, "receipt.json"), receipt);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    if (batch.conclusion !== "passed") process.exitCode = 1;
  } catch (error) {
    if (error instanceof SimulationRecoveryError && error.checkpoint) {
      await persistCheckpoint(error.checkpoint);
    }
    throw error;
  } finally {
    await checkpointWrites;
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

try {
  await main();
} catch (error) {
  const secrets = [process.env.FIREDRILL_CREDENTIAL, process.env.ANTHROPIC_API_KEY].filter(
    (value) => value !== undefined,
  );
  const message = error instanceof Error ? error.message : "SDK runner failed";
  const safe = redact(message, secrets)
    .replace(/https?:\/\/[^\s"<>]+/g, "[URL omitted]")
    .replace(/eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}/g, "[REDACTED]");
  process.stderr.write(`${safe}\n`);
  process.exitCode = 1;
}
