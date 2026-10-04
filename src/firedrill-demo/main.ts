/** Local opt-in UI against synthetic Tools. Never imported by production main. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunTurn } from "../agent/run-turn.js";
import { createRedactor } from "../config/redact.js";
import { stateDirUsageBaselines } from "../db/usage-baseline.js";
import { listeningLines } from "../server/app.js";
import { startServer } from "../server/runtime.js";
import {
  createFiredrillDemoCatalog,
  type DemoBindings,
  FIREDRILL_NATIVE_UPSTREAMS,
} from "./catalog.js";
import { connectDemoMcpUpstream } from "./mcp-startup.js";
import { demoAgentEnvironment, demoBindingsFromEnvironment } from "./runtime.js";

async function preflight(bindings: DemoBindings): Promise<void> {
  const upstream = await connectDemoMcpUpstream({
    transport: "http",
    url: bindings.core.worldMcpUrl,
    headers: { Authorization: `Bearer ${bindings.core.credential}` },
  });
  try {
    const advertised = new Set(upstream.tools.map((tool) => tool.name));
    const missing = [...new Set(Object.values(FIREDRILL_NATIVE_UPSTREAMS))].filter(
      (name) => !advertised.has(name),
    );
    if (missing.length > 0) {
      throw new Error(`Synthetic Tool surface is incomplete: ${missing.join(", ")}`);
    }
    for (const name of [
      "hubspot-list-objects",
      "hubspot-search-objects",
      "hubspot-batch-create-objects",
    ])
      if (!advertised.has(name)) throw new Error(`Synthetic HubSpot operation is missing: ${name}`);
  } finally {
    await upstream.close();
  }
  const stripe = await fetch(`${bindings.stripe.worldWireHttpUrl}/v1/balance`, {
    headers: {
      [bindings.stripe.worldWireAuthorizationHeader]: `Bearer ${bindings.stripe.credential}`,
      Authorization: `Bearer ${bindings.stripe.credential}`,
    },
  });
  if (!stripe.ok) throw new Error(`Synthetic Stripe balance probe failed: HTTP ${stripe.status}`);
}

async function main(): Promise<void> {
  const bindings = demoBindingsFromEnvironment();
  const env = demoAgentEnvironment();
  await preflight(bindings);
  const catalog = createFiredrillDemoCatalog(bindings);
  const webRoot = fileURLToPath(new URL("../web", import.meta.url));
  const running = await startServer({
    env,
    runTurn: createRunTurn({
      catalog,
      version: "0.0.0-firedrill-demo",
      connectUpstream: connectDemoMcpUpstream,
      usageStore: stateDirUsageBaselines,
    }),
    integrations: Object.values(catalog),
    redact: createRedactor(env),
    version: "0.0.0-firedrill-demo",
    webRoot,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  for (const line of listeningLines(running.url, existsSync(join(webRoot, "index.html"))))
    process.stderr.write(`${line}\n`);
  process.stderr.write(
    "Synthetic Tool mode: Gmail, Calendar, QuickBooks, Slack, HubSpot and Stripe; no real provider credentials.\n",
  );
  const expiresAt = Math.min(bindings.core.expiresAtMs, bindings.stripe.expiresAtMs);
  process.stderr.write(
    `World access expires at ${new Date(expiresAt).toISOString()}. Restart this command to renew.\n`,
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void running.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  setTimeout(
    () => {
      process.stderr.write("Synthetic Tool binding expired; stopping. Restart to renew it.\n");
      stop();
    },
    Math.max(1, expiresAt - Date.now()),
  ).unref();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Revenue Desk synthetic demo could not start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
