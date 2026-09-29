// Connection status for the Connections screen and for each run
// (docs/ARCHITECTURE.md §3, §5, §9), over the integrations' own rules in
// src/integrations/registry.ts, which the CLI uses too:
//
// - statusFromResolution: configured, not_configured (missing variable
//   names) or invalid (problems, never values), from the snapshot only;
// - checkConnection: the read-only probe of a configured integration;
// - connectionSnapshot: which integrations a run is offered (configured, and
//   the last check did not say needs_auth or expired).
//
// This service adds what the app needs around them: the last check results
// in the connections table, redaction of what a probe says, and Connect,
// which exists only for Composio and runs only on the user's click, through
// the integration's own connector (the same Composio session cache as its
// probes and runs).

import type { ConnectionView } from "../contracts/api.js";
import type { AgentEnv } from "../contracts/env.js";
import type { ConnectionPlan, RunConnection } from "../contracts/events.js";
import {
  COMPOSIO_TOOLKIT_OF,
  type ComposioIntegrationId,
  type ComposioToolkitSlug,
  type ConnectionStatus,
  INTEGRATION_IDS,
  INTEGRATIONS,
  type IntegrationDefinition,
  type IntegrationId,
  type ResolvedConnectionOf,
} from "../contracts/integration.js";
import { readConnectionRows, saveConnectionStatus } from "../db/repos/connections.js";
import type { DbExecutor } from "../db/repos/types.js";
import type { ConnectionRow } from "../db/schema.js";
import {
  checkConnection,
  connectionSnapshot,
  type IntegrationSet,
  integrationSet,
  type KnownConnection,
  knownFromCheck,
  statusFromResolution,
} from "../integrations/registry.js";
import { describeError, type Redact } from "./redaction.js";

export type ConnectOutcome =
  | { readonly ok: true; readonly redirectUrl: string }
  | {
      readonly ok: false;
      readonly code: "not_supported" | "upstream_error";
      readonly message: string;
    };

/**
 * A Composio integration's Connect: its connector's hosted sign-in
 * (ComposioIntegration.connector(...).authorize in src/integrations).
 */
type Connectable<I extends ComposioIntegrationId> = IntegrationDefinition<I> & {
  connector(connection: ResolvedConnectionOf<I>): {
    authorize(
      toolkit: ComposioToolkitSlug,
      callbackUrl: string,
    ): Promise<{ readonly redirectUrl: string }>;
  };
};

function connectable<I extends ComposioIntegrationId>(
  definition: IntegrationDefinition<I>,
): definition is Connectable<I> {
  return typeof (definition as Partial<Connectable<I>>).connector === "function";
}

export type ConnectionServiceOptions = {
  readonly db: DbExecutor;
  readonly env: AgentEnv;
  /** Exactly one definition per integration. */
  readonly integrations: readonly IntegrationDefinition[];
  readonly redact: Redact;
  readonly now: () => Date;
  /** Per probe. Default 20 seconds. */
  readonly probeTimeoutMs?: number;
};

/** The longest probe detail stored or shown. */
const MAX_DETAIL_LENGTH = 300;

const NOT_CONNECTABLE: ConnectOutcome = {
  ok: false,
  code: "not_supported",
  message:
    "Connect is available only for configured Composio integrations (Gmail, Google Calendar, QuickBooks Online, Slack).",
};

export class ConnectionService {
  readonly #options: ConnectionServiceOptions;
  readonly #set: IntegrationSet;

  constructor(options: ConnectionServiceOptions) {
    this.#options = options;
    this.#set = integrationSet(options.integrations);
  }

  /**
   * Stores every integration's configuration state (at boot). A configured
   * integration keeps its last check until the next check.
   */
  syncConfiguration(): void {
    for (const view of this.list()) this.#save(view);
  }

