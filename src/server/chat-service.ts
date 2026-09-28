// Starting a chat turn (POST /api/chat, docs/ARCHITECTURE.md §6, §7): one
// active run per conversation, at most MAX_CONCURRENT_RUNS at once. Checks,
// rows and registration happen synchronously, so two requests can never both
// pass the checks.

import type { AgentEnv } from "../contracts/env.js";
import {
  getConversation,
  nameConversationIfBlank,
  setConversationStatus,
} from "../db/repos/conversations.js";
import { getMessageRow, insertUserMessage } from "../db/repos/messages.js";
import { insertRun, runningRunOf } from "../db/repos/runs.js";
import type { DbExecutor } from "../db/repos/types.js";
import type { ApprovalGateController } from "../policy/approvals.js";
import type { ConnectionService } from "./connections.js";
import type { OrphanSweeper } from "./orphans.js";
import { prepareRunContext } from "./run-context.js";
import type { ActiveRun, RunRegistry } from "./run-registry.js";

export const MAX_TITLE_FROM_PROMPT = 80;

export type UserTurn = {
  /** The client's UIMessage id. */
  readonly messageId: string;
  /** The text parts of the message, in order. */
  readonly texts: readonly string[];
};

export type StartTurnResult =
  | { readonly ok: true; readonly run: ActiveRun }
  | {
      readonly ok: false;
      readonly code: "not_found" | "run_active" | "too_many_runs" | "invalid_request";
      readonly message: string;
    };

export type ChatServiceOptions = {
  readonly db: DbExecutor;
  readonly env: AgentEnv;
  readonly registry: RunRegistry;
  readonly connections: ConnectionService;
  readonly approvals: ApprovalGateController;
  readonly orphans: OrphanSweeper;
  readonly now: () => Date;
  readonly newId: () => string;
};

export class ChatService {
  readonly #options: ChatServiceOptions;

  constructor(options: ChatServiceOptions) {
    this.#options = options;
  }

  startTurn(conversationId: string, turn: UserTurn): StartTurnResult {
    const { db, env, registry } = this.#options;
    const conversation = getConversation(db, conversationId);
    if (conversation === undefined) {
      return { ok: false, code: "not_found", message: "No conversation has this id." };
    }
    // A run in the database that no live process runs (a killed CLI) is
    // recovered here instead of blocking the conversation for ever.
    if (
      registry.forConversation(conversationId) === undefined &&
      runningRunOf(db, conversationId)
    ) {
      this.#options.orphans.conversation(conversationId);
    }
    if (
      registry.forConversation(conversationId) !== undefined ||
      runningRunOf(db, conversationId)
    ) {
      return {
        ok: false,
        code: "run_active",
        message: "This conversation already has a run in progress. Wait for it or stop it.",
      };
    }
    if (registry.size >= registry.maxConcurrentRuns) {
      return {
        ok: false,
        code: "too_many_runs",
        message: `At most ${registry.maxConcurrentRuns} runs can be active at once. Try again when one finishes.`,
      };
    }
    if (getMessageRow(db, turn.messageId) !== undefined) {
      return { ok: false, code: "invalid_request", message: "This message id was already sent." };
    }
    const prompt = turn.texts.join("\n\n").trim();
    if (prompt === "") {
      return { ok: false, code: "invalid_request", message: "The message has no text." };
    }

    const startedAt = this.#options.now();
    const now = startedAt.toISOString();
    const context = prepareRunContext({
      db,
      env,
      connections: this.#options.connections,
      now: startedAt,
    });
    const runId = this.#options.newId();
    const assistantMessageId = this.#options.newId();

    db.transaction((tx) => {
      insertRun(tx, {
        id: runId,
        conversationId,
        source: "ui",
        mode: "interactive",
        model: context.model.model,
        effort: context.model.effort,
        userMessageId: turn.messageId,
        assistantMessageId,
        policy: context.policy,
        connections: context.connectionSnapshot,
        startedAt: now,
        owner: this.#options.orphans.owner,
      });
      insertUserMessage(tx, {
        id: turn.messageId,
        conversationId,
        runId,
        parts: turn.texts.map((text) => ({ type: "text", text })),
        now,
      });
      nameConversationIfBlank(tx, conversationId, titleFromPrompt(prompt), now);
      setConversationStatus(tx, conversationId, "running", now);
    });

    const run = registry.launch({
      runId,
      conversationId,
      assistantMessageId,
      model: context.model.model,
      effort: context.model.effort,
      input: (signal) => ({
        mode: "interactive",
        approvals: this.#options.approvals,
        runId,
        conversationId,
        source: "ui",
        prompt,
        resumeSessionId: conversation.sdkSessionId,
        env,
        model: context.model,
        settings: context.settings,
        policy: context.policy,
        businessDate: context.businessDate,
        connections: context.connections,
        signal,
      }),
    });
    return { ok: true, run };
  }
}

/** The first line of the prompt, whitespace collapsed, at most 80 characters. */
export function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  const characters = [...collapsed];
  if (characters.length <= MAX_TITLE_FROM_PROMPT) return collapsed;
  return `${characters
    .slice(0, MAX_TITLE_FROM_PROMPT - 1)
    .join("")
    .trimEnd()}…`;
}
