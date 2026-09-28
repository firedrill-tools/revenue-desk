// Server boot (runtime.ts): seed, boot recovery, connection rows, a loopback
// listener, background probes and an orderly shutdown. Also the seed script.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ConnectionView } from "../../../src/contracts/api.js";
import { DEFAULT_POLICY } from "../../../src/contracts/integration.js";
import { databasePath, openDatabase } from "../../../src/db/client.js";
import { getApproval, insertPendingApproval } from "../../../src/db/repos/approvals.js";
import { insertConversation } from "../../../src/db/repos/conversations.js";
import { readSavedPolicies } from "../../../src/db/repos/policies.js";
import { getRun, insertRun } from "../../../src/db/repos/runs.js";
import { readSettings } from "../../../src/db/repos/settings.js";
import { type RunningServer, SERVER_HOST, startServer } from "../../../src/server/runtime.js";
import {
  cleanupAll,
  fakeIntegrations,
  heldScript,
  refundDescriptor,
  scriptedCore,
  tempStateDir,
  testEnv,
  testRedact,
} from "./harness.js";

const running: RunningServer[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
  cleanupAll();
});

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("startServer", () => {
  it("recovers, seeds, listens on 127.0.0.1 and probes in the background", async () => {
    const stateDir = tempStateDir();
    // A previous process died with a run waiting for approval.
    const previous = openDatabase({ path: databasePath(stateDir) });
    insertConversation(previous.db, {
      id: "c1",
      title: "",
      source: "ui",
      now: "2026-09-28T09:00:00.000Z",
    });
    insertRun(previous.db, {
      id: "r_old",
      conversationId: "c1",
      source: "ui",
      mode: "interactive",
      model: "claude-sonnet-5",
      effort: "medium",
      userMessageId: null,
      assistantMessageId: null,
      policy: DEFAULT_POLICY,
      connections: [],
      startedAt: "2026-09-28T09:00:00.000Z",
    });
    insertPendingApproval(previous.db, {
      id: "apr_old",
      runId: "r_old",
      conversationId: "c1",
      toolUseId: "toolu_old",
      descriptor: refundDescriptor(),
      requestedAt: "2026-09-28T09:00:00.000Z",
      expiresAt: refundDescriptor().expiresAt,
    });
    previous.close();

    const logs: string[] = [];
    const integrations = fakeIntegrations({ configuration: { stripe: "configured" } });
    const server = await startServer({
      env: testEnv(stateDir),
      runTurn: scriptedCore(heldScript().script).runTurn,
      integrations: integrations.definitions,
      redact: testRedact,
      authorizeComposio: async () => ({ redirectUrl: "https://example.test" }),
      version: "9.9.9",
      log: (line) => logs.push(line),
    });
    running.push(server);
    expect(server.url).toBe(`http://${SERVER_HOST}:${server.port}`);

    const health = await fetch(`${server.url}/api/health`);
    expect(await health.json()).toEqual({
      status: "ok",
      service: "revenue-desk",
      version: "9.9.9",
    });

    const { db } = server.services;
    expect(getRun(db, "r_old")).toMatchObject({ status: "failed", errorCode: "server_restart" });
    expect(getApproval(db, "apr_old")).toMatchObject({ status: "expired", decidedBy: "restart" });
    expect(readSettings(db).agentName).toBe("Revenue Desk");
    expect(readSavedPolicies(db)).toEqual(DEFAULT_POLICY);
    expect(logs.join("\n")).toMatch(
      /1 interrupted run\(s\) failed, 1 pending approval\(s\) expired/,
    );

    await expect.poll(() => integrations.probeCalls.get("stripe")).toBe(1);
    const connections = (await (await fetch(`${server.url}/api/connections`)).json()) as {
      items: ConnectionView[];
    };
    expect(connections.items.find((item) => item.integration === "stripe")?.state).toBe(
      "connected",
    );
    expect(connections.items.find((item) => item.integration === "slack")?.state).toBe(
      "not_configured",
    );
  });

  it("stops active runs as a shutdown when it closes", async () => {
    const held = heldScript();
    const core = scriptedCore(held.script);
    const server = await startServer({
      env: testEnv(tempStateDir()),
      runTurn: core.runTurn,
      integrations: fakeIntegrations().definitions,
      redact: testRedact,
      authorizeComposio: async () => ({ redirectUrl: "https://example.test" }),
      version: "9.9.9",
      log: () => {},
    });
    const session = await fetch(`${server.url}/api/session`);
    const { csrfToken } = (await session.json()) as { csrfToken: string };
    const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const headers = {
      "content-type": "application/json",
      origin: server.url,
      cookie,
      "x-rd-csrf": csrfToken,
    };
    const created = await fetch(`${server.url}/api/conversations`, {
      method: "POST",
      headers,
      body: "{}",
    });
    const { conversation } = (await created.json()) as { conversation: { id: string } };
    const chat = await fetch(`${server.url}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        conversationId: conversation.id,
        message: { id: "u1", role: "user", parts: [{ type: "text", text: "Wait" }] },
      }),
    });
    expect(chat.status).toBe(200);
    const body = chat.text();
    await expect.poll(() => core.inputs.length).toBe(1);

    await server.close();
    expect((await body).trim().endsWith("data: [DONE]")).toBe(true);
    expect(core.inputs[0]?.signal.reason).toBe("shutdown");
  });
});

describe("pnpm db:seed", () => {
  it("seeds the state directory's database idempotently and exits 0", () => {
    const stateDir = tempStateDir();
    const run = () =>
      execFileSync(process.execPath, ["--import", "tsx", "src/db/seed.ts"], {
        cwd: REPO_ROOT,
        env: { PATH: process.env.PATH ?? "", AGENT_STATE_DIR: stateDir },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    expect(run()).toBe("");
    run();
    const database = openDatabase({ path: databasePath(stateDir) });
    try {
      expect(readSettings(database.db).companyName).toBe("");
      expect(readSavedPolicies(database.db)).toEqual(DEFAULT_POLICY);
      expect(database.sqlite.prepare("SELECT count(*) FROM conversations").pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });
});
