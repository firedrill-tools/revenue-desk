/**
 * Starts the real @hubspot/mcp-server through src/integrations/hubspot/launch.ts.
 * Every child preloads test/support/deny-network.mjs, so no test here can
 * reach HubSpot: a call to a non-loopback host is blocked and reported on
 * stderr. Calls that really reach HubSpot with a token are in
 * `pnpm test:live` (test/live/connections.test.ts, test/live/read-only.test.ts).
 *
 * The one loopback HTTP server below only records request paths and answers
 * 404 to everything: it shows where the server sends a call, and pretends
 * to be nothing.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildHubSpotStdioLaunch,
  type HubSpotStdioLaunch,
} from "../../src/integrations/hubspot/launch.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const DENY_NETWORK = pathToFileURL(join(repoRoot, "test/support/deny-network.mjs")).href;
const DENY_MARKER = "[deny-network] blocked";
const TOKEN = "integration-dummy-token";

interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: string;
}

interface Session {
  client: Client;
  stderr: () => string;
  close: () => Promise<void>;
}

async function start(
  launch: HubSpotStdioLaunch,
  overrides: { cwd?: string; env?: Record<string, string> } = {},
): Promise<Session> {
  const env = { ...(overrides.env ?? launch.env), NODE_OPTIONS: `--import=${DENY_NETWORK}` };
  const cwd = overrides.cwd ?? launch.cwd;
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    env,
    ...(cwd === undefined ? {} : { cwd }),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const client = new Client({ name: "revenue-desk-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr, close: () => client.close() };
}

let recorder: Server;
let recorderUrl: string;
const requests: RecordedRequest[] = [];

beforeAll(async () => {
  recorder = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        authorization: req.headers.authorization,
        body,
      });
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
  });
  await new Promise<void>((done) => recorder.listen(0, "127.0.0.1", done));
  recorderUrl = `http://127.0.0.1:${(recorder.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => recorder.close(() => done()));
});

describe("HubSpot MCP server launched over stdio", () => {
  it("lists exactly the captured 0.4.0 tool surface without any network attempt", async () => {
    const fixture = JSON.parse(
      readFileSync(join(repoRoot, "test/fixtures/surfaces/hubspot-mcp-0.4.0.json"), "utf8"),
    ) as { tools: Tool[] };
    const launch = buildHubSpotStdioLaunch({ accessToken: TOKEN });
    const session = await start(launch);
    try {
      const listed = await session.client.listTools();
      expect(listed.nextCursor).toBeUndefined();
      expect(listed.tools).toEqual(fixture.tools);
    } finally {
      await session.close();
    }
    expect(session.stderr()).not.toContain(DENY_MARKER);
  });

  it("runs with the network guard active (a non-loopback base URL is blocked)", async () => {
    const launch = buildHubSpotStdioLaunch({
      accessToken: TOKEN,
      apiBaseUrl: "https://hubspot-surface.invalid",
    });
    const session = await start(launch);
    try {
      const result = (await session.client.callTool({
        name: "hubspot-list-objects",
        arguments: { objectType: "contacts" },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
    } finally {
      await session.close();
    }
    expect(session.stderr()).toContain(`${DENY_MARKER} hubspot-surface.invalid:443`);
  });

  it("ignores a .env file in the child's working directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "revenue-desk-hubspot-dotenv-"));
    try {
      writeFileSync(join(dir, ".env"), `BASE_URL_OVERRIDE=${recorderUrl}/from-dotenv\n`);
      const launch = buildHubSpotStdioLaunch({ accessToken: TOKEN });

      // Control: without the dotenv guard, 0.4.0 reads the .env and follows it.
      requests.length = 0;
      const { DOTENV_CONFIG_PATH: _unused, ...unguarded } = launch.env;
      const exposed = await start(launch, { cwd: dir, env: unguarded });
      try {
        await exposed.client.callTool({
          name: "hubspot-list-objects",
          arguments: { objectType: "contacts" },
        });
      } finally {
        await exposed.close();
      }
      expect(requests.some((r) => r.path.startsWith("/from-dotenv/"))).toBe(true);

      // With the launch environment, the .env is not read: the call targets the
      // default HubSpot host, which the guard blocks, and the recorder sees nothing.
      requests.length = 0;
      const guarded = await start(launch, { cwd: dir });
      try {
        const result = (await guarded.client.callTool({
          name: "hubspot-list-objects",
          arguments: { objectType: "contacts" },
        })) as CallToolResult;
        expect(result.isError).toBe(true);
      } finally {
        await guarded.close();
      }
      expect(requests).toEqual([]);
      expect(guarded.stderr()).toContain(`${DENY_MARKER} api.hubspot.com:443`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
