/**
 * Plays scenarios through the HTTP API of a running harness, as the chat
 * screen does: create a conversation, POST /api/chat, read the UI message
 * stream, and decide each approval (POST /api/approvals/:id) or stop the run
 * (POST /api/runs/:id/stop) while the stream is open. A conversation sends
 * each scenario's prompt in turn to the same conversation. Returns the
 * chunks and every problem, like runScenarioInCore().
 */
import type { StreamChunk } from "../support/api-client.js";
import { FAKE_CREDENTIAL_VALUES } from "../support/fakes/credentials.js";
import type { Harness } from "../support/harness.js";
import { logicalCallId, type Scenario } from "./script.js";

export interface HttpTurn {
  readonly scenario: Scenario;
  readonly runId: string | null;
  readonly chunks: readonly StreamChunk[];
  /** The run status from the stream's message metadata. */
  readonly status: string | null;
  /** All text the assistant streamed. */
  readonly text: string;
}

export interface HttpScenarioRun extends HttpTurn {
  readonly conversationId: string;
  readonly turns: readonly HttpTurn[];
  readonly problems: readonly string[];
}

export function runScenarioOverHttp(
  harness: Harness,
  scenario: Scenario,
): Promise<HttpScenarioRun> {
  return runConversationOverHttp(harness, [scenario]);
}

export async function runConversationOverHttp(
  harness: Harness,
  scenarios: readonly Scenario[],
): Promise<HttpScenarioRun> {
  const api = harness.api;
  if (api === null) throw new Error("The harness has no server");
  const [first] = scenarios;
  if (first === undefined) throw new Error("A conversation needs at least one scenario");
  await api.session();
  const { conversation } = await api.expect("POST /api/conversations", {
    body: { title: first.title },
  });
  const problems: string[] = [];
  const turns: HttpTurn[] = [];
  for (const [index, scenario] of scenarios.entries()) {
    const turn = index + 1;
    const label = scenarios.length === 1 ? "" : `turn ${turn} (${scenario.id}): `;
    const note = (problem: string) => problems.push(`${label}${problem}`);
    const asked = new Set<string>();
    const actions: Promise<unknown>[] = [];
    let runId: string | null = null;
    const chunks = await api.chat(conversation.id, scenario.prompt, {
      onChunk: (chunk) => {
        if (chunk.type === "start")
          runId = (chunk.messageMetadata as { runId?: string } | undefined)?.runId ?? null;
        if (chunk.type !== "tool-approval-request" || chunk.isAutomatic === true) return;
        const logical = logicalCallId(String(chunk.toolCallId)) ?? String(chunk.toolCallId);
        asked.add(logical);
        const decision = scenario.approvals[logical];
        if (decision === undefined)
          note(`approval requested for ${logical}, which the scenario does not expect`);
        if (decision === "stop") {
          const id = runId;
          if (id === null) {
            note("cannot stop: the stream carried no runId before the approval");
            return;
          }
          actions.push(
            api.call("POST /api/runs/:runId/stop", { params: { runId: id } }).then((reply) => {
              if (!reply.ok) note(`stopping the run answered ${reply.status}`);
            }),
          );
          return;
        }
        actions.push(
          api
            .decide(
              String(chunk.approvalId),
              decision === "approve",
              decision === "approve" ? undefined : "Not now.",
            )
            .then((reply) => {
              if (!reply.ok) note(`deciding ${logical} answered ${reply.status}`);
            }),
        );
      },
    });
    await Promise.all(actions);
    const played = describe(scenario, runId, chunks);
    turns.push(played);
    for (const logical of Object.keys(scenario.approvals)) {
      if (!asked.has(logical)) note(`no approval was requested for ${logical}`);
    }
    if (played.status !== scenario.expected.status)
      note(`run ended ${String(played.status)}, expected ${scenario.expected.status}`);
    for (const fragment of scenario.expected.replyIncludes ?? []) {
      if (!played.text.includes(fragment)) note(`the streamed text lacks "${fragment}"`);
    }
    if (played.runId === null) note("the stream carried no runId");
    else
      problems.push(
        ...(scenario.verify?.(harness.fakes, { runId: played.runId, turn }) ?? []).map(
          (problem) => `${label}${problem}`,
        ),
      );
  }
  if (harness.script !== null) {
    problems.push(
      ...harness.script.problems.map(
        (entry) => `script ${entry.scenario} step ${entry.step}: ${entry.message}`,
      ),
    );
  }
  const wire = JSON.stringify(turns.map((entry) => entry.chunks));
  for (const credential of FAKE_CREDENTIAL_VALUES) {
    if (wire.includes(credential)) problems.push("a fake credential appears in the UI stream");
  }
  const last = turns.at(-1) as HttpTurn;
  return { ...last, conversationId: conversation.id, turns, problems };
}

function describe(
  scenario: Scenario,
  runId: string | null,
  chunks: readonly StreamChunk[],
): HttpTurn {
  const status =
    chunks
      .filter((chunk) => chunk.type === "message-metadata")
      .map((chunk) => (chunk.messageMetadata as { status?: string } | undefined)?.status)
      .findLast((value) => value !== undefined) ?? null;
  const text = chunks
    .filter((chunk) => chunk.type === "text-delta")
    .map((chunk) => String(chunk.delta ?? ""))
    .join("");
  return { scenario, runId, chunks, status, text };
}
