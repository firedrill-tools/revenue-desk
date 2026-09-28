// What a run remembers about the Gmail drafts it created (the gateway's
// RunMemory, src/gateway/catalog.ts): sending a draft names only its id, so
// the approval card takes the recipients, subject and thread from this run's
// GMAIL_CREATE_EMAIL_DRAFT of that draft (classify.ts). A draft this run did
// not create stays unconfirmed, and its card says so.

import type { Classification } from "../../contracts/integration.js";
import type { JsonObject, JsonValue } from "../../contracts/json.js";
import type { RunMemory } from "../../gateway/catalog.js";
import { str } from "../shared/json.js";
import { classifySendDraft, draftFromCreate, type KnownDraft } from "./classify.js";

export class GmailDraftMemory implements RunMemory {
  readonly #drafts = new Map<string, KnownDraft>();

  record(tool: string, input: JsonObject, output: JsonValue, isError: boolean): void {
    if (tool !== "GMAIL_CREATE_EMAIL_DRAFT" || isError) return;
    const draft = draftFromCreate(input, output);
    if (draft !== null) this.#drafts.set(draft.draftId, draft);
  }

  refine(tool: string, input: JsonObject, classification: Classification): Classification {
    if (tool !== "GMAIL_SEND_DRAFT") return classification;
    const draftId = str(input, "draft_id");
    const known = draftId === undefined ? null : (this.#drafts.get(draftId) ?? null);
    return classifySendDraft(input, known) ?? classification;
  }

  /** The drafts this run created, by id. */
  get drafts(): ReadonlyMap<string, KnownDraft> {
    return this.#drafts;
  }
}
