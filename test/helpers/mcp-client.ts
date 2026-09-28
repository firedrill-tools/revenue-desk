/** An MCP client connected in memory to one gateway server instance, the way the Claude CLI talks to it. */
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type CallToolResult, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

export async function connectClient(config: McpSdkServerConfigWithInstance): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await config.instance.connect(serverSide);
  const client = new Client({ name: "unit", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}

/** tools/call with the CLI's `_meta` (the tool_use id), or none when toolUseId is null. */
export async function callWithMeta(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  toolUseId: string | null,
): Promise<CallToolResult> {
  return (await client.request(
    {
      method: "tools/call",
      params: {
        name,
        arguments: args,
        ...(toolUseId === null ? {} : { _meta: { "claudecode/toolUseId": toolUseId } }),
      },
    },
    CallToolResultSchema,
  )) as CallToolResult;
}

export function textOf(result: CallToolResult): string {
  return (result.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
}
