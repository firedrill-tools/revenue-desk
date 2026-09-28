// The composition root of `revenue-desk ask`: the agent core (src/agent), the
// integrations (src/integrations) and the database (src/db) behind the
// AskServices port (src/cli/ports.ts).
//
// A CLI run is stored exactly like an app run (src/server/run-persistence.ts):
// the same runs, tool_calls and messages rows, with source "cli", so it
// appears in the app. Connection plans come from the configuration and the
// last check the app stored (the connections table); the CLI runs no probes,
// and an upstream that cannot be reached is reported by the gateway at run
// time. One services instance serves one invocation.

import { randomUUID } from "node:crypto";
import { createRunTurn } from "../agent/run-turn.js";
import { loadAgentEnv } from "../config/env.js";
import { createRedactor } from "../config/redact.js";
import type { ConversationStatus } from "../contracts/api.js";
import type { AgentEnv } from "../contracts/env.js";
import type { RunTurnInput } from "../contracts/events.js";
import type { IntegrationId } from "../contracts/integration.js";
import { databasePath, openDatabase } from "../db/client.js";
import { currentRunOwner } from "../db/owner.js";
import { recoverOrphanedRuns } from "../db/recover.js";
import { readConnectionRows } from "../db/repos/connections.js";
import {
  getConversation,
  insertConversation,
  nameConversationIfBlank,
  setConversationStatus,
} from "../db/repos/conversations.js";
import { insertUserMessage } from "../db/repos/messages.js";
import { readSavedPolicies } from "../db/repos/policies.js";
import { insertRun, runningRunOf } from "../db/repos/runs.js";
import { readSettings } from "../db/repos/settings.js";
import type { DbExecutor } from "../db/repos/types.js";
import type { ConversationRow } from "../db/schema.js";
import { seedDatabase } from "../db/seed.js";
import { recordedUsageBaselines, stateDirUsageBaselines } from "../db/usage-baseline.js";
import {
  connectionSnapshot,
  integrations,
  type KnownConnection,
  knownFromCheck,
} from "../integrations/registry.js";
import { titleFromMessage } from "../server/conversation-title.js";
import { RunPersistence } from "../server/run-persistence.js";
import type { AskServices, CliWorkspace, ConversationRecord, RunRecorder } from "./ports.js";
import { packageVersion } from "./version.js";

export type ServiceOptions = {
  /** Diagnostics (already redacted), e.g. a message that could not be stored. Default stderr. */
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
  readonly newId?: () => string;
};

export function createServices(options: ServiceOptions = {}): Promise<AskServices> {
  const log = options.log ?? ((line: string) => process.stderr.write(`revenue-desk: ${line}\n`));
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const catalog = integrations();
  /** The open workspace's database: the connections table holds the last checks. */
  let workspaceDb: DbExecutor | null = null;

  const services: AskServices = {
    loadConfig: (environment, { cwd }) => loadAgentEnv(environment, { cwd }),
    createRedactor: (env) => createRedactor(env),
    openWorkspace(env) {
      const workspace = openCliWorkspace(env, { log, now, newId });
      workspaceDb = workspace.db;
      return workspace;
    },
    async planConnections({ env }) {
      const known = workspaceDb === null ? {} : knownConnections(workspaceDb);
      return connectionSnapshot(catalog, env, known).plans;
    },
    runTurn: createRunTurn({
      catalog,
      version: packageVersion(),
      // A resumed session's usage is measured against what the database recorded.
      usageStore: (stateDir) =>
        workspaceDb === null
          ? stateDirUsageBaselines(stateDir)
          : recordedUsageBaselines(workspaceDb),
    }),
  };
  return Promise.resolve(services);
}

/** The app's last checks; a stored configuration state is not a check. */
function knownConnections(db: DbExecutor): { [I in IntegrationId]?: KnownConnection } {
  const known: { [I in IntegrationId]?: KnownConnection } = {};
  for (const [integration, row] of readConnectionRows(db)) {
    const check = knownFromCheck(row.status, row.statusDetail);
    if (check !== undefined) known[integration] = check;
  }
  return known;
}

type WorkspaceOptions = {
  readonly log: (line: string) => void;
  readonly now: () => Date;
  readonly newId: () => string;
};

/** The shared state directory's database, seeded, for one invocation. */
function openCliWorkspace(
  env: AgentEnv,
  options: WorkspaceOptions,
): CliWorkspace & { readonly db: DbExecutor } {
  const database = openDatabase({ path: databasePath(env.runtime.stateDir) });
  const { db } = database;
  const redact = createRedactor(env);
  const recover = (conversationId?: string) => {
    const recovered = recoverOrphanedRuns(db, {
      now: options.now().toISOString(),
      ...(conversationId === undefined ? {} : { conversationId }),
    });
    if (recovered.runs > 0) {
      options.log(`recovered ${recovered.runs} earlier run(s) whose process had exited.`);
    }
  };
  try {
    seedDatabase(db, options.now().toISOString());
    // A run whose process died (e.g. a CLI killed with SIGKILL) must not keep
    // its conversation busy: nothing will ever finish it.
    recover();
  } catch (error) {
    database.close();
    throw error;
  }

  return {
    db,
    settings: () => readSettings(db),
    savedPolicy: () => readSavedPolicies(db),
    findConversation(id) {
      const row = getConversation(db, id);
      return row === undefined ? null : conversationRecord(row);
    },
    createConversation({ id, title, createdAt }) {
      return conversationRecord(
        insertConversation(db, { id, title, source: "cli", now: createdAt }),
      );
    },
    beginRun(input: RunTurnInput): RunRecorder {
      const assistantMessageId = options.newId();
      const startedAt = options.now().toISOString();
      if (runningRunOf(db, input.conversationId) !== undefined) recover(input.conversationId);
      db.transaction(
        (tx) => {
          if (runningRunOf(tx, input.conversationId) !== undefined) {
            throw new Error(`Conversation ${input.conversationId} already has an active run.`);
          }
          const userMessageId = options.newId();
          insertRun(tx, {
            id: input.runId,
            conversationId: input.conversationId,
            source: "cli",
            mode: "headless",
            model: input.model.model,
            effort: input.model.effort,
            userMessageId,
            assistantMessageId,
            policy: input.policy,
            connections: connectionSnapshot(integrations(), input.env, knownConnections(tx))
              .connections,
            startedAt,
            owner: currentRunOwner(),
          });
          insertUserMessage(tx, {
            id: userMessageId,
            conversationId: input.conversationId,
            runId: input.runId,
            parts: [{ type: "text", text: input.prompt }],
            now: startedAt,
          });
          nameConversationIfBlank(
            tx,
            input.conversationId,
            titleFromMessage(input.prompt),
            startedAt,
          );
          setConversationStatus(tx, input.conversationId, "running", startedAt);
        },
        { behavior: "immediate" },
      );

      const persistence = new RunPersistence({
        db,
        runId: input.runId,
        conversationId: input.conversationId,
        assistantMessageId,
        fallbackMetadata: {
          runId: input.runId,
          model: input.model.model,
          effort: input.model.effort,
        },
        redact,
        now: options.now,
        log: options.log,
        newId: options.newId,
      });
      return {
        async record(event) {
          // A failure to record fails the run (the CLI aborts the core).
          persistence.record(event);
          persistence.map(event);
          if (event.type === "run.finished") await persistence.end(event.status);
        },
      };
    },
    close: () => database.close(),
  };
}

function conversationRecord(row: ConversationRow): ConversationRecord {
  const status: ConversationStatus = row.status;
  return { id: row.id, status, sdkSessionId: row.sdkSessionId };
}
