// Server assembly and boot (docs/ARCHITECTURE.md §4, §7, §8):
//
//   open <AGENT_STATE_DIR>/revenue-desk.sqlite -> seed defaults -> boot
//   recovery -> connection rows from configuration -> listen on 127.0.0.1 ->
//   read-only probes in the background.
//
// The agent core (runTurn) and the integration definitions are injected: they
// come from the core and integration workstreams, and unit tests pass
// in-process stubs of both (test/unit/server/harness.ts). The
// redactor defaults to the one built from the snapshot; the approval gate is
// the policy's (src/policy/approvals.ts) over the server's approvals table.

import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createRedactor } from "../config/redact.js";
import type { AgentEnv } from "../contracts/env.js";
import type { RunTurn } from "../contracts/events.js";
import type { IntegrationDefinition } from "../contracts/integration.js";
import { databasePath, openDatabase } from "../db/client.js";
import type { DbExecutor } from "../db/repos/types.js";
import { seedDatabase } from "../db/seed.js";
import { connectionFromFailure } from "../integrations/registry.js";
import { createApprovalGate } from "../policy/approvals.js";
import { createApp } from "./app.js";
import { createApprovalStore } from "./approval-store.js";
import { ChatService } from "./chat-service.js";
import { ConnectionService } from "./connections.js";
import { OrphanSweeper, type OrphanSweeperOptions } from "./orphans.js";
import { describeError, type Redact } from "./redaction.js";
import { RunRegistry } from "./run-registry.js";
import { createSessionSecrets, type SessionSecrets } from "./security.js";
import type { ApiServices } from "./services.js";
import { SSE_HEARTBEAT_MS } from "./sse.js";

/** The server always binds here (docs/ARCHITECTURE.md §3). */
export const SERVER_HOST = "127.0.0.1";
/** How long shutdown waits for runs to stop before closing the database. */
export const SHUTDOWN_TIMEOUT_MS = 4_000;

export type ServerDependencies = {
  readonly env: AgentEnv;
  readonly runTurn: RunTurn;
  /** One definition per integration (src/integrations, W2). */
  readonly integrations: readonly IntegrationDefinition[];
  /** Default: the redactor for the snapshot's secrets (src/config/redact.ts). */
  readonly redact?: Redact;
  readonly version: string;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly secrets?: SessionSecrets;
  readonly maxConcurrentRuns?: number;
  readonly stopGraceMs?: number;
  /** How often an open run stream sends an SSE comment. Default 15 s (sse.ts). */
  readonly sseHeartbeatMs?: number;
  /** Test seams for run ownership (src/db/owner.ts). Default: this process and the system. */
  readonly ownership?: OrphanSweeperOptions["ownership"];
};

/** Wires the services over an open database. */
export function createApiServices(
  deps: ServerDependencies & { readonly db: DbExecutor },
): ApiServices {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const redact = deps.redact ?? createRedactor(deps.env);
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const approvals = createApprovalGate({
    store: createApprovalStore(deps.db, redact),
    now,
    onError: (error, { approvalId }) =>
      log(`Approval ${approvalId} could not be recorded: ${describeError(error, redact)}`),
  });
  const connections = new ConnectionService({
    db: deps.db,
    env: deps.env,
    integrations: deps.integrations,
    redact,
    now,
  });
  const registry = new RunRegistry({
    db: deps.db,
    runTurn: deps.runTurn,
    redact,
    now,
    log,
    newId,
    ...(deps.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: deps.maxConcurrentRuns }),
    ...(deps.stopGraceMs === undefined ? {} : { stopGraceMs: deps.stopGraceMs }),
    // A call whose provider refused the credential marks the connection as a check would.
    connectionFromFailure,
  });
  const orphans = new OrphanSweeper({
    db: deps.db,
    runsLocally: (runId) => registry.get(runId) !== undefined,
    now,
    log,
    redact,
    ...(deps.ownership === undefined ? {} : { ownership: deps.ownership }),
  });
  const chat = new ChatService({
    db: deps.db,
    env: deps.env,
    registry,
    connections,
    approvals,
    orphans,
    now,
    newId,
  });
  return {
    db: deps.db,
    env: deps.env,
    version: deps.version,
    secrets: deps.secrets ?? createSessionSecrets(),
    registry,
    chat,
    approvals,
    connections,
    orphans,
    redact,
    sseHeartbeatMs: deps.sseHeartbeatMs ?? SSE_HEARTBEAT_MS,
    now,
    newId,
    log,
  };
}

/**
 * Seeds defaults, recovers the runs whose process is gone (this server's
 * previous life, a killed CLI) and stores connection configuration.
 */
export function prepareDatabase(services: ApiServices): void {
  const now = services.now().toISOString();
  seedDatabase(services.db, now);
  const recovered = services.orphans.boot();
  if (recovered.runs > 0 || recovered.approvals > 0) {
    services.log(
      `Boot recovery: ${recovered.runs} interrupted run(s) failed, ${recovered.approvals} pending approval(s) expired.`,
    );
  }
  services.connections.syncConfiguration();
}

export type RunningServer = {
  readonly url: string;
  readonly port: number;
  readonly services: ApiServices;
  /** Stops every run (as shutdown), closes the listener and the database. */
  close(): Promise<void>;
};

export async function startServer(
  deps: ServerDependencies & { readonly webRoot?: string },
): Promise<RunningServer> {
  const database = openDatabase({ path: databasePath(deps.env.runtime.stateDir) });
  try {
    const services = createApiServices({ ...deps, db: database.db });
    prepareDatabase(services);
    const app = createApp({
      version: deps.version,
      api: services,
      ...(deps.webRoot === undefined ? {} : { webRoot: deps.webRoot }),
    });
    const server = serve({ fetch: app.fetch, hostname: SERVER_HOST, port: deps.env.runtime.port });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const port = (server.address() as AddressInfo).port;

    const probes = new AbortController();
    services.connections.checkAll(probes.signal).catch((error: unknown) => {
      services.log(`Connection checks failed: ${describeError(error, services.redact)}`);
    });

    let closing: Promise<void> | undefined;
    return {
      url: `http://${SERVER_HOST}:${port}`,
      port,
      services,
      close: () => {
        closing ??= (async () => {
          probes.abort();
          // No new connection from here on; a request on an open one gets 503 for a new run.
          const closed = new Promise<void>((resolve) => server.close(() => resolve()));
          await services.registry.shutdown(SHUTDOWN_TIMEOUT_MS);
          // Idle keep-alive sockets would otherwise hold close() open.
          if ("closeIdleConnections" in server) server.closeIdleConnections();
          await closed;
          database.close();
        })();
        return closing;
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
