/**
 * Captures the `tools/list` surface of the installed @hubspot/mcp-server into
 * test/fixtures/surfaces/hubspot-mcp-<version>.json. Read-only and offline.
 *
 *   pnpm exec tsx scripts/surfaces/capture-hubspot-mcp.ts
 *   pnpm exec biome format --write test/fixtures/surfaces
 *
 * - Launches the server exactly as production does (src/integrations/hubspot/launch.ts)
 *   with a dummy token, so HubSpot is never authenticated against.
 * - Preloads test/support/deny-network.mjs in the child. Any non-loopback connection
 *   attempt aborts the capture and nothing is written.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  buildHubSpotStdioLaunch,
  describeHubSpotStdioLaunch,
} from "../../src/integrations/hubspot/launch.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DENY_MARKER = "[deny-network] blocked";
// Obviously fake and never valid for HubSpot; 0.4.0 only requires a non-empty value.
const DUMMY_TOKEN = "revenue-desk-surface-capture-not-a-token";

async function main(): Promise<void> {
  const launch = buildHubSpotStdioLaunch({ accessToken: DUMMY_TOKEN });
  if (launch.source.kind !== "bundled") throw new Error("expected the bundled server");
  const version = launch.source.version;
  process.stderr.write(`launch: ${JSON.stringify(describeHubSpotStdioLaunch(launch))}\n`);

  const denyNetwork = pathToFileURL(join(repoRoot, "test/support/deny-network.mjs")).href;
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    env: { ...launch.env, NODE_OPTIONS: `--import=${denyNetwork}` },
    ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const client = new Client({ name: "revenue-desk-surface-capture", version: "0.0.0" });
  await client.connect(transport);
  const serverInfo = client.getServerVersion();
  const capabilities = client.getServerCapabilities();
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor === undefined ? {} : { cursor });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  await client.close();

  if (stderr.includes(DENY_MARKER)) {
    const attempts = stderr.split("\n").filter((line) => line.includes(DENY_MARKER));
    throw new Error(
      `the server tried to reach the network during tools/list:\n${attempts.join("\n")}`,
    );
  }

  const names = tools.map((tool) => tool.name);
  if (new Set(names).size !== names.length) throw new Error("duplicate tool names");

  const serverDeps = resolvedServerDependencies(launch.source.binPath);

  const fixture = {
    schemaVersion: 1,
    surface: "hubspot-mcp",
    capturedAt: new Date().toISOString(),
    source: {
      package: "@hubspot/mcp-server",
      version,
      license: "MIT",
      tarball: `https://registry.npmjs.org/@hubspot/mcp-server/-/mcp-server-${version}.tgz`,
      integrity: lockfileIntegrity(version),
      resolvedDependencies: serverDeps,
      method:
        "tools/list over stdio. Launched by src/integrations/hubspot/launch.ts (process.execPath + " +
        "resolved bin, explicit env) with a dummy PRIVATE_APP_ACCESS_TOKEN and " +
        "test/support/deny-network.mjs preloaded; zero outbound connection attempts.",
      script: "scripts/surfaces/capture-hubspot-mcp.ts",
    },
    server: {
      name: serverInfo?.name ?? null,
      version: serverInfo?.version ?? null,
      capabilities: capabilities ?? null,
    },
    toolCount: tools.length,
    tools,
  };

  const out = join(repoRoot, `test/fixtures/surfaces/hubspot-mcp-${version}.json`);
  writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
  process.stderr.write(`wrote ${out}\n${tools.length} tools\n`);
}

function lockfileIntegrity(version: string): string | null {
  const lock = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
  const pattern = new RegExp(
    `'@hubspot/mcp-server@${version.replaceAll(".", "\\.")}':\\s*\\n\\s*resolution: \\{integrity: ([^}]+)\\}`,
  );
  return pattern.exec(lock)?.[1]?.trim() ?? null;
}

/** Versions the child actually loads (it resolves from its real path under node_modules/.pnpm). */
function resolvedServerDependencies(binPath: string): Record<string, string> {
  const script = [
    "const { createRequire } = require('node:module');",
    "const { readFileSync, realpathSync } = require('node:fs');",
    "const { join, relative } = require('node:path');",
    "const req = createRequire(process.argv[1]);",
    "const out = {};",
    "for (const name of ['@modelcontextprotocol/sdk', 'zod', 'zod-to-json-schema', 'dotenv']) {",
    "  out[name] = 'unresolved';",
    "  for (const dir of req.resolve.paths(name) ?? []) {",
    "    try { const file = join(dir, name, 'package.json');",
    "      const p = JSON.parse(readFileSync(file, 'utf8'));",
    "      out[name] = p.version + ' (' + relative(process.cwd(), realpathSync(file)) + ')'; break;",
    "    } catch {}",
    "  }",
    "}",
    "process.stdout.write(JSON.stringify(out));",
  ].join("\n");
  const raw = execFileSync(process.execPath, ["-e", script, binPath], {
    encoding: "utf8",
    cwd: repoRoot,
  });
  return JSON.parse(raw) as Record<string, string>;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `capture failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