  list(): ConnectionView[] {
    const rows = readConnectionRows(this.#options.db);
    return INTEGRATION_IDS.map((integration) => this.#view(integration, rows.get(integration)));
  }

  get(integration: IntegrationId): ConnectionView {
    return this.#view(integration, readConnectionRows(this.#options.db).get(integration));
  }

  /** Runs the read-only check of a configured integration and stores the result. */
  async check(integration: IntegrationId, signal?: AbortSignal): Promise<ConnectionView> {
    const timeout = AbortSignal.timeout(this.#options.probeTimeoutMs ?? 20_000);
    const probeSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const status = await checkConnection(
      this.#set,
      integration,
      this.#options.env,
      probeSignal,
      this.#options.now,
    );
    const view = this.#toView(
      status.checkedAt === null
        ? status
        : {
            ...status,
            detail: this.#clean(status.detail),
            accountHint: status.accountHint === null ? null : this.#clean(status.accountHint),
          },
    );
    this.#save(view);
    return view;
  }

  /** Checks every configured integration (at boot); failures are recorded, never thrown. */
  async checkAll(signal?: AbortSignal): Promise<void> {
    await Promise.all(
      INTEGRATION_IDS.filter(
        (id) => this.#set[id].resolve(this.#options.env).status === "configured",
      ).map((id) => this.check(id, signal)),
    );
  }

  /**
   * Composio's sign-in link for a configured Composio integration. Only the
   * user's click on Connect calls this: every call starts a new link flow.
   */
  connect(integration: IntegrationId, callbackUrl: string): Promise<ConnectOutcome> {
    switch (integration) {
      case "gmail":
        return this.#connect(this.#set.gmail, callbackUrl);
      case "google_calendar":
        return this.#connect(this.#set.google_calendar, callbackUrl);
      case "quickbooks":
        return this.#connect(this.#set.quickbooks, callbackUrl);
      case "slack":
        return this.#connect(this.#set.slack, callbackUrl);
      default:
        return Promise.resolve(NOT_CONNECTABLE);
    }
  }

  async #connect<I extends ComposioIntegrationId>(
    definition: IntegrationDefinition<I>,
    callbackUrl: string,
  ): Promise<ConnectOutcome> {
    const resolution = definition.resolve(this.#options.env);
    if (!connectable(definition) || resolution.status !== "configured") return NOT_CONNECTABLE;
    const { connection } = resolution;
    try {
      const { redirectUrl } = await definition
        .connector(connection)
        .authorize(COMPOSIO_TOOLKIT_OF[definition.id], callbackUrl);
      return { ok: true, redirectUrl };
    } catch (error) {
      return {
        ok: false,
        code: "upstream_error",
        message: `Composio could not start the sign-in: ${describeError(error, this.#options.redact, MAX_DETAIL_LENGTH)}`,
      };
    }
  }

  /** One plan per integration for a run, plus the matching snapshot for the runs row. */
  plans(): { readonly plans: ConnectionPlan[]; readonly snapshot: RunConnection[] } {
    const known: { [I in IntegrationId]?: KnownConnection } = {};
    for (const [integration, row] of readConnectionRows(this.#options.db)) {
      const check = knownFromCheck(row.status, row.statusDetail);
      if (check !== undefined) known[integration] = check;
    }
    const snapshot = connectionSnapshot(this.#set, this.#options.env, known);
    return { plans: [...snapshot.plans], snapshot: [...snapshot.connections] };
  }

  /** The configuration's status, with the last check when the integration is configured. */
  #view(integration: IntegrationId, row: ConnectionRow | undefined): ConnectionView {
    const resolution = this.#set[integration].resolve(this.#options.env);
    const status = statusFromResolution(integration, resolution);
    const check = row === undefined ? undefined : knownFromCheck(row.status, row.statusDetail);
    if (resolution.status !== "configured" || row === undefined || check === undefined) {
      return this.#toView(status);
    }
    return this.#toView({
      ...status,
      state: check.state,
      detail: check.detail,
      accountHint: row.accountHint,
      checkedAt: row.lastCheckedAt,
    });
  }

  #toView(status: ConnectionStatus): ConnectionView {
    const { label, kind } = INTEGRATIONS[status.integration];
    const configured = status.state !== "not_configured" && status.state !== "invalid";
    return {
      ...status,
      label,
      canConnect: kind === "composio" && configured && status.state !== "connected",
    };
  }

  /** What a probe says, redacted and kept short. */
  #clean(text: string): string {
    const redacted = this.#options.redact(text);
    return redacted.length <= MAX_DETAIL_LENGTH
      ? redacted
      : `${redacted.slice(0, MAX_DETAIL_LENGTH - 1)}…`;
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
