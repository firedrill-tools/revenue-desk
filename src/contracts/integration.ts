// Integration contract: which systems Revenue Desk reaches, how, and how each
// tool call is classified for the approval policy (docs/ARCHITECTURE.md §2, §5, §7).
//
// Frozen for the parallel workstreams. Change it only through the lead, and
// record the change in the decisions log of docs/ARCHITECTURE.md.
//
// Shared by server, CLI and web: no Node-only globals, no implementation imports.

import type { AgentEffort, AgentEnv, ConfigProblem, EnvVarName, SecretValue } from "./env.js";
import type { JsonObject } from "./json.js";

// ---------------------------------------------------------------------------
// Integrations and connection kinds
// ---------------------------------------------------------------------------

export const INTEGRATION_IDS = [
  "gmail",
  "google_calendar",
  "hubspot",
  "stripe",
  "quickbooks",
  "slack",
] as const;
export type IntegrationId = (typeof INTEGRATION_IDS)[number];

/** How a tool call reaches its system; shown as a neutral chip ("Composio", "MCP", "API"). */
export const CONNECTION_KINDS = ["composio", "mcp", "api"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

/** Composio toolkit slugs; equal to COMPOSIO_TOOLKITS in src/integrations/composio/session.ts. */
export type ComposioToolkitSlug = "gmail" | "googlecalendar" | "quickbooks" | "slack";

/**
 * The tool profile of each integration. There is exactly one per integration.
 * A profile id names a fixed tool surface; a new upstream surface (for example
 * a HubSpot MCP server 0.5) gets a new profile id rather than a silent change.
 */
export type ProfileId = "composio" | "hubspot-mcp-0.4" | "stripe-api";

/** Static facts about an integration. */
export type IntegrationInfo = {
  readonly id: IntegrationId;
  /** Text label; the UI never shows vendor logos. */
  readonly label: string;
  readonly kind: ConnectionKind;
  readonly profile: ProfileId;
};

/**
 * Decided connection mapping (Kiran, 2026-09-29): Composio for every system
 * it supports (Gmail, Google Calendar, QuickBooks, Slack), MCP for HubSpot
 * and the REST API for Stripe. 4 Composio, 1 MCP, 1 API.
 */
export const INTEGRATIONS = {
  gmail: { id: "gmail", label: "Gmail", kind: "composio", profile: "composio" },
  google_calendar: {
    id: "google_calendar",
    label: "Google Calendar",
    kind: "composio",
    profile: "composio",
  },
  hubspot: { id: "hubspot", label: "HubSpot", kind: "mcp", profile: "hubspot-mcp-0.4" },
  stripe: { id: "stripe", label: "Stripe", kind: "api", profile: "stripe-api" },
  quickbooks: {
    id: "quickbooks",
    label: "QuickBooks Online",
    kind: "composio",
    profile: "composio",
  },
  slack: { id: "slack", label: "Slack", kind: "composio", profile: "composio" },
} as const satisfies { readonly [I in IntegrationId]: IntegrationInfo & { readonly id: I } };

export type IntegrationKindOf<I extends IntegrationId> = (typeof INTEGRATIONS)[I]["kind"];
export type ProfileIdOf<I extends IntegrationId> = (typeof INTEGRATIONS)[I]["profile"];
export type ComposioIntegrationId = {
  [I in IntegrationId]: IntegrationKindOf<I> extends "composio" ? I : never;
}[IntegrationId];
export type McpIntegrationId = {
  [I in IntegrationId]: IntegrationKindOf<I> extends "mcp" ? I : never;
}[IntegrationId];
export type ApiIntegrationId = {
  [I in IntegrationId]: IntegrationKindOf<I> extends "api" ? I : never;
}[IntegrationId];

export const COMPOSIO_TOOLKIT_OF = {
  gmail: "gmail",
  google_calendar: "googlecalendar",
  quickbooks: "quickbooks",
  slack: "slack",
} as const satisfies Record<ComposioIntegrationId, ComposioToolkitSlug>;

// ---------------------------------------------------------------------------
// Tool naming
// ---------------------------------------------------------------------------

/**
 * Every tool reaches the model through one in-process MCP server per
 * integration, named by the integration id, so the model sees
 * `mcp__<integration>__<tool>`.
 */
export type SdkToolName = `mcp__${IntegrationId}__${string}`;

export function sdkToolName(integration: IntegrationId, tool: string): SdkToolName {
  return `mcp__${integration}__${tool}`;
}

/** Splits a model-visible tool name; null when it is not one of Revenue Desk's servers. */
export function parseSdkToolName(
  name: string,
): { readonly integration: IntegrationId; readonly tool: string } | null {
  const match = /^mcp__([a-z_]+?)__(.+)$/.exec(name);
  if (match === null) return null;
  const [, server, tool] = match;
  if (server === undefined || tool === undefined) return null;
  const integration = INTEGRATION_IDS.find((id) => id === server);
  return integration === undefined ? null : { integration, tool };
}

/**
 * The MCP `_meta` key under which the Claude CLI (2.1.283) sends the model's
 * tool_use id on every tools/call to an in-process server, for both the SDK's
 * own servers and hand-built McpServer instances. The gateway uses it to join
 * a call to its tool_use id (action log, idempotency key). Verified 2026-09-28.
 */
export const TOOL_USE_ID_META_KEY = "claudecode/toolUseId";

/** `<integration>.<resource>.<verb>`, e.g. `stripe.refunds.create`. */
export type OperationName = `${IntegrationId}.${string}`;

// ---------------------------------------------------------------------------
// Action classes and approval policy
// ---------------------------------------------------------------------------

export const ACTION_CLASSES = [
  "read",
  "internal_write",
  "outbound",
  "financial",
  "destructive",
] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export const APPROVAL_MODES = ["auto", "ask", "deny"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export type PolicyModes = { readonly [C in ActionClass]: ApprovalMode };
export type PolicyOverrides = { readonly [C in ActionClass]?: ApprovalMode };

export const DEFAULT_POLICY: PolicyModes = {
  read: "auto",
  internal_write: "auto",
  outbound: "ask",
  financial: "ask",
  destructive: "deny",
};

/** The tool result text for a call that `ask` would hold, in headless mode. */
export const HEADLESS_ASK_DENIAL = "Requires human approval; not available in headless mode.";

// ---------------------------------------------------------------------------
// Tool profiles (allowlists) and descriptors
// ---------------------------------------------------------------------------

/** One tool of a profile: the only tools the model is offered. */
export type ToolSpec = {
  /** The name after `mcp__<integration>__`. */
  readonly name: string;
  /** The upstream identity: a Composio slug, an MCP tool name, or "POST /v1/refunds". */
  readonly upstream: string;
  /** The operation when the input does not change it. */
  readonly operation: OperationName;
  /** A verb phrase for the UI, e.g. "Refund charge in Stripe". */
  readonly title: string;
  /** The class before the input is known; classify() decides the final class from the input. */
  readonly baseClass: ActionClass;
  /** Runs without side effects; reads may run concurrently. */
  readonly readOnly: boolean;
};

/**
 * A profile's allowlist. For MCP and Composio integrations the gateway offers
 * the intersection of the upstream tools/list and these names (with the raw
 * upstream schemas); for API integrations it is exactly the in-process tools.
 */
export type ToolProfile<I extends IntegrationId = IntegrationId> = {
  readonly id: ProfileIdOf<I>;
  readonly integration: I;
  readonly tools: { readonly [name: string]: ToolSpec };
};

/** The tool names of every profile. */
export type ProfileAllowlists = { readonly [I in IntegrationId]: readonly string[] };

/** A tool as registered for a run: the profile entry plus where it lives. */
export type ToolDescriptor = ToolSpec & {
  readonly integration: IntegrationId;
  readonly connectionKind: ConnectionKind;
  readonly sdkName: SdkToolName;
};

// ---------------------------------------------------------------------------
// Classification (one per tool call, from its complete input)
// ---------------------------------------------------------------------------

export type Money = {
  /** Integer minor units (4900 is $49.00). */
  readonly amountMinor: number;
  /** ISO 4217, upper case. */
  readonly currency: string;
};

/** A row of the approval card's facts table. Values are already formatted for display. */
export type ApprovalFact = { readonly label: string; readonly value: string };

/** What an approval card shows about an action. */
export type ActionDetails = {
  /** The exact consequence, e.g. "Refund $49.00 to Acme Inc on Stripe charge ch_…". */
  readonly consequence: string;
  readonly facts: readonly ApprovalFact[];
  readonly amount?: Money;
  /** Email addresses, attendees or Slack channels the action reaches. */
  readonly recipients?: readonly string[];
  /** Upstream record ids the action touches (charge, invoice, contact, ...). */
  readonly recordIds?: readonly string[];
};

type ClassificationBase = {
  readonly operation: OperationName;
  readonly title: string;
};

/**
 * The result of classifying one call. `null` from classify() means deny
 * (unknown tool, or an input the classifier cannot judge). Anything that can
 * reach other people, move money or destroy data must carry its details.
 */
export type Classification =
  | (ClassificationBase & {
      readonly actionClass: "read" | "internal_write";
      readonly details?: ActionDetails;
    })
  | (ClassificationBase & {
      readonly actionClass: "outbound" | "financial" | "destructive";
      readonly details: ActionDetails;
    });

// ---------------------------------------------------------------------------
// Workspace settings (read by classifiers, the prompt and the Settings screen)
// ---------------------------------------------------------------------------

export type WorkspaceSettings = {
  readonly companyName: string;
  readonly agentName: string;
  readonly senderName: string;
  readonly emailSignature: string;
  /** Lower-case domains; calendar attendees and email recipients outside them are external. */
  readonly internalEmailDomains: readonly string[];
  /** Channel for the agent's own notices (J2, J4, J5), e.g. "#billing"; null for none. */
  readonly notifySlackChannel: string | null;
  /** Posting to these channels is internal_write; any other channel is outbound. */
  readonly allowedSlackChannels: readonly string[];
  /**
   * Shared Google calendars (e.g. "team@group.calendar.google.com") the
   * company owns: writing to them is internal_write. Any other calendar except
   * "primary" and internal addresses is outbound.
   */
  readonly internalCalendarIds: readonly string[];
  /** IANA time zone, e.g. "America/New_York". */
  readonly timezone: string;
  /** ISO 4217 display currency. */
  readonly currency: string;
  /** Overrides AGENT_MODEL when set. */
  readonly defaultModel: string | null;
  /** Overrides AGENT_EFFORT when set. */
  readonly defaultEffort: AgentEffort | null;
  readonly updatedAt: string;
};

export type ClassifierSettings = Pick<
  WorkspaceSettings,
  "internalEmailDomains" | "allowedSlackChannels" | "internalCalendarIds" | "currency"
>;

// ---------------------------------------------------------------------------
// Resolved connections (from the AgentEnv snapshot; secrets stay wrapped)
// ---------------------------------------------------------------------------

type ConnectionBase<I extends IntegrationId> = {
  readonly integration: I;
  readonly kind: IntegrationKindOf<I>;
  readonly profile: ProfileIdOf<I>;
  /** Host only (e.g. "api.stripe.com"); safe to show, log and store. */
  readonly endpointLabel: string;
};

/**
 * How far a Composio session reaches (src/integrations/composio/session.ts):
 * read; draft (internal writes: the user's own mailbox, a QuickBooks
 * customer, a Slack reaction); outbound (tools that can reach other people
 * or move money: sending and replying, calendar events, Slack posts,
 * QuickBooks invoices and payments).
 */
export type ComposioAccess = "read" | "draft" | "outbound";

/**
 * The session exposure for a run: tools the policy would always deny are not
 * offered. Outbound-level tools are offered (and then gated call by call)
 * unless both outbound and financial are deny.
 */
export function composioAccessFor(policy: PolicyModes): ComposioAccess {
  if (policy.outbound !== "deny" || policy.financial !== "deny") return "outbound";
  return policy.internal_write === "deny" ? "read" : "draft";
}

export type ComposioConnection<I extends ComposioIntegrationId = ComposioIntegrationId> =
  ConnectionBase<I> & {
    readonly composio: {
      readonly apiKey: SecretValue;
      /** COMPOSIO_USER_ID; there is no default in code. */
      readonly userId: string;
      readonly toolkit: (typeof COMPOSIO_TOOLKIT_OF)[I];
    };
  };

/**
 * How the HubSpot MCP server runs: always HubSpot's official, pinned
 * @hubspot/mcp-server 0.4.x over stdio with HUBSPOT_ACCESS_TOKEN
 * (src/integrations/hubspot/launch.ts), calling HubSpot's own default host.
 * There is no other transport and no way to point it elsewhere.
 */
export type HubSpotMcpTransport = {
  readonly transport: "stdio";
  readonly accessToken: SecretValue;
};

export type HubSpotConnection = ConnectionBase<"hubspot"> & {
  readonly mcp: HubSpotMcpTransport;
};

export type StripeConnection = ConnectionBase<"stripe"> & {
  readonly api: {
    /** Always sent to https://api.stripe.com (src/integrations/shared/vendors.ts). */
    readonly secretKey: SecretValue;
    /** From the key prefix; live keys resolve only with ALLOW_LIVE_STRIPE=1. */
    readonly keyMode: "test" | "live";
    /** Stripe-Version header; null uses the account default. */
    readonly apiVersion: string | null;
  };
};

export type ResolvedConnection =
  | ComposioConnection<"gmail">
  | ComposioConnection<"google_calendar">
  | ComposioConnection<"quickbooks">
  | ComposioConnection<"slack">
  | HubSpotConnection
  | StripeConnection;

export type ResolvedConnectionOf<I extends IntegrationId> = Extract<
  ResolvedConnection,
  { readonly integration: I }
>;

/** The outcome of reading an integration's configuration. Never contacts the system. */
export type ConnectionResolution<I extends IntegrationId = IntegrationId> =
  | { readonly status: "configured"; readonly connection: ResolvedConnectionOf<I> }
  /** Required variables are unset; `missing` holds names only. */
  | { readonly status: "not_configured"; readonly missing: readonly EnvVarName[] }
  /** Values are present but refused (a live Stripe key, a malformed token, ...). */
  | { readonly status: "invalid"; readonly problems: readonly ConfigProblem[] };

// ---------------------------------------------------------------------------
// Connection status (probes, the Connections screen, the connections table)
// ---------------------------------------------------------------------------

export const CONNECTION_STATES = [
  "connected",
  "needs_auth",
  "expired",
  "not_configured",
  "invalid",
  "error",
  "unknown",
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/** A read-only check against a configured connection. */
export type ProbeResult = {
  readonly state: "connected" | "needs_auth" | "expired" | "error";
  /** One plain sentence; never contains a secret. */
  readonly detail: string;
  /** A masked account id such as "ca_…c6M", or null. */
  readonly accountHint: string | null;
};

export type ConnectionStatus = {
  readonly integration: IntegrationId;
  readonly kind: ConnectionKind;
  readonly profile: ProfileId;
  readonly state: ConnectionState;
  readonly detail: string;
  readonly endpointLabel: string | null;
  readonly accountHint: string | null;
  /** Unset variable names when not_configured; otherwise empty. */
  readonly missing: readonly EnvVarName[];
  /** ISO time of the last probe, or null if never probed. */
  readonly checkedAt: string | null;
};

// ---------------------------------------------------------------------------
// API tool calls
// ---------------------------------------------------------------------------

/**
 * What an API tool's `run` receives besides its arguments. The gateway's
 * ApiToolContext (src/gateway/api-server.ts) grows to this shape in W1.
 */
export type ApiCallContext = {
  readonly runId: string;
  /** From `_meta[TOOL_USE_ID_META_KEY]`. A write without it fails closed. */
  readonly toolUseId: string;
  /** Hex sha256 of `${runId}:${toolUseId}`: the Stripe Idempotency-Key. */
  readonly idempotencyKey: string;
  readonly signal: AbortSignal | undefined;
};

/** A provider error, as the model and the action log see it (ApiToolError.toJSON()). */
export type ToolFailure = {
  readonly provider: string | null;
  readonly status: number | null;
  readonly code: string | null;
  readonly message: string;
};

// ---------------------------------------------------------------------------
// One definition per integration (src/integrations/<id>/, workstream W2)
// ---------------------------------------------------------------------------

export interface IntegrationDefinition<I extends IntegrationId = IntegrationId> {
  readonly id: I;
  readonly label: string;
  readonly kind: IntegrationKindOf<I>;
  readonly profile: ToolProfile<I>;
  /** Reads the snapshot only; never contacts the system. */
  resolve(env: AgentEnv): ConnectionResolution<I>;
  /**
   * Classifies one call from its complete input. `tool` is the name after
   * `mcp__<integration>__`. Returns null to deny.
   */
  classify(tool: string, input: JsonObject, settings: ClassifierSettings): Classification | null;
  /** A read-only check (for example listing tools or reading the account). */
  probe(connection: ResolvedConnectionOf<I>, signal: AbortSignal): Promise<ProbeResult>;
}
