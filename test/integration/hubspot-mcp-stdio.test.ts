/**
 * Starts the real @hubspot/mcp-server through src/integrations/hubspot/launch.ts.
 * Every child preloads test/support/deny-network.mjs, so no test can reach HubSpot:
 * calls go to a loopback fake or are blocked and reported on stderr.
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

function text(result: CallToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

let fake: Server;
let fakeUrl: string;
const requests: RecordedRequest[] = [];

beforeAll(async () => {
  fake = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const path = req.url ?? "";
      requests.push({
        method: req.method ?? "",
        path,
        authorization: req.headers.authorization,
        body,
      });
      res.setHeader("content-type", "application/json");
      if (path.endsWith("/oauth/v2/private-apps/get/access-token-info")) {
        res.end(
          JSON.stringify({
            userId: 101,
            hubId: 202,
            appId: 303,
            scopes: ["crm.objects.contacts.read"],
          }),
        );
      } else if (path.endsWith("/account-info/v3/details")) {
        res.end(JSON.stringify({ portalId: 202, uiDomain: "app.hubspot.test" }));
      } else if (path.includes("/crm/v3/owners/101")) {
        res.end(JSON.stringify({ id: "9", userId: 101, email: "owner@kestrel.test" }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ status: "error", message: "not found" }));
      }
    });
  });
  await new Promise<void>((done) => fake.listen(0, "127.0.0.1", done));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => fake.close(() => done()));
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

  it("sends calls to apiBaseUrl with the token as a bearer credential", async () => {
    requests.length = 0;
    const launch = buildHubSpotStdioLaunch({
      accessToken: TOKEN,
      apiBaseUrl: `${fakeUrl}/prefix/`,
    });
    const session = await start(launch);
    try {
      const result = (await session.client.callTool({
        name: "hubspot-get-user-details",
        arguments: {},
      })) as CallToolResult;
      expect(result.isError).not.toBe(true);
      expect(text(result)).toContain("owner@kestrel.test");
    } finally {
      await session.close();
    }
    expect(requests.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      "GET /prefix/account-info/v3/details",
      "GET /prefix/crm/v3/owners/101?idProperty=userId&archived=false",
      "POST /prefix/oauth/v2/private-apps/get/access-token-info",
    ]);
    for (const request of requests) expect(request.authorization).toBe(`Bearer ${TOKEN}`);
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
      writeFileSync(join(dir, ".env"), `BASE_URL_OVERRIDE=${fakeUrl}/from-dotenv\n`);
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
      // default HubSpot host, which the guard blocks, and the fake sees nothing.
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
