// The workspace_settings singleton (docs/ARCHITECTURE.md §8).

import { eq } from "drizzle-orm";
import type { SettingsUpdate } from "../../contracts/api.js";
import type { WorkspaceSettings } from "../../contracts/integration.js";
import { type WorkspaceSettingsRow, workspaceSettings } from "../schema.js";
import type { DbExecutor, IsoTime } from "./types.js";

const SINGLETON_ID = 1;

export function toWorkspaceSettings(row: WorkspaceSettingsRow): WorkspaceSettings {
  return {
    companyName: row.companyName,
    agentName: row.agentName,
    senderName: row.senderName,
    emailSignature: row.emailSignature,
    internalEmailDomains: row.internalEmailDomains,
    notifySlackChannel: row.notifySlackChannel,
    allowedSlackChannels: row.allowedSlackChannels,
    internalCalendarIds: row.internalCalendarIds,
    timezone: row.timezone,
    currency: row.currency,
    defaultModel: row.defaultModel,
    defaultEffort: row.defaultEffort,
    updatedAt: row.updatedAt,
  };
}

/** Writes the default row (schema defaults: blank company name) when there is none. */
export function ensureSettings(db: DbExecutor, now: IsoTime): void {
  db.insert(workspaceSettings)
    .values({ id: SINGLETON_ID, updatedAt: now })
    .onConflictDoNothing()
    .run();
}

/** The settings row. The seed (or server boot) writes it; a missing row is a setup error. */
export function readSettings(db: DbExecutor): WorkspaceSettings {
  const row = db
    .select()
    .from(workspaceSettings)
    .where(eq(workspaceSettings.id, SINGLETON_ID))
    .get();
  if (row === undefined) {
    throw new Error("Workspace settings are missing: seed the database first (pnpm db:seed).");
  }
  return toWorkspaceSettings(row);
}

/** Applies a validated partial update and returns the new settings. */
export function updateSettings(
  db: DbExecutor,
  update: SettingsUpdate,
  now: IsoTime,
): WorkspaceSettings {
  const values: Partial<typeof workspaceSettings.$inferInsert> = { updatedAt: now };
  if (update.companyName !== undefined) values.companyName = update.companyName;
  if (update.agentName !== undefined) values.agentName = update.agentName;
  if (update.senderName !== undefined) values.senderName = update.senderName;
  if (update.emailSignature !== undefined) values.emailSignature = update.emailSignature;
  if (update.internalEmailDomains !== undefined) {
    values.internalEmailDomains = [...update.internalEmailDomains];
  }
  if (update.notifySlackChannel !== undefined)
    values.notifySlackChannel = update.notifySlackChannel;
  if (update.allowedSlackChannels !== undefined) {
    values.allowedSlackChannels = [...update.allowedSlackChannels];
  }
  if (update.internalCalendarIds !== undefined) {
    values.internalCalendarIds = [...update.internalCalendarIds];
  }
  if (update.timezone !== undefined) values.timezone = update.timezone;
  if (update.currency !== undefined) values.currency = update.currency;
  if (update.defaultModel !== undefined) values.defaultModel = update.defaultModel;
  if (update.defaultEffort !== undefined) values.defaultEffort = update.defaultEffort;

  ensureSettings(db, now);
  db.update(workspaceSettings).set(values).where(eq(workspaceSettings.id, SINGLETON_ID)).run();
  return readSettings(db);
}
