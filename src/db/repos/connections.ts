// Last known status of each integration (docs/ARCHITECTURE.md §8): written from
// configuration at boot and from read-only probes. Never holds a secret.

import type { EnvVarName } from "../../contracts/env.js";
import { INTEGRATIONS, type IntegrationId } from "../../contracts/integration.js";
import { type ConnectionRow, connections } from "../schema.js";
import type { DbExecutor, IsoTime } from "./types.js";

export type StoredConnectionStatus = {
  readonly integration: IntegrationId;
  readonly state: ConnectionRow["status"];
  readonly detail: string;
  readonly endpointLabel: string | null;
  readonly accountHint: string | null;
  readonly missing: readonly EnvVarName[];
  readonly checkedAt: IsoTime | null;
};

export function readConnectionRows(db: DbExecutor): ReadonlyMap<IntegrationId, ConnectionRow> {
  return new Map(
    db
      .select()
      .from(connections)
      .all()
      .map((row) => [row.integration, row]),
  );
}

export function saveConnectionStatus(
  db: DbExecutor,
  status: StoredConnectionStatus,
  now: IsoTime,
): void {
  const info = INTEGRATIONS[status.integration];
  const values = {
    kind: info.kind,
    profile: info.profile,
    status: status.state,
    statusDetail: status.detail,
    endpointLabel: status.endpointLabel,
    accountHint: status.accountHint,
    missingVars: [...status.missing],
    lastCheckedAt: status.checkedAt,
    updatedAt: now,
  };
  db.insert(connections)
    .values({ integration: status.integration, ...values })
    .onConflictDoUpdate({ target: connections.integration, set: values })
    .run();
}
