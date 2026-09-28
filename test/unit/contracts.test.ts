// Keeps the frozen contracts (src/contracts) honest against the libraries and
// modules they describe. Type assertions are checked by `pnpm typecheck`
// (tsconfig.node.json includes test/); runtime assertions by vitest.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EffortLevel, TerminalReason } from "@anthropic-ai/claude-agent-sdk";
import type { JSONValue, UIMessage, UIMessageChunk } from "ai";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  API_ERROR_STATUS,
  type API_PATHS,
  type ApiEndpoints,
  type ChatDataParts,
  type ChatMessageMetadata,
  type ChatUIMessage,
} from "../../src/contracts/api.js";
import { type AskCommand, CLI_EXIT_CODES, type RunSummary } from "../../src/contracts/cli.js";
import {
  type AgentEffort,
  EFFORT_LEVELS,
  ENV_VAR_NAMES,
  ENV_VARS,
  SDK_CHILD_PASSTHROUGH_VARS,
} from "../../src/contracts/env.js";
import type {
  AgentEvent,
  ApprovalDescriptor,
  RunUsage,
  SdkTerminalReason,
  StatusData,
  ToolMetadata,
} from "../../src/contracts/events.js";
import {
  ACTION_CLASSES,
  type ApiCallContext,
  COMPOSIO_TOOLKIT_OF,
  composioAccessFor,
  DEFAULT_POLICY,
  INTEGRATION_IDS,
  INTEGRATIONS,
  parseSdkToolName,
  sdkToolName,
  TOOL_USE_ID_META_KEY,
} from "../../src/contracts/integration.js";
import type { JsonObject } from "../../src/contracts/json.js";
import type { ApiToolContext } from "../../src/gateway/api-server.js";
import { COMPOSIO_TOOLKITS } from "../../src/integrations/composio/session.js";

type ChunkField<T extends UIMessageChunk["type"], K extends string> = NonNullable<
  Extract<UIMessageChunk, { type: T }> extends infer C ? (K extends keyof C ? C[K] : never) : never
>;
type AiJsonObject = ChunkField<"tool-input-start", "toolMetadata">;

describe("wire types fit the AI SDK v7 stream", () => {
  it("are JSON objects where the chunk types demand JSON", () => {
    expectTypeOf<ToolMetadata>().toExtend<AiJsonObject>();
    expectTypeOf<ApprovalDescriptor>().toExtend<AiJsonObject>();
    expectTypeOf<RunUsage>().toExtend<AiJsonObject>();
    expectTypeOf<StatusData>().toExtend<JSONValue>();
    expectTypeOf<JsonObject>().toExtend<AiJsonObject>();
  });

  it("types ChatUIMessage with Revenue Desk metadata and data parts", () => {
    expectTypeOf<ChatUIMessage>().toEqualTypeOf<UIMessage<ChatMessageMetadata, ChatDataParts>>();
    type DataPartTypes = Extract<
      ChatUIMessage["parts"][number],
      { type: `data-${string}` }
    >["type"];
    expectTypeOf<DataPartTypes>().toEqualTypeOf<
      "data-status" | "data-progress" | "data-usage" | "data-notice"
    >();
  });
});

