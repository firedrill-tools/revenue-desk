// Compact views of Slack objects for the model. Absent fields stay absent.

import type { JsonObject } from "../../contracts/json.js";
import { bool, compact, obj, pick, str } from "../shared/json.js";

/** The ISO time of a Slack ts ("1727512345.000200"). */
export function isoFromTs(ts: string | undefined): string | undefined {
  if (ts === undefined || !/^\d+(\.\d+)?$/.test(ts)) return undefined;
  return new Date(Math.floor(Number(ts) * 1000)).toISOString();
}

export function channel(object: JsonObject): JsonObject {
  return compact({
    ...pick(object, ["id", "name", "is_private", "is_member", "is_archived", "num_members"]),
    topic: str(obj(object, "topic"), "value"),
    purpose: str(obj(object, "purpose"), "value"),
  });
}

export function message(object: JsonObject): JsonObject {
  const ts = str(object, "ts");
  return compact({
    ts,
    time: isoFromTs(ts),
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
