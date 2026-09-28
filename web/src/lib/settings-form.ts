// Settings form rules: normalising list entries, validating fields and
// computing the PATCH body from the changed fields only.
//
// Alias-free and DOM-free so the Node test suite can import it.

import type { PoliciesUpdate, PolicyView, SettingsUpdate } from "../../../src/contracts/api.js";
import { EFFORT_LEVELS } from "../../../src/contracts/env.js";
import {
  ACTION_CLASSES,
  type ApprovalMode,
  type WorkspaceSettings,
} from "../../../src/contracts/integration.js";

export type Normalized = { value: string } | { error: string };

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const CHANNEL = /^#[a-z0-9][a-z0-9_-]{0,79}$/;

export function normalizeDomain(raw: string): Normalized {
  const value = raw.trim().toLowerCase().replace(/^@+/, "").replace(/\.$/, "");
  return DOMAIN.test(value) ? { value } : { error: "Enter a domain such as example.com." };
}

export function normalizeChannel(raw: string): Normalized {
  const bare = raw.trim().toLowerCase().replace(/^#+/, "");
  const value = `#${bare}`;
  return CHANNEL.test(value)
    ? { value }
    : { error: "Use a channel name such as #billing: lowercase letters, numbers, - and _." };
}

/** The editable fields, as strings where the form edits text. */
export type SettingsDraft = {
  companyName: string;
  agentName: string;
  senderName: string;
  emailSignature: string;
  internalEmailDomains: string[];
  notifySlackChannel: string;
  allowedSlackChannels: string[];
  timezone: string;
  currency: string;
  defaultModel: string;
  /** "" means the environment default. */
  defaultEffort: string;
};

export function draftFromSettings(settings: WorkspaceSettings): SettingsDraft {
  return {
    companyName: settings.companyName,
    agentName: settings.agentName,
    senderName: settings.senderName,
    emailSignature: settings.emailSignature,
    internalEmailDomains: [...settings.internalEmailDomains],
    notifySlackChannel: settings.notifySlackChannel ?? "",
    allowedSlackChannels: [...settings.allowedSlackChannels],
    timezone: settings.timezone,
    currency: settings.currency,
    defaultModel: settings.defaultModel ?? "",
    defaultEffort: settings.defaultEffort ?? "",
  };
}

export type FieldErrors = Partial<Record<keyof SettingsDraft, string>>;

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function validateDraft(draft: SettingsDraft): FieldErrors {
  const errors: FieldErrors = {};
  if (draft.companyName.trim() === "") errors.companyName = "Enter the company name.";
  if (draft.agentName.trim() === "") errors.agentName = "Enter a name for the agent.";
  if (!/^[A-Za-z]{3}$/.test(draft.currency.trim())) {
    errors.currency = "Use a three-letter ISO 4217 code such as USD.";
  }
  if (draft.timezone.trim() === "" || !isTimeZone(draft.timezone.trim())) {
    errors.timezone = "Use an IANA time zone such as America/New_York.";
  }
  const channel = draft.notifySlackChannel.trim();
  if (channel !== "" && "error" in normalizeChannel(channel)) {
    errors.notifySlackChannel = "Use a channel name such as #billing.";
  }
  if (draft.defaultEffort !== "" && !EFFORT_LEVELS.some((level) => level === draft.defaultEffort)) {
    errors.defaultEffort = "Choose an effort level.";
  }
  return errors;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** Only the fields that changed, in the contract's shape. */
export function settingsPatch(original: WorkspaceSettings, draft: SettingsDraft): SettingsUpdate {
  const patch: { -readonly [K in keyof SettingsUpdate]: SettingsUpdate[K] } = {};
  const text = (value: string) => value.trim();
  if (text(draft.companyName) !== original.companyName) patch.companyName = text(draft.companyName);
  if (text(draft.agentName) !== original.agentName) patch.agentName = text(draft.agentName);
  if (text(draft.senderName) !== original.senderName) patch.senderName = text(draft.senderName);
  if (draft.emailSignature !== original.emailSignature) patch.emailSignature = draft.emailSignature;
  if (!sameList(draft.internalEmailDomains, original.internalEmailDomains)) {
    patch.internalEmailDomains = draft.internalEmailDomains;
  }
  if (!sameList(draft.allowedSlackChannels, original.allowedSlackChannels)) {
    patch.allowedSlackChannels = draft.allowedSlackChannels;
  }
  const channel = text(draft.notifySlackChannel);
  const normalizedChannel = channel === "" ? null : normalizeChannelValue(channel);
  if (normalizedChannel !== original.notifySlackChannel)
    patch.notifySlackChannel = normalizedChannel;
  if (text(draft.timezone) !== original.timezone) patch.timezone = text(draft.timezone);
  const currency = text(draft.currency).toUpperCase();
  if (currency !== original.currency) patch.currency = currency;
  const model = text(draft.defaultModel) === "" ? null : text(draft.defaultModel);
  if (model !== original.defaultModel) patch.defaultModel = model;
  const effort = EFFORT_LEVELS.find((level) => level === draft.defaultEffort) ?? null;
  if (effort !== original.defaultEffort) patch.defaultEffort = effort;
  return patch;
}

function normalizeChannelValue(raw: string): string {
  const result = normalizeChannel(raw);
  return "value" in result ? result.value : raw;
}

/** The policy PATCH body: changed, unlocked classes only. */
export function policiesPatch(
  policies: readonly PolicyView[],
  draft: Readonly<Record<string, ApprovalMode>>,
): PoliciesUpdate {
  const modes: { -readonly [K in keyof PoliciesUpdate["modes"]]: PoliciesUpdate["modes"][K] } = {};
  for (const actionClass of ACTION_CLASSES) {
    const policy = policies.find((item) => item.actionClass === actionClass);
    const next = draft[actionClass];
    if (!policy || policy.locked || next === undefined || next === policy.mode) continue;
    modes[actionClass] = next;
  }
  return { modes };
}

export function isEmptyPatch(patch: object): boolean {
  return Object.keys(patch).length === 0;
}
