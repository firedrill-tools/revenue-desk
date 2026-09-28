// Connection status for the Connections screen and for each run
// (docs/ARCHITECTURE.md §3, §5, §9).
//
// - Configuration comes from IntegrationDefinition.resolve(env): configured,
//   not_configured (missing variable names) or invalid (problems, never values).
// - Account state comes from read-only probes, stored in the connections table.
// - A run is offered an integration only when it is configured and its last
//   probe did not say needs_auth or expired.
// - Connect exists only for Composio and runs only on the user's click.

import type { ConnectionView } from "../contracts/api.js";
import type { AgentEnv } from "../contracts/env.js";
import type { ConnectionPlan, RunConnection } from "../contracts/events.js";
import {
  type ComposioConnection,
  type ConnectionResolution,
  type ConnectionState,
  INTEGRATION_IDS,
  INTEGRATIONS,
  type IntegrationDefinition,
  type IntegrationId,
} from "../contracts/integration.js";
import { readConnectionRows, saveConnectionStatus } from "../db/repos/connections.js";
import type { DbExecutor } from "../db/repos/types.js";
import type { ConnectionRow } from "../db/schema.js";
import { describeError, type Redact } from "./redaction.js";

/** Starts Composio's hosted sign-in for a configured Composio integration. */
export type ComposioAuthorizer = (
  connection: ComposioConnection,
  callbackUrl: string,
) => Promise<{ readonly redirectUrl: string }>;

export type ConnectOutcome =
  | { readonly ok: true; readonly redirectUrl: string }
  | {
      readonly ok: false;
      readonly code: "not_supported" | "upstream_error";
      readonly message: string;
    };

export type ConnectionServiceOptions = {
  readonly db: DbExecutor;
  readonly env: AgentEnv;
  /** Exactly one definition per integration. */
  readonly integrations: readonly IntegrationDefinition[];
  readonly authorizeComposio: ComposioAuthorizer;
  readonly redact: Redact;
  readonly now: () => Date;
  /** Per probe. Default 20 seconds. */
  readonly probeTimeoutMs?: number;
};

const PROBE_STATES: ReadonlySet<ConnectionState> = new Set([
  "connected",
  "needs_auth",
  "expired",
  "error",
]);

export class ConnectionService {
  readonly #options: ConnectionServiceOptions;
  readonly #definitions: ReadonlyMap<IntegrationId, IntegrationDefinition>;

  constructor(options: ConnectionServiceOptions) {
    this.#options = options;
    const definitions = new Map<IntegrationId, IntegrationDefinition>();
    for (const definition of options.integrations) {
      if (definitions.has(definition.id)) {
        throw new Error(`Two integration definitions for ${definition.id}`);
      }
      definitions.set(definition.id, definition);
    }
    const missing = INTEGRATION_IDS.filter((id) => !definitions.has(id));
    if (missing.length > 0) {
      throw new Error(`No integration definition for ${missing.join(", ")}`);
    }
    this.#definitions = definitions;
  }

  resolution(integration: IntegrationId): ConnectionResolution {
    return this.#definition(integration).resolve(this.#options.env);
  }

