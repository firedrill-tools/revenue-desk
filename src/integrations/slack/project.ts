// Compact views of Slack objects for the model. Absent fields stay absent;
// times are in the workspace time zone with their offset (shared/time.ts).

import type { JsonObject } from "../../contracts/json.js";
import { bool, compact, obj, pick, str } from "../shared/json.js";
import { zonedIso } from "../shared/time.js";

/** The ISO time of a Slack ts ("1727512345.000200"), in `timezone` (UTC without one). */
export function isoFromTs(ts: string | undefined, timezone?: string): string | undefined {
  if (ts === undefined || !/^\d+(\.\d+)?$/.test(ts)) return undefined;
  return zonedIso(Math.floor(Number(ts) * 1000), timezone);
}

export function channel(object: JsonObject): JsonObject {
  return compact({
    ...pick(object, ["id", "name", "is_private", "is_member", "is_archived", "num_members"]),
    topic: str(obj(object, "topic"), "value"),
    purpose: str(obj(object, "purpose"), "value"),
  });
}

export function message(object: JsonObject, timezone?: string): JsonObject {
  const ts = str(object, "ts");
  return compact({
    ts,
    time: isoFromTs(ts, timezone),
    ...pick(object, ["user", "bot_id", "text", "thread_ts", "reply_count", "subtype"]),
  });
}

export function user(object: JsonObject): JsonObject {
  const profile = obj(object, "profile");
  return compact({
    ...pick(object, ["id", "name", "real_name", "tz"]),
    display_name: str(profile, "display_name"),
    email: str(profile, "email"),
    title: str(profile, "title"),
    is_bot: bool(object, "is_bot"),
    deleted: bool(object, "deleted"),
  });
}

/** Slack's next page cursor, or null on the last page. */
export function nextCursor(body: JsonObject): string | null {
  return str(obj(body, "response_metadata"), "next_cursor") ?? null;
}
