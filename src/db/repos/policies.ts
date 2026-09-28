// Saved approval modes per action class (docs/ARCHITECTURE.md §7, §8).
// The layering for a run (default < saved < AGENT_POLICY < --policy) is the
// policy engine's (src/policy/engine.ts); this module stores the saved layer
// and describes each class for the Settings screen.

import type { PolicyView } from "../../contracts/api.js";
import {
  ACTION_CLASSES,
  type ActionClass,
  type ApprovalMode,
  DEFAULT_POLICY,
  type PolicyOverrides,
} from "../../contracts/integration.js";
import { policies } from "../schema.js";
import type { DbExecutor, IsoTime } from "./types.js";

/** Writes DEFAULT_POLICY for every class that has no row yet. */
export function ensurePolicies(db: DbExecutor, now: IsoTime): void {
  for (const actionClass of ACTION_CLASSES) {
    db.insert(policies)
      .values({ actionClass, mode: DEFAULT_POLICY[actionClass], updatedAt: now })
      .onConflictDoNothing()
      .run();
  }
}

export function readSavedPolicies(db: DbExecutor): PolicyOverrides {
  const saved: { [C in ActionClass]?: ApprovalMode } = {};
  for (const row of db.select().from(policies).all()) saved[row.actionClass] = row.mode;
  return saved;
}

/** Upserts the given classes. Callers check locks first. */
export function savePolicies(db: DbExecutor, modes: PolicyOverrides, now: IsoTime): void {
  for (const actionClass of ACTION_CLASSES) {
    const mode = modes[actionClass];
    if (mode === undefined) continue;
    db.insert(policies)
      .values({ actionClass, mode, updatedAt: now })
      .onConflictDoUpdate({ target: policies.actionClass, set: { mode, updatedAt: now } })
      .run();
  }
}

/**
 * One view per class, in ACTION_CLASSES order. `source` is "environment" for
 * AGENT_POLICY classes (locked), "saved" when a saved mode differs from the
 * default, and "default" otherwise (the seed writes the defaults as rows).
 */
export function policyViews(
  saved: PolicyOverrides,
  environment: PolicyOverrides,
): readonly PolicyView[] {
  return ACTION_CLASSES.map((actionClass): PolicyView => {
    const locked = environment[actionClass];
    if (locked !== undefined) {
      return { actionClass, mode: locked, source: "environment", locked: true };
    }
    const mode = saved[actionClass] ?? DEFAULT_POLICY[actionClass];
    return {
      actionClass,
      mode,
      source: mode === DEFAULT_POLICY[actionClass] ? "default" : "saved",
      locked: false,
    };
  });
}