describe("agent SDK vocabulary", () => {
  it("matches @anthropic-ai/claude-agent-sdk 0.3.283", () => {
    expectTypeOf<AgentEffort>().toEqualTypeOf<EffortLevel>();
    expectTypeOf<SdkTerminalReason>().toEqualTypeOf<TerminalReason>();
    expect(EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("lets the gateway pass an ApiCallContext as its ApiToolContext", () => {
    expectTypeOf<ApiCallContext>().toExtend<ApiToolContext>();
    expect(TOOL_USE_ID_META_KEY).toBe("claudecode/toolUseId");
  });
});

describe("integration contract", () => {
  it("maps two Composio, one MCP and three API integrations", () => {
    const kinds = INTEGRATION_IDS.map((id) => INTEGRATIONS[id].kind);
    expect(kinds).toEqual(["composio", "composio", "mcp", "api", "api", "api"]);
    for (const id of INTEGRATION_IDS) expect(INTEGRATIONS[id].id).toBe(id);
    expect(Object.values(COMPOSIO_TOOLKIT_OF).sort()).toEqual([...COMPOSIO_TOOLKITS].sort());
  });

  it("names tools mcp__<integration>__<tool> and parses them back", () => {
    expect(sdkToolName("stripe", "create_refund")).toBe("mcp__stripe__create_refund");
    expect(parseSdkToolName("mcp__google_calendar__GOOGLECALENDAR_EVENTS_LIST")).toEqual({
      integration: "google_calendar",
      tool: "GOOGLECALENDAR_EVENTS_LIST",
    });
    expect(parseSdkToolName("mcp__hubspot__hubspot-search-objects")).toEqual({
      integration: "hubspot",
      tool: "hubspot-search-objects",
    });
    expect(parseSdkToolName("mcp__other__tool")).toBeNull();
    expect(parseSdkToolName("Bash")).toBeNull();
  });

  it("defaults to asking for outbound and financial actions and denying destructive ones", () => {
    expect(Object.keys(DEFAULT_POLICY)).toEqual([...ACTION_CLASSES]);
    expect(DEFAULT_POLICY).toMatchObject({
      read: "auto",
      internal_write: "auto",
      outbound: "ask",
      financial: "ask",
      destructive: "deny",
    });
  });

  it("offers Composio outbound tools only when the policy can allow them", () => {
    expect(composioAccessFor(DEFAULT_POLICY)).toBe("outbound");
    expect(composioAccessFor({ ...DEFAULT_POLICY, outbound: "deny" })).toBe("draft");
    expect(composioAccessFor({ ...DEFAULT_POLICY, outbound: "deny", internal_write: "deny" })).toBe(
      "read",
    );
  });
});

describe("environment contract", () => {
  it(".env.example lists exactly the contract's variable names, in order, with no values", () => {
    const example = readFileSync(resolve(import.meta.dirname, "../../.env.example"), "utf8");
    const assignments = example
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
    for (const line of assignments) expect(line).toMatch(/^[A-Z][A-Z0-9_]*=$/);
    expect(assignments.map((line) => line.slice(0, -1))).toEqual([...ENV_VAR_NAMES]);
  });

  it("marks every token and key as secret and nothing else", () => {
    const secrets = ENV_VAR_NAMES.filter((name) => ENV_VARS[name].secret);
    expect(secrets).toEqual([
      "ANTHROPIC_API_KEY",
      "COMPOSIO_API_KEY",
      "HUBSPOT_ACCESS_TOKEN",
      "HUBSPOT_MCP_TOKEN",
      "STRIPE_SECRET_KEY",
      "QBO_ACCESS_TOKEN",
      "SLACK_BOT_TOKEN",
    ]);
  });

  it("keeps passthrough variables out of the app configuration", () => {
    for (const name of SDK_CHILD_PASSTHROUGH_VARS) {
      expect(ENV_VAR_NAMES as readonly string[]).not.toContain(name);
    }
  });
});

describe("HTTP API contract", () => {
  it("has one endpoint entry per route path", () => {
    type Paths = ApiEndpoints extends infer E ? keyof E : never;
    type PathOf<K> = K extends `${string} ${infer P}` ? P : never;
    expectTypeOf<PathOf<Paths>>().toEqualTypeOf<(typeof API_PATHS)[keyof typeof API_PATHS]>();
  });

  it("gives every error code a 4xx or 5xx status", () => {
    for (const status of Object.values(API_ERROR_STATUS)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });
});

describe("CLI contract", () => {
  it("uses distinct exit codes and a plain summary shape", () => {
    const codes = Object.values(CLI_EXIT_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    expectTypeOf<RunSummary["kind"]>().toEqualTypeOf<"revenue-desk.run-summary">();
    expectTypeOf<AskCommand["effort"]>().toEqualTypeOf<AgentEffort | null>();
  });
});

describe("AgentEvent", () => {
  it("is discriminated by type", () => {
    type Types = AgentEvent["type"];
    expectTypeOf<"run.started" | "run.finished" | "tool.output">().toExtend<Types>();
    expectTypeOf<Extract<AgentEvent, { type: "tool.denied" }>["decision"]>().toEqualTypeOf<
      "denied" | "policy_denied" | "timed_out" | "stopped" | "rejected"
    >();
  });
});
