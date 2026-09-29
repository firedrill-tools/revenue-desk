// Test helpers for the integration unit tests: configuration snapshots,
// secrets, classifier settings and a recording fetch mock. No network.

import type { AgentEnv, SecretValue } from "../../../src/contracts/env.js";
import type { ApiCallContext, ClassifierSettings } from "../../../src/contracts/integration.js";
import type { JsonValue } from "../../../src/contracts/json.js";
import type { FetchLike, HttpDeps } from "../../../src/integrations/shared/http.js";
import { asArray, asObject, field } from "../../../src/integrations/shared/json.js";

export function secret(value: string): SecretValue {
  return {
    reveal: () => value,
    toString: () => "[redacted]",
    toJSON: () => "[redacted]",
  };
}

type DeepPartialEnv = { readonly [K in keyof AgentEnv]?: Partial<AgentEnv[K]> };

/** An AgentEnv with nothing configured, plus the given sections. */
export function testEnv(overrides: DeepPartialEnv = {}): AgentEnv {
  const base: AgentEnv = {
    model: {
      apiKey: null,
      model: "claude-sonnet-5",
      effort: "medium",
      thinkingDisplay: null,
      maxTurns: 30,
      maxBudgetUsd: 2,
    },
    runtime: {
      port: 4320,
      stateDir: "/tmp/revenue-desk-test",
      policyOverrides: {},
      businessDate: null,
      approvalTimeoutMs: 900_000,
      dotenvPath: null,
    },
    passthrough: {
      HTTP_PROXY: null,
      HTTPS_PROXY: null,
      NO_PROXY: null,
      CLAUDE_CODE_MAX_RETRIES: null,
    },
    composio: { apiKey: null, userId: null, baseUrl: "https://backend.composio.dev" },
    hubspot: { accessToken: null, apiBaseUrl: null, mcpUrl: null, mcpToken: null },
    stripe: {
      secretKey: null,
      allowLive: false,
      apiBaseUrl: "https://api.stripe.com",
      apiVersion: null,
    },
  };
  return {
    model: { ...base.model, ...overrides.model },
    runtime: { ...base.runtime, ...overrides.runtime },
    passthrough: { ...base.passthrough, ...overrides.passthrough },
    composio: { ...base.composio, ...overrides.composio },
    hubspot: { ...base.hubspot, ...overrides.hubspot },
    stripe: { ...base.stripe, ...overrides.stripe },
  };
}

export const SETTINGS: ClassifierSettings = {
  internalEmailDomains: ["contoso.example"],
  allowedSlackChannels: ["#billing", "#sales-ops"],
  internalCalendarIds: [],
  currency: "USD",
};

export function callContext(overrides: Partial<ApiCallContext> = {}): ApiCallContext {
  return {
    runId: "run_1",
    toolUseId: "toolu_1",
    idempotencyKey: "a".repeat(64),
    signal: undefined,
    ...overrides,
  };
}

export type RecordedRequest = {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

export type Reply = {
  readonly status?: number;
  readonly json?: JsonValue;
  readonly text?: string;
  readonly headers?: Readonly<Record<string, string>>;
};

export type FetchStub = {
  readonly fetch: FetchLike;
  readonly requests: RecordedRequest[];
  /** http deps with this fetch and instant sleeps. */
  readonly http: HttpDeps;
  readonly sleeps: number[];
};

/** A fetch that records every request and answers with `reply` (or throws what it throws). */
export function stubFetch(
  reply: (request: RecordedRequest, index: number) => Reply | Error,
): FetchStub {
  const requests: RecordedRequest[] = [];
  const sleeps: number[] = [];
  const fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const request: RecordedRequest = {
      method: init.method ?? "GET",
      url: new URL(input),
      headers,
      body: typeof init.body === "string" ? init.body : "",
    };
    requests.push(request);
    const answer = reply(request, requests.length - 1);
    if (answer instanceof Error) throw answer;
    const text = answer.text ?? (answer.json === undefined ? "" : JSON.stringify(answer.json));
    return new Response(text === "" ? null : text, {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json", ...answer.headers },
    });
  };
  return {
    fetch,
    requests,
    sleeps,
    http: {
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  };
}

/** A fetch failure whose cause carries a Node error code, like undici's. */
export function networkError(code: string): Error {
  const cause = Object.assign(new Error(`connect ${code}`), { code });
  return new TypeError("fetch failed", { cause });
}

/** The value at a path of object keys and array indexes, or undefined. */
export function at(
  value: JsonValue | undefined,
  ...path: readonly (string | number)[]
): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const step of path) {
    current = typeof step === "number" ? asArray(current)?.[step] : field(asObject(current), step);
  }
  return current;
}

/** Form or query parameters as a plain object (last value wins). */
export function paramsOf(search: string | URLSearchParams): Record<string, string> {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return Object.fromEntries(params.entries());
}
