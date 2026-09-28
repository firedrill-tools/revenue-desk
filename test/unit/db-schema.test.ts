import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import type { ConversationStatus, ToolCallStatus } from "../../src/contracts/api.js";
import { EFFORT_LEVELS } from "../../src/contracts/env.js";
import {
  type AgentMode,
  RUN_ERROR_CODES,
  RUN_STATUSES,
  type RunSource,
  TOOL_DECISIONS,
} from "../../src/contracts/events.js";
import {
  ACTION_CLASSES,
  APPROVAL_MODES,
  CONNECTION_KINDS,
  CONNECTION_STATES,
  DEFAULT_POLICY,
  INTEGRATION_IDS,
  INTEGRATIONS,
  type ProfileId,
} from "../../src/contracts/integration.js";
import {
  DEFAULT_MIGRATIONS_FOLDER,
  databasePath,
  openDatabase,
  type RevenueDeskDatabase,
} from "../../src/db/client.js";
import {
  approvals,
  conversations,
  DB_ENUMS,
  messages,
  policies,
  runs,
  toolCalls,
  workspaceSettings,
} from "../../src/db/schema.js";

const NOW = "2026-09-28T12:00:00.000Z";
const open: RevenueDeskDatabase[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const database of open.splice(0)) database.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fileDatabase(): RevenueDeskDatabase {
  const dir = mkdtempSync(join(tmpdir(), "revenue-desk-db-"));
  dirs.push(dir);
  const database = openDatabase({ path: databasePath(join(dir, "state")) });
  open.push(database);
  return database;
}

function seedConversationAndRun(database: RevenueDeskDatabase) {
  database.db
    .insert(conversations)
    .values({ id: "c1", source: "ui", createdAt: NOW, updatedAt: NOW })
    .run();
  database.db
    .insert(runs)
    .values({
      id: "r1",
      conversationId: "c1",
      source: "ui",
      mode: "interactive",
      model: "claude-sonnet-5",
      effort: "medium",
      policySnapshot: DEFAULT_POLICY,
      connectionsSnapshot: [],
      startedAt: NOW,
    })
    .run();
}

