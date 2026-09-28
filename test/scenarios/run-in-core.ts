/**
 * Plays a scenario end to end through the agent core: runTurn (src/agent),
 * the production integrations registry and approval gate, the real Claude
 * Agent SDK and its native CLI, the scripted model, and every local fake.
 * Approvals are decided as the scenario declares. Everything that went wrong
 * is returned as `problems`: script drift, undeclared approvals, an outcome
 * other than the expected one, the scenario's own checks on the fakes, and
 * any fake credential leaking into events or model traffic.
 *
 * Requires the native Claude CLI; fails (never skips) without it.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunTurn } from "../../src/agent/run-turn.js";
import { loadAgentEnv } from "../../src/config/env.js";
import type { AgentEvent, AgentEventOf, RunTurnInput } from "../../src/contracts/events.js";
import { DEFAULT_POLICY } from "../../src/contracts/integration.js";
import { connectionSnapshot, createIntegrations } from "../../src/integrations/registry.js";
import {
  type ApprovalSettlement,
  type ApprovalStore,
  createApprovalGate,
  type PendingApprovalRecord,
} from "../../src/policy/approvals.js";
import { FAKE_CREDENTIAL_VALUES, FAKE_CREDENTIALS } from "../support/fakes/credentials.js";
import { type Fakes, startFakes } from "../support/fakes/index.js";
import { type MockAnthropic, startMockAnthropic } from "../support/mock-anthropic.js";
import { requireNativeSdkBinary, strayTraffic } from "../support/sdk-gate-support.js";
import { logicalCallId, type Scenario, scenarioResponder } from "./script.js";

export interface CoreScenarioRun {
  readonly scenario: Scenario;
  readonly runId: string;
  readonly events: readonly AgentEvent[];
  readonly finished: AgentEventOf<"run.finished"> | undefined;
  /** Empty when the scenario played exactly as written. */
  readonly problems: readonly string[];
  readonly fakes: Fakes;
  readonly model: MockAnthropic;
  /** The Claude CLI's stderr lines (redacted by the core), for diagnosing a failure. */
  readonly stderr: readonly string[];
  close(): Promise<void>;
}

/** Approvals in memory, with the approvals table's rule: pending exactly when undecided. */
class MemoryApprovals implements ApprovalStore {
  private readonly rows = new Map<string, "pending" | ApprovalSettlement["status"]>();

  insertPending(record: PendingApprovalRecord): void {
    if (this.rows.has(record.approvalId)) throw new Error("duplicate approval id");
    this.rows.set(record.approvalId, "pending");
  }

  settle(approvalId: string, settlement: ApprovalSettlement): boolean {
    if (this.rows.get(approvalId) !== "pending") return false;
    this.rows.set(approvalId, settlement.status);
    return true;
  }

  exists(approvalId: string): boolean {
    return this.rows.has(approvalId);
  }
}

export interface CoreScenarioOptions {
  /** Run id (the idempotency keys derive from it). Default: "run_<scenario id>". */
  readonly runId?: string;
  /** Turn limit for the run. Default 16. */
  readonly maxTurns?: number;
}

