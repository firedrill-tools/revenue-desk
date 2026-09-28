/**
 * Plays a scenario through the HTTP API of a running harness, as the chat
 * screen does: create a conversation, POST /api/chat, read the UI message
 * stream, and decide each approval (POST /api/approvals/:id) while the
 * stream is open. Returns the chunks and every problem, like
 * runScenarioInCore(): undeclared approvals, the outcome, the scenario's
 * checks on the fakes and fake credentials in the stream.
 */
import type { StreamChunk } from "../support/api-client.js";
import { FAKE_CREDENTIAL_VALUES } from "../support/fakes/credentials.js";
import type { Harness } from "../support/harness.js";
import { logicalCallId, type Scenario } from "./script.js";

export interface HttpScenarioRun {
  readonly conversationId: string;
  readonly runId: string | null;
  readonly chunks: readonly StreamChunk[];
  /** The run status from the stream's message metadata. */
  readonly status: string | null;
  /** All text the assistant streamed. */
  readonly text: string;
  readonly problems: readonly string[];
}

export async function runScenarioOverHttp(
  harness: Harness,
  scenario: Scenario,
): Promise<HttpScenarioRun> {
  const api = harness.api;
  if (api === null) throw new Error("The harness has no server");
  await api.session();
  const { conversation } = await api.expect("POST /api/conversations", {
    body: { title: scenario.title },
  });
  const problems: string[] = [];
  const asked = new Set<string>();
  const decisions: Promise<unknown>[] = [];
  const chunks = await api.chat(conversation.id, scenario.prompt, {
    onChunk: (chunk) => {
      if (chunk.type !== "tool-approval-request") return;
      const toolCallId = String(chunk.toolCallId);
      const logical = logicalCallId(toolCallId) ?? toolCallId;
      asked.add(logical);
      const decision = scenario.approvals[logical];
      if (decision === undefined)
        problems.push(`approval requested for ${logical}, which the scenario does not expect`);
      if (chunk.isAutomatic === true) return;
      decisions.push(
        api
          .decide(
            String(chunk.approvalId),
            decision === "approve",
            decision === "approve" ? undefined : "Not now.",
          )
          .then((reply) => {
            if (!reply.ok) problems.push(`deciding ${logical} answered ${reply.status}`);
          }),
      );
    },
  });
  await Promise.all(decisions);

  const start = chunks.find((chunk) => chunk.type === "start");
  const runId = (start?.messageMetadata as { runId?: string } | undefined)?.runId ?? null;
  const status =
    chunks
      .filter((chunk) => chunk.type === "message-metadata")
      .map((chunk) => (chunk.messageMetadata as { status?: string } | undefined)?.status)
      .findLast((value) => value !== undefined) ?? null;
  const text = chunks
    .filter((chunk) => chunk.type === "text-delta")
    .map((chunk) => String(chunk.delta ?? ""))
    .join("");

  for (const logical of Object.keys(scenario.approvals)) {
    if (!asked.has(logical)) problems.push(`no approval was requested for ${logical}`);
  }
  if (status !== scenario.expected.status)
    problems.push(`run ended ${String(status)}, expected ${scenario.expected.status}`);
  for (const fragment of scenario.expected.replyIncludes ?? []) {
    if (!text.includes(fragment)) problems.push(`the streamed text lacks "${fragment}"`);
  }
  if (harness.script !== null) {
    problems.push(
      ...harness.script.problems.map(
        (entry) => `script ${entry.scenario} step ${entry.step}: ${entry.message}`,
      ),
    );
  }
  if (runId === null) problems.push("the stream carried no runId");
  else problems.push(...(scenario.verify?.(harness.fakes, { runId }) ?? []));
  const wire = JSON.stringify(chunks);
  for (const credential of FAKE_CREDENTIAL_VALUES) {
    if (wire.includes(credential)) problems.push("a fake credential appears in the UI stream");
  }
  return { conversationId: conversation.id, runId, chunks, status, text, problems };
}
