// Read-only capture of the Composio direct_tools MCP surface for Gmail,
// Google Calendar, QuickBooks and Slack, written to
// test/fixtures/surfaces/composio-direct.json.
//
//   DOTENV_PATH=/abs/path/outside/repo/.env pnpm exec tsx scripts/surfaces/capture-composio-direct.ts
//   pnpm exec biome format --write test/fixtures/surfaces/composio-direct.json
//
// Options:
//   --out <path>            Fixture path (default test/fixtures/surfaces/composio-direct.json).
//   --sdk-default-logger    Give the Composio SDK its default console logger instead of
//                           stderr, to observe whether it writes anything to stdout.
//   --dry-run               Do everything except write the fixture.
//
// What it does, and nothing more:
//   1. Reads COMPOSIO_API_KEY and COMPOSIO_USER_ID from the DOTENV_PATH file
//      (parsed locally; process.env is not modified; values are never printed).
//   2. Checks every allowlisted slug against the Composio tool catalog (read-only).
//   3. Creates one Composio session (the four toolkits, the full allowlist,
//      sessionPreset direct_tools, no sandbox, mcp: true) and reads its
//      per-toolkit connection state.
//   4. Connects an MCP client to the session's hosted MCP URL and calls
//      tools/list only. No tool is called. No OAuth flow is started.
//   5. Passes the listed tools through an in-process MCP server and client, to
//      check the raw JSON schemas survive a proxy hop unchanged.
//   6. Reads each toolkit's public Connect facts (Composio-managed auth
//      schemes and the fields a new connection asks for), never an auth
//      config or connected account of this project.
//   7. Writes the fixture with nothing account-specific (no ids, emails, URLs
//      or tokens) and fails if any such value would be written.
// This script writes its own output to stderr only; stdout stays empty.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual, parseEnv } from "node:util";
import { Composio } from "@composio/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  buildSessionConfig,
  COMPOSIO_ALLOWLISTS,
  COMPOSIO_TOOLKITS,
  ComposioSessionManager,
  type ComposioToolkit,
  describeEndpoint,
  stderrComposioLogger,
} from "../../src/integrations/composio/session.js";

const log = (message: string) => process.stderr.write(`${message}\n`);

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const outPath = resolve(argValue("--out") ?? "test/fixtures/surfaces/composio-direct.json");
const useSdkDefaultLogger = process.argv.includes("--sdk-default-logger");
const dryRun = process.argv.includes("--dry-run");

function loadSecrets(): { apiKey: string; userId: string } {
  const path = process.env.DOTENV_PATH;
  if (!path) throw new Error("Set DOTENV_PATH to an env file outside the repository");
  const env = parseEnv(readFileSync(path, "utf8"));
  const apiKey = env.COMPOSIO_API_KEY;
  const userId = env.COMPOSIO_USER_ID;
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is missing from the DOTENV_PATH file");
  if (!userId) throw new Error("COMPOSIO_USER_ID is missing from the DOTENV_PATH file");
  return { apiKey, userId };
}

const selection = { toolkits: COMPOSIO_TOOLKITS, access: "outbound" as const };
const allowlisted = COMPOSIO_TOOLKITS.flatMap((toolkit) =>
  COMPOSIO_ALLOWLISTS[toolkit].map((entry) => ({ toolkit, ...entry })),
);

type ConnectFieldSource = {
  readonly name: string;
  readonly displayName?: string | undefined;
  readonly description?: string | undefined;
  readonly default?: string | null | undefined;
};

/** A field a new connection asks for: public toolkit metadata, never a value of this project. */
function connectField(field: ConnectFieldSource) {
  return {
    name: field.name,
    displayName: field.displayName ?? null,
    description: field.description ?? null,
    default: field.default ?? null,
  };
}

function toolkitOf(name: string): ComposioToolkit | null {
  for (const toolkit of COMPOSIO_TOOLKITS) {
    if (name.startsWith(`${toolkit.toUpperCase()}_`)) return toolkit;
  }
  return null;
}

async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await client.listTools(cursor ? { cursor } : {});
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