describe("database client", () => {
  it("creates the file under the state directory with WAL and foreign keys on", () => {
    const database = fileDatabase();
    expect(database.path.endsWith(join("state", "revenue-desk.sqlite"))).toBe(true);
    expect(database.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
  });

  it("applies the committed migrations and is idempotent on reopen", () => {
    const first = fileDatabase();
    const tables = first.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .pluck()
      .all();
    expect(tables).toEqual(
      expect.arrayContaining([
        "approvals",
        "connections",
        "conversations",
        "messages",
        "policies",
        "runs",
        "tool_calls",
        "workspace_settings",
      ]),
    );
    const again = openDatabase({ path: first.path });
    open.push(again);
    const journal = JSON.parse(
      readFileSync(join(DEFAULT_MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
    ) as { entries: unknown[] };
    expect(journal.entries.length).toBeGreaterThanOrEqual(2);
    expect(again.sqlite.prepare("SELECT count(*) FROM __drizzle_migrations").pluck().get()).toBe(
      journal.entries.length,
    );
  });
});

describe("schema constraints", () => {
  it("keeps workspace_settings a singleton with JSON defaults", () => {
    const { db } = fileDatabase();
    db.insert(workspaceSettings).values({ updatedAt: NOW }).run();
    const row = db.select().from(workspaceSettings).get();
    expect(row).toMatchObject({
      id: 1,
      agentName: "Revenue Desk",
      internalEmailDomains: [],
      allowedSlackChannels: [],
      timezone: "UTC",
      currency: "USD",
      defaultModel: null,
    });
    expect(() => db.insert(workspaceSettings).values({ id: 2, updatedAt: NOW }).run()).toThrow(
      /CHECK constraint failed: workspace_settings_singleton/,
    );
  });

  it("rejects values outside the contract enums", () => {
    const { db, sqlite } = fileDatabase();
    db.insert(policies).values({ actionClass: "financial", mode: "ask", updatedAt: NOW }).run();
    expect(() =>
      sqlite
        .prepare("INSERT INTO policies (action_class, mode, updated_at) VALUES (?, ?, ?)")
        .run("financial_plus", "ask", NOW),
    ).toThrow(/CHECK constraint failed: policies_action_class/);
    expect(() =>
      sqlite.prepare("UPDATE policies SET mode = 'maybe' WHERE action_class = 'financial'").run(),
    ).toThrow(/CHECK constraint failed: policies_mode/);
  });

  it("enforces foreign keys and cascades conversation deletes", () => {
    const database = fileDatabase();
    const { db } = database;
    expect(() =>
      db
        .insert(messages)
        .values({
          id: "m0",
          conversationId: "missing",
          role: "user",
          partsJson: [{ type: "text", text: "hi" }],
          seq: 0,
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);

    seedConversationAndRun(database);
    db.insert(messages)
      .values({
        id: "m1",
        conversationId: "c1",
        runId: "r1",
        role: "user",
        partsJson: [{ type: "text", text: "Why was I charged twice?" }],
        text: "Why was I charged twice?",
        seq: 0,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    db.delete(conversations).where(eq(conversations.id, "c1")).run();
    expect(db.select().from(runs).all()).toEqual([]);
    expect(db.select().from(messages).all()).toEqual([]);
  });

  it("ties a run's finished time to its status", () => {
    const database = fileDatabase();
    seedConversationAndRun(database);
    const { db } = database;
    expect(() =>
      db.update(runs).set({ status: "completed" }).where(eq(runs.id, "r1")).run(),
    ).toThrow(/CHECK constraint failed: runs_finished/);
    db.update(runs)
      .set({ status: "completed", finishedAt: NOW, errorCode: null })
      .where(eq(runs.id, "r1"))
      .run();
    expect(db.select({ status: runs.status }).from(runs).get()).toEqual({ status: "completed" });
  });

  it("keeps tool_use_id unique within a run and requires an integration once a known tool is decided", () => {
    const database = fileDatabase();
    seedConversationAndRun(database);
    const { db } = database;
    db.insert(runs)
      .values({
        id: "r2",
        conversationId: "c1",
        source: "ui",
        mode: "interactive",
        model: "claude-sonnet-5",
        effort: "medium",
        policySnapshot: DEFAULT_POLICY,
        connectionsSnapshot: [],
        startedAt: NOW,
      })
      .run();
    const call = {
      runId: "r1",
      conversationId: "c1",
      toolName: "mcp__stripe__create_refund",
      title: "Refund charge in Stripe",
      status: "awaiting_approval" as const,
      inputJson: { charge: "ch_2", amount: 4900 },
      startedAt: NOW,
    };
    db.insert(toolCalls)
      .values({ ...call, id: "t1", toolUseId: "toolu_1", integration: "stripe" })
      .run();
    expect(() =>
      db
        .insert(toolCalls)
        .values({ ...call, id: "t2", toolUseId: "toolu_1", integration: "stripe" })
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    // Another run may repeat a tool_use id (a scripted model does).
    db.insert(toolCalls)
      .values({ ...call, id: "t2", runId: "r2", toolUseId: "toolu_1", integration: "stripe" })
      .run();
    expect(() =>
      db
        .insert(toolCalls)
        .values({ ...call, id: "t3", toolUseId: "toolu_3", decision: "auto", status: "running" })
        .run(),
    ).toThrow(/CHECK constraint failed: tool_calls_known_tool/);
    db.insert(toolCalls)
      .values({
        ...call,
        id: "t4",
        toolUseId: "toolu_4",
        toolName: "mcp__stripe__drop_tables",
        decision: "rejected",
        status: "denied",
      })
      .run();
  });

  it("requires decided approvals to say who decided and when", () => {
    const database = fileDatabase();
    seedConversationAndRun(database);
    const { db } = database;
    db.insert(approvals)
      .values({
        id: "a1",
        runId: "r1",
        conversationId: "c1",
        toolUseId: "toolu_1",
        integration: "stripe",
        actionClass: "financial",
        operation: "stripe.refunds.create",
        consequence: "Refund $49.00 to Kestrel Analytics",
        descriptorJson: {
          actionClass: "financial",
          integration: "stripe",
          connectionKind: "api",
          operation: "stripe.refunds.create",
          title: "Refund charge in Stripe",
          consequence: "Refund $49.00 to Kestrel Analytics",
          facts: [{ label: "Amount", value: "$49.00 USD" }],
          amount: { amountMinor: 4900, currency: "USD" },
          expiresAt: NOW,
        },
        requestedAt: NOW,
        expiresAt: NOW,
      })
      .run();
    expect(() =>
      db.update(approvals).set({ status: "approved" }).where(eq(approvals.id, "a1")).run(),
    ).toThrow(/CHECK constraint failed: approvals_decided/);
    db.update(approvals)
      .set({ status: "expired", decidedBy: "restart", decidedAt: NOW, reason: "restart" })
      .where(eq(approvals.id, "a1"))
      .run();
    const row = db.select().from(approvals).get();
    expect(row?.descriptorJson.amount).toEqual({ amountMinor: 4900, currency: "USD" });
  });
});

describe("schema enums match the contracts", () => {
  it("uses the contract value lists", () => {
    expect(DB_ENUMS.integration).toEqual(INTEGRATION_IDS);
    expect(DB_ENUMS.connectionKind).toEqual(CONNECTION_KINDS);
    expect(DB_ENUMS.actionClass).toEqual(ACTION_CLASSES);
    expect(DB_ENUMS.approvalMode).toEqual(APPROVAL_MODES);
    expect(DB_ENUMS.connectionState).toEqual(CONNECTION_STATES);
    expect(DB_ENUMS.effort).toEqual(EFFORT_LEVELS);
    expect(DB_ENUMS.runStatus).toEqual(RUN_STATUSES);
    expect(DB_ENUMS.runErrorCode).toEqual(RUN_ERROR_CODES);
    expect(DB_ENUMS.toolDecision).toEqual(TOOL_DECISIONS);
    expect([...new Set(Object.values(INTEGRATIONS).map((info) => info.profile))].sort()).toEqual(
      [...DB_ENUMS.profile].sort(),
    );
  });

  it("covers exactly the contract unions", () => {
    expectTypeOf<(typeof DB_ENUMS.profile)[number]>().toEqualTypeOf<ProfileId>();
    expectTypeOf<(typeof DB_ENUMS.source)[number]>().toEqualTypeOf<RunSource>();
    expectTypeOf<(typeof DB_ENUMS.mode)[number]>().toEqualTypeOf<AgentMode>();
    expectTypeOf<
      (typeof DB_ENUMS.conversationStatus)[number]
    >().toEqualTypeOf<ConversationStatus>();
    expectTypeOf<(typeof DB_ENUMS.toolCallStatus)[number]>().toEqualTypeOf<ToolCallStatus>();
  });
});