  /**
   * Stores every integration's configuration state (at boot). A configured
   * integration keeps its last probe result until the next probe.
   */
  syncConfiguration(): void {
    const rows = readConnectionRows(this.#options.db);
    for (const integration of INTEGRATION_IDS) {
      this.#save(this.#view(integration, this.resolution(integration), rows.get(integration)));
    }
  }

  list(): ConnectionView[] {
    const rows = readConnectionRows(this.#options.db);
    return INTEGRATION_IDS.map((integration) =>
      this.#view(integration, this.resolution(integration), rows.get(integration)),
    );
  }

  get(integration: IntegrationId): ConnectionView {
    const rows = readConnectionRows(this.#options.db);
    return this.#view(integration, this.resolution(integration), rows.get(integration));
  }

  /** Runs the read-only probe of a configured integration and stores the result. */
  async check(integration: IntegrationId, signal?: AbortSignal): Promise<ConnectionView> {
    const resolution = this.resolution(integration);
    if (resolution.status !== "configured") {
      const view = this.get(integration);
      this.#save(view);
      return view;
    }
    const timeout = AbortSignal.timeout(this.#options.probeTimeoutMs ?? 20_000);
    const probeSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const checkedAt = this.#options.now().toISOString();
    let state: ConnectionState;
    let detail: string;
    let accountHint: string | null;
    try {
      const result = await this.#definition(integration).probe(resolution.connection, probeSignal);
      state = result.state;
      detail = this.#options.redact(result.detail);
      accountHint = result.accountHint === null ? null : this.#options.redact(result.accountHint);
    } catch (error) {
      state = "error";
      detail = `The check failed: ${describeError(error, this.#options.redact, 300)}`;
      accountHint = null;
    }
    const view: ConnectionView = {
      ...INTEGRATION_FACTS[integration],
      state,
      detail,
      endpointLabel: resolution.connection.endpointLabel,
      accountHint,
      missing: [],
      checkedAt,
      canConnect: INTEGRATIONS[integration].kind === "composio" && state !== "connected",
    };
    this.#save(view);
    return view;
  }

  /** Probes every configured integration (at boot); failures are recorded, never thrown. */
  async checkAll(signal?: AbortSignal): Promise<void> {
    await Promise.all(
      INTEGRATION_IDS.filter((id) => this.resolution(id).status === "configured").map((id) =>
        this.check(id, signal),
      ),
    );
  }

  /** Composio's sign-in link for a configured Composio integration. */
  async connect(integration: IntegrationId, callbackUrl: string): Promise<ConnectOutcome> {
    const resolution = this.resolution(integration);
    if (INTEGRATIONS[integration].kind !== "composio" || resolution.status !== "configured") {
      return {
        ok: false,
        code: "not_supported",
        message:
          "Connect is available only for configured Composio integrations (Gmail, Google Calendar).",
      };
    }
    const { connection } = resolution;
    if (connection.integration !== "gmail" && connection.integration !== "google_calendar") {
      return { ok: false, code: "not_supported", message: "This integration has no Connect flow." };
    }
    try {
      const { redirectUrl } = await this.#options.authorizeComposio(connection, callbackUrl);
      return { ok: true, redirectUrl };
    } catch (error) {
      return {
        ok: false,
        code: "upstream_error",
        message: `Composio could not start the sign-in: ${describeError(error, this.#options.redact, 300)}`,
      };
    }
  }

  /** One plan per integration for a run, plus the matching snapshot for the runs row. */
  plans(): { readonly plans: ConnectionPlan[]; readonly snapshot: RunConnection[] } {
    const rows = readConnectionRows(this.#options.db);
    const plans: ConnectionPlan[] = [];
    const snapshot: RunConnection[] = [];
    for (const integration of INTEGRATION_IDS) {
      const resolution = this.resolution(integration);
      const view = this.#view(integration, resolution, rows.get(integration));
      const facts = INTEGRATION_FACTS[integration];
      const blocked =
        view.state === "not_configured" ||
        view.state === "invalid" ||
        view.state === "needs_auth" ||
        view.state === "expired";
      if (resolution.status === "configured" && !blocked) {
        plans.push({ integration, status: "available", connection: resolution.connection });
        snapshot.push({
          integration,
          kind: facts.kind,
          profile: facts.profile,
          availability: "ready",
          state: view.state,
          detail: null,
          endpointLabel: view.endpointLabel,
        });
        continue;
      }
      const state = view.state === "connected" ? "error" : view.state;
      plans.push({ integration, status: "unavailable", state, detail: view.detail });
      snapshot.push({
        integration,
        kind: facts.kind,
        profile: facts.profile,
        availability: "unavailable",
        state,
        detail: view.detail,
        endpointLabel: view.endpointLabel,
      });
    }
    return { plans, snapshot };
  }

  #definition(integration: IntegrationId): IntegrationDefinition {
    const definition = this.#definitions.get(integration);
    if (definition === undefined) throw new Error(`No integration definition for ${integration}`);
    return definition;
  }

  #view(
    integration: IntegrationId,
    resolution: ConnectionResolution,
    row: ConnectionRow | undefined,
  ): ConnectionView {
    const facts = INTEGRATION_FACTS[integration];
    const checkedAt = row?.lastCheckedAt ?? null;
    if (resolution.status === "not_configured") {
      return {
        ...facts,
        state: "not_configured",
        detail: `Not configured. Set ${resolution.missing.join(", ")}.`,
        endpointLabel: null,
        accountHint: null,
        missing: [...resolution.missing],
        checkedAt,
        canConnect: false,
      };
    }
    if (resolution.status === "invalid") {
      return {
        ...facts,
        state: "invalid",
        detail: resolution.problems
          .map((problem) => `${problem.variable}: ${problem.message}`)
          .join(" "),
        endpointLabel: null,
        accountHint: null,
        missing: [],
        checkedAt,
        canConnect: false,
      };
    }
    const probed = row !== undefined && PROBE_STATES.has(row.status);
    const state: ConnectionState = probed ? row.status : "unknown";
    return {
      ...facts,
      state,
      detail: probed ? row.statusDetail : "Not checked yet.",
      endpointLabel: resolution.connection.endpointLabel,
      accountHint: probed ? row.accountHint : null,
      missing: [],
      checkedAt,
      canConnect: facts.kind === "composio" && state !== "connected",
    };
  }

  #save(view: ConnectionView): void {
    saveConnectionStatus(
      this.#options.db,
      {
        integration: view.integration,
        state: view.state,
        detail: view.detail,
        endpointLabel: view.endpointLabel,
        accountHint: view.accountHint,
        missing: view.missing,
        checkedAt: view.checkedAt,
      },
      this.#options.now().toISOString(),
    );
  }
}

const INTEGRATION_FACTS = Object.fromEntries(
  INTEGRATION_IDS.map((id) => [
    id,
    {
      integration: id,
      label: INTEGRATIONS[id].label,
      kind: INTEGRATIONS[id].kind,
      profile: INTEGRATIONS[id].profile,
    },
  ]),
) as {
  readonly [I in IntegrationId]: Pick<ConnectionView, "integration" | "label" | "kind" | "profile">;
};