/** Serves `tools` from an in-process MCP server and lists them back. */
async function roundTripThroughProxy(tools: Tool[]): Promise<Tool[]> {
  const server = new Server(
    { name: "revenue-desk-proxy-check", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "revenue-desk-proxy-check", version: "0.0.0" });
  await client.connect(clientSide);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Reserved documentation domains (RFC 2606) only. Anything else fails the
// capture and is reported masked, so a person decides.
const EXAMPLE_EMAIL_DOMAIN = /@([a-z0-9-]+\.)*example\.(com|org|net)$/i;
const maskEmail = (email: string) => `${email.slice(0, 1)}***@${email.split("@")[1] ?? ""}`;

/** Known secret or account values, scrubbed from any message this script prints. */
const scrub: string[] = [];
const redact = (text: string) =>
  scrub.reduce((out, value) => (value ? out.split(value).join("[REDACTED]") : out), text);

/** Values that must never appear in the fixture. */
function assertNothingAccountSpecific(
  json: string,
  forbidden: string[],
  catalogText: string,
): void {
  for (const value of forbidden) {
    if (value && json.includes(value)) {
      throw new Error("Refusing to write the fixture: it contains an account-specific value");
    }
  }
  const ids = json.match(/\b(ca|ac|trs|sess)_[A-Za-z0-9]{6,}\b/g) ?? [];
  if (ids.length > 0)
    throw new Error(`Refusing to write the fixture: it contains ${ids.length} Composio id(s)`);
  const emails = [...new Set(json.match(EMAIL) ?? [])];
  // An address is generic documentation when it uses a reserved example domain
  // or appears verbatim in Composio's public tool catalog, which is the same
  // for every user. Anything else could be account data.
  const unexpected = emails.filter(
    (email) => !EXAMPLE_EMAIL_DOMAIN.test(email) && !catalogText.includes(email),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Refusing to write the fixture: it contains non-example email addresses: ${unexpected.map(maskEmail).join(", ")}`,
    );
  }
  if (emails.length > 0) {
    log(`note: ${emails.length} example address(es) kept; all appear in the public tool catalog`);
  }
}

async function main(): Promise<void> {
  const { apiKey, userId } = loadSecrets();
  scrub.push(apiKey, userId);
  const logger = useSdkDefaultLogger ? console : stderrComposioLogger;

  // 1. Catalog check (read-only).
  const catalogClient = new Composio({
    apiKey,
    disableVersionCheck: true,
    allowTracking: false,
    logger,
  });
  const catalog = await catalogClient.tools.getRawComposioTools({
    tools: allowlisted.map((entry) => entry.slug),
  });
  const catalogBySlug = new Map(catalog.map((tool) => [tool.slug, tool]));
  const missingFromCatalog = allowlisted.filter((entry) => !catalogBySlug.has(entry.slug));
  const deprecated = allowlisted.filter((entry) => catalogBySlug.get(entry.slug)?.isDeprecated);
  log(
    `catalog: ${catalogBySlug.size}/${allowlisted.length} allowlisted slugs found; missing ${missingFromCatalog.length}; deprecated ${deprecated.length}`,
  );

  // 2. Session and connection state.
  const manager = new ComposioSessionManager({ apiKey, userId, logger, selection });
  const status = await manager.connectionStatus();
  for (const toolkit of COMPOSIO_TOOLKITS) {
    const entry = status[toolkit];
    log(`connection ${toolkit}: ${entry.state} (${entry.accountStatus ?? "no account"})`);
  }
  const endpoint = await manager.mcpEndpoint();
  scrub.push(endpoint.url, new URL(endpoint.url).pathname, ...Object.values(endpoint.headers));
  const safeEndpoint = describeEndpoint(endpoint);
  log(
    `session MCP endpoint: type ${safeEndpoint.type}, host ${safeEndpoint.host}, header names ${Object.keys(endpoint.headers).sort().join(",")}`,
  );

  // 3. tools/list over the session's hosted MCP server.
  const url = new URL(endpoint.url);
  const requestInit = { headers: endpoint.headers };
  const transport =
    endpoint.type === "sse"
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit });
  const client = new Client({ name: "revenue-desk-capture", version: "0.0.0" });
  await client.connect(transport);
  const serverInfo = client.getServerVersion();
  const protocolVersion =
    transport instanceof StreamableHTTPClientTransport ? transport.protocolVersion : undefined;
  let listed: Tool[];
  try {
    listed = await listAllTools(client);
  } finally {
    await client.close();
  }
  const listedNames = listed.map((tool) => tool.name);
  const allowNames = new Set(allowlisted.map((entry) => entry.slug));
  const notListed = allowlisted
    .filter((entry) => !listedNames.includes(entry.slug))
    .map((e) => e.slug);
  const extra = listedNames.filter((name) => !allowNames.has(name));
  log(`tools/list: ${listed.length} tools (${listedNames.join(", ")})`);
  log(
    `allowlisted but not listed: ${notListed.join(", ") || "none"}; listed but not allowlisted: ${extra.join(", ") || "none"}`,
  );

  // 4. Proxy hop check.
  const echoed = await roundTripThroughProxy(listed);
  const proxyIntact = isDeepStrictEqual(echoed, listed);
  log(`in-process MCP proxy hop preserves tools/list exactly: ${proxyIntact}`);

  // 5. Public Connect facts per toolkit (the same for every Composio project).
  const connect: Record<string, unknown> = {};
  for (const toolkit of COMPOSIO_TOOLKITS) {
    const info = await catalogClient.toolkits.get(toolkit);
    connect[toolkit] = {
      composioManagedAuthSchemes: info.composioManagedAuthSchemes ?? [],
      authModes: (info.authConfigDetails ?? []).map((detail) => ({
        mode: detail.mode,
        connectionFields: [
          ...(detail.fields?.connectedAccountInitiation?.required ?? []).map((field) => ({
            ...connectField(field),
            required: true,
          })),
          ...(detail.fields?.connectedAccountInitiation?.optional ?? []).map((field) => ({
            ...connectField(field),
            required: false,
          })),
        ],
      })),
    };
  }
  log(
    `connect: ${COMPOSIO_TOOLKITS.map((toolkit) => `${toolkit} managed ${JSON.stringify((connect[toolkit] as { composioManagedAuthSchemes: string[] }).composioManagedAuthSchemes)}`).join("; ")}`,
  );

  // 6. Fixture.
  const metaKeys = [...new Set(listed.flatMap((tool) => Object.keys(tool._meta ?? {})))].sort();
  const toolkits = Object.fromEntries(
    COMPOSIO_TOOLKITS.map((toolkit) => [
      toolkit,
      {
        allowlist: COMPOSIO_ALLOWLISTS[toolkit],
        tools: listed
          .filter((tool) => toolkitOf(tool.name) === toolkit)
          .map((tool) => ({
            name: tool.name,
            ...(tool.title !== undefined ? { title: tool.title } : {}),
            description: tool.description,
            inputSchema: tool.inputSchema,
            ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
            ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
            catalog: {
              version: catalogBySlug.get(tool.name)?.version ?? null,
              deprecated: catalogBySlug.get(tool.name)?.isDeprecated ?? null,
              tags: catalogBySlug.get(tool.name)?.tags ?? [],
            },
          })),
        connect: connect[toolkit],
      },
    ]),
  );
  const fixture = {
    $comment:
      "Composio direct_tools MCP surface for Revenue Desk's Gmail, Google Calendar, QuickBooks and Slack allowlists, with each toolkit's public Connect facts. Captured read-only (tools/list only; no tool was called; no OAuth started). Account-specific values (ids, emails, URLs, tokens, connection states) are excluded. Regenerate with scripts/surfaces/capture-composio-direct.ts.",
    capturedAt: new Date().toISOString(),
    source: {
      sdk: "@composio/core 0.21.0",
      method:
        "composio.sessions.create(userId, config) then MCP tools/list on session.mcp.url; catalog metadata from composio.tools.getRawComposioTools; Connect facts from composio.toolkits.get",
      mcpClient: "@modelcontextprotocol/sdk 1.30.1",
      mcpTransport: safeEndpoint.type,
      mcpHost: safeEndpoint.host,
      mcpProtocolVersion: protocolVersion ?? null,
      mcpServer: serverInfo ? { name: serverInfo.name, version: serverInfo.version } : null,
      toolMetaKeysDropped: metaKeys,
    },
    sessionConfig: buildSessionConfig(selection),
    result: {
      listedCount: listed.length,
      allowlistedButNotListed: notListed,
      listedButNotAllowlisted: extra,
      proxyHopPreservesToolsList: proxyIntact,
    },
    toolkits,
  };
  const json = `${JSON.stringify(fixture, null, 2)}\n`;
  assertNothingAccountSpecific(
    json,
    [apiKey, userId, endpoint.url, url.pathname, ...Object.values(endpoint.headers)],
    JSON.stringify(catalog),
  );
  if (dryRun) {
    log(`dry run: fixture not written (${json.length} bytes)`);
  } else {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, json);
    log(`wrote ${outPath} (${json.length} bytes); format it with biome before committing`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  log(`capture failed: ${redact(message)}`);
  process.exitCode = 1;
});
