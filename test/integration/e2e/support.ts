/**
 * Full-stack end-to-end support: read what a run left in the state database
 * with plain SQL (independently of the product's repositories), and look at
 * what the scripted model was asked.
 */
import Database from "better-sqlite3";
import { databasePath } from "../../../src/db/client.js";
import { logicalCallId } from "../../scenarios/script.js";
import type { MockAnthropic } from "../../support/mock-anthropic.js";

export type RunRecord = {
  readonly id: string;
  readonly conversation_id: string;
  readonly source: string;
  readonly mode: string;
  readonly status: string;
  readonly stop_reason: string | null;
  readonly terminal_reason: string | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly model_requests: number | null;
  readonly cost_usd: number | null;
  readonly finished_at: string | null;
  readonly connections_snapshot: string;
  readonly user_message_id: string | null;
  readonly assistant_message_id: string | null;
};

export type ToolCallRecord = {
  readonly tool_use_id: string;
  readonly integration: string | null;
  readonly connection_kind: string | null;
  readonly tool_name: string;
  readonly upstream_tool: string | null;
  readonly operation: string | null;
  readonly action_class: string | null;
  readonly status: string;
  readonly decision: string;
  readonly is_error: number;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly http_status: number | null;
  readonly idempotency_key: string | null;
  readonly approval_id: string | null;
  readonly input_json: string;
  readonly output_json: string | null;
  readonly finished_at: string | null;
};

export type ApprovalRecord = {
  readonly id: string;
  readonly tool_use_id: string;
  readonly integration: string;
  readonly action_class: string;
  readonly operation: string;
  readonly status: string;
  readonly decided_by: string | null;
  readonly reason: string | null;
  readonly decided_at: string | null;
};

export type ConversationRecord = {
  readonly id: string;
  readonly status: string;
  readonly source: string;
  readonly sdk_session_id: string | null;
};

export type MessageRecord = {
  readonly id: string;
  readonly role: string;
  readonly run_id: string | null;
  readonly seq: number;
  readonly parts_json: string;
  readonly text: string;
};

export type RunRows = {
  readonly run: RunRecord;
  readonly conversation: ConversationRecord;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly approvals: readonly ApprovalRecord[];
  readonly messages: readonly MessageRecord[];
  /** Tool calls by logical scripted id (toolu_<id>[_tN] -> <id>). */
  call(logicalId: string): ToolCallRecord;
  approval(logicalId: string): ApprovalRecord;
  connection(integration: string): { readonly availability: string; readonly state: string };
};

/** Everything the database holds about one run, read with a separate read-only connection. */
export function readRunRows(stateDir: string, runId: string): RunRows {
  const sqlite = new Database(databasePath(stateDir), { readonly: true, fileMustExist: true });
  try {
    const run = sqlite.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
      | RunRecord
      | undefined;
    if (run === undefined) throw new Error(`No run ${runId} in ${stateDir}`);
    const conversation = sqlite
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(run.conversation_id) as ConversationRecord;
    const toolCalls = sqlite
      .prepare("SELECT * FROM tool_calls WHERE run_id = ? ORDER BY started_at, tool_use_id")
      .all(runId) as ToolCallRecord[];
    const approvals = sqlite
      .prepare("SELECT * FROM approvals WHERE run_id = ? ORDER BY requested_at")
      .all(runId) as ApprovalRecord[];
    const messages = sqlite
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq")
      .all(run.conversation_id) as MessageRecord[];
    const byLogical = <T extends { readonly tool_use_id: string }>(
      rows: readonly T[],
      id: string,
    ) => {
      const found = rows.find((row) => logicalCallId(row.tool_use_id) === id);
      if (found === undefined) {
        throw new Error(
          `No row for ${id}; rows: ${rows.map((row) => row.tool_use_id).join(", ") || "none"}`,
        );
      }
      return found;
    };
    const connections = JSON.parse(run.connections_snapshot) as {
      integration: string;
      availability: string;
      state: string;
    }[];
    return {
      run,
      conversation,
      toolCalls,
      approvals,
      messages,
      call: (id) => byLogical(toolCalls, id),
      approval: (id) => byLogical(approvals, id),
      connection: (integration) => {
        const found = connections.find((entry) => entry.integration === integration);
        if (found === undefined) throw new Error(`No connection ${integration} in the snapshot`);
        return found;
      },
    };
  } finally {
    sqlite.close();
  }
}

/** The logical ids of a run's tool calls, sorted. */
export function logicalIds(rows: readonly { readonly tool_use_id: string }[]): string[] {
  return rows.map((row) => logicalCallId(row.tool_use_id) ?? row.tool_use_id).sort();
}

type RequestBody = {
  readonly tools?: readonly unknown[];
  readonly messages?: readonly { readonly role: string; readonly content: unknown }[];
};

/** The agent's model requests (the ones that offer tools), in order. */
export function agentRequests(model: MockAnthropic | null): RequestBody[] {
  if (model === null) throw new Error("The harness runs the real model");
  return model.requests
    .map((request) => request.body as RequestBody | undefined)
    .filter((body): body is RequestBody => Array.isArray(body?.tools));
}

/** Every text the request's messages carry (user prompts, assistant text, tool results). */
export function messageTexts(body: RequestBody): string[] {
  const texts: string[] = [];
  for (const message of body.messages ?? []) {
    if (typeof message.content === "string") {
      texts.push(message.content);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as { type?: unknown; text?: unknown }[]) {
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
  }
  return texts;
}
