// The per-call identity the gateway derives from the Claude CLI's tools/call
// request (docs/ARCHITECTURE.md §5 "Tool-use id").
//
// The CLI (2.1.283) sends the model's tool_use id as
// `_meta["claudecode/toolUseId"]` on every tools/call to an in-process server.
// The idempotency key of a write is sha256hex(`${runId}:${toolUseId}`), so a
// replayed call reuses its key (Stripe Idempotency-Key, QuickBooks requestid).
// A write without the id fails closed.

import { createHash, randomUUID } from "node:crypto";
import { TOOL_USE_ID_META_KEY } from "../contracts/integration.js";

/** The tool_use id from a tools/call request's `_meta`, or null when absent or malformed. */
export function toolUseIdFromMeta(meta: unknown): string | null {
  if (meta === null || typeof meta !== "object") return null;
  const value = (meta as Record<string, unknown>)[TOOL_USE_ID_META_KEY];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.length > 256 ? null : trimmed;
}

export function idempotencyKeyFor(runId: string, toolUseId: string): string {
  return createHash("sha256").update(`${runId}:${toolUseId}`).digest("hex");
}

/** A stand-in id for a read that arrived without one; never used for a write. */
export function untrackedToolUseId(): string {
  return `untracked-${randomUUID()}`;
}

/** The model-facing text of a write refused for a missing tool-use id. */
export const MISSING_TOOL_USE_ID =
  "Revenue Desk could not identify this call, so the write was not run. Report this to the user; do not retry it.";
