import { loadAgentEnv } from "../config/env.js";
import type { AgentEnv } from "../contracts/env.js";
import { type CatalogBindings, type DemoBindings, validateDemoBindings } from "./catalog.js";

/** The launcher supplies these in memory; never read a committed credentials file. */
export function demoBindingsFromEnvironment(): DemoBindings {
  const raw = process.env.REVENUE_DESK_FIREDRILL_BINDINGS;
  if (!raw) throw new Error("The demo launcher did not supply synthetic Tool bindings");
  let parsed: DemoBindings;
  try {
    parsed = JSON.parse(raw) as DemoBindings;
  } catch {
    throw new Error("The demo launcher supplied invalid synthetic Tool bindings");
  }
  validateDemoBindings(parsed);
  return parsed;
}

/** Isolated tests carry exactly one Tool world, never the reusable demo pair. */
export function catalogBindingsFromEnvironment(): CatalogBindings {
  if (process.env.REVENUE_DESK_FIREDRILL_CASE_BINDING) {
    if (process.env.REVENUE_DESK_FIREDRILL_BINDINGS) {
      throw new Error("The isolated test cannot also receive reusable Tool bindings");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(process.env.REVENUE_DESK_FIREDRILL_CASE_BINDING);
    } catch {
      throw new Error("The isolated test supplied an invalid Tool binding");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("The isolated test supplied an invalid Tool binding");
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      (candidate.scope !== "core" && candidate.scope !== "stripe") ||
      !candidate.access ||
      typeof candidate.access !== "object" ||
      Array.isArray(candidate.access)
    ) {
      throw new Error("The isolated test supplied an invalid Tool scope or access");
    }
    return { [candidate.scope]: candidate.access } as CatalogBindings;
  }
  return demoBindingsFromEnvironment();
}

/** Fail closed if any real-provider credential is accidentally inherited. */
export function demoAgentEnvironment(): AgentEnv {
  const configuration = loadAgentEnv(process.env, { cwd: process.cwd() });
  if (!configuration.ok) {
    throw new Error(
      `Demo configuration is invalid: ${configuration.problems.map((problem) => problem.variable).join(", ")}`,
    );
  }
  const { env } = configuration;
  if (env.model.apiKey === null)
    throw new Error("ANTHROPIC_API_KEY is required for the local agent");
  if (
    env.composio.apiKey !== null ||
    env.hubspot.accessToken !== null ||
    env.stripe.secretKey !== null ||
    env.stripe.allowLive
  ) {
    throw new Error("Demo mode refuses real provider credentials");
  }
  return env;
}
