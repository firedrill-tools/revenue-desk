/**
 * A stdio MCP server for gateway tests, launched as
 * `node --import <tsx> test/support/stdio-upstream.ts <fixture>`.
 * Each call is appended to the JSONL file named by UPSTREAM_CALL_LOG.
 * stdout carries the MCP protocol only; nothing else may print to it.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  appendCallLog,
  createUpstreamServer,
  UPSTREAM_FIXTURES,
  type UpstreamFixtureName,
} from "./upstream-mcp.js";

const fixture = process.argv[2] as UpstreamFixtureName | undefined;
const callLog = process.env.UPSTREAM_CALL_LOG;
if (fixture === undefined || !(fixture in UPSTREAM_FIXTURES) || callLog === undefined) {
  process.stderr.write("usage: UPSTREAM_CALL_LOG=<file> stdio-upstream.ts <mail|crm>\n");
  process.exit(2);
}

const instructions = process.env.UPSTREAM_INSTRUCTIONS;
const server = createUpstreamServer({
  name: `stdio-${fixture}`,
  tools: UPSTREAM_FIXTURES[fixture],
  onCall: (call) => appendCallLog(callLog, call),
  ...(instructions === undefined ? {} : { instructions }),
});
await server.connect(new StdioServerTransport());
process.stderr.write(`stdio-${fixture} ready\n`);
