// Everything the /api routes use, assembled once per server (runtime.ts) or
// per test.

import type { AgentEnv } from "../contracts/env.js";
import type { DbExecutor } from "../db/repos/types.js";
import type { ApprovalGateController } from "../policy/approvals.js";
import type { ChatService } from "./chat-service.js";
import type { ConnectionService } from "./connections.js";
import type { OrphanSweeper } from "./orphans.js";
import type { Redact } from "./redaction.js";
import type { RunRegistry } from "./run-registry.js";
import type { SessionSecrets } from "./security.js";

export type ApiServices = {
  readonly db: DbExecutor;
  readonly env: AgentEnv;
  /** Package version, reported by /api/health and /api/session. */
  readonly version: string;
  readonly secrets: SessionSecrets;
  readonly registry: RunRegistry;
  readonly chat: ChatService;
  /** The approval gate (src/policy/approvals.ts) over the approvals table. */
  readonly approvals: ApprovalGateController;
  readonly connections: ConnectionService;
  /** Recovers runs whose process is gone (a killed CLI). */
  readonly orphans: OrphanSweeper;
  readonly redact: Redact;
  readonly now: () => Date;
  readonly newId: () => string;
  /** Operator log lines (stderr in production); already redacted by the caller. */
  readonly log: (line: string) => void;
};