export async function runScenarioInCore(
  scenario: Scenario,
  options: CoreScenarioOptions = {},
): Promise<CoreScenarioRun> {
  requireNativeSdkBinary();
  const cleanups: (() => Promise<void> | void)[] = [];
  const close = async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  };
  try {
    const fakes = await startFakes({ hubspot: scenario.hubspot ?? "stdio" });
    cleanups.push(() => fakes.close());
    scenario.arrange?.(fakes);
    const responder = scenarioResponder(scenario);
    const model = await startMockAnthropic(FAKE_CREDENTIALS.anthropicApiKey, responder.respond);
    cleanups.push(() => model.close());
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "revenue-desk-scenario-")));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));

    const loaded = loadAgentEnv(
      {
        ...fakes.env(),
        ANTHROPIC_API_KEY: FAKE_CREDENTIALS.anthropicApiKey,
        ANTHROPIC_BASE_URL: model.url,
        HTTP_PROXY: model.url,
        HTTPS_PROXY: model.url,
        NO_PROXY: "127.0.0.1,localhost",
        CLAUDE_CODE_MAX_RETRIES: "0",
        AGENT_STATE_DIR: stateDir,
        AGENT_BUSINESS_DATE: fakes.fixtures.company.businessDate,
        AGENT_SANDBOX: "1",
      },
      { cwd: stateDir },
    );
    if (!loaded.ok)
      throw new Error(`The scenario environment was refused: ${JSON.stringify(loaded.problems)}`);
    const env = loaded.env;
    const integrations = createIntegrations();
    const { plans } = connectionSnapshot(integrations, env);
    const gate = createApprovalGate({ store: new MemoryApprovals() });
    const stderr: string[] = [];
    const runTurn = createRunTurn({
      catalog: integrations,
      version: "0.0.0-scenarios",
      onStderr: (line) => stderr.push(line),
    });
    const runId = options.runId ?? `run_${scenario.id.replaceAll("-", "_")}`;
    const input: RunTurnInput = {
      runId,
      conversationId: `conv_${scenario.id.replaceAll("-", "_")}`,
      source: "ui",
      prompt: scenario.prompt,
      resumeSessionId: null,
      env,
      model: {
        model: env.model.model,
        effort: env.model.effort,
        thinkingDisplay: "summarized",
        maxTurns: options.maxTurns ?? 16,
        maxBudgetUsd: env.model.maxBudgetUsd,
      },
      settings: {
        ...fakes.fixtures.company.workspaceSettings,
        updatedAt: fakes.fixtures.company.asOf,
      },
      policy: DEFAULT_POLICY,
      businessDate: fakes.fixtures.company.businessDate,
      connections: plans,
      signal: new AbortController().signal,
      mode: "interactive",
      approvals: gate,
    };

    const problems: string[] = [];
    const events: AgentEvent[] = [];
    const asked = new Set<string>();
    for await (const event of runTurn(input)) {
      events.push(event);
      if (event.type !== "approval.requested") continue;
      const logical = logicalCallId(event.toolCallId) ?? event.toolCallId;
      asked.add(logical);
      const decision = scenario.approvals[logical];
      if (decision === undefined)
        problems.push(`approval requested for ${logical}, which the scenario does not expect`);
      gate.decide(event.approvalId, {
        approved: decision === "approve",
        reason: decision === "approve" ? null : "Not now.",
      });
    }

    for (const logical of Object.keys(scenario.approvals)) {
      if (!asked.has(logical)) problems.push(`no approval was requested for ${logical}`);
    }
    problems.push(
      ...responder.problems.map((entry) => `script step ${entry.step}: ${entry.message}`),
    );
    const finished = events.findLast(
      (event): event is AgentEventOf<"run.finished"> => event.type === "run.finished",
    );
    if (finished === undefined) {
      problems.push("the run produced no run.finished event");
    } else {
      if (finished.status !== scenario.expected.status) {
        problems.push(
          `run ended ${finished.status} (${finished.error?.code ?? "no error"}: ${finished.error?.message ?? ""}), expected ${scenario.expected.status}`,
        );
      }
      if (
        scenario.expected.errorCode !== undefined &&
        finished.error?.code !== scenario.expected.errorCode
      ) {
        problems.push(
          `error code ${finished.error?.code ?? "none"}, expected ${scenario.expected.errorCode}`,
        );
      }
      for (const fragment of scenario.expected.replyIncludes ?? []) {
        if (!(finished.reply ?? "").includes(fragment))
          problems.push(`the reply lacks "${fragment}": ${finished.reply ?? "(no reply)"}`);
      }
    }
    problems.push(...(scenario.verify?.(fakes, { runId }) ?? []));
    const stray = strayTraffic(model.requests);
    if (stray.length > 0)
      problems.push(
        `non-model traffic reached the scripted model: ${stray.map((entry) => `${entry.method} ${entry.target}`).join(", ")}`,
      );
    const wire = JSON.stringify(events) + JSON.stringify(model.requests);
    for (const credential of FAKE_CREDENTIAL_VALUES) {
      if (wire.includes(credential))
        problems.push("a fake credential appears in events or model traffic");
    }
    return { scenario, runId, events, finished, problems, fakes, model, stderr, close };
  } catch (error) {
    await close();
    throw error;
  }
}
