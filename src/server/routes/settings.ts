// Workspace settings and approval policies (docs/ARCHITECTURE.md §7, §9).

import type { Hono } from "hono";
import { z } from "zod";
import { API_PATHS } from "../../contracts/api.js";
import { EFFORT_LEVELS } from "../../contracts/env.js";
import {
  ACTION_CLASSES,
  type ActionClass,
  APPROVAL_MODES,
  type PolicyOverrides,
} from "../../contracts/integration.js";
import { policyViews, readSavedPolicies, savePolicies } from "../../db/repos/policies.js";
import { readSettings, updateSettings } from "../../db/repos/settings.js";
import { apiError, parseJsonBody } from "../http.js";
import type { ApiServices } from "../services.js";

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SLACK_CHANNEL_ID = /^[CGDU][A-Z0-9]{2,}$/;
const SLACK_CHANNEL_NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/;

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => value.replace(/^@/, ""))
  .refine((value) => DOMAIN.test(value), "Expected a domain such as example.com.");

/** "#billing" (names are normalised to lower case with #) or a channel id such as C0123ABC. */
const slackChannel = z
  .string()
  .trim()
  .transform((value) =>
    SLACK_CHANNEL_ID.test(value) ? value : `#${value.replace(/^#/, "").toLowerCase()}`,
  )
  .refine(
    (value) => SLACK_CHANNEL_ID.test(value) || SLACK_CHANNEL_NAME.test(value.slice(1)),
    "Expected a Slack channel such as #billing, or a channel id.",
  );

/**
 * A Google calendar id: "primary" is always internal and needs no entry, so
 * an entry is an address-shaped id such as team@group.calendar.google.com.
 */
const calendarId = z
  .string()
  .trim()
  .toLowerCase()
  .refine(
    (value) => /^[^\s@<>]+@[a-z0-9.-]+\.[a-z]{2,63}$/.test(value) && value.length <= 254,
    "Expected a calendar id such as team@group.calendar.google.com.",
  );

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

const settingsUpdate = z.strictObject({
  companyName: z.string().trim().max(200).optional(),
  agentName: z.string().trim().min(1).max(100).optional(),
  senderName: z.string().trim().max(200).optional(),
  emailSignature: z.string().max(2_000).optional(),
  internalEmailDomains: z.array(domain).max(50).transform(unique).optional(),
  notifySlackChannel: slackChannel.nullable().optional(),
  allowedSlackChannels: z.array(slackChannel).max(100).transform(unique).optional(),
  internalCalendarIds: z.array(calendarId).max(50).transform(unique).optional(),
  timezone: z
    .string()
    .trim()
    .refine(isTimeZone, "Expected an IANA time zone such as Europe/London.")
    .optional(),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Expected an ISO 4217 code such as USD.")
    .optional(),
  defaultModel: z.string().trim().min(1).max(200).nullable().optional(),
  defaultEffort: z.enum(EFFORT_LEVELS).nullable().optional(),
});

const mode = z.enum(APPROVAL_MODES).optional();
const modeShape = {
  read: mode,
  internal_write: mode,
  outbound: mode,
  financial: mode,
  destructive: mode,
} satisfies { readonly [C in ActionClass]: typeof mode };

const policiesUpdate = z.strictObject({ modes: z.strictObject(modeShape) });

export function registerSettingsRoutes(app: Hono, services: ApiServices): void {
  app.get(API_PATHS.settings, (c) => c.json({ settings: readSettings(services.db) }));

  app.patch(API_PATHS.settings, async (c) => {
    const body = await parseJsonBody(c, settingsUpdate);
    if (!body.ok) return body.response;
    const settings = updateSettings(services.db, body.data, services.now().toISOString());
    return c.json({ settings });
  });

  app.get(API_PATHS.policies, (c) =>
    c.json({
      policies: policyViews(readSavedPolicies(services.db), services.env.runtime.policyOverrides),
    }),
  );

  app.patch(API_PATHS.policies, async (c) => {
    const body = await parseJsonBody(c, policiesUpdate);
    if (!body.ok) return body.response;
    const modes: PolicyOverrides = body.data.modes;
    const environment = services.env.runtime.policyOverrides;
    const locked = ACTION_CLASSES.filter(
      (actionClass) => modes[actionClass] !== undefined && environment[actionClass] !== undefined,
    );
    if (locked.length > 0) {
      return apiError(
        c,
        "policy_locked",
        `AGENT_POLICY sets ${locked.join(", ")}; change it in the environment, not in the app.`,
      );
    }
    savePolicies(services.db, modes, services.now().toISOString());
    return c.json({
      policies: policyViews(readSavedPolicies(services.db), environment),
    });
  });
}
