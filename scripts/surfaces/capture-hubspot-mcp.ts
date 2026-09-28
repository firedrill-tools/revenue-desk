/**
 * Captures the `tools/list` surface of the installed @hubspot/mcp-server into
 * test/fixtures/surfaces/hubspot-mcp-<version>.json. Read-only and offline.
 *
 *   pnpm exec tsx scripts/surfaces/capture-hubspot-mcp.ts [--firedrill-tools <dir>]
 *   pnpm exec biome format --write test/fixtures/surfaces
 *
 * - Launches the server exactly as production does (src/integrations/hubspot/launch.ts)
 *   with a dummy token, so HubSpot is never authenticated against.
 * - Preloads test/support/deny-network.mjs in the child. Any non-loopback connection
 *   attempt aborts the capture and nothing is written.
 * - Compares the captured names with the Firedrill HubSpot Tool's MCP aliases, read
 *   from a local firedrill-tools checkout (read-only; default ../firedrill-tools).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
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

interface FiredrillOperation {
  id: string;
  inputSchema: unknown;
  mcp?: { name: string; description?: string };
}

const { values } = parseArgs({
  options: {
    "firedrill-tools": { type: "string", default: resolve(repoRoot, "../firedrill-tools") },
  },
});

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

  const firedrill = compareWithFiredrill(values["firedrill-tools"], tools);
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
    firedrillAliasComparison: firedrill,
  };

  const out = join(repoRoot, `test/fixtures/surfaces/hubspot-mcp-${version}.json`);
  writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
  process.stderr.write(
    `wrote ${out}\n${tools.length} tools; Firedrill aliases matched ` +
      `${firedrill.matched.length}/${firedrill.aliases.length}\n`,
  );
}

function compareWithFiredrill(firedrillToolsDir: string, tools: readonly Tool[]) {
  const packageDir = join(firedrillToolsDir, "packages/hubspot");
  const manifestPath = join(packageDir, "firedrill/tools/hubspot/hubspot.tool.json");
  const document = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    manifest: { id: string; version: string; operations: FiredrillOperation[] };
  };
  const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  const commit = execFileSync("git", ["-C", firedrillToolsDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const aliases = document.manifest.operations
    .filter((operation) => operation.mcp !== undefined)
    .map((operation) => ({ name: operation.mcp?.name ?? "", operation: operation.id }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const matched = aliases
    .filter((alias) => byName.has(alias.name))
    .map((alias) => {
      const hubspot = flattenSchema(byName.get(alias.name)?.inputSchema);
      const operation = document.manifest.operations.find((op) => op.id === alias.operation);
      const firedrillSchema = flattenSchema(operation?.inputSchema);
      return {
        name: alias.name,
        firedrillOperation: `hubspot.${alias.operation}`,
        hubspotShapedArgumentsRejectedByFiredrill: incompatibilities(hubspot, firedrillSchema),
        firedrillShapedArgumentsRejectedByHubSpot: incompatibilities(firedrillSchema, hubspot),
      };
    });

  const aliasNames = new Set(aliases.map((alias) => alias.name));
  return {
    source: {
      repository: "firedrill-tools (local checkout, read-only)",
      commit,
      package: packageJson.name,
      packageVersion: packageJson.version,
      manifestVersion: document.manifest.version,
      manifest: "packages/hubspot/firedrill/tools/hubspot/hubspot.tool.json",
    },
    method:
      "Input schemas flattened to property paths (anyOf branches merged). A line means an " +
      "argument valid for one side's schema fails the other's: an unknown property under " +
      "additionalProperties:false, a required property the other side lacks or leaves " +
      "optional, a JSON type or an enum value the other side does not allow.",
    aliases: aliases.map((alias) => alias.name),
    matched,
    aliasesNotInServer: aliases.filter((a) => !byName.has(a.name)).map((a) => a.name),
    serverToolsWithoutAlias: tools.map((t) => t.name).filter((name) => !aliasNames.has(name)),
  };
}

interface SchemaNode {
  types: Set<string>;
  properties: Set<string>;
  required: Set<string>;
  closed: boolean;
  enumValues: Set<string> | null;
}

/** Flattens a JSON Schema into property paths ("$", "$.a", "$.a[]", "$.m{}"), merging anyOf/oneOf. */
function flattenSchema(schema: unknown): Map<string, SchemaNode> {
  const nodes = new Map<string, SchemaNode>();
  const visit = (value: unknown, path: string): void => {
    if (value === null || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    for (const key of ["anyOf", "oneOf"] as const) {
      const branches = node[key];
      if (Array.isArray(branches)) for (const branch of branches) visit(branch, path);
    }
    const entry = nodes.get(path) ?? {
      types: new Set<string>(),
      properties: new Set<string>(),
      required: new Set<string>(),
      closed: false,
      enumValues: null,
    };
    nodes.set(path, entry);
    const type = node.type;
    for (const t of Array.isArray(type) ? type : type === undefined ? [] : [type]) {
      entry.types.add(String(t));
    }
    if (Array.isArray(node.enum)) {
      entry.enumValues ??= new Set();
      for (const v of node.enum) entry.enumValues.add(JSON.stringify(v));
    }
    if (node.properties !== null && typeof node.properties === "object") {
      entry.types.add("object");
      for (const [key, child] of Object.entries(node.properties)) {
        entry.properties.add(key);
        visit(child, `${path}.${key}`);
      }
      if (Array.isArray(node.required)) for (const key of node.required) entry.required.add(key);
      if (node.additionalProperties === false) entry.closed = true;
    }
    if (node.additionalProperties !== null && typeof node.additionalProperties === "object") {
      visit(node.additionalProperties, `${path}{}`);
    }
    if (node.items !== null && typeof node.items === "object") visit(node.items, `${path}[]`);
  };
  visit(schema, "$");
  return nodes;
}

/** Ways an argument valid under `from` can be invalid under `to`. */
function incompatibilities(from: Map<string, SchemaNode>, to: Map<string, SchemaNode>): string[] {
  const issues: string[] = [];
  for (const [path, source] of from) {
    const target = to.get(path);
    if (target === undefined) continue; // reported on the parent as an unknown property
    for (const key of source.properties) {
      if (!target.properties.has(key) && target.closed) {
        issues.push(`${path}.${key}: unknown property (additionalProperties false)`);
      }
    }
    for (const key of target.required) {
      if (!source.properties.has(key))
        issues.push(`${path}.${key}: required, absent in the other schema`);
      else if (!source.required.has(key))
        issues.push(`${path}.${key}: required, optional in the other schema`);
    }
    if (source.types.size > 0 && target.types.size > 0) {
      for (const type of source.types) {
        const accepted =
          target.types.has(type) || (type === "integer" && target.types.has("number"));
        if (!accepted) issues.push(`${path}: type ${type} not accepted`);
      }
    }
    if (target.enumValues !== null) {
      if (source.enumValues === null) issues.push(`${path}: restricted to an enum`);
      else {
        const extra = [...source.enumValues].filter((value) => !target.enumValues?.has(value));
        if (extra.length > 0) issues.push(`${path}: enum values ${extra.join(", ")} not accepted`);
      }
    }
  }
  return issues.sort();
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
