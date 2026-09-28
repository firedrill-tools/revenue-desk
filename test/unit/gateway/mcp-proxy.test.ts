import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sdkToolName, type ToolDescriptor } from "../../../src/contracts/integration.js";
import {
  connectUpstream,
  type Upstream,
  upstreamGatewayTools,
} from "../../../src/gateway/mcp-proxy.js";
import type { ExecutionContext } from "../../../src/gateway/types.js";
import { textOf } from "../../helpers/mcp-client.js";
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

function descriptor(name: string, upstream = name, readOnly = true): ToolDescriptor {
  return {
    name,
    upstream,
    operation: "gmail.messages.list",
    title: name,
    baseClass: readOnly ? "read" : "outbound",
    readOnly,
    integration: "gmail",
    connectionKind: "composio",
    sdkName: sdkToolName("gmail", name),
  };
}

const context = (): ExecutionContext => ({
  runId: "run_1",
  toolUseId: "toolu_1",
  idempotencyKey: "k",
  signal: new AbortController().signal,
});

async function mailUpstream(options: { pageSize?: number; failing?: string } = {}) {
  const upstream = await startHttpUpstream({ token: TOKEN, tools: MAIL_TOOLS, ...options });
  cleanups.push(() => upstream.close());
  const connection = await connectUpstream({
    transport: "http",
    url: upstream.url,
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  cleanups.push(() => connection.close());
  return { upstream, connection };
}

describe("connectUpstream", () => {
  it("lists every page of an HTTP upstream's tools with its bearer header", async () => {
    const { upstream, connection } = await mailUpstream({ pageSize: 1 });
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

  it("gives up when its signal aborts", async () => {
    const { upstream } = await mailUpstream();
    await expect(
      connectUpstream(
        { transport: "http", url: upstream.url, headers: { Authorization: `Bearer ${TOKEN}` } },
        { signal: AbortSignal.abort("user") },
      ),
    ).rejects.toThrow(/could not connect/);
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
    const { tools } = upstreamGatewayTools(connection, [
      { ...descriptor("search_contacts"), integration: "hubspot", connectionKind: "mcp" },
    ]);
    await tools[0]?.execute({ query: "ana" }, context());
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

describe("upstreamGatewayTools", () => {
  it("offers only the profile's tools, with the upstream schema byte for byte", async () => {
    const { connection } = await mailUpstream();
    const { tools, missing } = upstreamGatewayTools(connection, [
      descriptor("GMAIL_FETCH_EMAILS"),
      descriptor("GMAIL_SEND_DRAFT", "GMAIL_SEND_DRAFT", false),
      descriptor("GMAIL_NOT_OFFERED"),
    ]);
    expect(missing).toEqual(["GMAIL_NOT_OFFERED"]);
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "GMAIL_FETCH_EMAILS",
      "GMAIL_SEND_DRAFT",
    ]);
    for (const tool of tools) {
      const upstream = MAIL_TOOLS.find(
        (fixture) => fixture.tool.name === tool.definition.name,
      )?.tool;
      expect(tool.definition.inputSchema).toEqual(upstream?.inputSchema);
      expect(tool.definition.description).toBe(upstream?.description);
      expect(tool.definition._meta).toEqual({ "anthropic/alwaysLoad": true });
      expect(tool.definition).not.toHaveProperty("outputSchema");
    }
    // The profile, not the upstream, decides the read-only hint.
    expect(tools[1]?.definition.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });

  it("forwards the arguments unchanged under the upstream name", async () => {
    const { upstream, connection } = await mailUpstream();
    const { tools } = upstreamGatewayTools(connection, [
      descriptor("fetch_mail", "GMAIL_FETCH_EMAILS"),
    ]);
    const args = { query: "from:ana@acme.test", max_results: 5, label_ids: ["INBOX"] };
    const execution = await tools[0]?.execute(args, context());
    expect(upstream.calls).toEqual([{ tool: "GMAIL_FETCH_EMAILS", arguments: args }]);
    expect(tools[0]?.definition.name).toBe("fetch_mail");
    expect(execution?.error).toBeNull();
    expect(JSON.parse(textOf(execution?.result ?? { content: [] }))).toMatchObject({
      received: args,
    });
  });

  it("turns an upstream failure into an error result and a normalised failure", async () => {
    const { connection } = await mailUpstream({ failing: "GMAIL_SEND_DRAFT" });
    const { tools } = upstreamGatewayTools(connection, [
      descriptor("GMAIL_SEND_DRAFT", "GMAIL_SEND_DRAFT", false),
    ]);
    const execution = await tools[0]?.execute({ draft_id: "r_1" }, context());
    expect(execution?.result.isError).toBe(true);
    expect(execution?.error).toMatchObject({ provider: "gmail", status: null });
    expect(execution?.error?.message).toMatch(/GMAIL_SEND_DRAFT exploded/);
  });

  it("reports a tool result the upstream marked as an error", async () => {
    const fixture = MAIL_TOOLS[0]?.tool;
    if (fixture === undefined) throw new Error("fixture missing");
    const stub = {
      client: {
        request: async () => ({ isError: true, content: [{ type: "text", text: "not found" }] }),
      },
      tools: [fixture],
      instructions: undefined,
      stderrTail: () => "",
      close: async () => {},
    } as unknown as Upstream;
    const { tools } = upstreamGatewayTools(stub, [descriptor("GMAIL_FETCH_EMAILS")]);
    const execution = await tools[0]?.execute({ query: "x" }, context());
    expect(execution?.error).toEqual({
      provider: "gmail",
      status: null,
      code: null,
      message: "not found",
    });
  });

  it("reports a closed upstream as an upstream_error", async () => {
    const { connection } = await mailUpstream();
    const { tools } = upstreamGatewayTools(connection, [descriptor("GMAIL_FETCH_EMAILS")]);
    await connection.close();
    const execution = await tools[0]?.execute({ query: "x" }, context());
    expect(execution?.error?.code).toBe("upstream_error");
    expect(execution?.result.isError).toBe(true);
  });
});
