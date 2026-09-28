import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** How a gateway server reaches its Tool: in-process REST calls, or an upstream MCP server. */
export type GatewayKind = "api" | "mcp";

/** One tool call that went through a gateway server, reported after it settles. */
export interface GatewayCallEvent {
  /** The gateway server name, which is the `<server>` in `mcp__<server>__<tool>`. */
  readonly server: string;
  readonly kind: GatewayKind;
  /** The tool name as the gateway exposes it, without the `mcp__<server>__` prefix. */
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly result: CallToolResult;
  readonly isError: boolean;
  readonly durationMs: number;
}

/** Receives every settled call. It must not throw; a throwing observer is ignored. */
export type GatewayObserver = (event: GatewayCallEvent) => void;

/** A tool result that reports an error to the model instead of data. */
export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function notify(observer: GatewayObserver | undefined, event: GatewayCallEvent): void {
  if (observer === undefined) return;
  try {
    observer(event);
  } catch {
    // Observation must never change a tool result.
  }
}
