import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectUpstream,
  createFilteringProxy,
  type FilteringProxy,
} from "../../../src/gateway/mcp-proxy.js";
import type { GatewayCallEvent } from "../../../src/gateway/types.js";
import {
  CRM_INSTRUCTIONS,
  MAIL_TOOLS,
  readCallLog,
  startHttpUpstream,
  stdioUpstreamConfig,
} from "../../support/upstream-mcp.js";

const TOKEN = "unit-upstream-token";
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function mailProxy(options: { pageSize?: number; failing?: string } = {}) {
  const upstream = await startHttpUpstream({ token: TOKEN, tools: MAIL_TOOLS, ...options });
  cleanups.push(() => upstream.close());
  const connection = await connectUpstream({
    transport: "http",
    url: upstream.url,
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  cleanups.push(() => connection.close());
  const events: GatewayCallEvent[] = [];
  const proxy = createFilteringProxy({
    name: "gmail",
    upstream: connection,
    allow: ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_DRAFT", "GMAIL_NOT_OFFERED"],
    observer: (event) => events.push(event),
  });
  return { upstream, connection, proxy, events };
}

/** An MCP client talking to one proxy instance, the way the Claude CLI does. */
async function clientFor(proxy: FilteringProxy) {
  const config = proxy.serverConfig();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await config.instance.connect(serverSide);
  const client = new Client({ name: "unit", version: "1.0.0" });
  await client.connect(clientSide);
  cleanups.push(() => client.close());
  return { client, config };
}

describe("connectUpstream", () => {
  it("lists every page of an HTTP upstream's tools with its bearer header", async () => {
    const { upstream, connection } = await mailProxy({ pageSize: 1 });
    expect(connection.tools.map((tool) => tool.name)).toEqual(
      MAIL_TOOLS.map((fixture) => fixture.tool.name),
    );
    expect(upstream.unauthorized).toBe(0);
  });

  it("fails clearly when the HTTP upstream refuses the token", async () => {
    const upstream = await startHttpUpstream({ token: TOKEN, tools: MAIL_TOOLS });
    cleanups.push(() => upstream.close());
    await expect(
      connectUpstream({
        transport: "http",
        url: upstream.url,
        headers: { Authorization: "Bearer no" },
      }),
    ).rejects.toThrow(/could not connect to the http MCP server/);
    expect(upstream.unauthorized).toBeGreaterThan(0);
  });

  it("starts a stdio upstream and reads its instructions", { timeout: 20_000 }, async () => {
    const state = mkdtempSync(join(tmpdir(), "revenue-desk-proxy-"));
    cleanups.push(() => rmSync(state, { recursive: true, force: true }));
    const log = join(state, "calls.jsonl");
    const connection = await connectUpstream(
      stdioUpstreamConfig({ fixture: "crm", callLog: log, instructions: CRM_INSTRUCTIONS }),
    );
    cleanups.push(() => connection.close());
    expect(connection.instructions).toBe(CRM_INSTRUCTIONS);
    expect(connection.tools.map((tool) => tool.name)).toEqual([
      "search_contacts",
      "create_note",
      "delete_contact",
    ]);
    const proxy = createFilteringProxy({
      name: "hubspot",
      upstream: connection,
      allow: ["search_contacts"],
    });
    const { client } = await clientFor(proxy);
    await client.callTool({ name: "search_contacts", arguments: { query: "ana" } });
    expect(readCallLog(log)).toEqual([{ tool: "search_contacts", arguments: { query: "ana" } }]);
  });

  it("reports a stdio upstream that exits, with its stderr", { timeout: 20_000 }, async () => {
    await expect(
      connectUpstream({
        transport: "stdio",
        command: process.execPath,
        args: ["-e", "process.stderr.write('boom: missing token\\n'); process.exit(3)"],
      }),
    ).rejects.toThrow(/could not connect to the stdio MCP server[\s\S]*boom: missing token/);
  });
});

describe("createFilteringProxy", () => {
  it("lists only allowlisted tools with the upstream schemas unchanged", async () => {
    const { proxy } = await mailProxy();
    expect(proxy.missing).toEqual(["GMAIL_NOT_OFFERED"]);
    const { client, config } = await clientFor(proxy);
    expect(config).toMatchObject({ type: "sdk", name: "gmail", timeout: 120_000 });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["GMAIL_FETCH_EMAILS", "GMAIL_SEND_DRAFT"]);
    for (const tool of tools) {
      const upstream = MAIL_TOOLS.find((fixture) => fixture.tool.name === tool.name)?.tool;
      expect(tool.inputSchema).toEqual(upstream?.inputSchema);
      expect(tool.annotations).toEqual(upstream?.annotations);
      expect(tool.description).toBe(upstream?.description);
      expect(tool._meta).toEqual({ "anthropic/alwaysLoad": true });
    }
    expect(client.getInstructions()).toBeUndefined();
  });

  it("forwards name and arguments unchanged and returns the upstream result", async () => {
    const { upstream, proxy, events } = await mailProxy();
    const { client } = await clientFor(proxy);
    const args = { query: "from:ana@acme.test", max_results: 5, label_ids: ["INBOX"] };
    const result = await client.callTool({ name: "GMAIL_FETCH_EMAILS", arguments: args });
    expect(upstream.calls).toEqual([{ tool: "GMAIL_FETCH_EMAILS", arguments: args }]);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? "")).toMatchObject({
      received: args,
    });
    expect(events).toEqual([
      expect.objectContaining({
        server: "gmail",
        kind: "mcp",
        tool: "GMAIL_FETCH_EMAILS",
        arguments: args,
        isError: false,
      }),
    ]);
  });

  it("refuses a tool outside the allowlist without calling the upstream", async () => {
    const { upstream, proxy, events } = await mailProxy();
    const { client } = await clientFor(proxy);
    const result = await client.callTool({
      name: "GMAIL_DELETE_MESSAGE",
      arguments: { message_id: "m_1" },
    });
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Tool GMAIL_DELETE_MESSAGE is not available on gmail." }],
    });
    expect(upstream.calls).toEqual([]);
    expect(events).toEqual([]);
  });

  it("turns an upstream failure into an error result", async () => {
    const { proxy, events } = await mailProxy({ failing: "GMAIL_SEND_DRAFT" });
    const { client } = await clientFor(proxy);
    const result = await client.callTool({
      name: "GMAIL_SEND_DRAFT",
      arguments: { draft_id: "r_1" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text).toMatch(
      /^The gmail MCP server failed: .*GMAIL_SEND_DRAFT exploded/,
    );
    expect(events.map((event) => event.isError)).toEqual([true]);
  });

  it("builds a new server instance for every run and forwards instructions only when given", async () => {
    const { connection } = await mailProxy();
    const proxy = createFilteringProxy({
      name: "gmail",
      upstream: connection,
      allow: ["GMAIL_FETCH_EMAILS"],
      instructions: "Use Gmail search syntax.",
      timeoutMs: 5_000,
    });
    const first = proxy.serverConfig();
    const second = proxy.serverConfig();
    expect(first.instance).not.toBe(second.instance);
    expect(first.timeout).toBe(5_000);
    const { client } = await clientFor(proxy);
    expect(client.getInstructions()).toBe("Use Gmail search syntax.");
  });
});
