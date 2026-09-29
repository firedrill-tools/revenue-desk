/**
 * Every scripted scenario, and the responder the sandbox demo uses: it plays
 * J1–J5 by prompt, so the suggestions in the app's empty state run end to end
 * against the fakes with no model and no network.
 */
import type { ScriptedBlock } from "../support/mock-anthropic.js";
import {
  FAIL_COMPOSIO_SESSION,
  FAIL_HUBSPOT_DOWN,
  FAIL_MODEL_529,
  FAIL_STRIPE_429,
} from "./failures.js";
import { J1_BILLING_INQUIRY } from "./j1-billing-inquiry.js";
import {
  J2_INVALID_ARGUMENTS,
  J2_NAME_SEARCH_AND_NOTE_RULE,
  J2_REFUND_DENIED,
  J2_REFUND_DUPLICATE,
  J2_STOPPED_AT_APPROVAL,
  J2_STRIPE_DECLINE,
} from "./j2-refund-duplicate.js";
import { J3_CALL_DENIED, J3_COLLECTIONS } from "./j3-collections.js";
import { J4_CLOSED_WON } from "./j4-closed-won.js";
import { J5_WEEKLY_DIGEST } from "./j5-weekly-digest.js";
import { type Scenario, type ScenarioResponder, scenarioResponder } from "./script.js";

/** The five jobs on the happy path, in order. */
export const JOB_SCENARIOS: readonly Scenario[] = [
  J1_BILLING_INQUIRY,
  J2_REFUND_DUPLICATE,
  J3_COLLECTIONS,
  J4_CLOSED_WON,
  J5_WEEKLY_DIGEST,
];

/** Variants where a person decides differently, or stops the run at an approval. */
export const DECISION_SCENARIOS: readonly Scenario[] = [
  J2_REFUND_DENIED,
  J3_CALL_DENIED,
  J2_STOPPED_AT_APPROVAL,
];

/** Provider and model failures, and the argument guard. */
export const FAILURE_SCENARIOS: readonly Scenario[] = [
  J2_STRIPE_DECLINE,
  FAIL_STRIPE_429,
  FAIL_HUBSPOT_DOWN,
  FAIL_COMPOSIO_SESSION,
  FAIL_MODEL_529,
  J2_INVALID_ARGUMENTS,
  J2_NAME_SEARCH_AND_NOTE_RULE,
];

export const ALL_SCENARIOS: readonly Scenario[] = [
  ...JOB_SCENARIOS,
  ...DECISION_SCENARIOS,
  ...FAILURE_SCENARIOS,
];

/** Several scenarios as turns of one conversation (the SDK session is resumed). */
export interface ScriptedConversation {
  readonly id: string;
  readonly title: string;
  readonly turns: readonly Scenario[];
}

export const CONVERSATIONS: readonly ScriptedConversation[] = [
  {
    id: "j1-then-j2",
    title: "A billing question, then the refund, in one conversation",
    turns: [J1_BILLING_INQUIRY, J2_REFUND_DUPLICATE],
  },
];

export function scenarioById(id: string): Scenario {
  const scenario = ALL_SCENARIOS.find((entry) => entry.id === id);
  if (scenario === undefined) throw new Error(`No scenario ${id}`);
  return scenario;
}

/** Words in a prompt that pick a job when the text is not exactly a scenario's prompt. */
const KEYWORDS: readonly (readonly [RegExp, Scenario])[] = [
  [/\brefund/i, J2_REFUND_DUPLICATE],
  [
    /charged twice|double[- ]charge|billing (question|inquiry)|reply to (dana|her)/i,
    J1_BILLING_INQUIRY,
  ],
  [/collections?|overdue|past due/i, J3_COLLECTIONS],
  [/closed[- ]won|solstice|hand ?off/i, J4_CLOSED_WON],
  [/digest|weekly/i, J5_WEEKLY_DIGEST],
];

/** The job a sandbox prompt asks for: an exact prompt first, then keywords. */
export function chooseJob(prompt: string): Scenario | undefined {
  const exact = JOB_SCENARIOS.find((scenario) => scenario.prompt === prompt.trim());
  return exact ?? KEYWORDS.find(([pattern]) => pattern.test(prompt))?.[1];
}

function unmatched(): readonly ScriptedBlock[] {
  return [
    {
      type: "text",
      text: [
        "This local sandbox runs a scripted model, which knows five requests:",
        ...JOB_SCENARIOS.map((scenario) => `- ${scenario.prompt}`),
        "Start ANTHROPIC_API_KEY=… pnpm dev:sandbox to talk to the real model against the same local fakes.",
      ].join("\n"),
    },
  ];
}

/** The sandbox's scripted model: J1–J5 by prompt, problems reported on stderr. */
export function sandboxResponder(): ScenarioResponder {
  return scenarioResponder(JOB_SCENARIOS, {
    choose: (prompt) => chooseJob(prompt),
    unmatched,
    logProblems: true,
  });
}

export * from "./script.js";
export {
  FAIL_COMPOSIO_SESSION,
  FAIL_HUBSPOT_DOWN,
  FAIL_MODEL_529,
  FAIL_STRIPE_429,
  J1_BILLING_INQUIRY,
  J2_INVALID_ARGUMENTS,
  J2_NAME_SEARCH_AND_NOTE_RULE,
  J2_REFUND_DENIED,
  J2_REFUND_DUPLICATE,
  J2_STOPPED_AT_APPROVAL,
  J2_STRIPE_DECLINE,
  J3_CALL_DENIED,
  J3_COLLECTIONS,
  J4_CLOSED_WON,
  J5_WEEKLY_DIGEST,
};
